import { suggestSections } from "@audiosous/analysis-contract";
import { energyEnvelope, previewWaveformPeaks } from "@audiosous/audio-files";
import { describe, expect, it } from "vitest";

describe("section suggestions", () => {
  it("finds more than one section in a demo-shaped preview", () => {
    const peaks = ["kick", "bass", "pad"].map((seed) => previewWaveformPeaks({ sampleRate: 48_000, durationSeconds: 241.72, seed }));
    const energy = energyEnvelope(peaks, 241.72);
    const result = suggestSections({ durationSeconds: 241.72, energy });
    expect(result.suggestions.length).toBeGreaterThan(1);
    expect(result.suggestions[0]?.startTime).toBe(0);
    expect(result.suggestions.at(-1)?.endTime).toBeCloseTo(241.72, 2);
    expect(result.suggestions.every((section) => section.endTime > section.startTime)).toBe(true);
  });
});