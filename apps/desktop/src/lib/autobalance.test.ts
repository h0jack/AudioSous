import { FREQUENCY_BANDS, trackFileMeasurementSchema, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import { applyMixPlan, planBalance } from "@audiosous/balance-planner";
import { createProject, type ProjectDocument } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import { applyEdit, emptyHistory, undoEdit } from "../state/history";

describe("AutoBalance undo", () => {
  it("restores every gain from the snapshot taken before the plan was applied", () => {
    const before = createProject({
      id: "undo-balance",
      name: "Undo",
      now: new Date("2026-01-01T00:00:00.000Z"),
      tracks: [
        track("kick", "Kick", "kick"),
        track("lead", "Lead", "lead"),
      ],
    });
    const plan = planBalance({
      document: before,
      measurements: {
        kick: { track: measurement(-18, 90) },
        lead: { track: measurement(-22, 70) },
      },
      now: "2026-01-01T00:00:00.000Z",
    });
    const after = applyMixPlan(before, plan, "all");
    expect(after.tracks.find((item) => item.id === "lead")?.gainDb).not.toBe(0);
    const history = applyEdit(emptyHistory<ProjectDocument>(), before, "record", null, 0);
    const undone = undoEdit(history, after);
    expect(undone?.document.tracks.map((item) => item.gainDb)).toEqual(before.tracks.map((item) => item.gainDb));
    expect(before.tracks.map((item) => item.gainDb)).toEqual([0, 0]);
  });
});

function measurement(rms: number, activePercent: number): TrackFileMeasurement {
  return trackFileMeasurementSchema.parse({
    schemaVersion: 3,
    analysisVersion: "0.4.0",
    scope: { type: "track" },
    source: { sampleRate: 48_000, channelCount: 2, durationSeconds: 30, frameCount: 30 * 48_000 },
    levels: { peakDbfs: rms + 12, rmsDbfs: rms, integratedLufs: rms, crestFactorDb: 12, integratedLufsStatus: "measured" },
    stereo: { balance: 0, correlation: 1, width: 0.1, midRmsDbfs: rms, sideRmsDbfs: rms - 12 },
    dynamics: { dynamicRangeDb: 6, onsetDensityPerSecond: 1, activePercent, silentPercent: 100 - activePercent },
    spectral: { centroidHz: 400, bandwidthHz: 800, rolloffHz: 3000, flatness: 0.2 },
    bandEnergy: FREQUENCY_BANDS.map((band) => ({ ...band, normalizedEnergy: 0.1 })),
    spectrum: [],
    loudnessTimeline: [{ timeSeconds: 1, rmsDbfs: rms }, { timeSeconds: 2, rmsDbfs: rms }],
    spectrogram: { hopSeconds: 1, lowHz: 20, highHz: 20_000, bandCount: 1, columns: [] },
  });
}

function track(id: string, name: string, role: "kick" | "lead") {
  return {
    id,
    name,
    role,
    relativePath: `media/${id}__${id}.wav`,
    filename: `${id}.wav`,
    metadata: {
      format: "wav" as const,
      sampleRate: 48_000,
      channelCount: 2,
      bitDepth: 24,
      durationSeconds: 30,
      fileSizeBytes: 1000,
    },
  };
}
