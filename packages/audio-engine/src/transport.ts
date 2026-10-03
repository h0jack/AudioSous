export const PLAYBACK_WINDOW_SECONDS = 0.75;
export const PLAYBACK_LOOKAHEAD_SECONDS = 1.5;
export const PLAYBACK_START_DELAY_SECONDS = 0.08;

export interface PlaybackCue {
  contextTime: number;
  fileOffsetSeconds: number;
  durationSeconds: number;
}

export interface LoopRegion {
  startSeconds: number;
  endSeconds: number;
}

const EPSILON = 1e-4;

/**
 * Windows of audio to place on one clock.
 * A loop splits a window at its end and continues at the loop start.
 * Audio before the loop still plays; the wrap happens when the cursor reaches the loop end.
 */
export function planCues(input: {
  cursorContext: number;
  cursorProject: number;
  untilContext: number;
  windowSeconds: number;
  durationSeconds: number;
  loop: LoopRegion | null;
}): { cues: PlaybackCue[]; cursorContext: number; cursorProject: number } {
  const cues: PlaybackCue[] = [];
  let context = input.cursorContext;
  let project = input.cursorProject;
  const loop = validLoop(input.loop);
  let guard = 0;
  while (context < input.untilContext - EPSILON && guard < 64) {
    guard += 1;
    if (loop && project >= loop.endSeconds - EPSILON) project = loop.startSeconds;
    const segmentEnd = loop && project < loop.endSeconds ? loop.endSeconds : input.durationSeconds;
    const remaining = segmentEnd - project;
    if (remaining <= EPSILON) break;
    const take = Math.min(input.windowSeconds, remaining, input.untilContext - context);
    if (take <= EPSILON) break;
    cues.push({ contextTime: context, fileOffsetSeconds: project, durationSeconds: take });
    context += take;
    project += take;
  }
  return { cues, cursorContext: context, cursorProject: project };
}

export function validLoop(loop: LoopRegion | null): LoopRegion | null {
  if (!loop) return null;
  if (!(loop.endSeconds > loop.startSeconds)) return null;
  return loop;
}

export function gainLinear(gainDb: number): number {
  return 10 ** (gainDb / 20);
}

/** Mute wins. Solo silences every track that is not soloed. */
export function trackIsAudible(muted: boolean, solo: boolean, anySolo: boolean): boolean {
  if (muted) return false;
  if (anySolo && !solo) return false;
  return true;
}

export function projectTimeAt(input: {
  playing: boolean;
  originProject: number;
  originContext: number;
  now: number;
  durationSeconds: number;
  loop: LoopRegion | null;
}): number {
  const loop = validLoop(input.loop);
  const clamp = (time: number) => Math.min(input.durationSeconds, Math.max(0, time));
  if (!input.playing) return clamp(input.originProject);
  const elapsed = input.now - input.originContext;
  if (elapsed <= 0) return clamp(input.originProject);
  let time = input.originProject + elapsed;
  if (loop && time >= loop.endSeconds) {
    const span = loop.endSeconds - loop.startSeconds;
    const past = time - loop.startSeconds;
    time = loop.startSeconds + (past % span);
  }
  if (!loop) return clamp(time);
  return time;
}
