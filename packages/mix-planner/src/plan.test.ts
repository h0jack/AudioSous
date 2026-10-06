import { MAX_TRACK_EQ_NODES, setTrackEqNodes, setTrackSectionState, type EqNode } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import { fixtureB, multiProblem } from "./fixtures";
import {
  applyFullMixPlan,
  changeIncluded,
  editChange,
  fullMixAudition,
  fullMixPlanIsStale,
  fullMixPlanSchema,
  planFullMix,
  resetChange,
  setChangeStatus,
  setProblemStatus,
  solutionChanges,
  type FullMixPlan,
} from "./index";

const NOW = "2026-10-05T00:00:00.000Z";
const song = multiProblem();
const plan: FullMixPlan = planFullMix({ ...song, now: NOW });
const byKind = (kind: string) => plan.changes.find((change) => change.domain === kind)!;

describe("plan contract", () => {
  it("is versioned, serializable, and inspectable", () => {
    expect(plan.kind).toBe("full-mix");
    expect(plan.planVersion).toBe(1);
    const round = fullMixPlanSchema.parse(JSON.parse(JSON.stringify(plan)));
    expect(round).toEqual(plan);
    // Problems, the alternatives considered, the selected changes, and the evaluation are all in it.
    expect(plan.problems.length).toBeGreaterThan(0);
    expect(plan.interventions.some((item) => item.outcome === "selected")).toBe(true);
    expect(plan.interventions.some((item) => item.outcome !== "selected")).toBe(true);
    expect(plan.evaluation.before.problemScore).toBeGreaterThan(plan.evaluation.after.problemScore);
    for (const problem of plan.problems.filter((item) => item.interventionId)) expect(plan.interventions.some((item) => item.id === problem.interventionId)).toBe(true);
  });

  it("goes stale on anything it depends on, and not on selection or the playhead", () => {
    const document = song.document;
    expect(fullMixPlanIsStale(plan, document)).toBe(false);
    const fader = { ...document, tracks: document.tracks.map((track) => (track.id === "pad" ? { ...track, gainDb: track.gainDb + 0.5 } : track)) };
    expect(fullMixPlanIsStale(plan, fader)).toBe(true);
    const node: EqNode = { id: "manual", type: "eq", enabled: true, origin: "manual", note: null, filter: { kind: "bell", frequencyHz: 1_000, gainDb: -1, q: 1 } };
    const eq = setTrackEqNodes(document, "pad", [node]);
    expect(eq.ok && fullMixPlanIsStale(plan, eq.document)).toBe(true);
    const width = { ...document, tracks: document.tracks.map((track) => (track.id === "synth" ? { ...track, width: 1 } : track)) };
    expect(fullMixPlanIsStale(plan, width)).toBe(true);
    const role = { ...document, tracks: document.tracks.map((track) => (track.id === "pad" ? { ...track, role: "synth" as const } : track)) };
    expect(fullMixPlanIsStale(plan, role)).toBe(true);
    const intent = setTrackSectionState(document, "pad", "all", { userIntent: "quieter" });
    expect(intent.ok && fullMixPlanIsStale(plan, intent.document)).toBe(true);
    const section = { ...document, sections: document.sections.map((item) => ({ ...item, userIntent: "Make it wider." })) };
    expect(fullMixPlanIsStale(plan, section)).toBe(true);
    const selection = { ...document, uiState: { ...document.uiState, selectedTrackId: "pad", playheadSeconds: 12 } };
    expect(fullMixPlanIsStale(plan, selection)).toBe(false);
    expect(fullMixPlanIsStale(plan, document, [], { strength: "strong", goal: "balanced" })).toBe(true);
  });

  it("accepts and rejects one change, or a whole problem's solution", () => {
    const change = plan.changes[0]!;
    const rejected = setChangeStatus(plan, change.id, "rejected");
    expect(rejected.changes.find((item) => item.id === change.id)!.status).toBe("rejected");
    expect(changeIncluded(rejected.changes.find((item) => item.id === change.id)!, "preview")).toBe(false);
    const problem = plan.problems.find((item) => item.interventionId && solutionChanges(plan, item.id).length > 0)!;
    const accepted = setProblemStatus(plan, problem.id, "accepted");
    for (const item of solutionChanges(accepted, problem.id)) expect(item.status).toBe("accepted");
    const other = accepted.changes.filter((item) => !solutionChanges(accepted, problem.id).some((own) => own.id === item.id));
    for (const item of other) expect(item.status).toBe(plan.changes.find((own) => own.id === item.id)!.status);
  });

  it("re-checks an edit from its evidence with the subsystem's own evaluator, and sends an out-of-range edit to review", () => {
    const eq = byKind("eq");
    expect(eq.processing.type).toBe("eq");
    const edited = editChange(plan, eq.id, { gainDb: -2.5 });
    const after = edited.changes.find((item) => item.id === eq.id)!;
    expect(after.edited).toBe(true);
    expect(after.evaluation.eq!.regionChangeDb).toBeLessThan(eq.evaluation.eq!.regionChangeDb);
    const extreme = editChange(plan, eq.id, { gainDb: -9 });
    expect(extreme.changes.find((item) => item.id === eq.id)!.status).toBe("needs-review");
    const reset = resetChange(edited, eq.id);
    expect(reset.changes.find((item) => item.id === eq.id)!.processing).toEqual(eq.processing);
    expect(reset.changes.find((item) => item.id === eq.id)!.edited).toBe(false);

    const duck = plan.changes.find((item) => item.processing.type === "dynamics" && item.processing.processing.type === "ducking")!;
    const deeper = editChange(plan, duck.id, { rangeDb: -2.5 });
    const deeperChange = deeper.changes.find((item) => item.id === duck.id)!;
    expect(deeperChange.evaluation.dynamics!.reductionMaxDb).toBeGreaterThan(duck.evaluation.dynamics!.reductionMaxDb);

    const space = byKind("space");
    const narrower = editChange(plan, space.id, { width: 0.9 });
    expect(narrower.changes.find((item) => item.id === space.id)!.evaluation.space!.monoLossAfterDb).toBeLessThanOrEqual(space.evaluation.space!.monoLossAfterDb + 1e-9);
  });

  it("auditions Current, the whole candidate, one problem's solution, the candidate without it, and one change", () => {
    const document = song.document;
    const current = fullMixAudition(document, plan, { mode: "current" });
    expect(current.document).toBe(document);
    expect(current.changeIds).toEqual([]);
    const candidate = fullMixAudition(document, plan, { mode: "candidate" });
    expect(candidate.changeIds.sort()).toEqual(plan.changes.filter((item) => changeIncluded(item, "preview")).map((item) => item.id).sort());
    expect(Math.abs(candidate.loudnessMatchDb)).toBeLessThanOrEqual(3);
    const problem = plan.problems.find((item) => solutionChanges(plan, item.id).length > 0)!;
    const ids = solutionChanges(plan, problem.id).map((item) => item.id).sort();
    const only = fullMixAudition(document, plan, { mode: "candidate", focus: { kind: "problem", id: problem.id, side: "only" } });
    expect(only.changeIds.sort()).toEqual(ids);
    const without = fullMixAudition(document, plan, { mode: "candidate", focus: { kind: "problem", id: problem.id, side: "without" } });
    expect(without.changeIds.some((id) => ids.includes(id))).toBe(false);
    expect(without.changeIds.length).toBe(candidate.changeIds.length - ids.length);
    const one = fullMixAudition(document, plan, { mode: "current", focus: { kind: "change", id: plan.changes[0]!.id, side: "only" } });
    expect(one.changeIds).toEqual([plan.changes[0]!.id]);
    // The saved project is never touched.
    expect(fullMixPlanIsStale(plan, document)).toBe(false);
    const raw = fullMixAudition(document, plan, { mode: "candidate", loudnessMatch: false });
    expect(raw.loudnessMatchDb).toBe(0);
  });

  it("plays the candidate at Current's estimated loudness so it does not win by being louder", () => {
    const quieter = planFullMix({ ...fixtureB(), now: NOW });
    const audition = fullMixAudition(fixtureB().document, quieter, { mode: "candidate" });
    // A duck lowers the bass on average; the comparison puts that level back on every stem.
    expect(audition.loudnessMatchDb).toBeGreaterThanOrEqual(0);
    expect(audition.note).toMatch(/estimated loudness/);
  });

  it("applies the accepted changes in one update and leaves the rest", () => {
    const first = plan.changes[0]!;
    const reviewed = setChangeStatus(plan, first.id, "accepted");
    const applied = applyFullMixPlan(song.document, reviewed, "accepted");
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.applied).toBe(1);
    const all = applyFullMixPlan(song.document, plan, "all");
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.applied).toBe(plan.changes.filter((item) => changeIncluded(item, "all")).length);
    // The plan is stale against the applied project, so it cannot be applied twice.
    expect(fullMixPlanIsStale(plan, all.document)).toBe(true);
  });

  it("refuses to apply anything when one change cannot be stored", () => {
    const eq = byKind("eq");
    const full: EqNode[] = Array.from({ length: MAX_TRACK_EQ_NODES }, (_, index) => ({ id: `n${index}`, type: "eq", enabled: true, origin: "manual", note: null, filter: { kind: "bell", frequencyHz: 200 + index * 300, gainDb: -0.5, q: 1 } }));
    const crowded = setTrackEqNodes(song.document, eq.trackId, full);
    expect(crowded.ok).toBe(true);
    if (!crowded.ok) return;
    const result = applyFullMixPlan(crowded.document, plan, "all");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0]!.changeId).toBe(eq.id);
  });
});
