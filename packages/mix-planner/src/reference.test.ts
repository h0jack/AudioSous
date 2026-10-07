import { setTrackEqNodes, trackEqNodes } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import { multiProblem } from "./fixtures";
import { fullMixPlanSchema } from "./model";
import { applyFullMixPlan, editChange, fullMixPlanIsStale } from "./plan";
import { REFERENCE_REGIONS, compareToReference, planReferenceMatch, type SongProfile } from "./reference";

const NOW = "2026-10-07T00:00:00.000Z";
const EDGES = Array.from({ length: 25 }, (_, index) => 20 * 1000 ** (index / 24));
const CENTERS = EDGES.slice(0, -1).map((low, index) => Math.sqrt(low * EDGES[index + 1]!));

/** A profile with a gentle pink-ish slope, plus `shift(hz)` dB of tonal change and `side(hz)` dB of side level. */
function profile(shift: (hz: number) => number = () => 0, side: (hz: number) => number = () => -8, loudness = -14, plr = 10): SongProfile {
  return {
    version: 1,
    durationSeconds: 60,
    loudness: { integratedLufs: loudness, loudnessRangeLu: 6, samplePeakDbfs: loudness + plr - 0.3, truePeakDbtp: loudness + plr, maxShortTermLufs: loudness + 2 },
    edgesHz: EDGES,
    midDb: CENTERS.map((hz) => -20 - 3 * Math.log2(hz / 1000) + shift(hz)),
    sideDb: CENTERS.map((hz) => -20 - 3 * Math.log2(hz / 1000) + shift(hz) + side(hz)),
    bodyShare: 0.9,
    crestDb: 12,
    lowCorrelation: 0.95,
  };
}

const lowMid = (amount: number) => (hz: number) => (hz >= 150 && hz < 500 ? amount : 0);

function plan(song: ReturnType<typeof multiProblem>, mix: SongProfile, reference: SongProfile, extra: Partial<Parameters<typeof planReferenceMatch>[0]> = {}) {
  return planReferenceMatch({ ...song, mixProfile: mix, referenceProfile: reference, referenceName: "Reference Song", strength: "normal", now: NOW, ...extra });
}

describe("comparing with a reference", () => {
  it("finds nothing when the songs match, whatever their loudness", () => {
    const same = compareToReference(profile(), profile());
    expect(same.tonal.every((gap) => gap.gapDb === 0)).toBe(true);
    expect(same.findings).toEqual([]);
    const louder = compareToReference(profile(() => 0, () => -8, -20), profile(() => 0, () => -8, -9));
    expect(louder.tonal.every((gap) => Math.abs(gap.gapDb) < 0.01)).toBe(true);
    expect(louder.findings[0]).toMatch(/reference is 11\.0 dB louder.*Loudness is set at export/);
  });

  it("reads extra low-mids as muddier, in dB", () => {
    const comparison = compareToReference(profile(lowMid(3)), profile());
    const gap = comparison.tonal.find((item) => item.region.id === "low-mid")!;
    expect(gap.gapDb).toBeGreaterThan(2);
    expect(comparison.findings[0]).toMatch(/low-mids \(150–500 Hz\).*muddier/);
    expect(comparison.bands).toHaveLength(24);
  });

  it("reads width per region and a wider low end", () => {
    const comparison = compareToReference({ ...profile(() => 0, (hz) => (hz >= 500 && hz < 2000 ? -2 : -8)), lowCorrelation: 0.5 }, profile());
    expect(comparison.width.find((item) => item.region.id === "mid")!.gapDb).toBeGreaterThan(4);
    expect(comparison.findings.some((line) => /wider than the reference/.test(line))).toBe(true);
    expect(comparison.findings.some((line) => /close to mono/.test(line))).toBe(true);
  });

  it("reads a denser reference", () => {
    const comparison = compareToReference(profile(() => 0, () => -8, -18, 15), profile(() => 0, () => -8, -9, 8));
    expect(comparison.findings.some((line) => /denser and more limited/.test(line))).toBe(true);
  });
});

describe("planning toward a reference", () => {
  it("cuts the low-mids on the stem that carries them, and predicts the gap closing", () => {
    const song = multiProblem();
    const result = plan(song, profile(lowMid(4)), profile());
    expect(() => fullMixPlanSchema.parse(result)).not.toThrow();
    const lowMidProblem = result.problems.find((problem) => problem.id === "reference:tonal:low-mid")!;
    expect(lowMidProblem).toBeDefined();
    const changes = result.changes.filter((change) => change.problemIds.includes(lowMidProblem.id));
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change.source).toBe("reference");
      expect(change.evidence.kind).toBe("reference");
      if (change.processing.type === "eq") expect(change.processing.filter.gainDb).toBeLessThan(0);
      if (change.evidence.kind === "reference") expect(change.evidence.share).toBeGreaterThanOrEqual(0.12);
    }
    const region = result.reference!.regions.find((item) => item.id === "low-mid")!;
    expect(Math.abs(region.gapAfterDb)).toBeLessThan(Math.abs(region.gapBeforeDb) - 0.5);
    expect(result.summary.headline).toMatch(/Toward “Reference Song”/);
    const applied = applyFullMixPlan(song.document, result, "all");
    expect(applied.ok).toBe(true);
    expect(fullMixPlanIsStale(result, song.document, [], result.settings)).toBe(false);
  });

  it("changes nothing when the mix already sounds like the reference", () => {
    const result = plan(multiProblem(), profile(), profile());
    expect(result.changes).toEqual([]);
    expect(result.summary.headline).toMatch(/within 1\.5 dB/);
  });

  it("never touches a protected stem", () => {
    const song = multiProblem();
    const free = plan(song, profile(lowMid(4)), profile());
    const first = free.changes[0]!.trackId;
    const guarded = plan(song, profile(lowMid(4)), profile(), { constraints: { protectedTrackIds: [first], excludedDomains: [], excludedProcessors: [], sectionIds: null, focusTrackIds: [], focusSectionIds: [], intents: [] } });
    expect(guarded.changes.some((change) => change.trackId === first)).toBe(false);
  });

  it("edits a saved bell in the region instead of stacking another", () => {
    const song = multiProblem();
    const free = plan(song, profile(lowMid(4)), profile());
    const target = free.changes.find((change) => change.processing.type === "eq")!.trackId;
    const saved = setTrackEqNodes(song.document, target, [{ id: "boost-550", type: "eq", enabled: true, origin: "eq-plan", note: "", filter: { kind: "bell", frequencyHz: 300, gainDb: 1.5, q: 0.8 } }]);
    if (!saved.ok) throw new Error(saved.message);
    const result = plan({ ...song, document: saved.document }, profile(lowMid(4)), profile());
    const edit = result.changes.find((change) => change.trackId === target && change.processing.type === "eq")!;
    expect(edit.replacesNodeId).toBe("boost-550");
    expect(edit.current).toBe("+1.5 dB at 300 Hz");
    const applied = applyFullMixPlan(saved.document, result, "all");
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(trackEqNodes(applied.document, target)).toHaveLength(1);
  });

  it("narrows the stems that carry the sides when the mix is wider than the reference", () => {
    const song = multiProblem();
    const result = plan(song, profile(() => 0, (hz) => (hz >= 500 && hz < 6000 ? 0 : -8)), profile());
    const width = result.changes.filter((change) => change.processing.type === "spatial");
    expect(width.length).toBeGreaterThan(0);
    for (const change of width) {
      if (change.processing.type !== "spatial" || change.evidence.kind !== "reference") throw new Error("not a width change");
      expect(change.processing.width!).toBeLessThan(change.evidence.current!.width);
    }
  });

  it("is deterministic and edits like any Full Mix plan", () => {
    const song = multiProblem();
    const first = plan(song, profile(lowMid(4)), profile());
    expect(JSON.stringify(plan(song, profile(lowMid(4)), profile()))).toBe(JSON.stringify(first));
    const change = first.changes.find((item) => item.processing.type === "eq")!;
    const edited = editChange(first, change.id, { gainDb: -1 });
    const after = edited.changes.find((item) => item.id === change.id)!;
    expect(after.edited).toBe(true);
    expect(after.evaluation.summary).toMatch(/Plan again to re-measure/);
  });

  it("covers the audible range in six regions", () => {
    expect(REFERENCE_REGIONS.map((region) => region.id)).toEqual(["sub", "low", "low-mid", "mid", "presence", "air"]);
  });
});
