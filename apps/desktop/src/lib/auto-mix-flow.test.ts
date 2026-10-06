import { changeIncluded, planFullMix, type FullMixPlan } from "@audiosous/mix-planner";
import { fixtureG, multiProblem } from "@audiosous/mix-planner/testing";
import { updateTrack } from "@audiosous/project-model";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../state/app-store";
import { applyAutoMix, autoMixButtonState, autoMixSummaryLines, cancelAutoMix, discardAutoMix, runAutoMix, type AutoMixDeps } from "./auto-mix";
import type { LoadMixInputsOptions } from "./full-mix";
import { monitorState } from "./monitor";

const NOW = "2026-10-06T00:00:00.000Z";
type Song = ReturnType<typeof multiProblem>;

/** The real planner on the fixture's inputs; only the desktop's loading and render check are replaced. */
function deps(song: Song, overrides: Partial<AutoMixDeps> = {}) {
  const calls = { load: 0, stages: [] as string[] };
  const value: AutoMixDeps = {
    waitForAudio: async () => ({ ok: true }),
    loadInputs: async (_document, options: LoadMixInputsOptions) => {
      calls.load += 1;
      for (const stage of ["levels", "frequency", "space", "dynamics", "peak"] as const) {
        options.stage?.(stage, "running");
        calls.stages.push(stage);
        options.stage?.(stage, "done");
      }
      return { measurements: song.measurements, bands: song.bands, stereo: song.stereo, envelopes: song.envelopes, fingerprints: [], mixPeakDbfs: null };
    },
    plan: async (input) => planFullMix({ ...input, now: NOW }),
    check: async () => null,
    now: () => 0,
    ...overrides,
  };
  return { value, calls };
}

function mix(document: ReturnType<typeof useAppStore.getState>["document"]) {
  return JSON.stringify({ tracks: document!.tracks, sections: document!.sections, rows: document!.sectionTrackSettings });
}

function withoutTime(plan: FullMixPlan) {
  return JSON.stringify({ ...plan, createdAt: "" });
}

describe("Auto Mix", () => {
  let song: Song;

  beforeEach(() => {
    song = multiProblem();
    useAppStore.getState().openDocument(song.document, "/tmp/auto-mix-flow/project.amix", []);
  });

  it("gathers the evidence in order, then lets Full Mix decide: the result is the Full Mix plan", async () => {
    const { value, calls } = deps(song);
    await runAutoMix({}, value);
    const state = useAppStore.getState();
    expect(calls.stages).toEqual(["levels", "frequency", "space", "dynamics", "peak"]);
    expect(state.autoMix.phase).toBe("ready");
    expect(state.autoMix.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ["prepare", "done"],
      ["levels", "done"],
      ["frequency", "done"],
      ["space", "done"],
      ["dynamics", "done"],
      ["plan", "done"],
      ["verify", "skipped"],
    ]);
    // Exactly what running Full Mix on the same saved project gives: Auto Mix adds no decisions of its own.
    const manual = planFullMix({ ...song, settings: state.fullMix.settings, fingerprints: [], mixPeakDbfs: null, now: NOW });
    expect(withoutTime(state.fullMix.plan!)).toBe(withoutTime(manual));
    expect(state.planTab).toBe("full");
    expect(state.tasks["auto-mix"]).toMatchObject({ status: "complete" });
  });

  it("keeps fewer changes than the planners would on their own and says what it left out", async () => {
    await runAutoMix({}, deps(song).value);
    const { fullMix, autoMix } = useAppStore.getState();
    const kept = fullMix.plan!.changes.filter((change) => changeIncluded(change, "preview") && change.processing.type !== "trim").length;
    expect(kept).toBeLessThan(fullMix.plan!.evaluation.independent.total);
    const summary = autoMix.summary!;
    expect(summary.changeCount).toBe(kept);
    expect(summary.omitted).toBe(fullMix.plan!.evaluation.independent.total - kept);
    expect(summary.tracks).toBe(song.document.tracks.length);
    const lines = autoMixSummaryLines(summary);
    expect(lines.omitted).toMatch(/lower-value or redundant recommendations? from the individual planners/);
    expect(lines.detected.join(" ")).toMatch(/issue|interaction/);
  });

  it("previews without writing; Apply writes everything in one undo step", async () => {
    await runAutoMix({}, deps(song).value);
    expect(mix(useAppStore.getState().document)).toBe(mix(song.document));
    expect(useAppStore.getState().dirty).toBe(false);
    expect(useAppStore.getState().history.past).toHaveLength(0);
    expect(autoMixButtonState(useAppStore.getState())).toBe("ready");
    expect(applyAutoMix()).toBe(true);
    const applied = useAppStore.getState().document!;
    expect(mix(applied)).not.toBe(mix(song.document));
    expect(useAppStore.getState().history.past).toHaveLength(1);
    useAppStore.getState().undo();
    expect(mix(useAppStore.getState().document)).toBe(mix(song.document));
  });

  it("cancels: the work in flight is dropped, nothing is shown or saved", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { value } = deps(song, {
      loadInputs: async (_document, options) => {
        options.stage?.("levels", "running");
        await gate;
        return { measurements: song.measurements, bands: song.bands, stereo: song.stereo, envelopes: song.envelopes, fingerprints: [], mixPeakDbfs: null };
      },
    });
    const running = runAutoMix({}, value);
    for (let tick = 0; tick < 50 && useAppStore.getState().tasks["auto-mix"]?.stage?.index !== 2; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAppStore.getState().autoMix.phase).toBe("running");
    expect(useAppStore.getState().tasks["auto-mix"]).toMatchObject({ status: "running", stage: { index: 2, count: 7 } });
    cancelAutoMix();
    release();
    await running;
    const state = useAppStore.getState();
    expect(state.autoMix.phase).toBe("cancelled");
    expect(state.fullMix.plan).toBeNull();
    expect(state.fullMix.open).toBe(false);
    expect(mix(state.document)).toBe(mix(song.document));
    expect(monitorState(state.document!, state.balance, state.eq, state.space, state.dynamics, state.fullMix).fullMix).toBeNull();
  });

  it("refuses a candidate built while the project changed", async () => {
    const { value } = deps(song, {
      plan: async (input) => {
        const document = useAppStore.getState().document!;
        useAppStore.getState().replaceDocument(updateTrack(document, "pad", { gainDb: document.tracks.find((track) => track.id === "pad")!.gainDb - 2 }), true);
        return planFullMix({ ...input, now: NOW });
      },
    });
    await runAutoMix({}, value);
    const state = useAppStore.getState();
    expect(state.autoMix.phase).toBe("failed");
    expect(state.autoMix.error).toMatch(/project changed/);
    expect(state.fullMix.plan).toBeNull();
    expect(state.tasks["auto-mix"]).toMatchObject({ status: "failed", retryable: true });
  });

  it("marks a ready candidate stale when the mix changes after it", async () => {
    await runAutoMix({}, deps(song).value);
    const document = useAppStore.getState().document!;
    useAppStore.getState().replaceDocument(updateTrack(document, "lead", { gainDb: document.tracks.find((track) => track.id === "lead")!.gainDb + 1 }), true);
    expect(autoMixButtonState(useAppStore.getState())).toBe("stale");
    expect(applyAutoMix()).toBe(false);
  });

  it("closes open subsystem candidates instead of folding them in", async () => {
    useAppStore.getState().setEq({ open: true, phase: "idle" });
    useAppStore.getState().setDynamics({ open: true, phase: "idle" });
    await runAutoMix({}, deps(song).value);
    const state = useAppStore.getState();
    expect(state.eq.open).toBe(false);
    expect(state.dynamics.open).toBe(false);
    expect(state.autoMix.phase).toBe("ready");
  });

  it("reuses a current plan instead of measuring and planning again", async () => {
    const first = deps(song);
    await runAutoMix({}, first.value);
    const plan = useAppStore.getState().fullMix.plan;
    const second = deps(song);
    await runAutoMix({}, second.value);
    expect(second.calls.load).toBe(0);
    expect(useAppStore.getState().fullMix.plan).toBe(plan);
    expect(useAppStore.getState().autoMix.stages.every((stage) => stage.status === "reused")).toBe(true);
    expect(useAppStore.getState().autoMix.summary!.reused).toHaveLength(7);
  });

  it("does not start while preparation blocks planning, and fails visibly when playback audio failed", async () => {
    useAppStore.getState().setTask({ id: "waveform", kind: "waveform", label: "Preparing project", blocks: ["playback", "editing", "planning", "export"] });
    const blocked = deps(song);
    await runAutoMix({}, blocked.value);
    expect(useAppStore.getState().autoMix.phase).toBe("idle");
    useAppStore.getState().dropTask("waveform");
    await runAutoMix({}, deps(song, { waitForAudio: async () => ({ ok: false, reason: "Playback preparation failed for Pad." }) }).value);
    expect(useAppStore.getState().autoMix).toMatchObject({ phase: "failed", error: "Playback preparation failed for Pad." });
    expect(useAppStore.getState().autoMix.stages[0]!.status).toBe("failed");
  });

  it("discard returns to the saved mix", async () => {
    await runAutoMix({}, deps(song).value);
    discardAutoMix();
    expect(useAppStore.getState().fullMix.plan).toBeNull();
    expect(autoMixButtonState(useAppStore.getState())).toBe("idle");
  });
});

describe("Auto Mix on an already-good mix", () => {
  it("changes little or nothing", async () => {
    const song = fixtureG();
    useAppStore.getState().openDocument(song.document, "/tmp/auto-mix-good/project.amix", []);
    await runAutoMix({}, deps(song).value);
    const { autoMix, fullMix } = useAppStore.getState();
    expect(autoMix.phase).toBe("ready");
    expect(autoMix.summary!.changeCount).toBeLessThanOrEqual(2);
    expect(autoMix.summary!.changeCount).toBeLessThan(Math.max(1, fullMix.plan!.evaluation.independent.total));
  });
});
