import type { EqNode } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import {
  SAVED_COMPRESSOR,
  SAVED_DYNAMIC_EQ,
  alreadyGood,
  bassTrack,
  demonstration,
  fixtureA,
  fixtureB,
  fixtureC,
  fixtureD,
  fixtureE,
  fixtureF,
  fixtureG,
  fixtureH,
  kickTrack,
  sectionFixture,
  steadyBass,
} from "./fixtures";
import type { DynamicsPlan, DynamicsRecommendation } from "./plan";
import { planDynamics, type PlanDynamicsInput } from "./planner";
import { AUTO_RANGES, DYNAMICS_LIMITS_BY_STRENGTH, type DynamicsStrength } from "./settings";
import { BASS, KICK, LEAD, NOW, PAD_MASKING, dynamicsSong, hits, notes, wholeSong } from "./test-fixtures";

function plan(input: Omit<PlanDynamicsInput, "now">, strength: DynamicsStrength = "normal"): DynamicsPlan {
  return planDynamics({ ...input, now: NOW, settings: { strength } });
}

function only(result: DynamicsPlan, type: DynamicsRecommendation["processing"]["type"], trackId?: string): DynamicsRecommendation[] {
  return result.changes.filter((change) => change.processing.type === type && (!trackId || change.trackId === trackId));
}

function inAutoRange(change: DynamicsRecommendation): void {
  const processing = change.processing;
  if (processing.type === "compressor") {
    expect(processing.ratio).toBeGreaterThanOrEqual(AUTO_RANGES.minRatio);
    expect(processing.ratio).toBeLessThanOrEqual(AUTO_RANGES.maxRatio);
    expect(processing.attackMs).toBeGreaterThanOrEqual(AUTO_RANGES.minAttackMs);
    expect(processing.attackMs).toBeLessThanOrEqual(AUTO_RANGES.maxAttackMs);
    expect(processing.releaseMs).toBeGreaterThanOrEqual(AUTO_RANGES.minReleaseMs);
    expect(processing.releaseMs).toBeLessThanOrEqual(AUTO_RANGES.maxReleaseMs);
    expect(processing.kneeDb).toBeLessThanOrEqual(AUTO_RANGES.maxKneeDb);
    expect(processing.makeupDb).toBe(0);
  }
  if (processing.type === "ducking") {
    expect(-processing.rangeDb).toBeGreaterThanOrEqual(AUTO_RANGES.minDuckDb);
    expect(-processing.rangeDb).toBeLessThanOrEqual(AUTO_RANGES.maxDuckDb);
  }
  if (processing.type === "dynamic-eq") {
    expect(-processing.rangeDb).toBeGreaterThanOrEqual(AUTO_RANGES.minDynamicEqDb);
    expect(-processing.rangeDb).toBeLessThanOrEqual(AUTO_RANGES.maxDynamicEqDb);
    expect(processing.filter.q).toBeGreaterThanOrEqual(AUTO_RANGES.minQ);
    expect(processing.filter.q).toBeLessThanOrEqual(AUTO_RANGES.maxQ);
  }
  if (processing.type === "transient") {
    expect(Math.abs(processing.attack)).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(Math.abs(processing.sustain)).toBeLessThanOrEqual(0.2 + 1e-9);
  }
  expect(change.confidence).toBeGreaterThan(0);
  expect(change.reasons.length).toBeGreaterThan(0);
}

describe("compression (fixtures A and B)", () => {
  it("A: compresses an unstable bass moderately, sized by its result", () => {
    const result = plan(fixtureA());
    const [comp, ...rest] = only(result, "compressor", "bass");
    expect(rest).toEqual([]);
    expect(comp).toBeDefined();
    inAutoRange(comp!);
    expect(comp!.scope).toEqual({ type: "global" });
    expect(comp!.targetReductionDb).toEqual(DYNAMICS_LIMITS_BY_STRENGTH.normal.grTarget);
    const evaluation = comp!.evaluation!;
    expect(evaluation.reductionP95Db).toBeGreaterThanOrEqual(1.2);
    expect(evaluation.reductionP95Db).toBeLessThanOrEqual(4);
    expect(evaluation.spreadBeforeDb! - evaluation.spreadAfterDb!).toBeGreaterThanOrEqual(1.5);
    expect(evaluation.crestBeforeDb! - evaluation.crestAfterDb!).toBeLessThan(3);
    expect(comp!.status).toBe("proposed");
    expect(comp!.confidence).toBeGreaterThanOrEqual(0.55);
    expect(comp!.reasons[0]).toMatch(/Compresses Bass because its sustained level swings \d+\.\d dB through the song .* gives about \d+\.\d dB of reduction on the loudest sustained passages \(target 2–4 dB\)/);
    expect(comp!.reasons[1]).toMatch(/Makeup is 0 dB/);
    expect(result.readings.find((reading) => reading.trackId === "bass")!.classification).toBe("level-inconsistency");
  });

  it("B: leaves a high-crest but steady bass alone", () => {
    const result = plan(fixtureB());
    expect(result.changes).toEqual([]);
    expect(result.readings.find((reading) => reading.trackId === "bass" && reading.spreadDb !== null)!.classification).toBe("steady");
    expect(result.summary.headline).toMatch(/already serve the mix/);
  });

  it("does not compress a stem that is only consistently loud: that is a gain question", () => {
    const result = plan(dynamicsSong({ tracks: [bassTrack(steadyBass(-3), 6)] }));
    expect(only(result, "compressor")).toEqual([]);
  });

  it("does not read section-level steps as instability (AutoBalance's section gain handles those)", () => {
    const result = plan(
      dynamicsSong({
        tracks: [bassTrack((seconds) => steadyBass(seconds < 30 ? -20 : -11)(seconds))],
        sections: [
          { id: "verse", name: "Verse", type: "verse", start: 0, end: 30 },
          { id: "drop", name: "Drop", type: "drop", start: 30, end: 60 },
        ],
      }),
    );
    expect(only(result, "compressor")).toEqual([]);
  });
});

describe("ducking (fixtures C and D)", () => {
  it("C: ducks the bass a little from the kick, with a fast attack and a musical release", () => {
    const result = plan(fixtureC());
    const [duck] = only(result, "ducking", "bass");
    expect(duck).toBeDefined();
    inAutoRange(duck!);
    if (duck!.processing.type !== "ducking") throw new Error("not a duck");
    expect(duck!.processing.keyTrackId).toBe("kick");
    expect(duck!.processing.keyDetector).toBe("transient");
    expect(-duck!.processing.rangeDb).toBeGreaterThanOrEqual(1.5);
    expect(-duck!.processing.rangeDb).toBeLessThanOrEqual(3);
    expect(duck!.processing.attackMs).toBeGreaterThanOrEqual(2);
    expect(duck!.processing.attackMs).toBeLessThanOrEqual(10);
    expect(duck!.processing.releaseMs).toBeGreaterThanOrEqual(80);
    expect(duck!.processing.releaseMs).toBeLessThanOrEqual(180);
    const evaluation = duck!.evaluation!;
    expect(evaluation.conflictBeforeDb! - evaluation.conflictAfterDb!).toBeGreaterThan(1);
    expect(evaluation.recovery!).toBeGreaterThanOrEqual(0.6);
    expect(evaluation.levelChangeDb).toBeGreaterThan(-1.5);
    expect(duck!.relatedTrackIds).toEqual(["kick"]);
    expect(duck!.reasons[0]).toMatch(/Ducks Bass by up to \d\.\d dB from the Kick because their low end \(under 150 Hz\) overlaps around each Kick hit/);
    expect(result.interactions.find((item) => item.kind === "low-end")).toMatchObject({ trackA: "kick", trackB: "bass", recommendedTool: "ducking", outcome: "recommendation" });
  });

  it("D: does not duck a bass that already clears the kick", () => {
    const result = plan(fixtureD());
    expect(only(result, "ducking")).toEqual([]);
    expect(result.interactions.find((item) => item.kind === "low-end")).toMatchObject({ outcome: "already-separated", recommendedTool: "none" });
  });

  it("hears the current mix: a bass turned down 10 dB, or cut under the kick by EQ, no longer needs a duck", () => {
    expect(only(plan(fixtureC({ bassGainDb: -10 })), "ducking")).toEqual([]);
    const cut: EqNode = { id: "eq-low", type: "eq", enabled: true, filter: { kind: "low-shelf", frequencyHz: 160, gainDb: -10, q: 0.7 }, origin: "manual", note: null };
    expect(only(plan(fixtureC({ eq: [{ track: "bass", nodes: [cut] }] })), "ducking")).toEqual([]);
  });

  it("edits a saved duck from the same key instead of adding another", () => {
    const saved = { id: "duck-old", type: "ducking" as const, enabled: true, origin: "manual" as const, note: null, keyTrackId: "kick", keyDetector: "transient" as const, thresholdDb: -10, rangeDb: -0.5, attackMs: 5, releaseMs: 100 };
    const result = plan(fixtureC({ dynamics: [{ track: "bass", nodes: [saved] }] }));
    const ducks = only(result, "ducking", "bass");
    expect(ducks).toHaveLength(1);
    expect(ducks[0]!.replacesNodeId).toBe("duck-old");
  });
});

describe("event masking (fixtures E and F)", () => {
  it("E: keys the pad from the lead only where it masks, instead of cutting it for the whole song", () => {
    const result = plan(fixtureE());
    const rows = result.changes.filter((change) => change.trackId === "pad");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(["dynamic-eq", "ducking"]).toContain(row.processing.type);
    expect(row.problem).toBe("event-masking");
    inAutoRange(row);
    if (row.processing.type !== "dynamic-eq") throw new Error("expected a dynamic EQ for a masking region this concentrated");
    expect(row.processing.keyTrackId).toBe("lead");
    expect(row.processing.keyDetector).toBe("smooth");
    expect(row.processing.filter.frequencyHz).toBeGreaterThan(1_500);
    expect(row.processing.filter.frequencyHz).toBeLessThan(4_000);
    const evaluation = row.evaluation!;
    expect(evaluation.collisionAfter!).toBeLessThan(evaluation.collisionBefore!);
    expect(Math.abs(evaluation.outsideChangeDb!)).toBeLessThan(0.2);
    expect(row.reasons[0]).toMatch(/Dips Pad by up to \d\.\d dB around .* only while Lead plays: .* Lead is silent for \d+% of Pad's playing time, so a static cut would thin Pad needlessly/);
    expect(result.interactions.find((item) => item.trackB === "pad")).toMatchObject({ kind: "event-masking", recommendedTool: "dynamic-eq" });
  });

  it("F: proposes no dynamic EQ when the masking is persistent; static EQ is the right tool", () => {
    const result = plan(fixtureF());
    expect(result.changes).toEqual([]);
    expect(result.interactions.find((item) => item.trackB === "pad")).toMatchObject({ kind: "sustained-masking", recommendedTool: "static-eq", outcome: "static" });
    expect(result.summary.notes.some((note) => /static EQ .* is the right class of tool/.test(note))).toBe(true);
  });

  it("edits a saved dynamic EQ near the same frequency instead of adding another", () => {
    const result = plan(fixtureE({ dynamics: [{ track: "pad", nodes: [SAVED_DYNAMIC_EQ] }] }));
    const rows = only(result, "dynamic-eq", "pad");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.replacesNodeId).toBe("deq-old");
  });
});

describe("transients (fixtures G and H)", () => {
  it("G: softens a spiky Supporting snare a little", () => {
    const result = plan(fixtureG());
    const [row] = only(result, "transient", "snare");
    expect(row).toBeDefined();
    inAutoRange(row!);
    if (row!.processing.type !== "transient") throw new Error("not transient");
    expect(row!.processing.attack).toBeLessThan(0);
    expect(row!.processing.attack).toBeGreaterThanOrEqual(-0.15);
    expect(row!.processing.sustain).toBe(0);
    expect(row!.problem).toBe("transient-excess");
    expect(row!.evaluation!.transientAfterDb!).toBeLessThan(row!.evaluation!.transientBeforeDb!);
    expect(row!.reasons[0]).toMatch(/Lowers Snare's attack by \d+% because its hits peak \+\d+\.\d dB against the rest of the mix while it is a Supporting part/);
  });

  it("H: sharpens a Focal snare whose attack is buried, and leaves it alone when it is not Focal", () => {
    const [row] = only(plan(fixtureH()), "transient", "snare");
    expect(row).toBeDefined();
    if (row!.processing.type !== "transient") throw new Error("not transient");
    expect(row!.processing.attack).toBeGreaterThan(0);
    expect(row!.processing.attack).toBeLessThanOrEqual(0.2);
    expect(row!.problem).toBe("transient-weakness");
    expect(only(plan(fixtureH("supporting")), "transient")).toEqual([]);
  });

  it("does not shape transients and compress the same stem", () => {
    const result = plan(demonstration());
    for (const track of new Set(result.changes.map((change) => change.trackId))) {
      const types = result.changes.filter((change) => change.trackId === track).map((change) => change.processing.type);
      expect(types.includes("compressor") && types.includes("transient")).toBe(false);
    }
  });
});

describe("existing processing, scope, and the already-good mix", () => {
  it("edits a saved compressor close to the target instead of stacking a second one", () => {
    const result = plan(fixtureA({ dynamics: [{ track: "bass", nodes: [SAVED_COMPRESSOR] }] }));
    const rows = only(result, "compressor", "bass");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.replacesNodeId).toBe("comp-old");
    expect(rows[0]!.reasons[0]).toMatch(/^Adjusts the saved compressor on Bass/);
  });

  it("proposes nothing when a saved compressor already does the job", () => {
    const doing = { ...SAVED_COMPRESSOR, thresholdDb: -21, ratio: 3 };
    expect(only(plan(fixtureA({ dynamics: [{ track: "bass", nodes: [doing] }] })), "compressor")).toEqual([]);
  });

  it("compresses only the section that needs it", () => {
    const rows = only(plan(sectionFixture()), "compressor", "bass");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).toEqual({ type: "section", sectionId: "drop" });
    expect(rows[0]!.reasons.some((reason) => /Only in the Drop/.test(reason))).toBe(true);
  });

  it("leaves an already-good mix untouched at every strength", () => {
    for (const strength of ["conservative", "normal", "strong"] as const) {
      const result = plan(alreadyGood(), strength);
      expect(result.changes.length, strength).toBeLessThanOrEqual(strength === "strong" ? 1 : 0);
    }
  });

  it("plans the acceptance demonstration: bass compression, a Drop duck, a keyed pad dip, a softer snare", () => {
    const result = plan(demonstration());
    const kinds = result.changes.map((change) => `${change.trackId}:${change.processing.type}:${change.scope.type === "global" ? "global" : change.scope.sectionId}`).sort();
    expect(kinds).toEqual(["bass:compressor:global", "bass:ducking:drop", "pad:dynamic-eq:global", "snare:transient:global"]);
    expect(result.changes.every((change) => change.status === "proposed")).toBe(true);
    for (const change of result.changes) inAutoRange(change);
  });
});

describe("intent", () => {
  it("reads a request for control as a lower spread threshold and a request for natural as a gentler one", () => {
    // A bass that swings a little: under the threshold without a note.
    const mild = () => notes({ levelDb: -14, period: 0.5, offsets: [0, -3.5, -0.5, -4, 0, -3.5, -1, -4.5], decayDb: 1, lowDb: -1 });
    const base = { tracks: [bassTrack(mild())], sections: wholeSong() };
    expect(only(plan(dynamicsSong(base)), "compressor")).toEqual([]);
    const controlled = dynamicsSong({ ...base, prominence: [{ track: "bass", section: "all", prominence: "primary", intent: "Keep the bass controlled." }] });
    expect(only(plan(controlled), "compressor")).toHaveLength(1);
    const natural = plan(fixtureA({ sections: wholeSong(), prominence: [{ track: "bass", section: "all", prominence: "primary", intent: "Keep the bass natural." }] }));
    for (const row of only(natural, "compressor")) if (row.processing.type === "compressor") expect(row.processing.ratio).toBeLessThanOrEqual(2);
  });

  it("lets the kick punch through the bass at a smaller collision, but punchy alone never adds a duck", () => {
    // A bass that meets the kick on only some hits.
    const partial = notes({ levelDb: -12, period: 0.5, offsets: [0, -6, -6, -6, 0, -6, -6, -6, -6, -6], decayDb: 1, lowDb: -1 });
    const song = (intent?: string) =>
      dynamicsSong({
        tracks: [kickTrack(), bassTrack(partial)],
        sections: wholeSong(),
        ...(intent ? { prominence: [{ track: "kick", section: "all", prominence: "primary" as const, intent }] } : {}),
      });
    expect(only(plan(song()), "ducking")).toEqual([]);
    expect(only(plan(song("Make the kick punchy.")), "ducking")).toEqual([]);
    const pair = dynamicsSong({ tracks: [kickTrack(), bassTrack(notes({ levelDb: -13, period: 0.5, offsets: [0, 0, -6, 0, -6], decayDb: 1, lowDb: -1 }))], sections: [{ ...wholeSong()[0]!, intent: "Let the kick punch through the bass." }] });
    const without = dynamicsSong({ tracks: [kickTrack(), bassTrack(notes({ levelDb: -13, period: 0.5, offsets: [0, 0, -6, 0, -6], decayDb: 1, lowDb: -1 }))], sections: wholeSong() });
    const asked = only(plan(pair), "ducking");
    expect(asked.length).toBeGreaterThanOrEqual(only(plan(without), "ducking").length);
    if (asked.length > 0) expect(asked[0]!.reasons.join(" ")).toMatch(/Let the kick punch through the bass/);
  });

  it("allows an audible pump only when it is asked for, and sends it to review", () => {
    const pumping = dynamicsSong({
      tracks: [kickTrack(), bassTrack(notes({ levelDb: -8, period: 0.5, decayDb: 1, lowDb: -1 }))],
      sections: [{ ...wholeSong()[0]!, intent: "Make the bass pump with the kick." }],
    });
    const [duck] = only(plan(pumping, "strong"), "ducking");
    expect(duck).toBeDefined();
    if (duck!.processing.type !== "ducking") throw new Error("not a duck");
    expect(-duck!.processing.rangeDb).toBeGreaterThan(3);
    expect(duck!.status).toBe("needs-review");
  });
});

describe("strength, determinism, and scale", () => {
  it("scales reduction, duck depth, and dip depth with strength", () => {
    for (const strength of ["conservative", "normal", "strong"] as const) {
      const limits = DYNAMICS_LIMITS_BY_STRENGTH[strength];
      for (const row of plan(fixtureC(), strength).changes) if (row.processing.type === "ducking") expect(-row.processing.rangeDb).toBeLessThanOrEqual(limits.maxDuckDb);
      for (const row of plan(fixtureE(), strength).changes) if (row.processing.type === "dynamic-eq") expect(-row.processing.rangeDb).toBeLessThanOrEqual(limits.maxDynamicEqDb);
      for (const row of plan(fixtureA(), strength).changes) {
        if (row.processing.type !== "compressor") continue;
        expect(row.processing.ratio).toBeLessThanOrEqual(limits.maxRatio);
        expect(row.evaluation!.reductionP95Db).toBeLessThanOrEqual(limits.grTarget.max + 1e-9);
      }
    }
  });

  it("gives the same plan for the same input", () => {
    const input = demonstration();
    expect(JSON.stringify(plan(input))).toBe(JSON.stringify(plan(input)));
  });

  it("plans 32 stems in reasonable time", () => {
    const tracks = Array.from({ length: 32 }, (_, index) => {
      if (index % 8 === 0) return { ...kickTrack(), id: `kick${index}`, name: `Kick ${index}` };
      if (index % 8 === 1) return { ...bassTrack(), id: `bass${index}`, name: `Bass ${index}` };
      if (index % 8 === 2) return { id: `lead${index}`, name: `Lead ${index}`, role: "lead" as const, fixture: { shape: LEAD, active: [[10, 30]] as Array<[number, number]> }, envelope: notes({ levelDb: -16, period: 0.4 }) };
      if (index % 8 === 3) return { id: `pad${index}`, name: `Pad ${index}`, role: "pad" as const, fixture: { shape: PAD_MASKING }, envelope: notes({ levelDb: -20, period: 2 }) };
      return { id: `t${index}`, name: `Part ${index}`, role: "synth" as const, fixture: { shape: index % 2 ? KICK : BASS }, envelope: hits({ peakDb: -14, period: 0.25 + (index % 3) * 0.125 }) };
    });
    const input = dynamicsSong({ tracks, duration: 60 });
    const started = Date.now();
    const result = plan(input);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.summary.tracksAnalyzed).toBe(32);
  });
});

describe("unmeasured stems", () => {
  it("leaves out a stem without envelope frames and says so", () => {
    const input = fixtureC();
    const result = plan({ ...input, envelopes: { kick: input.envelopes.kick! } });
    expect(result.changes).toEqual([]);
    expect(result.summary.analysisSource).toMatch(/1 stem has no envelope yet/);
  });
});

void KICK;
void BASS;
