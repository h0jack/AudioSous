import type { AudioEngine, LoopRegion } from "@audiosous/audio-engine";
import type { ProjectDocument } from "@audiosous/project-model";
import { invoke } from "@tauri-apps/api/core";

export interface NativeEngineStatus {
  state: "stopped" | "priming" | "playing" | "paused";
  positionSeconds: number;
  durationSeconds: number;
  outputSampleRate: number;
  callbackFrames: number;
  activeTracks: number;
  proxyReadyTracks: number;
  proxyTotalTracks: number;
  bufferedAheadMin: number;
  bufferedAheadAvg: number;
  underruns: number;
  lastUnderrunTrack: string;
  readerBacklog: number;
  seekPrimeMs: number;
  callbackMs: number;
  callbackBudgetMs: number;
  deviceFormat: string;
  proxyPercent: number;
  message: string;
}

export interface NativeAudioEngine extends AudioEngine {
  poll(): Promise<NativeEngineStatus>;
}

export function audioEngineKind(): Promise<"native" | "legacy"> {
  return invoke<"native" | "legacy">("audio_engine_kind");
}

export function createNativeAudioEngine(projectFile: string): NativeAudioEngine {
  let position = 0;
  let duration = 0;
  return {
    async loadProject(project: ProjectDocument) {
      duration = project.project.durationSeconds;
      position = project.uiState.playheadSeconds;
      await invoke("audio_load", {
        request: {
          projectFile,
          tracks: project.tracks.map((track) => ({
            id: track.id,
            label: track.file.filename,
            relativePath: track.file.relativePath,
            gainDb: track.gainDb,
            pan: track.pan,
            muted: track.muted,
            solo: track.solo,
          })),
        },
      });
    },
    async play(startTime?: number) {
      const seconds = startTime ?? position;
      await invoke("audio_play", { seconds });
      const status = await this.poll();
      position = status.positionSeconds;
      if (status.state === "stopped" && status.message) {
        throw new Error(status.message);
      }
    },
    pause() {
      void invoke("audio_pause");
    },
    stop() {
      position = 0;
      void invoke("audio_stop");
    },
    seek(seconds: number) {
      position = seconds;
      void invoke("audio_seek", { seconds });
    },
    setTrackGain(trackId: string, gainDb: number) {
      void invoke("audio_set_track", { track: { id: trackId, gainDb, pan: null, muted: null, solo: null } });
    },
    setTrackPan(trackId: string, pan: number) {
      void invoke("audio_set_track", { track: { id: trackId, gainDb: null, pan, muted: null, solo: null } });
    },
    setMute(trackId: string, muted: boolean) {
      void invoke("audio_set_track", { track: { id: trackId, gainDb: null, pan: null, muted, solo: null } });
    },
    setSolo(trackId: string, solo: boolean) {
      void invoke("audio_set_track", { track: { id: trackId, gainDb: null, pan: null, muted: null, solo } });
    },
    setLoop(region: LoopRegion | null) {
      void invoke("audio_set_loop", {
        start: region?.startSeconds ?? null,
        end: region?.endSeconds ?? null,
      });
    },
    setGainRegions(regions) {
      void invoke("audio_set_gain_regions", {
        regions: regions.map((region) => ({
          trackId: region.trackId,
          startSeconds: region.startSeconds,
          endSeconds: region.endSeconds,
          gainDb: region.gainDb,
        })),
      });
    },
    setTrackEq(tracks) {
      void invoke("audio_set_eq", { tracks });
    },
    getCurrentTime() {
      return position;
    },
    getDuration() {
      return duration;
    },
    dispose() {
      void invoke("audio_stop");
    },
    async poll() {
      const status = await invoke<NativeEngineStatus>("audio_status");
      if (status.state === "playing" || status.state === "priming") position = status.positionSeconds;
      return status;
    },
  };
}
