import { changeIncluded, editChange, fullMixPlanIsStale, planFullMix, setChangeStatus, solutionChanges, type FullMixPlan, type MixChange } from "@audiosous/mix-planner";
import { multiProblem } from "@audiosous/mix-planner/testing";
import { setTrackEqNodes, trackDynamicsNodes, trackEqNodes, type ProjectDocument } from "@audiosous/project-model";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../state/app-store";
import { setDynamicsPreview } from "./dynamics";
import { setEqPreview } from "./eq";
import {
  applyFullMix,
  auditionFullMix,
  cancelFullMixPlan,
  editFullMixChange,
  engineVariant,
  fullMixHearing,
  fullMixScope,
  problemWindows,
  setFullMixChangeStatus,
  setFullMixPreview,
  setFullMixProblemStatus,
  songWindows,
} from "./full-mix";
import { monitorState } from "./monitor";

const NOW = "2026-10-05T00:00:00.000Z";

function heard() {
  const store = useAppStore.getState();
  return monitorState(store.document!, store.balance, store.eq, store.space, store.dynamics, store.fullMix);
}

function find(plan: FullMixPlan, predicate: (change: MixChange) => boolean): MixChange {
  const found = plan.changes.find(predicate);
  if (!found) throw new Error("no such change");
  return found;
}

const isDuck = (change: MixChange) => change.processing.type === "dynamics" && change.processing.processing.type === "ducking";
const isEq = (change: MixChange) => change.processing.type === "eq";

describe("Full Mix review flow", () => {
  let document: ProjectDocument;
  let plan: FullMixPlan;

  beforeEach(() => {
    const song = multiProblem();
    document = song.document;
    plan = planFullMix({ ...song, now: NOW });
    useAppStore.getState().openDocument(document, "/tmp/full-mix-flow/project.amix", []);
    useAppStore.getState().setFullMix({ open: true, phase: "ready", plan, fingerprints: [] });
  });

  it("plans the multi-problem song problem by problem and says what it reads", () => {
    expect(plan.problems.length).toBeGreaterThanOrEqual(4);
    expect(plan.changes.length).toBeLessThan(plan.evaluation.independent.total);
    expect(fullMixScope(document)).toMatch(/each of the 1 section/);
  });

  it("A/Bs Current and the whole candidate through the monitor, gain, EQ, space, and dynamics together", () => {
    const pad = find(plan, (change) => change.trackId === "pad" && isEq(change));
    const duck = find(plan, (change) => change.trackId === "bass" && isDuck(change));
    expect(heard().fullMix).toBeNull();
    expect(heard().eq.find((item) => item.trackId === "pad")).toBeUndefined();
    setFullMixPreview(true);
    expect(fullMixHearing(document, useAppStore.getState().fullMix)).toBe("Hearing the Full Mix Candidate, loudness-matched");
    const candidate = heard();
    expect(candidate.fullMix).not.toBeNull();
    expect(candidate.eq.find((item) => item.trackId === "pad")!.filters).toEqual([pad.processing.type === "eq" ? pad.processing.filter : null]);
    expect(candidate.dynamics.find((item) => item.trackId === "bass")!.nodes.map((node) => node.type)).toContain("ducking");
    expect(candidate.spatial.find((item) => item.trackId === "synth")!.width).toBeLessThan(1.7);
    // Loudness match moves every stem by the same amount, so the balance between them is the candidate's.
    const offset = candidate.fullMix!.offsetDb;
    expect(Math.abs(offset)).toBeLessThanOrEqual(3);
    expect(candidate.gains.get("kick")).toBeCloseTo(offset, 5);
    setFullMixPreview(false);
    expect(heard().fullMix).toBeNull();
    // The saved project never changes.
    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().dirty).toBe(false);
    void duck;
  });

  it("A/Bs one problem's solution on its own and the candidate without it", () => {
    const problem = plan.problems.find((item) => item.type === "low-end-collision")!;
    const ids = solutionChanges(plan, problem.id).map((change) => change.id);
    auditionFullMix({ kind: "problem", id: problem.id, side: "only" });
    expect(heard().fullMix!.changeIds.sort()).toEqual([...ids].sort());
    expect(fullMixHearing(document, useAppStore.getState().fullMix)).toMatch(/^Hearing only the fix for/);
    auditionFullMix({ kind: "problem", id: problem.id, side: "without" });
    const without = heard().fullMix!;
    expect(without.changeIds.some((id) => ids.includes(id))).toBe(false);
    expect(without.changeIds.length).toBeGreaterThan(0);
    // The same button again stops the focus.
    auditionFullMix({ kind: "problem", id: problem.id, side: "without" });
    expect(useAppStore.getState().fullMix.focus).toBeNull();
  });

  it("keeps one-change A/B", () => {
    const duck = find(plan, (change) => change.trackId === "bass" && isDuck(change));
    auditionFullMix({ kind: "change", id: duck.id, side: "only" });
    const state = heard();
    expect(state.fullMix!.changeIds).toEqual([duck.id]);
    expect(state.dynamics.find((item) => item.trackId === "bass")!.nodes.map((node) => node.type)).toEqual(["ducking"]);
    expect(state.eq.find((item) => item.trackId === "pad")).toBeUndefined();
  });

  it("one comparison plays at a time across every plan", () => {
    setDynamicsPreview(true);
    setFullMixPreview(true);
    expect(useAppStore.getState().dynamics.preview).toBe(false);
    setEqPreview(true);
    expect(useAppStore.getState().fullMix.preview).toBe(false);
    setFullMixPreview(true);
    setDynamicsPreview(true);
    expect(useAppStore.getState().fullMix.preview).toBe(false);
  });

  it("hears an edit right away and re-checks it", () => {
    const duck = find(plan, (change) => change.trackId === "bass" && isDuck(change));
    editFullMixChange(duck.id, { rangeDb: -0.8 });
    const edited = useAppStore.getState().fullMix.plan!.changes.find((change) => change.id === duck.id)!;
    expect(edited.edited).toBe(true);
    expect(useAppStore.getState().fullMix.focus).toEqual({ kind: "change", id: duck.id, side: "only" });
    const node = heard().dynamics.find((item) => item.trackId === "bass")!.nodes.find((item) => item.type === "ducking")!;
    expect(node).toMatchObject({ type: "ducking", rangeDb: -0.8 });
  });

  it("accepts and rejects by change and by problem, applies accepted in one step, and undoes the whole mix in one", () => {
    const lowEnd = plan.problems.find((item) => item.type === "low-end-collision")!;
    const masking = plan.problems.find((item) => item.type === "frequency-conflict" || item.type === "event-masking")!;
    setFullMixProblemStatus(lowEnd.id, "accepted");
    setFullMixProblemStatus(masking.id, "accepted");
    const synth = find(plan, (change) => change.trackId === "synth");
    setFullMixChangeStatus(synth.id, "rejected");
    const reviewed = useAppStore.getState().fullMix.plan!;
    const accepted = reviewed.changes.filter((change) => change.status === "accepted");
    expect(accepted.length).toBeGreaterThanOrEqual(2);
    setFullMixPreview(true);
    expect(applyFullMix("accepted")).toBe(true);
    const applied = useAppStore.getState().document!;
    expect(trackDynamicsNodes(applied, "bass").some((node) => node.type === "ducking" && node.keyTrackId === "kick" && node.origin === "dynamics-plan")).toBe(true);
    expect(trackEqNodes(applied, "pad").some((node) => node.origin === "eq-plan")).toBe(true);
    expect(applied.tracks.find((track) => track.id === "synth")!.width).toBe(document.tracks.find((track) => track.id === "synth")!.width);
    expect(applied.tracks.map((track) => track.file)).toEqual(document.tracks.map((track) => track.file));
    expect(useAppStore.getState().fullMix.plan).toBeNull();
    expect(heard().fullMix).toBeNull();
    useAppStore.getState().undo();
    const undone = useAppStore.getState().document!;
    expect(undone.tracks).toEqual(document.tracks);
    expect(undone.sectionTrackSettings).toEqual(document.sectionTrackSettings);
  });

  it("refuses to apply part of a plan and says why", () => {
    const pad = find(plan, (change) => change.trackId === "pad" && isEq(change));
    const nodes = Array.from({ length: 6 }, (_, index) => ({ id: `n${index}`, type: "eq" as const, enabled: true, origin: "manual" as const, note: null, filter: { kind: "bell" as const, frequencyHz: 300 + index * 500, gainDb: -0.5, q: 1 } }));
    const crowded = setTrackEqNodes(document, "pad", nodes);
    if (!crowded.ok) throw new Error(crowded.message);
    // A plan made on the crowded project, so it is fresh there; the pad's cut cannot be stored.
    const staleFree = { ...plan, stateIdentity: planFullMix({ ...multiProblem(), document: crowded.document, now: NOW }).stateIdentity };
    useAppStore.getState().replaceDocument(crowded.document, true, { mode: "record" });
    useAppStore.getState().setFullMix({ plan: staleFree });
    expect(applyFullMix("all")).toBe(false);
    expect(useAppStore.getState().document).toBe(crowded.document);
    expect(useAppStore.getState().fullMix.error).toMatch(/Nothing was applied/);
    void pad;
  });

  it("refuses a stale plan after a fader or EQ change and stops auditioning it, but not after selection", () => {
    setFullMixPreview(true);
    useAppStore.getState().replaceDocument({ ...document, uiState: { ...document.uiState, selectedTrackId: "pad", playheadSeconds: 20 } }, false);
    expect(heard().fullMix).not.toBeNull();
    const moved = { ...document, tracks: document.tracks.map((track) => (track.id === "bass" ? { ...track, gainDb: -2 } : track)) };
    useAppStore.getState().replaceDocument(moved, true, { mode: "record" });
    expect(fullMixPlanIsStale(plan, moved)).toBe(true);
    expect(heard().fullMix).toBeNull();
    expect(applyFullMix("all")).toBe(false);
    expect(useAppStore.getState().document).toBe(moved);
  });

  it("cancel discards the plan and leaves the project untouched", () => {
    setFullMixPreview(true);
    cancelFullMixPlan();
    expect(useAppStore.getState().document).toEqual(document);
    expect(useAppStore.getState().fullMix).toMatchObject({ plan: null, preview: false, open: false });
  });

  it("builds the render check from the engine's own settings, over representative and problem windows", () => {
    const current = engineVariant("current", document);
    expect(current.tracks).toHaveLength(document.tracks.length);
    expect(current.spatial.find((item) => item.trackId === "synth")!.width).toBe(1.7);
    const windows = songWindows(document);
    expect(windows.length).toBeGreaterThan(0);
    expect(problemWindows(plan).length).toBeGreaterThan(0);
    const edited = editChange(setChangeStatus(plan, plan.changes[0]!.id, "rejected"), plan.changes[1]!.id, {});
    expect(edited.changes.filter((change) => changeIncluded(change, "preview")).length).toBe(plan.changes.length - 1);
  });
});
