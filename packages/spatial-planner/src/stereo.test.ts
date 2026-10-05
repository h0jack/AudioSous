import { describe, expect, it } from "vitest";
import { equalPowerPan, fieldShares, imageOf, occupancy, overlapOf, placeStats, widthLevelChangeDb, type Lrc } from "./stereo";

/** Balanced stereo with a given correlation and unit mid power. */
function stereo(correlation: number, balance = 0): Lrc {
  const side = (1 - correlation) / (1 + correlation);
  const total = 1 + side;
  return { l: total * (1 - balance), r: total * (1 + balance), c: 1 - side };
}

describe("stereo statistics", () => {
  it("uses the engine's equal-power law: linear power split, -3 dB each side at center", () => {
    const [left, right] = equalPowerPan(0);
    expect(left).toBeCloseTo(Math.SQRT1_2, 6);
    expect(right).toBeCloseTo(Math.SQRT1_2, 6);
    expect(equalPowerPan(-1)).toEqual([1, 0]);
    for (const pan of [-0.8, -0.3, 0.18, 0.6]) {
      const [l, r] = equalPowerPan(pan);
      expect(l * l + r * r).toBeCloseTo(1, 9);
    }
  });

  it("reads a mono stem panned to x at position x, as a point, with only the pan law's mono loss", () => {
    for (const pan of [-0.5, 0, 0.18, 0.75]) {
      const image = imageOf(placeStats({ l: 1, r: 1, c: 1 }, { pan, width: 1 }, true));
      expect(image.position).toBeCloseTo(pan, 6);
      expect(image.spread).toBeCloseTo(0, 6);
      expect(image.correlation).toBeCloseTo(1, 6);
      // Folding a panned source to (L + R) / 2 costs a little level: 0 at center, 0.8 dB at 75%.
      const [l, r] = equalPowerPan(pan);
      expect(image.monoLossDb).toBeCloseTo(10 * Math.log10(0.5 / ((l + r) / 2) ** 2), 6);
    }
    expect(imageOf(placeStats({ l: 1, r: 1, c: 1 }, { pan: 0, width: 1 }, true)).monoLossDb).toBeCloseTo(0, 6);
  });

  it("keeps a stereo stem's width when its balance moves", () => {
    const source = stereo(0.4);
    const centered = imageOf(placeStats(source, { pan: 0, width: 1 }, false));
    const moved = imageOf(placeStats(source, { pan: 0.3, width: 1 }, false));
    expect(moved.correlation).toBeCloseTo(centered.correlation, 9);
    expect(moved.spread).toBeCloseTo(centered.spread, 9);
    expect(moved.position).toBeCloseTo(0.3, 6);
  });

  it("ignores width on a mono stem: nothing is synthesized", () => {
    const mono = { l: 1, r: 1, c: 1 };
    expect(placeStats(mono, { pan: 0.2, width: 2 }, true)).toEqual(placeStats(mono, { pan: 0.2, width: 1 }, true));
  });

  it("predicts correlation and mono loss after a width change: rho' = (1 - w²r) / (1 + w²r)", () => {
    const source = stereo(0.5);
    const ratio = (1 - 0.5) / (1 + 0.5);
    for (const width of [0, 0.5, 1, 1.5, 2]) {
      const image = imageOf(placeStats(source, { pan: 0, width }, false));
      const expected = (1 - width * width * ratio) / (1 + width * width * ratio);
      expect(image.correlation).toBeCloseTo(expected, 6);
      expect(image.monoLossDb).toBeCloseTo(10 * Math.log10(1 + width * width * ratio), 6);
    }
  });

  it("keeps the mid power, and so the mono fold-down, at every width", () => {
    const source = stereo(0.3, 0.2);
    const mid = (s: Lrc) => (s.l + s.r + 2 * s.c) / 4;
    for (const width of [0, 0.6, 1, 1.4, 2]) {
      expect(mid(placeStats(source, { pan: 0, width }, false))).toBeCloseTo(mid(placeStats(source, { pan: 0, width: 1 }, false)), 9);
    }
  });

  it("reads decorrelated noise as wide and anti-phase as a mono-cancellation risk", () => {
    const decorrelated = imageOf(stereo(0));
    expect(decorrelated.spread).toBeCloseTo(1, 6);
    expect(decorrelated.monoLossDb).toBeCloseTo(3.01, 2);
    const anti = imageOf(stereo(-0.6));
    expect(anti.correlation).toBeCloseTo(-0.6, 6);
    expect(anti.monoLossDb).toBeGreaterThan(5);
  });

  it("changes level with width only as far as the side signal reaches", () => {
    expect(widthLevelChangeDb(stereo(1), 1, 2, false)).toBeCloseTo(0, 6);
    expect(widthLevelChangeDb(stereo(0), 1, 0, false)).toBeCloseTo(-3.01, 2);
    expect(widthLevelChangeDb(stereo(0.5), 1, 1.4, false)).toBeGreaterThan(0);
    expect(widthLevelChangeDb(stereo(0.5), 1, 1.4, true)).toBe(0);
  });
});

describe("field occupancy", () => {
  const point = (position: number) => occupancy({ position, spread: 0 });

  it("distinguishes two centered parts, two parts apart, two wide parts, and a center part inside a wide one", () => {
    expect(overlapOf(point(0), point(0))).toBeCloseTo(1, 6);
    expect(overlapOf(point(0), point(0.25))).toBeLessThan(0.2);
    expect(overlapOf(point(-0.5), point(0.5))).toBeLessThan(0.01);
    const wide = occupancy({ position: 0, spread: 1 });
    expect(overlapOf(wide, wide)).toBeCloseTo(1, 6);
    expect(overlapOf(point(0), wide)).toBeLessThan(0.2);
  });

  it("splits a distribution into center, left, and right", () => {
    const centered = fieldShares(point(0));
    expect(centered.center).toBeGreaterThan(0.95);
    const left = fieldShares(point(-0.6));
    expect(left.left).toBeGreaterThan(0.95);
    const wide = fieldShares(occupancy({ position: 0, spread: 1 }));
    expect(wide.left).toBeGreaterThan(0.3);
    expect(wide.right).toBeGreaterThan(0.3);
    for (const shares of [centered, left, wide]) expect(shares.center + shares.left + shares.right).toBeCloseTo(1, 6);
  });
});
