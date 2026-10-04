import type { AudioEngine, PcmStream } from "./index";
import { createStreamResampler, type StreamResampler } from "./resample";
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
  sampleRate(): number;
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

interface TrackCursor {
  resampler: StreamResampler;
  frame: number;
}

export interface StreamingEngine extends AudioEngine {
  pump(): Promise<void>;
}

export function createStreamingEngine(
  output: AudioOutput,
  options?: { windowSeconds?: number; lookaheadSeconds?: number },
): StreamingEngine {
  const windowOverride = options?.windowSeconds;
  const lookaheadOverride = options?.lookaheadSeconds;
  const streams = new Map<string, PcmStream | null>();
  const cursors = new Map<string, TrackCursor>();
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
  let anchored = false;
  let loop: LoopRegion | null = null;

  function currentTime(): number {
    if (!anchored) return Math.min(durationSeconds, Math.max(0, originProject));
    return projectTimeAt({
      playing,
      originProject,
      originContext,
      now: output.now(),
      durationSeconds,
      loop,
    });
  }

  function disarmClock(): void {
    anchored = false;
    scheduledUntilContext = 0;
    cursors.clear();
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
      cursors.clear();
      loaded.clear();
      durationSeconds = project.project.durationSeconds;
      originProject = 0;
      cursorProject = 0;
      disarmClock();
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
      cursorProject = originProject;
      disarmClock();
      await engine.pump();
    },
    pause() {
      if (!playing) return;
      originProject = currentTime();
      playing = false;
      generation += 1;
      stopSources();
      disarmClock();
    },
    stop() {
      playing = false;
      generation += 1;
      stopSources();
      originProject = 0;
      cursorProject = 0;
      disarmClock();
    },
    seek(seconds) {
      const time = Math.min(durationSeconds, Math.max(0, seconds));
      originProject = time;
      cursorProject = time;
      generation += 1;
      stopSources();
      disarmClock();
      if (!playing) return;
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
      cursorProject = originProject;
      disarmClock();
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
        const windowSeconds = windowOverride ?? PLAYBACK_WINDOW_SECONDS;
        const lookaheadSeconds = lookaheadOverride ?? PLAYBACK_LOOKAHEAD_SECONDS;
        const outputRate = output.sampleRate();
        const clockWasAnchored = anchored;
        const planned = planCues({
          cursorContext: clockWasAnchored ? scheduledUntilContext : 0,
          cursorProject,
          untilContext: clockWasAnchored ? output.now() + lookaheadSeconds : lookaheadSeconds,
          windowSeconds,
          durationSeconds,
          loop,
        });
        const batch: Array<{ cue: (typeof planned.cues)[number]; slices: Array<{ trackId: string; channels: Float32Array[]; sampleRate: number }> }> = [];
        for (const cue of planned.cues) {
          if (stamp !== generation || !playing) return;
          const reads = await Promise.all(
            [...streams.entries()].map(async ([trackId, stream]) => {
              if (!stream) return null;
              const startFrame = Math.max(0, Math.round(cue.fileOffsetSeconds * stream.sampleRate));
              const inputFrames = Math.max(1, Math.round(cue.durationSeconds * stream.sampleRate));
              const outputFrames = Math.max(1, Math.round(cue.durationSeconds * outputRate));
              const channels = await stream.readFrames(startFrame, inputFrames);
              if (channels.length === 0 || channels[0]!.length === 0) return null;
              return { trackId, stream, startFrame, outputFrames, channels };
            }),
          );
          if (stamp !== generation || !playing) return;
          const slices: Array<{ trackId: string; channels: Float32Array[]; sampleRate: number }> = [];
          for (const read of reads) {
            if (!read) continue;
            let cursor = cursors.get(read.trackId);
            if (!cursor || cursor.frame !== read.startFrame) {
              cursor = { resampler: createStreamResampler(read.stream.sampleRate, outputRate), frame: read.startFrame };
              cursors.set(read.trackId, cursor);
            }
            const rendered = cursor.resampler.process(read.channels, read.outputFrames);
            cursor.frame = read.startFrame + (read.channels[0]?.length ?? 0);
            if (rendered.length === 0 || (rendered[0]?.length ?? 0) === 0) continue;
            slices.push({ trackId: read.trackId, channels: rendered, sampleRate: outputRate });
          }
          batch.push({ cue, slices });
        }
        if (stamp !== generation || !playing || batch.length === 0) return;
        if (!clockWasAnchored) {
          originContext = output.now() + PLAYBACK_START_DELAY_SECONDS - batch[0]!.cue.contextTime;
          anchored = true;
        }
        let shift = 0;
        const firstStart = clockWasAnchored ? batch[0]!.cue.contextTime : originContext + batch[0]!.cue.contextTime;
        const sounding = sources.some((source) => source.endContext > output.now());
        if (!sounding && firstStart < output.now() + PLAYBACK_START_DELAY_SECONDS) {
          shift = output.now() + PLAYBACK_START_DELAY_SECONDS - firstStart;
          originContext += shift;
        }
        for (const item of batch) {
          const startAt = (clockWasAnchored ? item.cue.contextTime : originContext + item.cue.contextTime) + shift;
          for (const slice of item.slices) {
            const handle = output.start({
              trackId: slice.trackId,
              channels: slice.channels,
              sampleRate: slice.sampleRate,
              contextTime: startAt,
              fileOffsetSeconds: item.cue.fileOffsetSeconds,
            });
            sources.push({ stop: handle.stop, endContext: startAt + item.cue.durationSeconds });
          }
          scheduledUntilContext = startAt + item.cue.durationSeconds;
          cursorProject = item.cue.fileOffsetSeconds + item.cue.durationSeconds;
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
