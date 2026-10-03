import { describe, expect, it } from "vitest";
import { arrowSeekStep } from "./playback";

describe("arrowSeekStep", () => {
  it("seeks one second, five seconds with shift, and one millisecond with ctrl", () => {
    expect(arrowSeekStep({ shiftKey: false, ctrlKey: false })).toBe(1);
    expect(arrowSeekStep({ shiftKey: true, ctrlKey: false })).toBe(5);
    expect(arrowSeekStep({ shiftKey: false, ctrlKey: true })).toBe(0.001);
    expect(arrowSeekStep({ shiftKey: true, ctrlKey: true })).toBe(0.001);
  });
});
