import { compressorNodeSchema, type ProjectDocument } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import { fixtureA, fixtureB, fixtureC, fixtureD, fixtureE, fixtureF, fixtureG, fixtureH, multiBenefit, multiProblem } from "./fixtures";
import { evaluateCandidate } from "./evaluate";
import { MIX_LIMITS_BY_STRENGTH, PLANNERS, Surveyor, applyFullMixPlan, detectMixProblems, fullMixPlanSchema, planFullMix, processorKind, type FullMixPlan, type FullMixSettings, type MixChange } from "./index";
import { fromBalanceRow, gainChange } from "./rows";
import { LEAD, PAD_MASKING, PAD_SEPARATED, bassTrack, kickTrack, mixSong, unstableBass, wholeSong, type MixSong, type MixTrackInput } from "./testing";

const NOW = "2026-10-05T00:00:00.000Z";

function plan(song: MixSong, settings: Partial<FullMixSettings> = {}): FullMixPlan {
  return planFullMix({ ...song, settings, now: NOW });
}

const on = (result: FullMixPlan, trackId: string) => result.changes.filter((change) => change.trackId === trackId);
const kinds = (changes: MixChange[]) => changes.map((change) => processorKind(change.processing));

describe("problem model", () => {
  it("reads one problem per relationship, whatever number of planners saw it", () => {
    const song = fixtureA();
    const survey = new Surveyor(song.document, song, "normal", NOW).survey([], PLANNERS);
    const problems = detectMixProblems({ survey, settings: { strength: "normal", goal: "balanced" }, levels: [] });
    const masking = problems.filter((problem) => problem.trackIds.includes("lead") && problem.trackIds.includes("pad"));
    expect(masking).toHaveLength(1);
    expect(masking[0]!.protectedTrackId).toBe("lead");
    expect(masking[0]!.yieldingTrackId).toBe("pad");
    // Evidence from more than one planner, and the rows of more than one as candidate interventions.
    expect(new Set(masking[0]!.evidence.map((item) => item.source)).size).toBeGreaterThan(1);
    expect(masking[0]!.rows.eq.length + masking[0]!.rows.space.length).toBeGreaterThan(1);
    for (const problem of problems) {
      expect(problem.severity).toBeGreaterThanOrEqual(0);
      expect(problem.severity).toBeLessThanOrEqual(1);
      expect(problem.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe("fixtures", () => {
  it("A: one problem with many possible fixes gets one or two cheap moves, all on the supporting part", () => {
    const result = plan(fixtureA());
    expect(result.evaluation.independent.total).toBeGreaterThanOrEqual(2);
    expect(result.changes.length).toBeGreaterThanOrEqual(1);
    expect(result.changes.length).toBeLessThanOrEqual(2);
    expect(on(result, "lead")).toEqual([]);
    expect(new Set(kinds(result.changes)).size).toBe(result.changes.length);
  });

  it("B: a kick/bass collision on the hits is ducked, not solved by lowering the bass everywhere", () => {
    const result = plan(fixtureB());
    const bass = on(result, "bass");
    expect(bass.some((change) => change.processing.type === "dynamics" && change.processing.processing.type === "ducking" && change.processing.processing.keyTrackId === "kick")).toBe(true);
    expect(bass.some((change) => change.processing.type === "gain" && change.scope.type === "global")).toBe(false);
    const problem = result.problems.find((item) => item.type === "low-end-collision")!;
    // The global gain alternative was considered and rejected, with the reason stated.
    const rejected = result.interventions.find((item) => item.problemIds.includes(problem.id) && item.outcome !== "selected" && item.items.some((entry) => entry.domain === "gain"));
    expect(rejected?.reason).toMatch(/everywhere it plays|removes less|outside the conflict/);
  });

  it("C: a conflict the saved EQ already fixed gets no spatial move", () => {
    const result = plan(fixtureC());
    expect(result.changes.filter((change) => change.domain === "space")).toEqual([]);
    expect(result.changes.length).toBeLessThanOrEqual(1);
  });

  it("D: an excessively loud pad gets a gain cut, not an EQ, pan, or compression workaround", () => {
    const result = plan(fixtureD());
    const pad = on(result, "pad");
    expect(pad.some((change) => change.processing.type === "gain" && change.processing.deltaDb < 0)).toBe(true);
    expect(pad.filter((change) => change.processing.type !== "gain")).toEqual([]);
  });

  it("E: static masking gets a static EQ cut, not a dynamic EQ", () => {
    const result = plan(fixtureE());
    const pad = on(result, "pad");
    expect(pad.some((change) => change.processing.type === "eq" && change.processing.filter.gainDb < 0)).toBe(true);
    expect(kinds(pad)).not.toContain("dynamicEq");
    // The cheaper static cut was preferred to the comparable dynamic one.
    const problem = result.problems.find((item) => item.trackIds.includes("pad"))!;
    expect(problem.outcome === "improved" || problem.outcome === "solved").toBe(true);
  });

  it("F: event-specific masking gets a dynamic EQ or a duck, not a permanent cut", () => {
    const result = plan(fixtureF());
    const pad = on(result, "pad");
    const timeVarying = pad.filter((change) => change.processing.type === "dynamics" && (change.processing.processing.type === "dynamic-eq" || change.processing.processing.type === "ducking"));
    expect(timeVarying).toHaveLength(1);
    expect(pad.some((change) => change.processing.type === "eq")).toBe(false);
    const rejected = result.interventions.find((item) => item.outcome !== "selected" && item.items.length === 1 && item.items[0]!.domain === "eq");
    expect(rejected?.reason).toMatch(/rests|removes less/);
  });

  it("G: an already-good mix gets few or no changes", () => {
    for (const strength of ["conservative", "normal", "strong"] as const) {
      const result = plan(fixtureG(), { strength });
      expect(result.changes.length).toBeLessThanOrEqual(1);
    }
  });

  it("H: a drop that lacks its intended contrast gets small section moves, never a blanket gain lift", () => {
    const result = plan(fixtureH());
    const contrast = result.problems.find((problem) => problem.type === "section-contrast");
    expect(contrast).toBeDefined();
    expect(contrast!.evidence.some((item) => item.label === "Width")).toBe(true);
    const drop = result.changes.filter((change) => change.problemIds.includes(contrast!.id));
    expect(drop.length).toBeGreaterThanOrEqual(1);
    expect(drop.length).toBeLessThanOrEqual(2);
    for (const change of drop) expect(change.scope).toEqual({ type: "section", sectionId: "drop" });
    const lifts = result.changes.filter((change) => change.processing.type === "gain" && change.processing.deltaDb > 0);
    expect(lifts.length).toBeLessThanOrEqual(1);
    expect(contrast!.outcome === "solved" || contrast!.outcome === "improved").toBe(true);
  });

  it("H: a section that already has what its note asks for gets nothing (intent biases, measurement decides)", () => {
    const song = fixtureH();
    const wide = { ...song, document: { ...song.document, sections: song.document.sections.map((section) => (section.id === "drop" ? { ...section, userIntent: "Keep the drop as it is, just not narrower." } : section)) } };
    const result = plan(wide);
    expect(result.problems.filter((problem) => problem.type === "section-contrast")).toEqual([]);
  });
});

describe("integrated planning", () => {
  it("does not concatenate the four planners on a multi-problem song", () => {
    const result = plan(multiProblem());
    const types = new Set(result.problems.map((problem) => problem.type));
    expect(types.has("low-end-collision")).toBe(true);
    expect(types.has("excessive-width")).toBe(true);
    expect(types.has("dynamic-instability")).toBe(true);
    expect([...types].some((type) => type === "frequency-conflict" || type === "event-masking")).toBe(true);
    expect(result.changes.length).toBeLessThan(result.evaluation.independent.total);
    // At most one change of each kind on a stem; every change says which problems it serves.
    for (const trackId of new Set(result.changes.map((change) => change.trackId))) {
      const list = kinds(on(result, trackId));
      expect(new Set(list).size).toBe(list.length);
    }
    for (const change of result.changes) expect(change.problemIds.length).toBeGreaterThan(0);
    expect(on(result, "synth").some((change) => change.processing.type === "spatial" && (change.processing.width ?? 2) < 1.7)).toBe(true);
    expect(result.summary.lines.join(" ")).toMatch(/four planners on their own propose/);
  });

  it("never solves one conflict with gain, EQ, pan, and a duck together", () => {
    for (const song of [fixtureA(), fixtureF(), multiProblem()]) {
      const result = plan(song);
      for (const problem of result.problems) {
        const domains = new Set(result.changes.filter((change) => change.problemIds.includes(problem.id) && change.trackId === problem.yieldingTrackId).map((change) => change.domain));
        expect(domains.size).toBeLessThanOrEqual(2);
      }
    }
  });

  it("prefers one change that serves two problems", () => {
    const result = plan(multiBenefit());
    const shared = result.changes.filter((change) => change.problemIds.length >= 2);
    expect(shared.length).toBeGreaterThanOrEqual(1);
    expect(result.changes.length).toBeLessThanOrEqual(2);
  });

  it("is deterministic", () => {
    const first = plan(multiProblem());
    const second = plan(multiProblem());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(fullMixPlanSchema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  it("stops within the strength's pass limit and says why", () => {
    for (const strength of ["conservative", "normal", "strong"] as const) {
      const result = plan(multiProblem(), { strength });
      expect(result.evaluation.passes.length).toBeLessThanOrEqual(MIX_LIMITS_BY_STRENGTH[strength].maxIterations);
      expect(result.evaluation.stopReason.length).toBeGreaterThan(0);
    }
  });

  it("does more with Strong than with Conservative, inside the same limits", () => {
    const conservative = plan(multiProblem(), { strength: "conservative" });
    const strong = plan(multiProblem(), { strength: "strong" });
    expect(conservative.changes.length).toBeLessThanOrEqual(strong.changes.length);
    expect(conservative.evaluation.after.processingCost).toBeLessThanOrEqual(MIX_LIMITS_BY_STRENGTH.conservative.maxTotalCost + 1e-9);
  });

  it("re-measures the candidate: what it reports after is not just the planners' own prediction", () => {
    const result = plan(fixtureB());
    const problem = result.problems.find((item) => item.type === "low-end-collision")!;
    expect(problem.severityAfter).not.toBeNull();
    expect(problem.severityAfter!).toBeLessThan(problem.severity);
    expect(result.evaluation.after.problemScore).toBeLessThan(result.evaluation.before.problemScore);
  });
});

describe("intent", () => {
  const trumpet = (extra: Partial<MixTrackInput> = {}): MixTrackInput => ({ id: "trumpet", name: "Trumpet", role: "brass", fixture: { shape: LEAD }, ...extra });
  const note = (text: string) => [{ id: "all", name: "Chorus", type: "chorus" as const, start: 0, end: 60, intent: text }];

  it("turns 'make the trumpet stand out' into the cheapest effective move, not automatically a trumpet boost", () => {
    const song = mixSong({ tracks: [trumpet(), { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_MASKING }, stereo: { correlation: 0.7 } }], sections: note("Make the trumpet stand out.") });
    const result = plan(song);
    expect(result.problems.some((problem) => problem.trackIds.includes("trumpet"))).toBe(true);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.length).toBeLessThanOrEqual(2);
    // Whatever was chosen, it was weighed against the alternatives, and the trumpet is not simply turned up by several dB.
    const boost = result.changes.find((change) => change.trackId === "trumpet" && change.processing.type === "gain");
    if (boost && boost.processing.type === "gain") expect(boost.processing.deltaDb).toBeLessThanOrEqual(2);
  });

  it("does nothing when the stem a note asks to stand out already does", () => {
    const song = mixSong({ tracks: [trumpet(), { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_SEPARATED }, gainDb: -6 }], sections: note("Make the trumpet stand out.") });
    expect(plan(song).changes).toEqual([]);
  });
});

describe("safety and regressions", () => {
  it("keeps headroom, mono, and gain reduction inside their limits", () => {
    for (const song of [multiProblem(), fixtureB(), fixtureH()]) {
      const result = plan(song);
      const { before, after } = result.evaluation;
      if (before.estimatedPeakDbfs !== null && after.estimatedPeakDbfs !== null) expect(after.estimatedPeakDbfs + result.candidateTrim.gainDb).toBeLessThanOrEqual(Math.max(before.estimatedPeakDbfs, -1) + 0.05);
      if (before.monoLossDb !== null && after.monoLossDb !== null) expect(after.monoLossDb).toBeLessThanOrEqual(before.monoLossDb + 0.5);
      expect(after.maxReductionDb).toBeLessThanOrEqual(8);
    }
  });

  it("rejects a candidate whose change makes the whole mix worse when re-measured", () => {
    const song = fixtureA();
    const surveyor = new Surveyor(song.document, song, "normal", NOW);
    const baseline = surveyor.survey([], PLANNERS);
    const settings: FullMixSettings = { strength: "normal", goal: "balanced" };
    const known = detectMixProblems({ survey: baseline, settings, levels: [] });
    const ctx = { surveyor, settings, limits: MIX_LIMITS_BY_STRENGTH.normal, levels: [], measurements: song.measurements, base: song.document, baseline, mixPeakDbfs: null };
    const names = (id: string) => id;
    const louder = gainChange({ document: song.document, goal: "balanced", names, chosen: [] }, { trackId: "pad", scope: { type: "global" }, currentGainDb: 0, deltaDb: 6, problemId: known[0]!.id, reason: "test", confidence: 0.9 });
    const before = evaluateCandidate(ctx, [], known);
    const worse = evaluateCandidate(ctx, [louder], known);
    expect(worse.score).toBeLessThan(before.score);
    expect(worse.regressions.length).toBeGreaterThan(0);
  });

  it("respects manual processing: a saved compressor that already holds the bass is not duplicated, and stays", () => {
    const manual = compressorNodeSchema.parse({ id: "comp-manual", type: "compressor", enabled: true, origin: "manual", note: "mine", thresholdDb: -20, ratio: 3, attackMs: 30, releaseMs: 200, kneeDb: 6, makeupDb: 0 });
    const song = mixSong({ tracks: [kickTrack(), { ...bassTrack(unstableBass(-12)), fixture: bassTrack().fixture }], sections: wholeSong(), dynamics: [{ track: "bass", nodes: [manual] }] });
    const result = plan(song);
    const compressors = on(result, "bass").filter((change) => change.processing.type === "dynamics" && change.processing.processing.type === "compressor");
    for (const change of compressors) expect(change.replacesNodeId).toBe("comp-manual");
    const applied = applyFullMixPlan(song.document, result, "all");
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      const nodes = applied.document.tracks.find((track) => track.id === "bass")!.processing.dynamics;
      expect(nodes.filter((node) => node.type === "compressor")).toHaveLength(1);
      if (compressors.length === 0) expect(nodes.some((node) => node.id === "comp-manual")).toBe(true);
    }
  });

  it("starts from the current mix: an applied plan is the new baseline and the next run finds less", () => {
    const song = multiProblem();
    const first = plan(song);
    const applied = applyFullMixPlan(song.document, first, "all");
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const second = plan({ ...song, document: applied.document as ProjectDocument });
    expect(second.evaluation.before.problemScore).toBeLessThan(first.evaluation.before.problemScore);
    expect(second.changes.length).toBeLessThan(first.changes.length);
  });

  it("treats a planner's review flag as a person's decision, never chosen automatically", () => {
    const song = fixtureB();
    const result = plan(song);
    for (const change of result.changes) expect(change.status).not.toBe("needs-review");
    void fromBalanceRow;
  });

  it("plans 32 stems in seconds, not minutes", () => {
    const tracks: MixTrackInput[] = Array.from({ length: 32 }, (_, index) => {
      if (index % 4 === 0) return { ...kickTrack(), id: `kick${index}`, name: `Kick ${index}` };
      if (index % 4 === 1) return { ...bassTrack(unstableBass(-12)), id: `bass${index}`, name: `Bass ${index}` };
      if (index % 4 === 2) return { id: `lead${index}`, name: `Lead ${index}`, role: "lead", fixture: { shape: LEAD } };
      return { id: `pad${index}`, name: `Pad ${index}`, role: "pad", fixture: { shape: PAD_MASKING }, stereo: { correlation: 0.7 } };
    });
    const song = mixSong({ tracks, duration: 60, sections: wholeSong() });
    const started = Date.now();
    const result = plan(song);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(result.levels).toHaveLength(32);
  }, 120_000);
});
