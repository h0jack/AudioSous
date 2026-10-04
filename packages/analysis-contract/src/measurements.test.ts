import { describe, expect, it } from "vitest";
import {
  ANALYSIS_ENGINE_VERSION,
  FREQUENCY_BANDS,
  analysisCacheIsCurrent,
  analysisCachePath,
  bandOverlap,
  levelDeltaDb,
  mixAnalysisCacheName,
  rangeAnalysisCacheName,
  sectionAnalysisCacheName,
  trackFileMeasurementSchema,
  type AnalysisCacheEntry,
  type TrackFileMeasurement,
} from "./measurements";

function measurement(overrides?: Partial<TrackFileMeasurement["levels"]>): TrackFileMeasurement {
  return trackFileMeasurementSchema.parse({
    schemaVersion: 2,
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
    spectrum: [{ hz: 100, magnitudeDb: -12 }],
    loudnessTimeline: [{ timeSeconds: 0, rmsDbfs: -9 }],
    spectrogram: { hopSeconds: 0.5, lowHz: 20, highHz: 20000, bandCount: 1, columns: [{ timeSeconds: 0, magnitudesDb: [-40] }] },
  });
}

function entry(identityNs = "1000"): AnalysisCacheEntry {
  return {
    schemaVersion: 2,
    analysisVersion: ANALYSIS_ENGINE_VERSION,
    identity: { relativePath: "media/track-bass__bass.wav", fileSizeBytes: 128, modifiedAtNs: identityNs },
    scope: { type: "track" },
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
    const scope = { type: "track" as const };
    expect(analysisCacheIsCurrent(cached, identity, scope)).toBe(true);
    expect(analysisCacheIsCurrent(cached, { ...identity, modifiedAtNs: "1001" }, scope)).toBe(false);
    expect(analysisCacheIsCurrent(cached, { ...identity, fileSizeBytes: 129 }, scope)).toBe(false);
    expect(analysisCacheIsCurrent({ ...cached, analysisVersion: "0.1.0" } as unknown as AnalysisCacheEntry, identity, scope)).toBe(false);
    expect(analysisCacheIsCurrent(cached, identity, { type: "section", startSeconds: 0, endSeconds: 4 })).toBe(false);
  });

  it("keeps analysis cache files beside waveform peaks", () => {
    expect(analysisCachePath("track-bass")).toBe("cache/analysis/track-bass.json");
    expect(analysisCachePath(sectionAnalysisCacheName("track-bass", "section-1"))).toBe("cache/analysis/track-bass__section-section-1.json");
    expect(analysisCachePath(rangeAnalysisCacheName("track-bass"))).toBe("cache/analysis/track-bass__range.json");
    expect(analysisCachePath(mixAnalysisCacheName())).toBe("cache/analysis/mix.json");
    expect(() => analysisCachePath("../secret")).toThrow(/cache\/analysis/);
  });

  it("reports shared band energy and level differences", () => {
    const left = measurement();
    const right = measurement();
    const bass = right.bandEnergy.find((band) => band.id === "bass");
    const mid = right.bandEnergy.find((band) => band.id === "mid");
    if (!bass || !mid) throw new Error("expected bands");
    bass.normalizedEnergy = 0.25;
    mid.normalizedEnergy = 0.75;
    expect(bandOverlap(left.bandEnergy, right.bandEnergy).find((band) => band.id === "bass")?.shared).toBe(0.25);
    expect(levelDeltaDb(-6, -9)).toBe(3);
    expect(levelDeltaDb(null, -9)).toBeNull();
  });
});
