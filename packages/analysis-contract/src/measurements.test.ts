import { describe, expect, it } from "vitest";
import {
  ANALYSIS_ENGINE_VERSION,
  FREQUENCY_BANDS,
  analysisCacheIsCurrent,
  analysisCachePath,
  trackFileMeasurementSchema,
  type AnalysisCacheEntry,
  type TrackFileMeasurement,
} from "./measurements";

function measurement(overrides?: Partial<TrackFileMeasurement["levels"]>): TrackFileMeasurement {
  return trackFileMeasurementSchema.parse({
    schemaVersion: 1,
    analysisVersion: ANALYSIS_ENGINE_VERSION,
    scope: { type: "track" },
    source: { sampleRate: 48_000, channelCount: 1, durationSeconds: 2, frameCount: 96_000 },
    levels: {
      peakDbfs: -6.02,
      rmsDbfs: -9.03,
      integratedLufs: -12.5,
      crestFactorDb: 3.01,
      integratedLufsStatus: "measured",
      ...overrides,
    },
    bandEnergy: FREQUENCY_BANDS.map((band, index) => ({
      ...band,
      normalizedEnergy: index === 1 ? 1 : 0,
    })),
  });
}

function entry(identityNs = "1000"): AnalysisCacheEntry {
  return {
    schemaVersion: 1,
    analysisVersion: ANALYSIS_ENGINE_VERSION,
    identity: { relativePath: "media/track-bass__bass.wav", fileSizeBytes: 128, modifiedAtNs: identityNs },
    measuredAt: "2026-10-03T12:00:00.000Z",
    measurement: measurement(),
  };
}

describe("track measurement contract", () => {
  it("requires the shared frequency bands in order", () => {
    expect(measurement().bandEnergy.map((band) => band.id)).toEqual(FREQUENCY_BANDS.map((band) => band.id));
    const swapped = measurement();
    const first = swapped.bandEnergy[0];
    const second = swapped.bandEnergy[1];
    if (!first || !second) throw new Error("expected bands");
    swapped.bandEnergy[0] = second;
    swapped.bandEnergy[1] = first;
    expect(trackFileMeasurementSchema.safeParse(swapped).success).toBe(false);
  });

  it("rejects a non-finite level", () => {
    const parsed = trackFileMeasurementSchema.safeParse({
      ...measurement(),
      levels: { ...measurement().levels, peakDbfs: Number.NaN },
    });
    expect(parsed.success).toBe(false);
  });

  it("treats a changed file or analysis version as stale", () => {
    const cached = entry();
    const identity = cached.identity;
    expect(analysisCacheIsCurrent(cached, identity)).toBe(true);
    expect(analysisCacheIsCurrent(cached, { ...identity, modifiedAtNs: "1001" })).toBe(false);
    expect(analysisCacheIsCurrent(cached, { ...identity, fileSizeBytes: 129 })).toBe(false);
    expect(analysisCacheIsCurrent({ ...cached, analysisVersion: "0.1.0" } as unknown as AnalysisCacheEntry, identity)).toBe(false);
  });

  it("keeps analysis cache files beside waveform peaks", () => {
    expect(analysisCachePath("track-bass")).toBe("cache/analysis/track-bass.json");
    expect(() => analysisCachePath("../secret")).toThrow(/cache\/analysis/);
  });
});
