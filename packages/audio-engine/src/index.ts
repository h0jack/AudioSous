import type { ProjectDocument } from "@audiosous/project-model";
import type { LoopRegion } from "./transport";

export const AUDIO_ENGINE_INTERFACE_VERSION = 1;

export interface PcmStream {
  sampleRate: number;
  channelCount: number;
  readFrames(frameOffset: number, frameCount: number): Promise<Float32Array[]>;
}

/** Turns a bundle-relative media path into media the shell has already checked. */
export interface MediaResolver {
  resolve(relativePath: string): string;
  open?(relativePath: string): Promise<PcmStream | null>;
}

export type { LoopRegion };

/**
 * One transport clock for every stem.
 * Pan is -1 (full left) through 0 (center) to +1 (right).
 * Gain is decibels.
 *
 * Implementations schedule every stem from the same clock.
 * They must not start independent media elements, and they must not
 * decode every stem into a full in-memory buffer for a long session.
 */
export interface AudioEngine {
  loadProject(project: ProjectDocument, media: MediaResolver): Promise<void>;
  play(startTime?: number): Promise<void>;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  setTrackGain(trackId: string, gainDb: number): void;
  setTrackPan(trackId: string, pan: number): void;
  setMute(trackId: string, muted: boolean): void;
  setSolo(trackId: string, solo: boolean): void;
  setLoop(region: LoopRegion | null): void;
  /** Section gain windows. Empty clears them. The native engine follows the playhead; other engines may ignore this. */
  setGainRegions?(regions: Array<{ trackId: string; startSeconds: number; endSeconds: number; gainDb: number }>): void;
  getCurrentTime(): number;
  getDuration(): number;
  dispose(): void;
}

export { createStreamingEngine } from "./streaming";
export type { AudioOutput, ScheduledSlice, StreamingEngine } from "./streaming";
export {
  PLAYBACK_LOOKAHEAD_SECONDS,
  PLAYBACK_START_DELAY_SECONDS,
  PLAYBACK_WINDOW_SECONDS,
  gainLinear,
  planCues,
  projectTimeAt,
  trackIsAudible,
} from "./transport";

export function createUnboundAudioEngine(): AudioEngine {
  const unavailable = (): never => {
    throw new Error("Synchronized playback is not connected yet.");
  };
  return {
    loadProject: async () => unavailable(),
    play: async () => unavailable(),
    pause: unavailable,
    stop: unavailable,
    seek: unavailable,
    setTrackGain: unavailable,
    setTrackPan: unavailable,
    setMute: unavailable,
    setSolo: unavailable,
    setLoop: unavailable,
    getCurrentTime: () => 0,
    getDuration: () => 0,
    dispose() {},
  };
}
