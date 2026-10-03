import type { AudioEngine, PcmStream } from "./index";
import {
  PLAYBACK_LOOKAHEAD_SECONDS,
  PLAYBACK_START_DELAY_SECONDS,
  PLAYBACK_WINDOW_SECONDS,
  gainLinear,
  planCues,
  projectTimeAt,
  trackIsAudible,
  validLoop,
  type LoopRegion,
} from "./transport";

export interface ScheduledSlice {
  trackId: string;
  channels: Float32Array[];
  sampleRate: number;
  contextTime: number;
  fileOffsetSeconds: number;
}

export interface AudioOutput {
  now(): number;
  resume(): Promise<void>;
  prepareTrack(trackId: string): void;
  setGain(trackId: string, linear: number): void;
  setPan(trackId: string, pan: number): void;
  start(slice: ScheduledSlice): { stop(): void };
  close(): void;
}

interface MixState {
  gainDb: number;
  pan: number;
  muted: boolean;
  solo: boolean;
}

interface LiveSource {
  stop: () => void;
  endContext: number;
}

export interface StreamingEngine extends AudioEngine {
  pump(): Promise<void>;
}

export function createStreamingEngine(
  output: AudioOutput,
  options?: { windowSeconds?: number; lookaheadSeconds?: number },
): StreamingEngine {
  const windowSeconds = options?.windowSeconds ?? PLAYBACK_WINDOW_SECONDS;
  const lookaheadSeconds = options?.lookaheadSeconds ?? PLAYBACK_LOOKAHEAD_SECONDS;
  const streams = new Map<string, PcmStream | null>();
  const mix = new Map<string, MixState>();
  const loaded = new Set<string>();
  let sources: LiveSource[] = [];
  let durationSeconds = 0;
  let playing = false;
  let disposed = false;
  let busy = false;
  let generation = 0;
  let originProject = 0;
  let originContext = 0;
  let cursorProject = 0;
  let scheduledUntilContext = 0;
  let loop: LoopRegion | null = null;

  function currentTime(): number {
    return projectTimeAt({
      playing,
      originProject,
      originContext,
      now: output.now(),
      durationSeconds,
      loop,
    });
  }

  function stopSources(): void {
    const now = output.now();
    for (const source of sources) {
      if (source.endContext > now) source.stop();
    }
    sources = [];
  }

  function apply(trackId: string): void {
    if (!loaded.has(trackId)) return;
    const row = mix.get(trackId);
    if (!row) return;
    const anySolo = [...mix.values()].some((item) => item.solo);
    const linear = trackIsAudible(row.muted, row.solo, anySolo) ? gainLinear(row.gainDb) : 0;
    output.setGain(trackId, linear);
    output.setPan(trackId, row.pan);
  }

  function applyAll(): void {
    for (const trackId of loaded) apply(trackId);
  }

  function ensureMix(trackId: string): MixState {
    const existing = mix.get(trackId);
    if (existing) return existing;
    const created = { gainDb: 0, pan: 0, muted: false, solo: false };
    mix.set(trackId, created);
    return created;
  }

  const engine: StreamingEngine = {
    async loadProject(project, media) {
      generation += 1;
      playing = false;
      stopSources();
      mix.clear();
      streams.clear();
      loaded.clear();
      durationSeconds = project.project.durationSeconds;
      originProject = 0;
      cursorProject = 0;
      const opened = await Promise.all(
        project.tracks.map(async (track) => ({
          track,
          stream: (await media.open?.(track.file.relativePath)) ?? null,
        })),
      );
      if (disposed) return;
      for (const { track, stream } of opened) {
        output.prepareTrack(track.id);
        streams.set(track.id, stream);
        if (!mix.has(track.id)) {
          mix.set(track.id, { gainDb: track.gainDb, pan: track.pan, muted: track.muted, solo: track.solo });
        }
        loaded.add(track.id);
      }
      applyAll();
    },
    async play(startTime) {
      if (disposed) return;
      if (startTime !== undefined) engine.seek(startTime);
      if (playing) return;
      if (!loop && originProject >= durationSeconds - 1e-3) originProject = 0;
      await output.resume();
      if (disposed) return;
      playing = true;
      originContext = output.now() + PLAYBACK_START_DELAY_SECONDS;
      scheduledUntilContext = originContext;
      cursorProject = originProject;
      await engine.pump();
    },
    pause() {
      if (!playing) return;
      originProject = currentTime();
      playing = false;
      generation += 1;
      stopSources();
    },
    stop() {
      playing = false;
      generation += 1;
      stopSources();
      originProject = 0;
      cursorProject = 0;
    },
    seek(seconds) {
      const time = Math.min(durationSeconds, Math.max(0, seconds));
      originProject = time;
      cursorProject = time;
      generation += 1;
      stopSources();
      if (!playing) return;
      originContext = output.now() + PLAYBACK_START_DELAY_SECONDS;
      scheduledUntilContext = originContext;
      void engine.pump();
    },
    setTrackGain(trackId, gainDb) {
      ensureMix(trackId).gainDb = gainDb;
      applyAll();
    },
    setTrackPan(trackId, pan) {
      ensureMix(trackId).pan = pan;
      apply(trackId);
    },
    setMute(trackId, muted) {
      ensureMix(trackId).muted = muted;
      applyAll();
    },
    setSolo(trackId, solo) {
      ensureMix(trackId).solo = solo;
      applyAll();
    },
    setLoop(region) {
      loop = validLoop(region);
      if (!playing) return;
      generation += 1;
      stopSources();
      originProject = currentTime();
      originContext = output.now() + PLAYBACK_START_DELAY_SECONDS;
      scheduledUntilContext = originContext;
      cursorProject = originProject;
      void engine.pump();
    },
    getCurrentTime: currentTime,
    getDuration: () => durationSeconds,
    dispose() {
      disposed = true;
      playing = false;
      generation += 1;
      stopSources();
      output.close();
    },
    async pump() {
      if (busy || !playing || disposed) return;
      busy = true;
      const stamp = generation;
      try {
        const horizon = output.now() + lookaheadSeconds;
        const planned = planCues({
          cursorContext: scheduledUntilContext,
          cursorProject,
          untilContext: horizon,
          windowSeconds,
          durationSeconds,
          loop,
        });
        for (const cue of planned.cues) {
          if (stamp !== generation || !playing) return;
          const framePlans = [...streams.entries()].map(async ([trackId, stream]) => {
            if (!stream) return;
            const frameCount = Math.max(1, Math.round(cue.durationSeconds * stream.sampleRate));
            const frameOffset = Math.max(0, Math.round(cue.fileOffsetSeconds * stream.sampleRate));
            const channels = await stream.readFrames(frameOffset, frameCount);
            if (stamp !== generation || !playing || channels.length === 0 || channels[0]!.length === 0) return;
            const handle = output.start({
              trackId,
              channels,
              sampleRate: stream.sampleRate,
              contextTime: cue.contextTime,
              fileOffsetSeconds: cue.fileOffsetSeconds,
            });
            sources.push({ stop: handle.stop, endContext: cue.contextTime + cue.durationSeconds });
          });
          await Promise.all(framePlans);
          if (stamp !== generation || !playing) return;
          scheduledUntilContext = cue.contextTime + cue.durationSeconds;
          cursorProject = cue.fileOffsetSeconds + cue.durationSeconds;
        }
        const now = output.now();
        sources = sources.filter((source) => source.endContext > now - 1);
      } finally {
        busy = false;
      }
    },
  };

  return engine;
}
