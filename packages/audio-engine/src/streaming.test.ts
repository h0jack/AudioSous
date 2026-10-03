import { createProject, projectDocumentSchema } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import type { AudioOutput, ScheduledSlice } from "./streaming";
import { createStreamingEngine } from "./streaming";
import { planCues } from "./transport";
import type { PcmStream } from "./index";

function project() {
  return createProject({
    id: "project-clock",
    name: "Clock",
    tracks: [
      track("kick", "kick"),
      track("bass", "bass"),
    ],
  });
}

function track(id: string, role: "kick" | "bass") {
  return {
    id,
    name: id,
    role,
    relativePath: `media/${id}.wav`,
    filename: `${id}.wav`,
    metadata: {
      format: "wav" as const,
      sampleRate: 48_000,
      channelCount: 1,
      bitDepth: 16,
      durationSeconds: 10,
      fileSizeBytes: 96_000,
    },
  };
}

function stream(requests: number[]): PcmStream {
  return {
    sampleRate: 48_000,
    channelCount: 1,
    async readFrames(_offset, frameCount) {
      requests.push(frameCount);
      return [new Float32Array(frameCount).fill(0.2)];
    },
  };
}

function fakeOutput() {
  const gains = new Map<string, number>();
  const starts: ScheduledSlice[] = [];
  let stopped = 0;
  const output: AudioOutput & { time: number; gains: Map<string, number>; starts: ScheduledSlice[]; stopped: () => number } = {
    time: 0,
    gains,
    starts,
    stopped: () => stopped,
    now() {
      return this.time;
    },
    async resume() {},
    prepareTrack() {},
    setGain(trackId, linear) {
      gains.set(trackId, linear);
    },
    setPan() {},
    start(slice) {
      starts.push(slice);
      return {
        stop() {
          stopped += 1;
        },
      };
    },
    close() {},
  };
  return output;
}

describe("playback cues", () => {
  it("shares windows and stops at the end of the song", () => {
    const planned = planCues({
      cursorContext: 0,
      cursorProject: 0,
      untilContext: 1,
      windowSeconds: 0.5,
      durationSeconds: 10,
      loop: null,
    });
    expect(planned.cues.map((cue) => cue.fileOffsetSeconds)).toEqual([0, 0.5]);
    const ending = planCues({
      cursorContext: 0,
      cursorProject: 9.8,
      untilContext: 2,
      windowSeconds: 0.5,
      durationSeconds: 10,
      loop: null,
    });
    expect(ending.cues).toHaveLength(1);
    expect(ending.cues[0]?.durationSeconds).toBeCloseTo(0.2, 5);
  });

  it("plays up to a loop end, then continues from the loop start", () => {
    const planned = planCues({
      cursorContext: 5,
      cursorProject: 9.6,
      untilContext: 5.9,
      windowSeconds: 0.5,
      durationSeconds: 30,
      loop: { startSeconds: 8, endSeconds: 10 },
    });
    expect(planned.cues.map((cue) => Number(cue.fileOffsetSeconds.toFixed(3)))).toEqual([9.6, 8]);
    expect(planned.cues[0]?.durationSeconds).toBeCloseTo(0.4, 5);
    expect(planned.cues[1]?.contextTime).toBeCloseTo(5.4, 5);
  });
});

describe("streaming engine", () => {
  it("schedules every stem on the same clock without reading the whole file", async () => {
    const output = fakeOutput();
    const requests: number[] = [];
    const engine = createStreamingEngine(output, { windowSeconds: 0.5, lookaheadSeconds: 1 });
    await engine.loadProject(project(), {
      resolve: (path) => path,
      open: async () => stream(requests),
    });
    await engine.play(0);
    const kick = output.starts.filter((slice) => slice.trackId === "kick");
    const bass = output.starts.filter((slice) => slice.trackId === "bass");
    expect(kick.map((slice) => slice.contextTime)).toEqual(bass.map((slice) => slice.contextTime));
    expect(kick.map((slice) => slice.fileOffsetSeconds)).toEqual([0, 0.5]);
    expect(Math.max(...requests)).toBeLessThanOrEqual(48_000 * 0.5);
    output.time = 1.08;
    expect(engine.getCurrentTime()).toBeCloseTo(1, 5);
    engine.pause();
    output.time = 5;
    expect(engine.getCurrentTime()).toBeCloseTo(1, 5);
    engine.dispose();
  });

  it("restarts every stem together after a seek", async () => {
    const output = fakeOutput();
    const engine = createStreamingEngine(output, { windowSeconds: 0.5, lookaheadSeconds: 0.5 });
    await engine.loadProject(project(), {
      resolve: (path) => path,
      open: async () => stream([]),
    });
    await engine.play(0);
    const started = output.starts.length;
    engine.seek(4);
    for (let step = 0; step < 6; step += 1) await Promise.resolve();
    expect(output.stopped()).toBeGreaterThan(0);
    const after = output.starts.slice(started);
    expect(after).toHaveLength(2);
    expect(after.every((slice) => slice.fileOffsetSeconds === 4)).toBe(true);
    expect(new Set(after.map((slice) => slice.trackId)).size).toBe(2);
    engine.dispose();
  });

  it("schedules 32 stems from one window instead of the whole file", async () => {
    const output = fakeOutput();
    const requests: number[] = [];
    const wide = createProject({
      id: "project-wide",
      name: "Wide",
      tracks: Array.from({ length: 32 }, (_, index) => track(`stem-${index}`, index % 2 === 0 ? "kick" : "bass")),
    });
    wide.project.durationSeconds = 600;
    for (const item of wide.tracks) item.metadata.durationSeconds = 600;
    expect(projectDocumentSchema.safeParse(wide).success).toBe(true);
    const engine = createStreamingEngine(output, { windowSeconds: 0.5, lookaheadSeconds: 0.5 });
    await engine.loadProject(wide, {
      resolve: (path) => path,
      open: async () => stream(requests),
    });
    await engine.play(0);
    expect(output.starts).toHaveLength(32);
    expect(new Set(output.starts.map((slice) => slice.contextTime)).size).toBe(1);
    expect(Math.max(...requests)).toBeLessThanOrEqual(48_000 * 0.5);
    expect(requests.reduce((sum, frames) => sum + frames, 0)).toBeLessThan(48_000 * 0.5 * 32 + 1);
    engine.dispose();
  });

  it("mutes a track and solos without changing the clock", async () => {
    const output = fakeOutput();
    const engine = createStreamingEngine(output, { windowSeconds: 0.5, lookaheadSeconds: 0.5 });
    await engine.loadProject(project(), {
      resolve: (path) => path,
      open: async () => stream([]),
    });
    engine.setMute("kick", true);
    expect(output.gains.get("kick")).toBe(0);
    expect(output.gains.get("bass")).toBeCloseTo(1, 5);
    engine.setMute("kick", false);
    engine.setSolo("bass", true);
    expect(output.gains.get("kick")).toBe(0);
    expect(output.gains.get("bass")).toBeCloseTo(1, 5);
    engine.dispose();
  });
});
