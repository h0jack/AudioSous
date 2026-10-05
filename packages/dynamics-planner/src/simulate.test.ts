import { describe, expect, it } from "vitest";
import { reductionDb, simulateCompressor, simulateDucking, simulateDynamicEq, transientGainDb, downsampleMax } from "./simulate";

describe("envelope simulation", () => {
  it("uses the native static curve", () => {
    expect(reductionDb(-10, -20, 4, 0)).toBeCloseTo(7.5, 6);
    expect(reductionDb(-20, -20, 2, 6)).toBeCloseTo(0.375, 6);
    expect(reductionDb(-30, -20, 4, 6)).toBe(0);
  });

  it("settles a compressor at the static curve and follows its attack and release", () => {
    const level = Array.from({ length: 300 }, (_, frame) => (frame >= 100 && frame < 200 ? -8 : -30));
    const reduction = simulateCompressor(level, { thresholdDb: -20, ratio: 3, attackMs: 20, releaseMs: 100, kneeDb: 0, makeupDb: 0 });
    expect(reduction[99]).toBe(0);
    expect(reduction[102]!).toBeGreaterThan(8 * 0.5);
    expect(reduction[102]!).toBeLessThan(8 * 0.85);
    expect(reduction[199]!).toBeCloseTo(8, 2);
    expect(reduction[209]!).toBeCloseTo(8 * Math.exp(-1), 0);
  });

  it("ducks from a transient key's hits and recovers, and a smooth key rides a phrase", () => {
    const peak = Array.from({ length: 200 }, (_, frame) => (frame % 50 === 0 ? -4 : -60));
    const rms = peak.map((value) => value - 3);
    const duck = simulateDucking(peak, rms, { thresholdDb: -16, rangeDb: -2, attackMs: 5, releaseMs: 100, keyDetector: "transient" });
    expect(Math.max(...duck)).toBeLessThanOrEqual(2 + 1e-9);
    expect(duck[51]!).toBeGreaterThan(1.5);
    expect(duck[95]!).toBeLessThan(0.3);
    const phrase = Array.from({ length: 300 }, (_, frame) => (frame >= 100 && frame < 200 ? -10 : -80));
    const smooth = simulateDucking(phrase, phrase, { thresholdDb: -24, rangeDb: -1.5, attackMs: 40, releaseMs: 300, keyDetector: "smooth" });
    expect(smooth[190]!).toBeCloseTo(1.5, 1);
    expect(smooth[90]!).toBe(0);
  });

  it("activates a dynamic EQ per step and caps it at full range", () => {
    const activation = simulateDynamicEq([-40, -20, -10, -10, -40, -40], { thresholdDb: -24, rangeDb: -2, attackMs: 20, releaseMs: 250 }, 0.25);
    expect(activation[0]).toBe(0);
    expect(activation[2]!).toBeGreaterThan(0.99);
    expect(activation[4]!).toBeLessThan(activation[3]!);
    expect(activation[4]!).toBeGreaterThan(0);
  });

  it("predicts transient shaping from the hit's rise and draws a reduction by bucket", () => {
    expect(transientGainDb(20, -0.1, 0).attackDb).toBeCloseTo(-0.9, 6);
    expect(transientGainDb(9, 0.2, 0).attackDb).toBeCloseTo(0.81, 6);
    expect(transientGainDb(20, 0, 0.1).bodyDb).toBeCloseTo(1, 6);
    expect(transientGainDb(20, -0.1, 0).bodyDb).toBeCloseTo(-0.15, 6);
    expect(downsampleMax([0, 1, 0, 3, 0, 2], 3)).toEqual([1, 3, 2]);
  });
});
