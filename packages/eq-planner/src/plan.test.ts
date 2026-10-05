import { eqChainAt, setTrackEqNodes } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import {
  applyEqPlan,
  editEqRecommendation,
  eqAudition,
  eqAuditionChainAt,
  eqPlanIsStale,
  eqPlanSchema,
  evaluateFilter,
  refreshEqTrim,
  resetEqRecommendation,
  setEqRecommendationStatus,
  checkRange,
  withProxyChecks,
  type EqPlan,
} from "./plan";
import { planEq } from "./planner";
import { bandPowerGain, chainMagnitudeDb, filterMagnitudeDb, octavesForQ, qForOctaves, responseCurve } from "./response";
import { BASS, KICK, LEAD, NOW, PAD_MASKING, PAD_WITH_SUB, base, bump, song, sum } from "./test-fixtures";

/** Verse and Drop, Lead Focal throughout, a pad that crowds it, a trumpet Focal in the Drop that the pad also crowds. */
function demo() {
  const sections = [
    { id: "verse", name: "Verse", type: "verse" as const, start: 0, end: 40 },
    { id: "drop", name: "Drop", type: "drop" as const, start: 40, end: 60 },
  ];
  return song({
    tracks: [
      { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 } },
      { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS, crest: 8 } },
      { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD, active: [[0, 40]] } },
      { id: "pad", name: "Pad", role: "pad", fixture: { shape: sum(PAD_MASKING, bump(1_300, 0.3, 8)) } },
      { id: "trumpet", name: "Trumpet", role: "brass", fixture: { shape: sum(base(-36, -2), bump(1_300, 0.35, 13)), active: [[40, 60]] } },
    ],
    sections,
    prominence: [
      { track: "bass", section: "verse", prominence: "supporting" },
      { track: "bass", section: "drop", prominence: "supporting" },
      { track: "lead", section: "verse", prominence: "focal" },
      { track: "trumpet", section: "drop", prominence: "focal" },
    ],
  });
}

function planned(): { plan: EqPlan; input: ReturnType<typeof demo> } {
  const input = demo();
  return { plan: planEq({ ...input, now: NOW }), input };
}

describe("EQ plan contract", () => {
  it("round-trips through JSON and the schema", () => {
    const { plan } = planned();
    expect(plan.kind).toBe("frequency-balance");
    expect(plan.planVersion).toBe(1);
    expect(eqPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    for (const change of plan.changes) {
      expect(change.reasons.length).toBeGreaterThan(0);
      expect(change.confidence).toBeGreaterThan(0);
      expect(change.evidence.bandsHz).toHaveLength(24);
    }
  });

  it("has the acceptance shape: bass and pad track-wide, pad again in the Drop", () => {
    const { plan } = planned();
    const bass = plan.changes.find((change) => change.trackId === "bass" && change.purpose === "separation");
    expect(bass?.scope).toEqual({ type: "global" });
    expect(bass!.processing.filter.frequencyHz).toBeLessThan(120);
    const pad = plan.changes.filter((change) => change.trackId === "pad" && change.purpose === "separation");
    const padDrop = pad.find((change) => change.scope.type === "section");
    expect(padDrop?.scope).toEqual({ type: "section", sectionId: "drop" });
    expect(padDrop!.processing.filter.frequencyHz).toBeGreaterThanOrEqual(900);
    expect(padDrop!.processing.filter.frequencyHz).toBeLessThanOrEqual(1_800);
    expect(pad.find((change) => change.scope.type === "global")!.processing.filter.frequencyHz).toBeGreaterThan(2_000);
  });

  it("drops a section filter the track-wide cut already covers", () => {
    const input = song({
      tracks: [
        { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD, active: [[0, 40]] } },
        { id: "pad", name: "Pad", role: "pad", fixture: { shape: sum(PAD_MASKING, bump(2_300, 0.4, 8)) } },
        { id: "trumpet", name: "Trumpet", role: "brass", fixture: { shape: sum(base(-36, -2), bump(2_300, 0.5, 13)), active: [[40, 60]] } },
      ],
      sections: [
        { id: "verse", name: "Verse", type: "verse", start: 0, end: 40 },
        { id: "drop", name: "Drop", type: "drop", start: 40, end: 60 },
      ],
      prominence: [
        { track: "lead", section: "verse", prominence: "focal" },
        { track: "trumpet", section: "drop", prominence: "focal" },
      ],
    });
    const plan = planEq({ ...input, now: NOW });
    const pad = plan.changes.filter((change) => change.trackId === "pad" && change.purpose === "separation");
    const section = pad.find((change) => change.scope.type === "section");
    const global = pad.find((change) => change.scope.type === "global");
    expect(global).toBeTruthy();
    if (section) {
      // Whatever remains is only the extra on top of the track-wide cut.
      expect(section.reasons.join(" ")).toMatch(/track-wide Pad cut already gives|second pass/);
      expect(Math.abs(section.processing.filter.gainDb)).toBeLessThan(Math.abs(global!.processing.filter.gainDb));
    } else {
      expect(plan.summary.notes.join(" ")).toMatch(/Pad needs no extra filter in Drop/);
    }
    // Track-wide and section cuts together never pass the strength's cut limit at one frequency.
    const total = pad.reduce((sum, change) => sum + Math.min(0, change.processing.filter.gainDb), 0);
    expect(total).toBeGreaterThanOrEqual(-3.5 - 0.6);
    if (section) {
      expect(section.processing.filter.gainDb).toBeLessThan(0);
    }
  });

  it("edits a filter, marks it edited, re-checks it, and resets it", () => {
    const { plan } = planned();
    const target = plan.changes.find((change) => change.processing.filter.kind === "bell")!;
    const edited = editEqRecommendation(plan, target.id, { gainDb: target.processing.filter.gainDb / 2 });
    const row = edited.changes.find((change) => change.id === target.id)!;
    expect(row.edited).toBe(true);
    expect(row.processing.filter.gainDb).toBeCloseTo(Math.round((target.processing.filter.gainDb / 2) * 10) / 10, 5);
    expect(row.evaluation!.gapReductionDb).toBeLessThan(target.evaluation!.gapReductionDb);
    expect(row.planned).toEqual(target.planned);
    const back = resetEqRecommendation(edited, target.id).changes.find((change) => change.id === target.id)!;
    expect(back.edited).toBe(false);
    expect(back.processing.filter).toEqual(target.planned);
  });

  it("shows a filter moved off the conflict as no longer helping", () => {
    const { plan } = planned();
    const target = plan.changes.find((change) => change.purpose === "separation" && change.processing.filter.frequencyHz > 1_000)!;
    const moved = editEqRecommendation(plan, target.id, { frequencyHz: 120 });
    expect(moved.changes.find((change) => change.id === target.id)!.evaluation!.gapReductionDb).toBeLessThan(0.3);
  });

  it("clamps edits to the review bounds", () => {
    const { plan } = planned();
    const target = plan.changes[0]!;
    const wild = editEqRecommendation(plan, target.id, { gainDb: -40, q: 50, frequencyHz: 5 });
    const filter = wild.changes.find((change) => change.id === target.id)!.processing.filter;
    expect(filter.frequencyHz).toBeGreaterThanOrEqual(20);
    expect(filter.q).toBeLessThanOrEqual(6);
    if (filter.kind !== "high-pass" && filter.kind !== "low-pass") expect(filter.gainDb).toBeGreaterThanOrEqual(-12);
  });

  it("auditions Current, the whole candidate, and one filter in the full mix", () => {
    const { plan, input } = planned();
    const current = eqAudition(input.document, plan, { mode: "current" });
    expect(current.tracks.every((track) => track.filters.length === 0)).toBe(true);
    expect(current.regions).toEqual([]);
    const candidate = eqAudition(input.document, plan, { mode: "candidate" });
    const included = plan.changes.filter((change) => change.status === "proposed");
    const globalCount = included.filter((change) => change.scope.type === "global").length;
    expect(candidate.tracks.reduce((sum, track) => sum + track.filters.length, 0)).toBe(globalCount);
    const drop = candidate.regions.find((region) => region.trackId === "pad" && region.sectionId === "drop");
    expect(drop?.startSeconds).toBe(40);
    expect(eqAuditionChainAt(candidate, "pad", 50).length).toBeGreaterThan(eqAuditionChainAt(candidate, "pad", 10).length);
    const one = plan.changes[0]!;
    const on = eqAudition(input.document, plan, { mode: "current", focusId: one.id, focusSide: "recommended" });
    const off = eqAudition(input.document, plan, { mode: "current", focusId: one.id, focusSide: "bypassed" });
    const count = (audition: typeof on) => audition.tracks.reduce((sum, track) => sum + track.filters.length, 0) + audition.regions.reduce((sum, region) => sum + region.filters.length, 0);
    expect(count(on)).toBe(1);
    expect(count(off)).toBe(0);
    expect(on.trimDb).toBe(0);
  });

  it("leaves rejected and review rows out of the candidate until accepted", () => {
    const { plan, input } = planned();
    const first = plan.changes.find((change) => change.status === "proposed")!;
    const rejected = setEqRecommendationStatus(plan, first.id, "rejected");
    const audition = eqAudition(input.document, rejected, { mode: "candidate" });
    const filters = [...audition.tracks.flatMap((track) => track.filters), ...audition.regions.flatMap((region) => region.filters)];
    expect(filters).not.toContainEqual(first.processing.filter);
  });

  it("applies accepted rows as processing nodes, leaves sources alone, and keeps the rest out", () => {
    const { plan, input } = planned();
    const [bass, ...rest] = plan.changes;
    let next = setEqRecommendationStatus(plan, bass!.id, "rejected");
    for (const change of rest) next = setEqRecommendationStatus(next, change.id, "accepted");
    const target = rest.find((change) => change.processing.filter.kind === "bell")!;
    next = editEqRecommendation(next, target.id, { gainDb: -0.9 });
    const applied = applyEqPlan(input.document, next, "accepted");
    expect(applied.tracks.map((track) => track.file)).toEqual(input.document.tracks.map((track) => track.file));
    const allNodes = [...applied.tracks.flatMap((track) => track.processing.nodes), ...applied.sectionTrackSettings.flatMap((row) => row.processing.nodes)];
    expect(allNodes).toHaveLength(rest.length);
    expect(allNodes.every((node) => node.origin === "eq-plan" && node.enabled && node.note)).toBe(true);
    expect(allNodes.map((node) => node.filter)).toContainEqual(expect.objectContaining({ gainDb: -0.9 }));
    if (bass!.trackId !== target.trackId || bass!.scope.type !== target.scope.type) {
      expect(eqChainAt(applied, bass!.trackId, 10)).not.toContainEqual(bass!.processing.filter);
    }
    expect(eqPlanIsStale(next, applied)).toBe(true);
    const none = applyEqPlan(input.document, plan, "accepted");
    expect(none.tracks.every((track) => track.processing.nodes.length === 0)).toBe(true);
  });

  it("Apply all takes proposed and accepted rows but not review rows", () => {
    const { plan, input } = planned();
    const applied = applyEqPlan(input.document, plan, "all");
    const count = [...applied.tracks.flatMap((track) => track.processing.nodes), ...applied.sectionTrackSettings.flatMap((row) => row.processing.nodes)].length;
    expect(count).toBe(plan.changes.filter((change) => change.status === "proposed").length);
  });

  it("replaces a saved node rather than adding a second one on apply", () => {
    const input = song({
      tracks: [
        { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD } },
        { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_MASKING } },
      ],
      sections: [{ id: "all", name: "Chorus", type: "chorus", start: 0, end: 60 }],
      prominence: [{ track: "lead", section: "all", prominence: "focal" }],
    });
    const saved = setTrackEqNodes(input.document, "pad", [
      { id: "manual-1", type: "eq", enabled: true, filter: { kind: "bell", frequencyHz: 2_800, gainDb: -0.5, q: 1 }, origin: "manual", note: null },
    ]);
    if (!saved.ok) throw new Error(saved.message);
    const plan = planEq({ document: saved.document, measurements: input.measurements, now: NOW });
    const change = plan.changes.find((item) => item.replacesNodeId === "manual-1");
    expect(change).toBeTruthy();
    const applied = applyEqPlan(saved.document, plan, "all");
    const nodes = applied.tracks.find((track) => track.id === "pad")!.processing.nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.filter.gainDb).toBeLessThan(-0.5);
    const audition = eqAudition(saved.document, plan, { mode: "candidate" });
    expect(audition.tracks.find((track) => track.trackId === "pad")!.filters).toHaveLength(1);
  });

  it("adds a safety trim only for boosts, and keeps it apart from the EQ rows", () => {
    const { plan } = planned();
    expect(plan.candidateTrim.gainDb).toBe(0);
    const target = plan.changes.find((change) => change.processing.filter.kind === "bell")!;
    const loud = { ...plan, levels: plan.levels.map((level) => ({ ...level, peakDbfs: -1.2, shares: level.shares.map(() => 1 / 24) })) };
    const boosted = editEqRecommendation(loud, target.id, { gainDb: 6, q: 0.5 });
    const trimmed = refreshEqTrim(boosted);
    expect(trimmed.candidateTrim.gainDb).toBeLessThan(0);
    expect(trimmed.candidateTrim.reason).toMatch(/safety trim, not an EQ decision/);
    expect(trimmed.summary.notes.join(" ")).toMatch(/Headroom trim/);
  });

  it("keeps an HPF row's evaluation about the low end", () => {
    const input = song({
      tracks: [
        { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 } },
        { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS } },
        { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_WITH_SUB } },
      ],
    });
    const plan = planEq({ ...input, now: NOW });
    const hpf = plan.changes.find((change) => change.processing.filter.kind === "high-pass")!;
    expect(hpf.evaluation!.identityChangeDb).toBeGreaterThan(-1.5);
    expect(hpf.evaluation!.regionChangeDb).toBeLessThan(-3);
  });
});

describe("proxy checks", () => {
  it("keeps agreeing filters, sends a filter that did nothing to review, and notes the run", () => {
    const { plan } = planned();
    const [first, second] = plan.changes.filter((change) => change.status === "proposed");
    const range = checkRange(first!);
    expect(range.lowHz).toBeLessThan(range.highHz);
    const checked = withProxyChecks(plan, [
      { id: first!.id, regionChangeDb: first!.evaluation!.regionChangeDb - 0.2, identityChangeDb: -0.5, seconds: 18 },
      { id: second!.id, regionChangeDb: -0.05, identityChangeDb: 0, seconds: 18 },
    ]);
    const kept = checked.changes.find((change) => change.id === first!.id)!;
    const flagged = checked.changes.find((change) => change.id === second!.id)!;
    expect(kept.status).toBe("proposed");
    expect(kept.evaluation!.proxy!.agrees).toBe(true);
    expect(flagged.status).toBe("needs-review");
    expect(flagged.reasons.at(-1)).toMatch(/On the playback proxy .* waits for a listen/);
    expect(checked.summary.notes.join(" ")).toMatch(/Proxy check: 2 filters were run .* 1 matched the prediction, 1 went to review/);
    expect(eqPlanSchema.parse(checked)).toEqual(checked);
  });
});

describe("filter response", () => {
  it("matches the cookbook at the reference points", () => {
    expect(filterMagnitudeDb({ kind: "bell", frequencyHz: 2_400, gainDb: -1.4, q: 1 }, 2_400)).toBeCloseTo(-1.4, 3);
    expect(filterMagnitudeDb({ kind: "bell", frequencyHz: 2_400, gainDb: -1.4, q: 1 }, 100)).toBeGreaterThan(-0.02);
    expect(filterMagnitudeDb({ kind: "high-pass", frequencyHz: 68, gainDb: 0, q: 0.707 }, 68)).toBeCloseTo(-3.01, 1);
    expect(filterMagnitudeDb({ kind: "low-pass", frequencyHz: 9_000, gainDb: 0, q: 0.707 }, 9_000)).toBeCloseTo(-3.01, 1);
    expect(filterMagnitudeDb({ kind: "low-shelf", frequencyHz: 150, gainDb: -3, q: 0.707 }, 25)).toBeCloseTo(-3, 1);
    expect(filterMagnitudeDb({ kind: "high-shelf", frequencyHz: 8_000, gainDb: 2, q: 0.707 }, 19_000)).toBeCloseTo(2, 0);
  });

  it("adds filters in dB and averages band power", () => {
    const filters = [
      { kind: "bell" as const, frequencyHz: 1_000, gainDb: -2, q: 1 },
      { kind: "bell" as const, frequencyHz: 1_000, gainDb: -1, q: 1 },
    ];
    expect(chainMagnitudeDb(filters, 1_000)).toBeCloseTo(-3, 3);
    expect(10 * Math.log10(bandPowerGain(filters, 900, 1_100))).toBeLessThan(-2.8);
    expect(bandPowerGain([], 100, 200)).toBe(1);
    const curve = responseCurve(filters);
    expect(curve).toHaveLength(120);
    expect(curve[0]!.hz).toBeCloseTo(20, 5);
    expect(curve[119]!.hz).toBeCloseTo(20_000, 0);
  });

  it("converts between Q and octaves", () => {
    expect(qForOctaves(octavesForQ(1.4))).toBeCloseTo(1.4, 5);
    expect(octavesForQ(1.41)).toBeCloseTo(1, 1);
  });

  it("evaluates a misplaced cut as no help", () => {
    const { plan } = planned();
    const target = plan.changes.find((change) => change.purpose === "separation" && change.processing.filter.frequencyHz > 1_000)!;
    const right = evaluateFilter(target.evidence, target.processing.filter, "separation");
    const wrong = evaluateFilter(target.evidence, { ...target.processing.filter, frequencyHz: 9_000 }, "separation");
    expect(right.gapReductionDb).toBeGreaterThan(wrong.gapReductionDb);
    expect(wrong.gapReductionDb).toBeLessThan(0.4);
  });
});
