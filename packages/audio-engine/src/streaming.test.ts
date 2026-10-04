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
    sampleRate() {
      return 48_000;
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

  it("keeps the playhead on the first audio when reading it takes longer than the clock", async () => {
    const output = fakeOutput();
    const engine = createStreamingEngine(output, { windowSeconds: 0.5, lookaheadSeconds: 0.5 });
    await engine.loadProject(project(), {
      resolve: (path) => path,
      open: async () => ({
        sampleRate: 48_000,
        channelCount: 1,
        async readFrames(_offset, frameCount) {
          output.time += 3;
          return [new Float32Array(frameCount).fill(0.2)];
        },
      }),
    });
    await engine.play(0);
    expect(output.time).toBeGreaterThan(2);
    expect(output.starts.length).toBe(2);
    expect(output.starts.every((slice) => slice.fileOffsetSeconds === 0)).toBe(true);
    expect(output.starts.every((slice) => slice.contextTime > output.time)).toBe(true);
    expect(engine.getCurrentTime()).toBeLessThan(0.2);
    engine.dispose();
  });

  it("plays 192 kHz stems at the output rate", async () => {
    const output = fakeOutput();
    const requests: number[] = [];
    const engine = createStreamingEngine(output, { windowSeconds: 0.5, lookaheadSeconds: 0.5 });
    await engine.loadProject(project(), {
      resolve: (path) => path,
      open: async () => ({
        sampleRate: 192_000,
        channelCount: 1,
        async readFrames(_offset, frameCount) {
          requests.push(frameCount);
          return [new Float32Array(frameCount).fill(0.25)];
        },
      }),
    });
    await engine.play(0);
    const rendered = output.starts[0]?.channels[0];
    expect(output.starts.every((slice) => slice.sampleRate === 48_000)).toBe(true);
    expect(rendered?.length).toBeGreaterThan(10_000);
    expect(Math.max(...requests) / (rendered?.length ?? 1)).toBeCloseTo(4, 0);
    expect(rendered?.[Math.floor((rendered?.length ?? 0) / 2)]).toBeCloseTo(0.25, 1);
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

  it("schedules 32 stems of a 10 minute song from one window instead of the whole file", async () => {
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

  it("plays 32 stereo stems for several seconds without reading a 10 minute song", async () => {
    const sampleRate = 48_000;
    const windowSeconds = 0.5;
    let maxFrames = 0;
    let totalFrames = 0;
    const starts: Array<{ trackId: string; contextTime: number; fileOffsetSeconds: number; frames: number; channels: number; sample: number }> = [];
    const output: AudioOutput & { time: number } = {
      time: 0,
      now() {
        return this.time;
      },
      sampleRate() {
        return sampleRate;
      },
      async resume() {},
      prepareTrack() {},
      setGain() {},
      setPan() {},
      start(slice) {
        const frames = slice.channels[0]?.length ?? 0;
        starts.push({
          trackId: slice.trackId,
          contextTime: slice.contextTime,
          fileOffsetSeconds: slice.fileOffsetSeconds,
          frames,
          channels: slice.channels.length,
          sample: slice.channels[0]?.[0] ?? 0,
        });
        return { stop() {} };
      },
      close() {},
    };
    const wide = createProject({
      id: "project-stress",
      name: "Stress",
      tracks: Array.from({ length: 32 }, (_, index) => ({
        ...track(`stem-${index}`, index % 2 === 0 ? "kick" : "bass"),
        metadata: {
          format: "wav" as const,
          sampleRate,
          channelCount: 2,
          bitDepth: 24,
          durationSeconds: 600,
          fileSizeBytes: sampleRate * 600 * 2 * 3,
        },
      })),
    });
    wide.project.durationSeconds = 600;
    const engine = createStreamingEngine(output, { windowSeconds, lookaheadSeconds: 1.5 });
    const startedAt = Date.now();
    await engine.loadProject(wide, {
      resolve: (path) => path,
      open: async () => ({
        sampleRate,
        channelCount: 2,
        async readFrames(offset, frameCount) {
          maxFrames = Math.max(maxFrames, frameCount);
          totalFrames += frameCount;
          const left = new Float32Array(frameCount);
          const right = new Float32Array(frameCount);
          for (let index = 0; index < frameCount; index += 8) {
            const sample = (((offset + index) % 200) - 100) / 500;
            left[index] = sample;
            right[index] = -sample;
          }
          return [left, right];
        },
      }),
    });
    await engine.play(30);
    output.time = 3;
    await engine.pump();
    output.time = 6;
    await engine.pump();
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(starts.length).toBeGreaterThan(32);
    expect(maxFrames).toBeLessThanOrEqual(sampleRate * windowSeconds);
    expect(totalFrames).toBeLessThan(32 * sampleRate * 10);
    expect(starts.every((slice) => slice.channels === 2 && slice.frames > 0)).toBe(true);
    expect(starts.some((slice) => slice.sample !== 0)).toBe(true);
    expect(Math.min(...starts.map((slice) => slice.fileOffsetSeconds))).toBeGreaterThanOrEqual(30);
    const byTime = new Map<number, Set<string>>();
    for (const slice of starts) {
      const key = Number(slice.contextTime.toFixed(3));
      const tracks = byTime.get(key) ?? new Set<string>();
      tracks.add(slice.trackId);
      byTime.set(key, tracks);
    }
    expect([...byTime.values()].every((tracks) => tracks.size === 32)).toBe(true);
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
