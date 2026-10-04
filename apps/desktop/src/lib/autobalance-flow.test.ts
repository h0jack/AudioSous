import { FREQUENCY_BANDS, trackFileMeasurementSchema, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import { auditionGainAt, editRecommendation, planBalance, planIsStale, setRecommendationStatus, type MixPlan } from "@audiosous/balance-planner";
import { createProject, type ProjectDocument, type TrackRole } from "@audiosous/project-model";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../state/app-store";
import { applyAutoBalance, cancelAutoBalance, currentAudition } from "./autobalance";

const NOW = "2026-01-01T00:00:00.000Z";

describe("AutoBalance review flow", () => {
  let document: ProjectDocument;
  let plan: MixPlan;

  beforeEach(() => {
    document = fixture();
    plan = planBalance({ document, measurements: measurements(), now: NOW });
    useAppStore.getState().openDocument(document, "/tmp/flow/project.amix", []);
    useAppStore.getState().setBalance({ open: true, phase: "ready", plan, fingerprints: [] });
  });

  it("produces a plan with an anchor, confidence, reasons, global and section rows", () => {
    expect(plan.anchor.label).toBe("Kick");
    expect(plan.summary.confidence).toBeGreaterThan(0.5);
    expect(plan.trackChanges.length).toBeGreaterThanOrEqual(3);
    expect(plan.trackChanges.some((item) => item.scope.type === "section")).toBe(true);
    for (const item of plan.trackChanges) expect(item.reasons[0]!.length).toBeGreaterThan(10);
  });

  it("edits, rejects and accepts rows, auditions, and applies only accepted rows as one undo step", () => {
    const [lead, pad, trumpet] = ["lead", "pad", "trumpet"].map((id) => plan.trackChanges.find((item) => item.trackId === id)!);
    let next = editRecommendation(plan, lead!.id, 1.2);
    next = setRecommendationStatus(next, lead!.id, "accepted");
    next = setRecommendationStatus(next, pad!.id, "rejected");
    next = setRecommendationStatus(next, trumpet!.id, "accepted");
    useAppStore.getState().setBalance({ plan: next });

    // Current vs AutoBalance: the candidate carries the edited lead and the drop region; the rejected pad stays put.
    useAppStore.getState().setBalance({ preview: true });
    const candidate = currentAudition(useAppStore.getState().document!, useAppStore.getState().balance)!;
    expect(candidate.trimApplied).toBe(true);
    expect(auditionGainAt(candidate, "lead", 5)).toBeCloseTo(1.2 + candidate.trimDb, 5);
    expect(auditionGainAt(candidate, "pad", 5)).toBeCloseTo(0 + candidate.trimDb, 5);
    expect(auditionGainAt(candidate, "trumpet", 45)).toBeGreaterThan(auditionGainAt(candidate, "trumpet", 5));

    // Single-row A/B: original vs recommended for the lead only, no trim.
    useAppStore.getState().setBalance({ preview: false, auditionId: lead!.id, auditionSide: "original" });
    const original = currentAudition(useAppStore.getState().document!, useAppStore.getState().balance)!;
    useAppStore.getState().setBalance({ auditionSide: "recommended" });
    const recommended = currentAudition(useAppStore.getState().document!, useAppStore.getState().balance)!;
    expect(auditionGainAt(original, "lead", 5)).toBe(0);
    expect(auditionGainAt(recommended, "lead", 5)).toBe(1.2);
    expect(auditionGainAt(recommended, "kick", 5)).toBe(0);
    expect(recommended.trimApplied).toBe(false);

    applyAutoBalance("accepted");
    const applied = useAppStore.getState().document!;
    const gain = (id: string) => applied.tracks.find((track) => track.id === id)!.gainDb;
    const trim = gain("kick");
    expect(gain("lead") - trim).toBeCloseTo(1.2, 5);
    expect(gain("pad")).toBe(trim);
    const drop = applied.sectionTrackSettings.find((row) => row.trackId === "trumpet" && row.sectionId === "drop");
    expect(drop?.overrides.gainDb).toBeGreaterThan(gain("trumpet"));
    expect(useAppStore.getState().balance.plan).toBeNull();

    useAppStore.getState().undo();
    expect(useAppStore.getState().document!.tracks).toEqual(document.tracks);
    expect(useAppStore.getState().document!.sectionTrackSettings).toEqual(document.sectionTrackSettings);
  });

  it("goes stale when a fader moves and refuses to apply", () => {
    const moved = { ...document, tracks: document.tracks.map((track) => (track.id === "kick" ? { ...track, gainDb: -1 } : track)) };
    useAppStore.getState().replaceDocument(moved, true, { mode: "record" });
    const balance = useAppStore.getState().balance;
    expect(planIsStale(balance.plan!, useAppStore.getState().document!, balance.fingerprints, balance.settings)).toBe(true);
    expect(currentAudition(useAppStore.getState().document!, { ...balance, preview: true })).toBeNull();
    applyAutoBalance("all");
    expect(useAppStore.getState().document!.tracks).toEqual(moved.tracks);
    expect(useAppStore.getState().balance.plan).not.toBeNull();
  });

  it("does not go stale when a recommendation is focused", () => {
    const current = useAppStore.getState().document!;
    useAppStore.getState().replaceDocument(
      { ...current, uiState: { ...current.uiState, selectedTrackId: "trumpet", selectedSectionId: "drop", playheadSeconds: 30 } },
      true,
      { mode: "skip" },
    );
    const balance = useAppStore.getState().balance;
    expect(planIsStale(balance.plan!, useAppStore.getState().document!, balance.fingerprints, balance.settings)).toBe(false);
  });

  it("cancel discards the plan and leaves the project untouched", () => {
    useAppStore.getState().setBalance({ preview: true });
    cancelAutoBalance();
    expect(useAppStore.getState().document).toEqual(document);
    expect(useAppStore.getState().balance.plan).toBeNull();
    expect(useAppStore.getState().balance.preview).toBe(false);
    expect(useAppStore.getState().dirty).toBe(false);
  });
});

function fixture(): ProjectDocument {
  const tracks: Array<[string, string, TrackRole]> = [
    ["kick", "Kick", "kick"],
    ["lead", "Lead", "lead"],
    ["pad", "Pad", "pad"],
    ["trumpet", "Trumpet", "brass"],
  ];
  const base = createProject({
    id: "flow",
    name: "Flow",
    now: new Date(NOW),
    tracks: tracks.map(([id, name, role]) => ({
      id,
      name,
      role,
      relativePath: `media/${id}.wav`,
      filename: `${id}.wav`,
      metadata: { format: "wav" as const, sampleRate: 48_000, channelCount: 2, bitDepth: 24, durationSeconds: 60, fileSizeBytes: 1_000 },
    })),
  });
  return {
    ...base,
    sections: [
      { id: "verse", name: "Verse", type: "verse", startTime: 0, endTime: 30, userIntent: null, source: "manual", confidence: null, structuralGroupId: null },
      {
        id: "drop",
        name: "Drop 2",
        type: "drop",
        startTime: 30,
        endTime: 60,
        userIntent: "Big and punchy. Trumpets should dominate.",
        source: "manual",
        confidence: null,
        structuralGroupId: null,
      },
    ],
  };
}

function measurements(): Record<string, { track: TrackFileMeasurement }> {
  return { kick: { track: measurement(-18, 90) }, lead: { track: measurement(-22, 80) }, pad: { track: measurement(-16, 85) }, trumpet: { track: measurement(-23, 85) } };
}

function measurement(rms: number, activePercent: number): TrackFileMeasurement {
  return trackFileMeasurementSchema.parse({
    schemaVersion: 3,
    analysisVersion: "0.4.0",
    scope: { type: "track" },
    source: { sampleRate: 48_000, channelCount: 2, durationSeconds: 60, frameCount: 60 * 48_000 },
    levels: { peakDbfs: rms + 12, rmsDbfs: rms, integratedLufs: rms, crestFactorDb: 12, integratedLufsStatus: "measured" },
    stereo: { balance: 0, correlation: 1, width: 0.1, midRmsDbfs: rms, sideRmsDbfs: rms - 12 },
    dynamics: { dynamicRangeDb: 6, onsetDensityPerSecond: 1, activePercent, silentPercent: 100 - activePercent },
    spectral: { centroidHz: 400, bandwidthHz: 800, rolloffHz: 3000, flatness: 0.2 },
    bandEnergy: FREQUENCY_BANDS.map((band) => ({ ...band, normalizedEnergy: 0.1 })),
    spectrum: [],
    loudnessTimeline: Array.from({ length: 60 }, (_, index) => ({ timeSeconds: index + 0.5, rmsDbfs: rms })),
    spectrogram: { hopSeconds: 1, lowHz: 20, highHz: 20_000, bandCount: 1, columns: [] },
  });
}
