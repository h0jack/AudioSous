import { ANALYSIS_ENGINE_VERSION, FREQUENCY_BANDS, trackFileMeasurementSchema } from "@audiosous/analysis-contract";
import { multiProblem } from "@audiosous/mix-planner/testing";
import { updateTrack, type ProjectDocument } from "@audiosous/project-model";
import { beforeEach, describe, expect, it } from "vitest";
import type { DesktopPlatform, MixCheckRequest } from "../platform/types";
import { loadBandFrames } from "./eq";
import { clearMixInputsCache, loadMixInputs, type MixInputStage, type MixInputStageState } from "./full-mix";
import { shareInFlight } from "./inflight";

const measurement = trackFileMeasurementSchema.parse({
  schemaVersion: 3,
  analysisVersion: ANALYSIS_ENGINE_VERSION,
  scope: { type: "track" },
  source: { sampleRate: 48_000, channelCount: 1, durationSeconds: 2, frameCount: 96_000 },
  levels: { peakDbfs: -6, rmsDbfs: -9, integratedLufs: -14, crestFactorDb: 3, integratedLufsStatus: "measured" },
  bandEnergy: FREQUENCY_BANDS.map((band, index) => ({ ...band, normalizedEnergy: index === 1 ? 1 : 0 })),
  spectrum: [{ hz: 100, magnitudeDb: -12 }],
  loudnessTimeline: [{ timeSeconds: 0, rmsDbfs: -9 }],
  spectrogram: { hopSeconds: 0.5, lowHz: 20, highHz: 20000, bandCount: 1, columns: [{ timeSeconds: 0, magnitudesDb: [-40] }] },
  stereo: { balance: 0, correlation: null, width: 0, midRmsDbfs: -9, sideRmsDbfs: null },
  dynamics: { dynamicRangeDb: 0.2, onsetDensityPerSecond: 0, activePercent: 100, silentPercent: 0 },
  spectral: { centroidHz: 1000, bandwidthHz: 40, rolloffHz: 1200, flatness: 0.02 },
});

/** A desktop shell that counts the expensive calls. */
function shell() {
  const counts = { analyze: 0, bands: 0, stereo: 0, envelopes: 0, renders: 0 };
  let modified = "10";
  const platform = {
    kind: "tauri",
    async projectMediaStatus(_file: string, paths: string[]) {
      return paths.map((relativePath) => ({ relativePath, exists: true, fileSizeBytes: 40, modifiedAtNs: modified }));
    },
    async readProjectCache() {
      return null;
    },
    async writeProjectCache() {},
    async analyzeAudio() {
      counts.analyze += 1;
      return { ok: true, message: "", detail: "", measurementJson: JSON.stringify(measurement), fileSizeBytes: 40, modifiedAtNs: modified, durationMs: 1 };
    },
    async cancelAnalysis() {},
    async eqBandFrames(_file: string, tracks: Array<{ trackId: string }>) {
      counts.bands += 1;
      await Promise.resolve();
      return tracks.map((track) => ({ trackId: track.trackId, json: null, error: null }));
    },
    async stereoFrames(_file: string, tracks: Array<{ trackId: string }>) {
      counts.stereo += 1;
      return tracks.map((track) => ({ trackId: track.trackId, json: null, error: null }));
    },
    async envelopeFrames(_file: string, tracks: Array<{ trackId: string }>) {
      counts.envelopes += 1;
      return tracks.map((track) => ({ trackId: track.trackId, json: null, error: null }));
    },
    async checkMix(_file: string, request: MixCheckRequest) {
      counts.renders += 1;
      return request.variants.map((variant) => ({ name: variant.name, seconds: 10, peakDbfs: -4, rmsDb: -18, monoLossDb: 0.5, correlation: 0.8, sections: [] }));
    },
    async appendLog() {},
  } as unknown as DesktopPlatform;
  return {
    platform,
    counts,
    touch: () => {
      modified = String(Number(modified) + 1);
    },
  };
}

async function load(platform: DesktopPlatform, document: ProjectDocument) {
  const stages: Array<[MixInputStage, MixInputStageState]> = [];
  const inputs = await loadMixInputs(platform, "/tmp/mix-inputs/project.amix", document, { current: () => true, progress: () => undefined, stage: (stage, state) => stages.push([stage, state]) });
  return { inputs, stages };
}

describe("mix inputs for Full Mix, Auto Mix, and the assistant", () => {
  let document: ProjectDocument;
  beforeEach(() => {
    clearMixInputsCache();
    document = multiProblem().document;
  });

  it("measures once, then reuses what is current", async () => {
    const { platform, counts } = shell();
    const first = await load(platform, document);
    expect(first.inputs?.mixPeakDbfs).toBe(-4);
    expect(first.stages.filter(([, state]) => state === "done").map(([stage]) => stage)).toEqual(["levels", "frequency", "space", "dynamics", "peak"]);
    expect(counts).toEqual({ analyze: document.tracks.length, bands: 1, stereo: 1, envelopes: 1, renders: 1 });
    const second = await load(platform, document);
    expect(second.stages.every(([, state]) => state === "reused")).toBe(true);
    expect(counts).toEqual({ analyze: document.tracks.length, bands: 1, stereo: 1, envelopes: 1, renders: 1 });
  });

  it("renders the mix peak again after a fader move but keeps the stems' measurements", async () => {
    const { platform, counts } = shell();
    await load(platform, document);
    const moved = updateTrack(document, "pad", { gainDb: -3 });
    const again = await load(platform, moved);
    expect(again.stages).toContainEqual(["levels", "reused"]);
    expect(again.stages).toContainEqual(["peak", "done"]);
    expect(counts.renders).toBe(2);
    expect(counts.bands).toBe(1);
  });

  it("measures again when a source file changes", async () => {
    const { platform, counts, touch } = shell();
    await load(platform, document);
    touch();
    await load(platform, document);
    expect(counts.bands).toBe(2);
    expect(counts.analyze).toBe(document.tracks.length * 2);
  });

  it("joins a measurement already in flight instead of starting another", async () => {
    const { platform, counts } = shell();
    const [one, two] = await Promise.all([loadBandFrames(platform, "/tmp/p.amix", document), loadBandFrames(platform, "/tmp/p.amix", document)]);
    expect(counts.bands).toBe(1);
    expect(one).toBe(two);
    await loadBandFrames(platform, "/tmp/p.amix", document);
    expect(counts.bands).toBe(2);
  });

  it("shares by key only", async () => {
    let runs = 0;
    const work = () => new Promise<number>((resolve) => setTimeout(() => resolve(++runs), 1));
    const [a, b, c] = await Promise.all([shareInFlight("x", work), shareInFlight("x", work), shareInFlight("y", work)]);
    expect([a, b]).toEqual([1, 1]);
    expect(c).toBe(2);
  });
});
