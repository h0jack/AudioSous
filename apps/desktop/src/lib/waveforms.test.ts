import { describe, expect, it } from "vitest";
import { waveformLoadRatio } from "./waveforms";

describe("waveformLoadRatio", () => {
  it("advances through the current stem and the stems already finished", () => {
    expect(waveformLoadRatio({ index: 0, total: 4, filename: "kick.wav", fileRatio: 0 })).toBe(0);
    expect(waveformLoadRatio({ index: 1, total: 4, filename: "bass.wav", fileRatio: 0.5 })).toBe(0.375);
    expect(waveformLoadRatio({ index: 3, total: 4, filename: "fx.wav", fileRatio: 1 })).toBe(1);
  });

  it("stays inside 0 to 1", () => {
    expect(waveformLoadRatio({ index: 0, total: 0, filename: "", fileRatio: 0 })).toBe(1);
    expect(waveformLoadRatio({ index: 2, total: 2, filename: "pad.wav", fileRatio: 4 })).toBe(1);
  });
});
