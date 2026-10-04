import {
  ANALYSIS_ENGINE_VERSION,
  FREQUENCY_BANDS,
  trackFileMeasurementSchema,
  type TrackFileMeasurement,
} from "@audiosous/analysis-contract";
import { describe, expect, it } from "vitest";
import type { DesktopPlatform, TrackAnalysisBridgeResult } from "../platform/types";
import { loadAnalysis, loadTrackAnalysis, TrackAnalysisError } from "./track-analysis";

function measurement(): TrackFileMeasurement {
  return trackFileMeasurementSchema.parse({
    schemaVersion: 2,
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
    spectrum: [{ hz: 100, magnitudeDb: -12 }],
    loudnessTimeline: [{ timeSeconds: 0, rmsDbfs: -9 }],
    spectrogram: { hopSeconds: 0.5, lowHz: 20, highHz: 20000, bandCount: 1, columns: [{ timeSeconds: 0, magnitudesDb: [-40] }] },
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
}): { platform: DesktopPlatform; writes: Array<{ path: string; bytes: Uint8Array }>; analyzed: number; requests: unknown[] } {
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const requests: unknown[] = [];
  let analyzed = 0;
  const identity = options.identity ?? { fileSizeBytes: 40, modifiedAtNs: "10" };
  const host = {
    kind: options.kind ?? "tauri",
    async projectMediaStatus(_projectFile: string, relativePaths: string[]) {
      return relativePaths.map((relativePath) => ({ relativePath, exists: true, ...identity }));
    },
    async readProjectCache() {
      return options.cache ?? null;
    },
    async writeProjectCache(_projectFile: string, relativePath: string, bytes: Uint8Array) {
      writes.push({ path: relativePath, bytes });
    },
    async analyzeTrackFile() {
      throw new Error("loadAnalysis uses analyzeAudio");
    },
    async analyzeAudio(_projectFile: string, request: unknown) {
      analyzed += 1;
      requests.push(request);
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
    get requests() {
      return requests;
    },
  };
}

const track = { id: "track-bass", filename: "bass.wav", relativePath: "media/track-bass__bass.wav" };

describe("selected stem analysis", () => {
  it("returns a fresh cache without starting the sidecar", async () => {
    const cached = measurement();
    const entry = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        analysisVersion: ANALYSIS_ENGINE_VERSION,
        identity: { relativePath: track.relativePath, fileSizeBytes: 40, modifiedAtNs: "10" },
        scope: { type: "track" },
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
        schemaVersion: 2,
        analysisVersion: ANALYSIS_ENGINE_VERSION,
        identity: { relativePath: track.relativePath, fileSizeBytes: 40, modifiedAtNs: "9" },
        scope: { type: "track" },
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

  it("measures a section window and ignores a cache from a different window", async () => {
    const entry = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        analysisVersion: ANALYSIS_ENGINE_VERSION,
        identity: { relativePath: track.relativePath, fileSizeBytes: 40, modifiedAtNs: "10" },
        scope: { type: "section", startSeconds: 0, endSeconds: 4 },
        measuredAt: "2026-10-03T12:00:00.000Z",
        measurement: measurement(),
      }),
    );
    const host = platform({ cache: entry });
    const loaded = await loadAnalysis(host.platform, "/tmp/Song/project.amix", {
      cacheName: "track-bass__section-verse",
      label: "bass.wav",
      logId: "track-bass",
      files: [{ relativePath: track.relativePath, filename: "bass.wav" }],
      scope: { type: "section", startSeconds: 8, endSeconds: 16 },
    });
    expect(loaded.fromCache).toBe(false);
    expect(host.analyzed).toBe(1);
    expect(host.requests[0]).toMatchObject({ scopeType: "section", startSeconds: 8, endSeconds: 16 });
    expect(host.writes[0]?.path).toBe("cache/analysis/track-bass__section-verse.json");
    const stored = JSON.parse(new TextDecoder().decode(host.writes[0]?.bytes ?? new Uint8Array())) as { scope: { endSeconds: number } };
    expect(stored.scope.endSeconds).toBe(16);
  });
});
