import { beforeEach, describe, expect, it, vi } from "vitest";
import { idleAssistant, idleEq, useAppStore } from "../state/app-store";
import { proxyTaskPatch, waveformTaskPatch } from "./preparation";
import { bannerTask, gate, progressText, registerTaskActions, taskActions, upsertTask, type ProcessingTask } from "./tasks";

type ProxyTracks = Parameters<typeof proxyTaskPatch>[0]["proxyTracks"];

function engine(ready: number, total: number, tracks?: ProxyTracks) {
  const proxyTracks: ProxyTracks =
    tracks ??
    Array.from({ length: total }, (_, index) => ({ id: `t${index}`, label: `Stem ${index}.wav`, state: index < ready ? "ready" : index === ready ? "building" : "queued", percent: index < ready ? 100 : index === ready ? 50 : 0, error: "" }));
  return { proxyReadyTracks: ready, proxyTotalTracks: total, proxyTracks };
}

const names = (id: string) => `Stem ${id.slice(1)}`;

function tasksWith(...patches: Array<Parameters<typeof upsertTask>[1]>): Record<string, ProcessingTask> {
  return patches.reduce<Record<string, ProcessingTask>>((tasks, patch) => upsertTask(tasks, patch, 1_000), {});
}

describe("playback readiness", () => {
  it("blocks Play while playback audio is being prepared, and says why", () => {
    const tasks = tasksWith(proxyTaskPatch(engine(8, 11), names)!);
    const playback = gate(tasks, "playback");
    expect(playback.blocked).toBe(true);
    expect(playback.reason).toBe("Preparing playback — 8 of 11 stems ready");
    expect(tasks["playback-proxy"]!.progress).toBeCloseTo((8 + 0.5) / 11, 5);
    expect(tasks["playback-proxy"]!.steps.map((step) => step.status)).toEqual([...Array(8).fill("done"), "running", "pending", "pending"]);
  });

  it("enables Play when every stem is ready and leaves a short note", () => {
    let tasks = tasksWith(proxyTaskPatch(engine(10, 11), names)!);
    tasks = upsertTask(tasks, proxyTaskPatch(engine(11, 11), names)!, 2_000);
    expect(gate(tasks, "playback").blocked).toBe(false);
    expect(bannerTask(tasks, 3_000)?.completionNote).toBe("Project ready — 11 tracks prepared");
    expect(bannerTask(tasks, 9_000)).toBeNull();
  });

  it("does not block Play for analysis, a planner, or the assistant", () => {
    const tasks = tasksWith(
      { id: "analysis", kind: "analysis", label: "Analyzing audio", blocks: [] },
      { id: "eq-plan", kind: "eq-plan", label: "EQ: Checking frequency interactions", blocks: [] },
      { id: "assistant", kind: "assistant", label: "Assistant", blocks: [], major: true },
    );
    expect(gate(tasks, "playback").blocked).toBe(false);
    expect(bannerTask(tasks, 1_000)?.kind).toBe("assistant");
  });

  it("keeps Play off after a stem fails, names it, and offers retry", () => {
    const failed = engine(10, 11, [
      ...Array.from({ length: 10 }, (_, index) => ({ id: `t${index}`, label: `Stem ${index}.wav`, state: "ready" as const, percent: 100, error: "" })),
      { id: "t10", label: "Phase Plant 2.wav", state: "failed", percent: 0, error: "Could not open Phase Plant 2.wav" },
    ]);
    const tasks = tasksWith(proxyTaskPatch(failed, (id) => (id === "t10" ? "Phase Plant 2" : names(id)))!);
    const playback = gate(tasks, "playback");
    expect(playback.blocked).toBe(true);
    expect(playback.reason).toContain("Playback preparation failed for Phase Plant 2");
    expect(bannerTask(tasks, 1_000)?.status).toBe("failed");
    const retry = vi.fn();
    registerTaskActions("playback-proxy", { retry });
    taskActions("playback-proxy").retry?.();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("blocks export while preparing but not planning", () => {
    const tasks = tasksWith(proxyTaskPatch(engine(3, 11), names)!);
    expect(gate(tasks, "export").blocked).toBe(true);
    expect(gate(tasks, "planning").blocked).toBe(false);
  });
});

describe("the banner", () => {
  it("shows blocking preparation over a planner and a failure over both", () => {
    let tasks = tasksWith({ id: "eq-plan", kind: "eq-plan", label: "EQ", blocks: [] }, proxyTaskPatch(engine(1, 4), names)!);
    expect(bannerTask(tasks, 1_000)?.kind).toBe("playback-proxy");
    tasks = upsertTask(tasks, { id: "export", kind: "export", label: "Exporting FLAC", status: "failed", error: "Disk full" }, 1_000);
    expect(bannerTask(tasks, 1_000)?.id).toBe("export");
  });

  it("disappears when the work is done", () => {
    let tasks = tasksWith({ id: "eq-plan", kind: "eq-plan", label: "EQ", blocks: [] });
    tasks = upsertTask(tasks, { id: "eq-plan", kind: "eq-plan", status: "complete" }, 2_000);
    expect(bannerTask(tasks, 2_500)).toBeNull();
  });

  it("uses real numbers or stages, never invented percentages", () => {
    const [staged, measured, neither] = Object.values(
      tasksWith(
        { id: "a", kind: "auto-mix", label: "Auto Mix", stage: { index: 4, count: 7 } },
        { id: "b", kind: "export", label: "Export", progress: 0.38 },
        { id: "c", kind: "assistant", label: "Assistant" },
      ),
    );
    expect(progressText(staged!)).toBe("Stage 4 of 7");
    expect(progressText(measured!)).toBe("38%");
    expect(progressText(neither!)).toBeNull();
  });
});

describe("preparation stages", () => {
  it("measures waveforms as a blocking stage with per-stem steps", () => {
    const patch = waveformTaskPatch({ index: 2, total: 4, filename: "Pad.wav", fileRatio: 0.5 }, ["Kick", "Bass", "Pad", "Lead"])!;
    expect(patch.detail).toBe("Measuring waveforms — 3 of 4: Pad.wav");
    expect(patch.progress).toBeCloseTo(2.5 / 4, 5);
    expect(patch.blocks).toContain("playback");
    expect(patch.steps!.map((step) => step.status)).toEqual(["done", "done", "running", "pending"]);
    expect(waveformTaskPatch(null, [])).toBeNull();
    expect(waveformTaskPatch(null, [], "Waveforms could not be measured.")!.blocks).toEqual([]);
  });
});

describe("the store publishes planners and the assistant", () => {
  beforeEach(() => {
    useAppStore.setState({ tasks: {}, eq: idleEq(), assistant: idleAssistant() });
  });

  it("follows a planner from running to failed to idle", () => {
    const store = useAppStore.getState();
    store.setEq({ phase: "analyzing", progress: "Analyzing 3 of 11: Kick" });
    expect(useAppStore.getState().tasks["eq-plan"]).toMatchObject({ status: "running", label: "EQ: Checking frequency interactions", detail: "Analyzing 3 of 11: Kick" });
    store.setEq({ phase: "failed", progress: null, error: "The project changed while EQ was planning. Run it again." });
    expect(useAppStore.getState().tasks["eq-plan"]).toMatchObject({ status: "failed", retryable: true });
    store.setEq({ phase: "idle" });
    expect(useAppStore.getState().tasks["eq-plan"]).toBeUndefined();
  });

  it("shows the assistant's step while it works", () => {
    useAppStore.getState().setAssistant({ busy: true, activity: "Building Chorus candidate" });
    expect(useAppStore.getState().tasks.assistant).toMatchObject({ status: "running", detail: "Building Chorus candidate", major: true });
    useAppStore.getState().setAssistant({ busy: false, activity: null });
    expect(useAppStore.getState().tasks.assistant).toBeUndefined();
  });
});
