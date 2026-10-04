import {
  ANALYSIS_ENGINE_VERSION,
  FREQUENCY_BANDS,
  trackFileMeasurementSchema,
  type TrackFileMeasurement,
} from "@audiosous/analysis-contract";
import { describe, expect, it } from "vitest";
import type { DesktopPlatform, TrackAnalysisBridgeResult } from "../platform/types";
import { loadTrackAnalysis, TrackAnalysisError } from "./track-analysis";

function measurement(): TrackFileMeasurement {
  return trackFileMeasurementSchema.parse({
    schemaVersion: 1,
    analysisVersion: ANALYSIS_ENGINE_VERSION,
    scope: { type: "track" },
    source: { sampleRate: 48_000, channelCount: 1, durationSeconds: 2, frameCount: 96_000 },
    levels: {
      peakDbfs: -6.02,
      rmsDbfs: -9.03,
      integratedLufs: -14,
      crestFactorDb: 3.01,
      integratedLufsStatus: "measured",
    },
    bandEnergy: FREQUENCY_BANDS.map((band, index) => ({ ...band, normalizedEnergy: index === 1 ? 1 : 0 })),
  });
}

function bridge(value: TrackFileMeasurement, identity = { fileSizeBytes: 40, modifiedAtNs: "10" }): TrackAnalysisBridgeResult {
  return {
    ok: true,
    message: "",
    detail: "",
    measurementJson: JSON.stringify(value),
    fileSizeBytes: identity.fileSizeBytes,
    modifiedAtNs: identity.modifiedAtNs,
    durationMs: 12,
  };
}

function platform(options: {
  kind?: "tauri" | "browser";
  cache?: Uint8Array | null;
  identity?: { fileSizeBytes: number; modifiedAtNs: string };
  analyze?: () => Promise<TrackAnalysisBridgeResult>;
}): { platform: DesktopPlatform; writes: Uint8Array[]; analyzed: number } {
  const writes: Uint8Array[] = [];
  let analyzed = 0;
  const identity = options.identity ?? { fileSizeBytes: 40, modifiedAtNs: "10" };
  const host = {
    kind: options.kind ?? "tauri",
    async projectMediaStatus() {
      return [{ relativePath: "media/track-bass__bass.wav", exists: true, ...identity }];
    },
    async readProjectCache() {
      return options.cache ?? null;
    },
    async writeProjectCache(_projectFile: string, _relativePath: string, bytes: Uint8Array) {
      writes.push(bytes);
    },
    async analyzeTrackFile() {
      analyzed += 1;
      if (!options.analyze) return bridge(measurement(), identity);
      return options.analyze();
    },
    async appendLog() {},
  };
  return {
    platform: host as unknown as DesktopPlatform,
    get writes() {
      return writes;
    },
    get analyzed() {
      return analyzed;
    },
  };
}

const track = { id: "track-bass", filename: "bass.wav", relativePath: "media/track-bass__bass.wav" };

describe("selected stem analysis", () => {
  it("returns a fresh cache without starting the sidecar", async () => {
    const cached = measurement();
    const entry = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        analysisVersion: ANALYSIS_ENGINE_VERSION,
        identity: { relativePath: track.relativePath, fileSizeBytes: 40, modifiedAtNs: "10" },
        measuredAt: "2026-10-03T12:00:00.000Z",
        measurement: cached,
      }),
    );
    const host = platform({ cache: entry });
    const loaded = await loadTrackAnalysis(host.platform, "/tmp/Song/project.amix", track);
    expect(loaded.fromCache).toBe(true);
    expect(loaded.measurement.levels.peakDbfs).toBe(-6.02);
    expect(host.analyzed).toBe(0);
    expect(host.writes).toHaveLength(0);
  });

  it("measures again when the stem timestamp changes and stores the new cache", async () => {
    const stale = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        analysisVersion: ANALYSIS_ENGINE_VERSION,
        identity: { relativePath: track.relativePath, fileSizeBytes: 40, modifiedAtNs: "9" },
        measuredAt: "2026-10-03T12:00:00.000Z",
        measurement: measurement(),
      }),
    );
    const host = platform({ cache: stale, identity: { fileSizeBytes: 40, modifiedAtNs: "10" } });
    const statuses: string[] = [];
    const loaded = await loadTrackAnalysis(host.platform, "/tmp/Song/project.amix", track, (status) => statuses.push(status));
    expect(loaded.fromCache).toBe(false);
    expect(host.analyzed).toBe(1);
    expect(host.writes).toHaveLength(1);
    expect(statuses).toEqual(["queued", "stale", "analyzing"]);
  });

  it("keeps a bad stem from throwing away the error text", async () => {
    const host = platform({
      analyze: async () => ({
        ok: false,
        message: "Unable to analyze bass.wav",
        detail: "Unsupported sample encoding",
        measurementJson: "{}",
        fileSizeBytes: 40,
        modifiedAtNs: "10",
        durationMs: 4,
      }),
    });
    await expect(loadTrackAnalysis(host.platform, "/tmp/Song/project.amix", track)).rejects.toBeInstanceOf(TrackAnalysisError);
    await expect(loadTrackAnalysis(host.platform, "/tmp/Song/project.amix", track)).rejects.toMatchObject({
      message: "Unable to analyze bass.wav",
      detail: "Unsupported sample encoding",
    });
  });

  it("does not start Python from the browser preview", async () => {
    const host = platform({ kind: "browser" });
    await expect(loadTrackAnalysis(host.platform, "preview://project.amix", track)).rejects.toThrow(/desktop app/);
    expect(host.analyzed).toBe(0);
  });
});
