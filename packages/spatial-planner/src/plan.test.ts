import { spatialForSection } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import {
  applySpacePlan,
  editSpatialRecommendation,
  resetSpatialRecommendation,
  setSpatialRecommendationStatus,
  spatialAudition,
  spatialAuditionAt,
  spatialPlanSchema,
  spatialRecommendationIncluded,
  withSpatialProxyChecks,
  type SpatialPlan,
} from "./plan";
import { planSpace } from "./planner";
import { BASS, KICK, LEAD, NOW, PAD_MASKING, base, bump, spatialSong, sum } from "./test-fixtures";

/** The acceptance project from the milestone: a Chorus where Lead and Pad share the center, a Drop where Pad and Synth are both wide. */
function acceptance() {
  return spatialSong({
    tracks: [
      { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 }, stereo: { mono: true } },
      { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS }, stereo: { correlation: 0.99 } },
      { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD, active: [[0, 30]] }, stereo: { correlation: 0.98 } },
      { id: "pad", name: "Pad", role: "pad", width: 1.1, fixture: { shape: PAD_MASKING }, stereo: { correlation: 0.75 } },
      { id: "synth", name: "Synth", role: "synth", pan: -0.15, width: 1.3, fixture: { shape: sum(base(-40, -1), bump(2_600, 0.8, 11)), active: [[30, 60]] }, stereo: { correlation: 0.3 } },
      { id: "atmos", name: "Atmosphere", role: "atmosphere", width: 0.6, fixture: { shape: sum(base(-48, -1), bump(1_000, 1.5, 6)) }, stereo: { correlation: 0.6 } },
    ],
    sections: [
      { id: "chorus", name: "Chorus", type: "chorus", start: 0, end: 30 },
      { id: "drop", name: "Drop", type: "drop", start: 30, end: 60 },
    ],
    prominence: [{ track: "lead", section: "chorus", prominence: "focal" }],
  });
}

function planned(): { input: ReturnType<typeof acceptance>; plan: SpatialPlan } {
  const input = acceptance();
  return { input, plan: planSpace({ ...input, now: NOW }) };
}

describe("spatial plan contract", () => {
  it("is versioned, serializable, and validates", () => {
    const { plan } = planned();
    expect(plan).toMatchObject({ planVersion: 1, plannerVersion: "5.0.0", kind: "spatial-balance" });
    const round = JSON.parse(JSON.stringify(plan));
    expect(spatialPlanSchema.parse(round)).toEqual(plan);
    expect(plan.changes.length).toBeGreaterThan(0);
    for (const change of plan.changes) {
      expect(change.processing.pan !== null || change.processing.width !== null).toBe(true);
      expect(change.evaluation?.method).toBe("stereo-statistics");
    }
  });

  it("reports current, proposed, and the saved values each row is read against", () => {
    const { plan } = planned();
    const pad = plan.changes.find((change) => change.trackId === "pad" && change.scope.type === "global");
    expect(pad).toBeTruthy();
    expect(pad!.current).toEqual({ pan: 0, width: 1.1 });
    expect(pad!.reasons[0]).toMatch(/Lead/);
  });

  it("edits a row, re-checks it from its evidence, and resets it", () => {
    const { plan } = planned();
    const row = plan.changes[0]!;
    const edited = editSpatialRecommendation(plan, row.id, { pan: 0.12 });
    const after = edited.changes.find((change) => change.id === row.id)!;
    expect(after.processing.pan).toBe(0.12);
    expect(after.edited).toBe(true);
    expect(after.evaluation!.proxy).toBeNull();
    expect(after.evaluation!.conflictBefore).toBe(row.evaluation!.conflictBefore);
    const reset = resetSpatialRecommendation(edited, row.id).changes.find((change) => change.id === row.id)!;
    expect(reset.processing).toEqual(row.processing);
    expect(reset.edited).toBe(false);
  });

  it("follows the same inclusion rule as AutoBalance and EQ", () => {
    expect(spatialRecommendationIncluded({ status: "proposed" }, "all")).toBe(true);
    expect(spatialRecommendationIncluded({ status: "needs-review" }, "all")).toBe(false);
    expect(spatialRecommendationIncluded({ status: "needs-review" }, "preview")).toBe(false);
    expect(spatialRecommendationIncluded({ status: "accepted" }, "accepted")).toBe(true);
    expect(spatialRecommendationIncluded({ status: "proposed" }, "accepted")).toBe(false);
    expect(spatialRecommendationIncluded({ status: "rejected" }, "all")).toBe(false);
  });
});

describe("audition", () => {
  it("plays the saved mix as Current and the included rows as the Spatial Candidate", () => {
    const { input, plan } = planned();
    const current = spatialAudition(input.document, plan, { mode: "current" });
    expect(current.tracks.find((track) => track.trackId === "pad")).toEqual({ trackId: "pad", pan: 0, width: 1.1 });
    const candidate = spatialAudition(input.document, plan, { mode: "candidate" });
    for (const change of plan.changes.filter((item) => item.status === "proposed")) {
      const at = change.scope.type === "global" ? 1 : input.document.sections.find((section) => section.id === (change.scope as { sectionId: string }).sectionId)!.startTime + 1;
      const played = spatialAuditionAt(candidate, change.trackId, at);
      if (change.processing.pan !== null) expect(played.pan).toBe(change.processing.pan);
      if (change.processing.width !== null) expect(played.width).toBe(change.processing.width);
    }
    // The saved project is untouched.
    expect(input.document.tracks.find((track) => track.id === "pad")).toMatchObject({ pan: 0, width: 1.1 });
  });

  it("switches only the focused row in a single-row A/B", () => {
    const { input, plan } = planned();
    const row = plan.changes.find((change) => change.scope.type === "global")!;
    const recommended = spatialAudition(input.document, plan, { mode: "current", focusId: row.id, focusSide: "recommended" });
    const bypassed = spatialAudition(input.document, plan, { mode: "current", focusId: row.id, focusSide: "bypassed" });
    const saved = spatialAudition(input.document, plan, { mode: "current" });
    expect(bypassed).toEqual({ ...saved, note: bypassed.note });
    const track = recommended.tracks.find((item) => item.trackId === row.trackId)!;
    if (row.processing.pan !== null) expect(track.pan).toBe(row.processing.pan);
    if (row.processing.width !== null) expect(track.width).toBe(row.processing.width);
    for (const other of recommended.tracks.filter((item) => item.trackId !== row.trackId)) {
      expect(other).toEqual(saved.tracks.find((item) => item.trackId === other.trackId));
    }
    expect(recommended.trimDb).toBe(0);
  });

  it("plays a saved section override as a region, and a whole-song row does not override it", () => {
    const input = spatialSong({
      tracks: [
        { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD }, stereo: { correlation: 0.98 } },
        { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_MASKING }, stereo: { correlation: 0.9 } },
      ],
      sections: [
        { id: "verse", name: "Verse", type: "verse", start: 0, end: 30 },
        { id: "drop", name: "Drop", type: "drop", start: 30, end: 60 },
      ],
      prominence: [
        { track: "lead", section: "verse", prominence: "focal" },
        { track: "lead", section: "drop", prominence: "focal" },
      ],
      overrides: [{ track: "pad", section: "drop", pan: -0.4 }],
    });
    const plan = planSpace({ ...input, now: NOW });
    const candidate = spatialAudition(input.document, plan, { mode: "candidate" });
    expect(spatialAuditionAt(candidate, "pad", 45).pan).toBe(-0.4);
    const saved = spatialAudition(input.document, null, { mode: "current" });
    expect(saved.regions).toEqual([{ trackId: "pad", sectionId: "drop", startSeconds: 30, endSeconds: 60, pan: -0.4, width: 1 }]);
  });
});

describe("apply", () => {
  it("Apply all writes proposed and accepted rows into track and section state, nothing else", () => {
    const { input, plan } = planned();
    const next = applySpacePlan(input.document, plan, "all");
    for (const change of plan.changes) {
      const sectionId = change.scope.type === "section" ? change.scope.sectionId : null;
      const applied = spatialForSection(next, change.trackId, sectionId);
      const included = spatialRecommendationIncluded(change, "all");
      if (change.processing.pan !== null) expect(applied.pan === change.processing.pan).toBe(included);
      if (change.processing.width !== null) expect(applied.width === change.processing.width).toBe(included);
    }
    // Sources, EQ, sections, and intent are untouched.
    expect(next.tracks.map((track) => [track.file, track.processing])).toEqual(input.document.tracks.map((track) => [track.file, track.processing]));
    expect(next.sections).toEqual(input.document.sections);
  });

  it("Apply accepted writes only accepted rows, after an edit and a rejection", () => {
    const { input, plan } = planned();
    const [first, second] = plan.changes;
    let reviewed = setSpatialRecommendationStatus(plan, first!.id, "accepted");
    if (first!.processing.pan !== null) reviewed = editSpatialRecommendation(reviewed, first!.id, { pan: first!.processing.pan > 0 ? 0.12 : -0.12 });
    if (second) reviewed = setSpatialRecommendationStatus(reviewed, second.id, "rejected");
    const next = applySpacePlan(input.document, reviewed, "accepted");
    const row = reviewed.changes.find((change) => change.id === first!.id)!;
    const applied = spatialForSection(next, row.trackId, row.scope.type === "section" ? row.scope.sectionId : null);
    if (row.processing.pan !== null) expect(applied.pan).toBe(row.processing.pan);
    if (row.processing.width !== null) expect(applied.width).toBe(row.processing.width);
    if (second && second.trackId !== first!.trackId) {
      const untouched = spatialForSection(next, second.trackId, second.scope.type === "section" ? second.scope.sectionId : null);
      expect(untouched).toEqual(spatialForSection(input.document, second.trackId, second.scope.type === "section" ? second.scope.sectionId : null));
    }
  });

  it("writes a section row as an override that a later whole-song edit does not disturb", () => {
    const { input, plan } = planned();
    const section = plan.changes.find((change) => change.scope.type === "section");
    if (!section) return;
    const accepted = setSpatialRecommendationStatus(plan, section.id, "accepted");
    const next = applySpacePlan(input.document, accepted, "accepted");
    const row = next.sectionTrackSettings.find((item) => item.trackId === section.trackId && item.sectionId === (section.scope as { sectionId: string }).sectionId)!;
    if (section.processing.width !== null) expect(row.overrides.width).toBe(section.processing.width);
    if (section.processing.pan === null) expect(row.overrides.pan).toBeNull();
  });
});

describe("headroom", () => {
  it("trims the candidate when wider and moved stems could raise one channel's peak", () => {
    const input = spatialSong({
      tracks: Array.from({ length: 6 }, (_, index) => ({
        id: `p${index}`,
        name: `Pad ${index}`,
        role: "pad" as const,
        fixture: { shape: sum(base(-30, -1), bump(1_000, 1, 6)), crest: 4 },
        stereo: { correlation: 0.4 },
      })),
    });
    const plan = planSpace({ ...input, now: NOW, settings: { strength: "strong" } });
    // Push every pad hard toward one side to force the estimate.
    let edited = plan;
    const changes = plan.changes.length > 0 ? plan.changes : [];
    for (const change of changes) edited = setSpatialRecommendationStatus(editSpatialRecommendation(edited, change.id, { pan: 0.8, width: 1.6 }), change.id, "accepted");
    if (changes.length === 0) return;
    expect(edited.candidateTrim.gainDb).toBeLessThan(0);
    expect(edited.candidateTrim.reason).toMatch(/safety trim, not a spatial decision/);
    const next = applySpacePlan(input.document, edited, "accepted");
    expect(next.tracks[0]!.gainDb).toBeCloseTo(input.document.tracks[0]!.gainDb + edited.candidateTrim.gainDb, 1);
  });
});

describe("proxy check", () => {
  it("keeps a row whose measured correlation and mono loss match, and sends a disagreeing one to review", () => {
    const { plan } = planned();
    const row = plan.changes.find((change) => change.status === "proposed")!;
    const evaluation = row.evaluation!;
    const agreeing = withSpatialProxyChecks(plan, [
      {
        id: row.id,
        correlationBefore: evaluation.correlationBefore,
        correlationAfter: evaluation.correlationAfter,
        monoLossBeforeDb: evaluation.monoLossBeforeDb,
        monoLossAfterDb: evaluation.monoLossAfterDb,
        peakBeforeDbfs: -6,
        peakAfterDbfs: -5.8,
        seconds: 12,
      },
    ]);
    const kept = agreeing.changes.find((change) => change.id === row.id)!;
    expect(kept.status).toBe("proposed");
    expect(kept.evaluation!.proxy).toMatchObject({ agrees: true, seconds: 12 });
    expect(agreeing.summary.notes.join(" ")).toMatch(/Proxy check: 1 row was run through the native width and pan stage/);
    const disagreeing = withSpatialProxyChecks(plan, [
      {
        id: row.id,
        correlationBefore: evaluation.correlationBefore,
        correlationAfter: evaluation.correlationAfter - 0.6,
        monoLossBeforeDb: evaluation.monoLossBeforeDb,
        monoLossAfterDb: evaluation.monoLossAfterDb + 3,
        peakBeforeDbfs: -6,
        peakAfterDbfs: -3,
        seconds: 12,
      },
    ]);
    const flagged = disagreeing.changes.find((change) => change.id === row.id)!;
    expect(flagged.status).toBe("needs-review");
    expect(flagged.reasons[flagged.reasons.length - 1]).toMatch(/On the playback proxy/);
  });
});
