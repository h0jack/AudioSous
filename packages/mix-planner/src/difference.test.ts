import { planEq } from "@audiosous/eq-planner";
import { setSectionDynamicsNodes, setTrackDynamicsNodes, setTrackEqNodes, setTrackSpatial, updateTrack, type DynamicsNode, type EqNode, type ProjectDocument } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import { addGain, setGain } from "./changes";
import { differenceScale, eqPlanDifference, explainEq, explainGain, fullMixDifference, keyHits, mixDifference, panLabel } from "./difference";
import { fixtureA, multiProblem } from "./fixtures";
import { planFullMix } from "./planner";
import { changeIncluded } from "./plan";

const NOW = "2026-10-06T00:00:00.000Z";

function song(): ProjectDocument {
  return multiProblem().document;
}

function sectionOf(document: ProjectDocument) {
  return document.sections[0]!;
}

const bell = (id: string, frequencyHz: number, gainDb: number, q = 1.2): EqNode => ({ id, type: "eq", enabled: true, origin: "eq-plan", note: "", filter: { kind: "bell", frequencyHz, gainDb, q } });

function ok<T>(result: { ok: true; document: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.document;
}

describe("gain differences", () => {
  it("shows current, candidate, and delta, and keeps a section move apart from the song", () => {
    const current = song();
    const section = sectionOf(current);
    let candidate = addGain(current, "lead", { type: "global" }, 0.8);
    candidate = setGain(candidate, "pad", { type: "section", sectionId: section.id }, current.tracks.find((track) => track.id === "pad")!.gainDb - 0.6);
    const diff = mixDifference({ current, candidate });
    const lead = diff.gain.find((row) => row.trackId === "lead")!;
    expect(lead).toMatchObject({ deltaDb: 0.8, scope: { sectionId: null, label: "Song" } });
    expect(lead.candidateDb - lead.currentDb).toBeCloseTo(0.8, 5);
    const pad = diff.gain.find((row) => row.trackId === "pad")!;
    expect(pad.scope.sectionId).toBe(section.id);
    expect(pad.deltaDb).toBeCloseTo(-0.6, 5);
    expect(diff.sections).toEqual([expect.objectContaining({ sectionId: section.id, domains: ["gain"], count: 1 })]);
    expect(diff.songWide).toEqual(["gain"]);
    expect(diff.subtle).toBe(true);
    expect(explainGain(lead)).toMatch(/^This is a subtle change: Lead up 0\.8 dB/);
  });
});

describe("safety trim", () => {
  it("is one line, not a move on every stem", () => {
    const current = song();
    let candidate = current;
    for (const track of current.tracks) candidate = addGain(candidate, track.id, { type: "global" }, -0.4);
    candidate = addGain(candidate, "lead", { type: "global" }, 1);
    const diff = mixDifference({ current, candidate, trimDb: -0.4 });
    expect(diff.trimDb).toBe(-0.4);
    expect(diff.gain.map((row) => row.trackId)).toEqual(["lead"]);
    expect(diff.gain[0]!.deltaDb).toBeCloseTo(0.6, 5);
    expect(diff.songWide).toEqual(["gain"]);
  });
});

describe("EQ differences", () => {
  it("draws the net difference curve and finds where it acts", () => {
    const current = song();
    const candidate = ok(setTrackEqNodes(current, "pad", [bell("cut", 2_400, -1.2)]));
    const diff = mixDifference({ current, candidate });
    const row = diff.eq.find((item) => item.trackId === "pad")!;
    expect(row.peakDeltaDb).toBeCloseTo(-1.2, 1);
    expect(row.peakHz).toBeGreaterThan(2_000);
    expect(row.peakHz).toBeLessThan(2_900);
    expect(row.difference.every((point, index) => Math.abs(point.db - (row.candidate[index]!.db - row.current[index]!.db)) < 0.011)).toBe(true);
    expect(row.replacesSaved).toBe(false);
    // A 1.2 dB move is drawn on a ±2 dB difference scale, not lost on ±12.
    expect(diff.eqDifferenceScaleDb).toBe(2);
    expect(explainEq(row, null)).toMatch(/^This is a subtle change\. Pad is only reduced 1\.2 dB around 2\.\d kHz/);
  });

  it("shows the net change when a saved filter is replaced, not the new filter alone", () => {
    const saved = ok(setTrackEqNodes(song(), "pad", [bell("saved", 2_400, -3)]));
    const candidate = ok(setTrackEqNodes(saved, "pad", [bell("saved", 2_400, -4)]));
    const row = mixDifference({ current: saved, candidate }).eq.find((item) => item.trackId === "pad")!;
    expect(row.replacesSaved).toBe(true);
    expect(row.peakDeltaDb).toBeCloseTo(-1, 1);
    expect(Math.min(...row.candidate.map((point) => point.db))).toBeCloseTo(-4, 1);
    expect(Math.min(...row.current.map((point) => point.db))).toBeCloseTo(-3, 1);
  });
});

describe("space differences", () => {
  it("says which way a stem moved and how its width changed", () => {
    const current = ok(setTrackSpatial(song(), "synth", { width: 1.28 }));
    const candidate = ok(setTrackSpatial(current, "synth", { width: 1.12, pan: 0.2 }));
    const row = mixDifference({ current, candidate }).space.find((item) => item.trackId === "synth")!;
    expect(row.current).toEqual({ pan: 0, width: 1.28 });
    expect(row.candidate).toEqual({ pan: 0.2, width: 1.12 });
    expect(row.words).toBe("moved right, narrower");
    expect(panLabel(0.2)).toBe("R20");
  });
});

describe("dynamics differences", () => {
  const duck: DynamicsNode = { id: "duck", type: "ducking", enabled: true, origin: "dynamics-plan", note: "", keyTrackId: "kick", keyDetector: "transient", thresholdDb: -24, rangeDb: -1.4, attackMs: 5, releaseMs: 120 };

  it("aligns a duck's reduction over time with the key's hits", () => {
    const fixture = multiProblem();
    const current = fixture.document;
    const candidate = ok(setTrackDynamicsNodes(current, "bass", [duck]));
    const values = Array.from({ length: 100 }, (_, index) => (index % 10 < 2 ? 1.4 : 0));
    const evaluation = { timeline: { startSeconds: 0, hopSeconds: 0.1, values }, reductionP50Db: 0, reductionP95Db: 1.4, reductionMaxDb: 1.4, spreadBeforeDb: null, spreadAfterDb: null, crestBeforeDb: null, crestAfterDb: null, conflictBeforeDb: 0.4, conflictAfterDb: -1.1, collisionBefore: 0.71, collisionAfter: 0.34, transientBeforeDb: null, transientAfterDb: null } as never;
    const diff = mixDifference({ current, candidate, evidence: [{ trackId: "bass", sectionId: null, domain: "dynamics", dynamicsKind: "ducking", dynamics: evaluation }], envelopes: fixture.envelopes });
    const row = diff.dynamics[0]!;
    expect(row).toMatchObject({ kind: "ducking", change: "added", keyTrackId: "kick", keyName: "Kick", reductionMaxDb: 1.4 });
    expect(row.after).toBe("Duck up to -1.4 dB from Kick, release 120 ms");
    expect(row.activeShare).toBeCloseTo(0.2, 5);
    expect(row.keyEvents!.length).toBeGreaterThan(3);
    expect(row.metrics).toContainEqual({ label: "Kick/Bass hit collision", before: 0.71, after: 0.34, unit: "", better: "lower" });
  });

  it("draws a dynamic EQ's deepest curve and marks section-only processing", () => {
    const current = song();
    const section = sectionOf(current);
    const node: DynamicsNode = { id: "deq", type: "dynamic-eq", enabled: true, origin: "dynamics-plan", note: "", keyTrackId: "lead", keyDetector: "smooth", thresholdDb: -30, rangeDb: -1.8, attackMs: 10, releaseMs: 150, filter: { frequencyHz: 2_400, q: 1.5 } } as DynamicsNode;
    const candidate = ok(setSectionDynamicsNodes(current, "pad", section.id, [node]));
    const diff = mixDifference({ current, candidate });
    const row = diff.dynamics[0]!;
    expect(row.scope.sectionId).toBe(section.id);
    expect(Math.min(...row.dynamicEq!.maxCurve.map((point) => point.db))).toBeCloseTo(-1.8, 1);
    expect(diff.sections[0]!.domains).toEqual(["dynamics"]);
    expect(diff.songWide).toEqual([]);
  });

  it("finds a key's hits in its envelope", () => {
    const fixture = multiProblem();
    const hits = keyHits(fixture.envelopes.kick!, 0, 10)!;
    expect(hits.length).toBeGreaterThan(5);
    expect(hits.every((time, index) => index === 0 || time - hits[index - 1]! >= 0.08)).toBe(true);
    expect(keyHits(null, 0, 10)).toBeNull();
  });
});

describe("the difference scale", () => {
  it("zooms to the largest change and says so", () => {
    expect(differenceScale(0.6)).toBe(1);
    expect(differenceScale(1.2)).toBe(2);
    expect(differenceScale(2.5)).toBe(3);
    expect(differenceScale(5)).toBe(6);
    expect(differenceScale(9)).toBe(12);
  });
});

describe("plan adapters", () => {
  it("Full Mix: every included change appears once, by domain, with interactions before and after", () => {
    const fixture = multiProblem();
    const plan = planFullMix({ ...fixture, now: NOW });
    const diff = fullMixDifference(fixture.document, plan)!;
    const included = plan.changes.filter((change) => changeIncluded(change, "all"));
    const byDomain = (domain: string) => included.filter((change) => change.domain === domain).length;
    expect(diff.counts.eq).toBe(byDomain("eq"));
    expect(diff.counts.space).toBe(byDomain("space"));
    expect(diff.counts.dynamics).toBe(byDomain("dynamics"));
    expect(diff.counts.gain).toBeGreaterThanOrEqual(byDomain("gain"));
    expect(diff.interactions.length).toBeGreaterThan(0);
    for (const interaction of diff.interactions) {
      expect(interaction.measure).toBe(interaction.trackIds.length > 1 ? "interaction" : "problem severity");
      expect(interaction.after).toBeLessThanOrEqual(interaction.before + 0.2);
    }
    expect(diff.metrics.map((metric) => metric.label)).toContain("Open problems");
    expect(diff.metrics.some((metric) => /quality/i.test(metric.label))).toBe(false);
    expect(diff.hierarchy!.length).toBe(fixture.document.tracks.length);
    const duck = diff.dynamics.find((row) => row.kind === "ducking");
    if (duck) expect(duck.timeline!.values.length).toBeGreaterThan(0);
  });

  it("EQ plan: the planner's own rows, with competed share before and after", () => {
    const fixture = fixtureA();
    const plan = planEq({ document: fixture.document, measurements: fixture.measurements, bands: fixture.bands, fingerprints: [], settings: { strength: "normal" } });
    const diff = eqPlanDifference(fixture.document, plan);
    expect(diff.eq.length).toBeGreaterThan(0);
    expect(diff.interactions[0]).toMatchObject({ measure: "competed share" });
    expect(diff.interactions[0]!.after).toBeLessThan(diff.interactions[0]!.before);
  });

  it("an unchanged candidate has no differences", () => {
    const document = song();
    const diff = mixDifference({ current: document, candidate: updateTrack(document, "lead", {}) });
    expect(diff.counts).toEqual({ gain: 0, eq: 0, space: 0, dynamics: 0 });
    expect(diff.sections).toEqual([]);
  });
});
