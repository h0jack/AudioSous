import { setSectionSpatial, setTrackEqNodes, setTrackSectionState, trackDynamicsNodes, type ProjectDocument } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import { SAVED_COMPRESSOR, demonstration, fixtureA, fixtureC, fixtureE } from "./fixtures";
import {
  applyDynamicsPlan,
  describeProcessing,
  dynamicsAudition,
  dynamicsPlanIsStale,
  dynamicsPlanSchema,
  dynamicsRecommendationIncluded,
  editDynamicsRecommendation,
  engineDynamics,
  resetDynamicsRecommendation,
  setDynamicsRecommendationStatus,
  withDynamicsProxyChecks,
  type DynamicsPlan,
  type DynamicsRecommendation,
} from "./plan";
import { planDynamics } from "./planner";
import { NOW } from "./test-fixtures";

function demo(): { document: ProjectDocument; plan: DynamicsPlan } {
  const input = demonstration();
  return { document: input.document, plan: planDynamics({ ...input, now: NOW }) };
}

function row(plan: DynamicsPlan, trackId: string, type: DynamicsRecommendation["processing"]["type"]): DynamicsRecommendation {
  const found = plan.changes.find((change) => change.trackId === trackId && change.processing.type === type);
  if (!found) throw new Error(`no ${type} row on ${trackId}`);
  return found;
}

describe("dynamics plan contract", () => {
  it("is plain JSON that survives a round trip", () => {
    const { plan } = demo();
    expect(dynamicsPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(plan.kind).toBe("dynamics-balance");
    expect(plan.changes.every((change) => change.evaluation && change.evaluation.timeline.values.length <= 400)).toBe(true);
    expect(plan.interactions.length).toBeGreaterThan(0);
    expect(plan.readings.length).toBeGreaterThan(0);
  });

  it("re-checks an edit from the stored evidence and sends an out-of-range edit to review", () => {
    const { plan } = demo();
    const comp = row(plan, "bass", "compressor");
    const gentler = editDynamicsRecommendation(plan, comp.id, { ratio: 1.2 });
    const edited = row(gentler, "bass", "compressor");
    expect(edited.edited).toBe(true);
    expect(edited.evaluation!.reductionP95Db).toBeLessThan(comp.evaluation!.reductionP95Db);
    expect(edited.status).toBe("proposed");
    const heavy = row(editDynamicsRecommendation(plan, comp.id, { ratio: 8, thresholdDb: -40 }), "bass", "compressor");
    expect(heavy.status).toBe("needs-review");
    expect(heavy.warnings.join(" ")).toMatch(/Ratio 8\.0:1 is past/);
    const loud = row(editDynamicsRecommendation(plan, comp.id, { makeupDb: 3 }), "bass", "compressor");
    expect(loud.warnings.join(" ")).toMatch(/Makeup gain/);
    // Edits are clamped to stored bounds.
    expect(row(editDynamicsRecommendation(plan, comp.id, { ratio: 99 }), "bass", "compressor").processing).toMatchObject({ ratio: 20 });
    const reset = resetDynamicsRecommendation(gentler, comp.id);
    expect(row(reset, "bass", "compressor")).toMatchObject({ edited: false, processing: comp.processing });
  });

  it("edits a duck: depth, key timing, and a deep duck goes to review", () => {
    const { plan } = demo();
    const duck = row(plan, "bass", "ducking");
    const lighter = row(editDynamicsRecommendation(plan, duck.id, { rangeDb: -1.3 }), "bass", "ducking");
    expect(lighter.processing).toMatchObject({ rangeDb: -1.3 });
    expect(lighter.evaluation!.reductionMaxDb).toBeLessThanOrEqual(1.31);
    expect(lighter.evaluation!.conflictAfterDb!).toBeGreaterThan(duck.evaluation!.conflictAfterDb!);
    const deep = row(editDynamicsRecommendation(plan, duck.id, { rangeDb: -5 }), "bass", "ducking");
    expect(deep.status).toBe("needs-review");
    const slow = row(editDynamicsRecommendation(plan, duck.id, { releaseMs: 900 }), "bass", "ducking");
    expect(slow.evaluation!.recovery!).toBeLessThan(duck.evaluation!.recovery!);
    expect(slow.warnings.join(" ")).toMatch(/release/);
  });

  it("edits a dynamic EQ's frequency, Q, and range against the stored band levels", () => {
    const { plan } = demo();
    const dip = row(plan, "pad", "dynamic-eq");
    const off = row(editDynamicsRecommendation(plan, dip.id, { frequencyHz: 300 }), "pad", "dynamic-eq");
    expect(off.evaluation!.collisionAfter!).toBeGreaterThan(dip.evaluation!.collisionAfter!);
    const deeper = row(editDynamicsRecommendation(plan, dip.id, { rangeDb: -2.5 }), "pad", "dynamic-eq");
    expect(deeper.evaluation!.collisionAfter!).toBeLessThan(dip.evaluation!.collisionAfter!);
    const narrow = row(editDynamicsRecommendation(plan, dip.id, { q: 5 }), "pad", "dynamic-eq");
    expect(narrow.status).toBe("needs-review");
    expect(describeProcessing(dip.processing, (id) => (id === "lead" ? "Lead" : id))).toMatch(/kHz, Q .*, up to −?-?\d\.\d dB, key Lead/);
  });

  it("follows the inclusion rule and keeps counts current", () => {
    const { plan } = demo();
    const snare = row(plan, "snare", "transient");
    const rejected = setDynamicsRecommendationStatus(plan, snare.id, "rejected");
    expect(dynamicsRecommendationIncluded(row(rejected, "snare", "transient"), "preview")).toBe(false);
    expect(dynamicsRecommendationIncluded(row(rejected, "bass", "compressor"), "preview")).toBe(true);
    expect(dynamicsRecommendationIncluded(row(rejected, "bass", "compressor"), "accepted")).toBe(false);
    const review = setDynamicsRecommendationStatus(plan, snare.id, "needs-review");
    expect(review.summary.reviewCount).toBe(1);
    expect(dynamicsRecommendationIncluded(row(review, "snare", "transient"), "all")).toBe(false);
  });

  it("auditions Current, the candidate, and one row without touching the project, level-matched", () => {
    const { document, plan } = demo();
    const current = dynamicsAudition(document, plan, { mode: "current" });
    expect(current.tracks).toEqual([]);
    expect(current.compensation).toEqual([]);
    const candidate = dynamicsAudition(document, plan, { mode: "candidate" });
    const bass = candidate.tracks.find((track) => track.trackId === "bass")!;
    expect(bass.nodes.map((node) => node.type)).toEqual(["compressor"]);
    expect(bass.regions).toEqual([{ startSeconds: 30, endSeconds: 60, nodes: [expect.objectContaining({ type: "ducking", keyTrackId: "kick" })] }]);
    expect(candidate.tracks.find((track) => track.trackId === "pad")!.nodes[0]).toMatchObject({ type: "dynamic-eq", keyTrackId: "lead" });
    // Level match: the compressed bass is raised by about what compression took off, in the audition only.
    const comp = row(plan, "bass", "compressor");
    expect(candidate.compensation.find((item) => item.trackId === "bass" && item.sectionId === null)!.gainDb).toBeCloseTo(-comp.evaluation!.levelChangeDb, 1);
    expect(candidate.note).toMatch(/level-matched/);
    expect(dynamicsAudition(document, plan, { mode: "candidate", levelMatch: false }).compensation).toEqual([]);
    const single = dynamicsAudition(document, plan, { mode: "current", focusId: comp.id, focusSide: "recommended" });
    expect(single.tracks.map((track) => track.trackId)).toEqual(["bass"]);
    expect(single.tracks[0]!.regions).toEqual([]);
    const bypassed = dynamicsAudition(document, plan, { mode: "candidate", focusId: comp.id, focusSide: "bypassed" });
    expect(bypassed.tracks.find((track) => track.trackId === "bass")!.nodes).toEqual([]);
    expect(document.tracks.every((track) => track.processing.dynamics.length === 0)).toBe(true);
  });

  it("applies all or only the accepted rows as dynamics-plan nodes", () => {
    const { document, plan } = demo();
    const all = applyDynamicsPlan(document, plan, "all");
    const bass = all.tracks.find((track) => track.id === "bass")!;
    expect(bass.processing.dynamics).toHaveLength(1);
    expect(bass.processing.dynamics[0]).toMatchObject({ type: "compressor", origin: "dynamics-plan", enabled: true });
    expect(bass.processing.dynamics[0]!.note).toBe(row(plan, "bass", "compressor").reasons[0]!.slice(0, 400));
    expect(all.sectionTrackSettings.find((item) => item.trackId === "bass" && item.sectionId === "drop")!.processing.dynamics[0]).toMatchObject({ type: "ducking", keyTrackId: "kick" });
    expect(all.tracks.map((track) => track.file)).toEqual(document.tracks.map((track) => track.file));
    expect(engineDynamics(all).find((track) => track.trackId === "bass")!.nodes[0]!.type).toBe("compressor");
    const accepted = setDynamicsRecommendationStatus(plan, row(plan, "pad", "dynamic-eq").id, "accepted");
    const some = applyDynamicsPlan(document, accepted, "accepted");
    expect(some.tracks.filter((track) => track.processing.dynamics.length > 0).map((track) => track.id)).toEqual(["pad"]);
  });

  it("replaces a saved node in place instead of adding one", () => {
    const input = fixtureA({ dynamics: [{ track: "bass", nodes: [SAVED_COMPRESSOR] }] });
    const plan = planDynamics({ ...input, now: NOW });
    const applied = applyDynamicsPlan(input.document, plan, "all");
    const nodes = trackDynamicsNodes(applied, "bass");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).not.toBe("comp-old");
    expect(nodes[0]).toMatchObject({ type: "compressor", origin: "dynamics-plan" });
  });

  it("goes stale on gain, EQ, space, dynamics, prominence, or intent, and not on selection or the playhead", () => {
    const { document, plan } = demo();
    expect(dynamicsPlanIsStale(plan, document)).toBe(false);
    const moved = { ...document, uiState: { ...document.uiState, playheadSeconds: 12, selectedTrackId: "bass" } };
    expect(dynamicsPlanIsStale(plan, moved)).toBe(false);
    expect(dynamicsPlanIsStale(plan, { ...document, tracks: document.tracks.map((track) => (track.id === "bass" ? { ...track, gainDb: -1 } : track)) })).toBe(true);
    const eq = setTrackEqNodes(document, "pad", [{ id: "e", type: "eq", enabled: true, filter: { kind: "bell", frequencyHz: 2_000, gainDb: -2, q: 1 }, origin: "manual", note: null }]);
    expect(eq.ok && dynamicsPlanIsStale(plan, eq.document)).toBe(true);
    const space = setSectionSpatial(document, "pad", "drop", { pan: 0.3 });
    expect(space.ok && dynamicsPlanIsStale(plan, space.document)).toBe(true);
    expect(dynamicsPlanIsStale(plan, applyDynamicsPlan(document, plan, "all"))).toBe(true);
    const prominence = setTrackSectionState(document, "pad", "drop", { prominence: "focal" });
    expect(prominence.ok && dynamicsPlanIsStale(plan, prominence.document)).toBe(true);
    const intent = setTrackSectionState(document, "bass", "drop", { userIntent: "Keep it natural." });
    expect(intent.ok && dynamicsPlanIsStale(plan, intent.document)).toBe(true);
    expect(dynamicsPlanIsStale(plan, document, [], { strength: "strong" })).toBe(true);
  });

  it("merges proxy checks: agreement keeps the row, a failed purpose sends it to review with the numbers", () => {
    const input = fixtureC();
    const plan = planDynamics({ ...input, now: NOW });
    const duck = row(plan, "bass", "ducking");
    const agree = withDynamicsProxyChecks(plan, [
      { id: duck.id, reductionP50Db: 2, reductionP95Db: 2.4, reductionMaxDb: 2.5, levelBeforeDb: -14, levelAfterDb: -14.6, spreadBeforeDb: 1, spreadAfterDb: 1, transientBeforeDb: null, transientAfterDb: null, bandOnChangeDb: -1.8, bandOffChangeDb: -0.1, recovered: 0.8, seconds: 18 },
    ]);
    expect(row(agree, "bass", "ducking").evaluation!.proxy).toMatchObject({ agrees: true, bandOnChangeDb: -1.8 });
    expect(row(agree, "bass", "ducking").status).toBe("proposed");
    expect(agree.summary.notes.some((note) => note.startsWith("Proxy check: 1 row was run"))).toBe(true);
    const stuck = withDynamicsProxyChecks(plan, [
      { id: duck.id, reductionP50Db: 2, reductionP95Db: 2.4, reductionMaxDb: 2.5, levelBeforeDb: -14, levelAfterDb: -15.6, spreadBeforeDb: 1, spreadAfterDb: 1, transientBeforeDb: null, transientAfterDb: null, bandOnChangeDb: -1.8, bandOffChangeDb: -1.5, recovered: 0.3, seconds: 18 },
    ]);
    const held = row(stuck, "bass", "ducking");
    expect(held.status).toBe("needs-review");
    expect(held.reasons[held.reasons.length - 1]).toMatch(/back to full level only 30% of the time/);
    expect(held.confidence).toBeLessThan(duck.confidence);
    const failed = withDynamicsProxyChecks(plan, [], 1);
    expect(failed.summary.notes.some((note) => /1 could not be checked/.test(note))).toBe(true);
  });

  it("keeps the proxy result through an edit, as a measurement of the planned values, and reset restores the row", () => {
    const input = fixtureE();
    const plan = planDynamics({ ...input, now: NOW });
    const dip = row(plan, "pad", "dynamic-eq");
    const checked = withDynamicsProxyChecks(plan, [
      { id: dip.id, reductionP50Db: 1.4, reductionP95Db: 1.5, reductionMaxDb: 1.5, levelBeforeDb: -18, levelAfterDb: -18.2, spreadBeforeDb: 1, spreadAfterDb: 1, transientBeforeDb: null, transientAfterDb: null, bandOnChangeDb: -1.2, bandOffChangeDb: 0, recovered: null, seconds: 20 },
    ]);
    expect(row(checked, "pad", "dynamic-eq").evaluation!.proxy).not.toBeNull();
    const edited = editDynamicsRecommendation(checked, dip.id, { rangeDb: -2 });
    expect(row(edited, "pad", "dynamic-eq")).toMatchObject({ edited: true, evaluation: { proxy: { bandOnChangeDb: -1.2 } } });
    expect(row(resetDynamicsRecommendation(edited, dip.id), "pad", "dynamic-eq")).toMatchObject({ edited: false, processing: dip.processing, evaluation: { proxy: { bandOnChangeDb: -1.2 } } });
  });
});
