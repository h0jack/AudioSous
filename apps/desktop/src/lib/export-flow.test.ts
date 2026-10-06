import { planFullMix } from "@audiosous/mix-planner";
import { multiProblem } from "@audiosous/mix-planner/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopPlatform, ExportRequest, ExportStatus } from "../platform/types";
import { useAppStore } from "../state/app-store";
import { exportRequest, exportTaskPatch, LOUDNESS_PRESETS, openCandidate, openExportDialog, rateOptions, startExport, decideExport, STREAMING_NOTE } from "./export";
import { engineVariant } from "./full-mix";
import { taskActions } from "./tasks";

const NOW = "2026-10-06T00:00:00.000Z";

function status(patch: Partial<ExportStatus>): ExportStatus {
  return { jobId: 7, stage: "rendering", detail: "", framesDone: 0, framesTotal: 48_000 * 222, sampleRate: 48_000, analysis: null, plan: null, report: null, error: null, peakMemoryMb: null, ...patch };
}

const REPORT = {
  output: "/music/Night Drive.flac",
  format: "FLAC 24-bit",
  sampleRate: 48_000,
  bitDepth: 24,
  bitrateKbps: null,
  channels: 2,
  durationSeconds: 222,
  fileBytes: 40_000_000,
  integratedLufs: -13.9,
  truePeakDbtp: -1.0,
  samplePeakDbfs: -1.3,
  loudnessRangeLu: 6.1,
  mix: { integratedLufs: -19.2, loudnessRangeLu: 6.3, samplePeakDbfs: -4.1, truePeakDbtp: -3.9, maxMomentaryLufs: -12, maxShortTermLufs: -14, frames: 0, sampleRate: 48_000 },
  gainDb: 5.3,
  targetLufs: -14,
  ceilingDbtp: -1,
  limiter: { maxReductionDb: 2.4, shareOver1db: 0.02, shareOver3db: 0, meanActiveReductionDb: 0.8, activeShare: 0.06 },
  verification: ["✓ Decoded completely"],
  warnings: [],
  renderSeconds: 9.1,
  totalSeconds: 14.2,
  renderSpeed: 24.4,
};

function shell(sequence: ExportStatus[]) {
  const started: ExportRequest[] = [];
  let at = 0;
  const platform = {
    kind: "tauri",
    pickExportPath: vi.fn(async (name: string, extension: string) => `/music/${name}.${extension}`),
    startExport: vi.fn(async (_file: string, request: ExportRequest) => {
      started.push(request);
      return 7;
    }),
    exportStatus: vi.fn(async () => sequence[Math.min(at++, sequence.length - 1)]!),
    decideExport: vi.fn(async () => undefined),
    cancelExport: vi.fn(async () => undefined),
    revealExport: vi.fn(async () => undefined),
    mp3Available: vi.fn(async () => "LAME 3.100"),
    appendLog: vi.fn(async () => undefined),
  } as unknown as DesktopPlatform & { pickExportPath: ReturnType<typeof vi.fn>; startExport: ReturnType<typeof vi.fn>; decideExport: ReturnType<typeof vi.fn>; cancelExport: ReturnType<typeof vi.fn> };
  return { platform, started };
}

describe("export", () => {
  let song: ReturnType<typeof multiProblem>;
  beforeEach(() => {
    song = multiProblem();
    useAppStore.getState().openDocument(song.document, "/tmp/export-flow/project.amix", []);
    openExportDialog();
  });

  it("offers presets with their numbers, and never as platform requirements", () => {
    expect(LOUDNESS_PRESETS.balanced.target).toEqual({ mode: "target", integratedLufs: -14, ceilingDbtp: -1 });
    expect(LOUDNESS_PRESETS.loud.target).toEqual({ mode: "target", integratedLufs: -10, ceilingDbtp: -1 });
    expect(LOUDNESS_PRESETS.preserve.target.mode).toBe("preserve");
    expect(STREAMING_NOTE).toMatch(/not a guarantee/);
    for (const preset of Object.values(LOUDNESS_PRESETS)) expect(preset.note + preset.label).not.toMatch(/Spotify|Apple|YouTube|requires/i);
    expect(useAppStore.getState().exportJob).toMatchObject({ open: true, phase: "setup", preset: "balanced" });
  });

  it("offers the project's rate when it fits the format, and 44.1 or 48 kHz for MP3", () => {
    const document = { ...song.document, project: { ...song.document.project, sampleRate: 96_000 } };
    expect(rateOptions(document, { kind: "flac", bits: 24 })).toEqual([96_000, 44_100, 48_000]);
    expect(rateOptions(document, { kind: "mp3", quality: "cbr320" })).toEqual([44_100, 48_000]);
    const high = { ...song.document, project: { ...song.document.project, sampleRate: 192_000 } };
    expect(rateOptions(high, { kind: "wav", depth: "pcm24" })).toEqual([192_000, 44_100, 48_000]);
    expect(rateOptions(high, { kind: "flac", bits: 24 })).toEqual([96_000, 44_100, 48_000]);
  });

  it("exports the applied mix, not an open candidate, and says a candidate is open", async () => {
    const plan = planFullMix({ ...song, now: NOW });
    useAppStore.getState().setFullMix({ open: true, phase: "ready", plan, preview: true });
    expect(openCandidate(useAppStore.getState())).toBe("Full Mix candidate");
    const { platform, started } = shell([status({ stage: "done", report: REPORT })]);
    await startExport(platform, 0);
    expect(started).toHaveLength(1);
    expect(started[0]!.mix).toEqual(engineVariant("export", song.document));
    expect(started[0]!.tracks.map((track) => track.trackId)).toEqual(song.document.tracks.map((track) => track.id));
    expect(started[0]!.settings.loudness).toEqual({ mode: "target", integratedLufs: -14, ceilingDbtp: -1 });
    expect(exportRequest(song.document, started[0]!.settings, "/x.wav").durationSeconds).toBe(song.document.project.durationSeconds);
  });

  it("shows rendering, encoding, and verifying in the shared status, then completes with the file", async () => {
    const { platform } = shell([
      status({ stage: "rendering", framesDone: 48_000 * 84, framesTotal: 48_000 * 222 }),
      status({ stage: "analyzing" }),
      status({ stage: "encoding", framesDone: 48_000 * 100 }),
      status({ stage: "verifying" }),
      status({ stage: "done", report: REPORT }),
    ]);
    const seen: Array<{ label: string; detail: string | null; progress: number | null; stage: number | null }> = [];
    const stop = useAppStore.subscribe((state) => {
      const task = state.tasks.export;
      if (task && task.status === "running") seen.push({ label: task.label, detail: task.detail, progress: task.progress, stage: task.stage?.index ?? null });
    });
    await startExport(platform, 0);
    stop();
    expect(seen[0]).toMatchObject({ label: "Exporting WAV 24-bit", detail: "Rendering mix — 1:24 / 3:42", stage: 1 });
    expect(seen[0]!.progress).toBeCloseTo(84 / 222, 5);
    expect(seen.some((item) => item.detail === "Analyzing loudness" && item.progress === null)).toBe(true);
    expect(seen.some((item) => item.detail?.startsWith("Encoding WAV"))).toBe(true);
    expect(seen.some((item) => item.detail === "Verifying output" && item.stage === 5)).toBe(true);
    const state = useAppStore.getState();
    expect(state.tasks.export).toMatchObject({ status: "complete", completionNote: "Export completed — Night Drive.flac" });
    expect(state.exportJob).toMatchObject({ phase: "done", report: REPORT });
  });

  it("stops for heavy limiting and passes the choice on", async () => {
    const plan = { gainDb: 14, ceilingDbtp: -1, targetLufs: -9, estimatedMaxReductionDb: 8.5, estimatedShareOver1db: 0.3, estimatedShareOver3db: 0.12, limitingNeeded: true, heavy: true, saferTargetLufs: -13.2 };
    const { platform } = shell([status({ stage: "deciding", plan })]);
    const running = startExport(platform, 0);
    for (let tick = 0; tick < 50 && useAppStore.getState().exportJob?.phase !== "deciding"; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAppStore.getState().exportJob).toMatchObject({ phase: "deciding", plan });
    expect(useAppStore.getState().tasks.export?.detail).toMatch(/heavy limiting/);
    await decideExport("safer", platform);
    expect(platform.decideExport).toHaveBeenCalledWith(7, "safer");
    useAppStore.getState().setExportJob({ jobId: null });
    await running;
  });

  it("cancels from the status bar and is not available while playback audio is prepared", async () => {
    const { platform } = shell([status({ stage: "rendering" }), status({ stage: "cancelled" })]);
    await startExport(platform, 0);
    taskActions("export").cancel?.();
    await Promise.resolve();
    expect(platform.cancelExport).toHaveBeenCalledWith(7);
    expect(useAppStore.getState().exportJob?.phase).toBe("cancelled");
    expect(useAppStore.getState().tasks.export).toBeUndefined();
    useAppStore.getState().setExportJob({ phase: "setup", jobId: null });
    useAppStore.getState().setTask({ id: "playback-proxy", kind: "playback-proxy", label: "Preparing", detail: "3 of 6 stems ready", blocks: ["playback", "export"] });
    const blocked = shell([]);
    await startExport(blocked.platform, 0);
    expect(blocked.platform.startExport).not.toHaveBeenCalled();
    expect(useAppStore.getState().exportJob?.error).toBe("Preparing playback — 3 of 6 stems ready");
  });

  it("states failures plainly", () => {
    expect(exportTaskPatch(status({ stage: "failed", error: "A stem is missing: Pad.wav." }), { kind: "flac", bits: 24 })).toMatchObject({ status: "failed", error: "A stem is missing: Pad.wav." });
  });
});
