import { FREQUENCY_BANDS, trackFileMeasurementSchema, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import { createProject, setTrackSectionState, type ProjectDocument, type SectionType, type TrackRole } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import { applyMixPlan, editRecommendation, headroomTrimDb, planIsStale, recommendationIncluded, setRecommendationStatus } from "./plan";
import { planBalance, type TrackMeasurements } from "./planner";

const NOW = "2026-01-01T00:00:00.000Z";

describe("planBalance", () => {
  it("raises a primary lead that is quiet against the kick anchor", () => {
    const plan = planBalance({
      document: song([
        ["kick", "Kick", "kick"],
        ["bass", "Bass", "bass"],
        ["lead", "Lead", "lead"],
        ["pad", "Pad", "pad"],
      ]),
      measurements: {
        kick: measured(-18, 90),
        bass: measured(-18.4, 90),
        lead: measured(-22, 70),
        pad: measured(-21, 80),
      },
      now: NOW,
    });
    const lead = change(plan, "lead");
    expect(lead?.scope.type).toBe("global");
    expect(lead?.deltaDb).toBeGreaterThanOrEqual(2.5);
    expect(lead?.deltaDb).toBeLessThanOrEqual(4.5);
    expect(lead?.confidenceLabel).toBe("high");
    expect(lead?.reasons[0]).toMatch(/Lead/);
    expect(lead?.reasons[0]).toMatch(/Kick/);
    expect(plan.anchor.label).toBe("Kick");
  });

  it("reduces a supporting pad that is louder than the lead", () => {
    const plan = planBalance({
      document: song([
        ["kick", "Kick", "kick"],
        ["lead", "Lead", "lead"],
        ["pad", "Pad", "pad"],
      ]),
      measurements: {
        kick: measured(-18, 90),
        lead: measured(-18, 80),
        pad: measured(-16, 85),
      },
      now: NOW,
    });
    const pad = change(plan, "pad");
    expect(pad?.deltaDb).toBeLessThanOrEqual(-1);
    expect(pad?.deltaDb).toBeGreaterThanOrEqual(-3);
    expect(pad?.reasons[0]).toMatch(/Supporting|supporting/);
    expect(pad?.status).not.toBe("needs-review");
  });

  it("keeps a focal trumpet lift inside the drop instead of moving the whole track", () => {
    let document = song(
      [
        ["kick", "Kick", "kick"],
        ["lead", "Lead", "lead"],
        ["trumpet", "Trumpet", "brass"],
      ],
      [
        section("verse", "Verse", "verse", 0, 30),
        section("drop", "Drop 2", "drop", 30, 60),
      ],
    );
    const marked = setTrackSectionState(document, "trumpet", "drop", { prominence: "focal" });
    expect(marked.ok).toBe(true);
    if (!marked.ok) return;
    document = marked.document;
    const plan = planBalance({
      document,
      measurements: {
        kick: measured(-18, 90),
        lead: measured(-18, 80),
        trumpet: {
          track: measurement(-21, 40),
          sections: {
            verse: measurement(-20.5, 50, { duration: 30 }),
            drop: measurement(-22, 70, { duration: 30 }),
          },
        },
      },
      now: NOW,
    });
    const global = plan.trackChanges.find((item) => item.trackId === "trumpet" && item.scope.type === "global");
    const drop = plan.trackChanges.find(
      (item) => item.trackId === "trumpet" && item.scope.type === "section" && item.scope.sectionId === "drop",
    );
    expect(global).toBeUndefined();
    expect(drop?.deltaDb).toBeGreaterThanOrEqual(1.2);
    expect(drop?.deltaDb).toBeLessThanOrEqual(4);
    expect(drop?.reasons.join(" ")).toMatch(/Focal/);
    expect(drop?.reasons.join(" ")).toMatch(/Drop 2/);
    const applied = applyMixPlan(document, plan, "all");
    const setting = applied.sectionTrackSettings.find((item) => item.trackId === "trumpet" && item.sectionId === "drop");
    const trumpetGain = applied.tracks.find((item) => item.id === "trumpet")?.gainDb ?? 0;
    expect(setting?.overrides.gainDb).toBeGreaterThan(trumpetGain);
  });

  it("does not raise a sparse background stem because its integrated level is low", () => {
    const plan = planBalance({
      document: song([
        ["kick", "Kick", "kick"],
        ["fx", "Sparkle", "fx"],
      ]),
      measurements: {
        kick: measured(-18, 90),
        fx: measured(-42, 4),
      },
      now: NOW,
    });
    const lifts = plan.trackChanges.filter((item) => item.trackId === "fx" && item.deltaDb > 0);
    expect(lifts).toEqual([]);
  });

  it("leaves an already balanced mix mostly unchanged", () => {
    const plan = planBalance({
      document: song([
        ["kick", "Kick", "kick"],
        ["bass", "Bass", "bass"],
        ["lead", "Lead", "lead"],
        ["pad", "Pad", "pad"],
        ["fx", "Air", "atmosphere"],
      ]),
      measurements: {
        kick: measured(-18, 90),
        bass: measured(-18.3, 88),
        lead: measured(-18.2, 75),
        pad: measured(-22, 80),
        fx: measured(-32, 30),
      },
      now: NOW,
    });
    expect(plan.trackChanges.length).toBeLessThanOrEqual(1);
    expect(plan.summary.headline).toMatch(/did not find a level change|recommended/);
    for (const item of plan.trackChanges) expect(Math.abs(item.deltaDb)).toBeLessThanOrEqual(1);
  });

  it("prefers one global move when a stem is low in every section", () => {
    const document = song(
      [
        ["kick", "Kick", "kick"],
        ["bass", "Bass", "bass"],
      ],
      [
        section("a", "Verse", "verse", 0, 15),
        section("b", "Chorus", "chorus", 15, 30),
        section("c", "Verse 2", "verse", 30, 45),
        section("d", "Chorus 2", "chorus", 45, 60),
      ],
    );
    const plan = planBalance({
      document,
      measurements: {
        kick: measured(-18, 90),
        bass: {
          track: measurement(-21, 80),
          sections: {
            a: measurement(-21, 80, { duration: 15 }),
            b: measurement(-20.8, 80, { duration: 15 }),
            c: measurement(-21.2, 80, { duration: 15 }),
            d: measurement(-21, 80, { duration: 15 }),
          },
        },
      },
      now: NOW,
    });
    const bassChanges = plan.trackChanges.filter((item) => item.trackId === "bass");
    expect(bassChanges.some((item) => item.scope.type === "global" && item.deltaDb > 0.5)).toBe(true);
    expect(bassChanges.filter((item) => item.scope.type === "section")).toEqual([]);
  });

  it("caps moves and sends a large correction to review", () => {
    const plan = planBalance({
      document: song([
        ["kick", "Kick", "kick"],
        ["lead", "Lead", "lead"],
      ]),
      measurements: {
        kick: measured(-18, 90),
        lead: measured(-34, 80),
      },
      now: NOW,
    });
    const lead = change(plan, "lead");
    expect(lead?.deltaDb).toBeLessThanOrEqual(4);
    expect(lead?.deltaDb).toBeGreaterThan(0);
    expect(lead?.status).toBe("needs-review");
    expect(recommendationIncluded(lead!, "preview")).toBe(false);
    expect(lead?.reasons.join(" ")).toMatch(/needs review/);
  });

  it("suppresses corrections inside the deadband", () => {
    const plan = planBalance({
      document: song([
        ["kick", "Kick", "kick"],
        ["lead", "Lead", "lead"],
      ]),
      measurements: {
        kick: measured(-18, 90),
        lead: measured(-18.3, 80),
      },
      now: NOW,
    });
    expect(plan.trackChanges.filter((item) => item.trackId === "lead")).toEqual([]);
  });

  it("is deterministic for the same project, analysis, and settings", () => {
    const input = {
      document: song([
        ["kick", "Kick", "kick"],
        ["lead", "Lead", "lead"],
      ]),
      measurements: {
        kick: measured(-18, 90),
        lead: measured(-22, 70),
      },
      now: NOW,
    };
    expect(planBalance(input)).toEqual(planBalance(input));
  });

  it("keeps the current fader in the recommendation instead of assuming unity", () => {
    const document = song([
      ["kick", "Kick", "kick", 0],
      ["lead", "Lead", "lead", 2],
    ]);
    const plan = planBalance({
      document,
      measurements: {
        kick: measured(-18, 90),
        lead: measured(-24, 70),
      },
      now: NOW,
    });
    const lead = change(plan, "lead");
    expect(lead?.currentGainDb).toBe(2);
    expect(lead).toBeTruthy();
    if (!lead) return;
    expect(lead.recommendedGainDb - lead.currentGainDb).toBeCloseTo(lead.deltaDb, 5);
  });

  it("lowers confidence when roles are missing and does not invent a hierarchy", () => {
    const plan = planBalance({
      document: song([
        ["a", "One", "other"],
        ["b", "Two", "other"],
        ["c", "Three", "other"],
        ["d", "Four", "other"],
        ["e", "Five", "other"],
      ]),
      measurements: {
        a: measured(-18, 80),
        b: measured(-18.2, 80),
        c: measured(-18.1, 80),
        d: measured(-18.4, 80),
        e: measured(-17.8, 80),
      },
      now: NOW,
    });
    expect(plan.trackChanges).toEqual([]);
    expect(plan.summary.confidence).toBeLessThan(0.5);
    expect(plan.summary.notes.join(" ")).toMatch(/5 stems have no confirmed role/);
  });

  it("respects a tucked-pad instruction on one section", () => {
    let document = song(
      [
        ["lead", "Lead", "lead"],
        ["pad", "Pad", "pad"],
      ],
      [section("chorus", "Chorus", "chorus", 0, 30)],
    );
    const marked = setTrackSectionState(document, "pad", "chorus", { userIntent: "Keep the pad tucked behind the lead" });
    expect(marked.ok).toBe(true);
    if (!marked.ok) return;
    document = marked.document;
    const plan = planBalance({
      document,
      measurements: {
        lead: measured(-18, 80),
        pad: {
          track: measurement(-16, 80),
          sections: { chorus: measurement(-16, 80, { duration: 30 }) },
        },
      },
      now: NOW,
    });
    const pad = plan.trackChanges.find((item) => item.trackId === "pad");
    expect(pad?.deltaDb).toBeLessThan(0);
    expect(pad?.reasons.join(" ")).toMatch(/Pad/);
  });

  it("never recommends more than the strength cap", () => {
    for (const strength of ["conservative", "normal", "strong"] as const) {
      const plan = planBalance({
        document: song([
          ["kick", "Kick", "kick"],
          ["lead", "Lead", "lead"],
        ]),
        measurements: { kick: measured(-18, 90), lead: measured(-40, 80) },
        settings: { strength },
        now: NOW,
      });
      const cap = strength === "conservative" ? 2 : strength === "normal" ? 4 : 6;
      for (const item of plan.trackChanges) expect(Math.abs(item.deltaDb)).toBeLessThanOrEqual(cap);
    }
  });

  it("adds a separate headroom trim without baking it into the track delta", () => {
    const plan = planBalance({
      document: song([
        ["kick", "Kick", "kick"],
        ["lead", "Lead", "lead"],
      ]),
      measurements: {
        kick: measured(-18, 90, { peak: -2 }),
        lead: measured(-24, 80, { peak: -2 }),
      },
      settings: { strength: "strong" },
      now: NOW,
    });
    const lead = change(plan, "lead");
    expect(lead?.deltaDb).toBeGreaterThan(0);
    expect(plan.candidateTrim.gainDb).toBeLessThan(0);
    expect(plan.candidateTrim.reason).toMatch(/Headroom trim/);
    expect(headroomTrimDb(-8, 2)).toBe(-3);
    expect(headroomTrimDb(-8, -4)).toBe(0);
  });

  it("applying a plan is reversible and a rejection stays out", () => {
    const document = song([
      ["kick", "Kick", "kick"],
      ["lead", "Lead", "lead"],
      ["pad", "Pad", "pad"],
    ]);
    const plan = planBalance({
      document,
      measurements: {
        kick: measured(-18, 90),
        lead: measured(-22, 70),
        pad: measured(-16, 80),
      },
      now: NOW,
    });
    const pad = change(plan, "pad");
    expect(pad).toBeTruthy();
    const rejected = setRecommendationStatus(plan, pad!.id, "rejected");
    const applied = applyMixPlan(document, rejected, "all");
    expect(document.tracks.map((track) => track.gainDb)).toEqual([0, 0, 0]);
    const padGain = applied.tracks.find((track) => track.id === "pad")?.gainDb ?? 0;
    const leadGain = applied.tracks.find((track) => track.id === "lead")?.gainDb ?? 0;
    expect(padGain).toBeCloseTo(rejected.candidateTrim.gainDb, 5);
    expect(leadGain - padGain).toBeGreaterThan(1);
    expect(leadGain).toBeGreaterThan(0);
  });

  it("marks a plan stale when a fader or role changes", () => {
    const document = song([
      ["kick", "Kick", "kick"],
      ["lead", "Lead", "lead"],
    ]);
    const plan = planBalance({
      document,
      measurements: { kick: measured(-18, 90), lead: measured(-22, 70) },
      now: NOW,
    });
    expect(planIsStale(plan, document)).toBe(false);
    const moved = {
      ...document,
      tracks: document.tracks.map((track) => (track.id === "lead" ? { ...track, gainDb: 1 } : track)),
    };
    expect(planIsStale(plan, moved)).toBe(true);
  });

  it("keeps an edited recommendation inside the same plan", () => {
    const document = song([
      ["kick", "Kick", "kick"],
      ["lead", "Lead", "lead"],
    ]);
    const plan = planBalance({
      document,
      measurements: { kick: measured(-18, 90), lead: measured(-22, 70) },
      now: NOW,
    });
    const lead = change(plan, "lead");
    const edited = editRecommendation(plan, lead!.id, 1.5);
    const next = edited.trackChanges.find((item) => item.id === lead?.id);
    expect(next?.edited).toBe(true);
    expect(next?.recommendedGainDb).toBe(1.5);
    expect(next?.deltaDb).toBe(1.5);
  });

  it("derives a section difference from the loudness timeline when no section cache exists", () => {
    const document = song(
      [
        ["kick", "Kick", "kick"],
        ["trumpet", "Trumpet", "brass"],
      ],
      [section("verse", "Verse", "verse", 0, 30), section("drop", "Drop", "drop", 30, 60)],
    );
    const marked = setTrackSectionState(document, "trumpet", "drop", { prominence: "focal" });
    expect(marked.ok).toBe(true);
    if (!marked.ok) return;
    const timeline = Array.from({ length: 60 }, (_, index) => ({
      timeSeconds: index + 0.5,
      rmsDbfs: index < 30 ? -19 : -24,
    }));
    const plan = planBalance({
      document: marked.document,
      measurements: {
        kick: measured(-18, 90),
        trumpet: { track: measurement(-21, 50, { timeline }) },
      },
      now: NOW,
    });
    const drop = plan.trackChanges.find((item) => item.trackId === "trumpet" && item.scope.type === "section");
    expect(drop?.deltaDb).toBeGreaterThan(0);
  });
});

function change(plan: ReturnType<typeof planBalance>, trackId: string) {
  return plan.trackChanges.find((item) => item.trackId === trackId && item.scope.type === "global") ?? plan.trackChanges.find((item) => item.trackId === trackId);
}

function measured(rms: number, activePercent: number, extra?: { peak?: number; timeline?: Array<{ timeSeconds: number; rmsDbfs: number | null }> }): TrackMeasurements {
  return { track: measurement(rms, activePercent, extra) };
}

function measurement(
  rms: number,
  activePercent: number,
  extra?: { peak?: number; duration?: number; timeline?: Array<{ timeSeconds: number; rmsDbfs: number | null }> },
): TrackFileMeasurement {
  const duration = extra?.duration ?? 60;
  const timeline =
    extra?.timeline ??
    Array.from({ length: 20 }, (_, index) => ({
      timeSeconds: (index / 19) * Math.max(0, duration - 0.1),
      rmsDbfs: rms,
    }));
  const parsed = trackFileMeasurementSchema.parse({
    schemaVersion: 3,
    analysisVersion: "0.4.0",
    scope: { type: "track" },
    source: { sampleRate: 48_000, channelCount: 2, durationSeconds: duration, frameCount: Math.round(duration * 48_000) },
    levels: {
      peakDbfs: extra?.peak ?? rms + 12,
      rmsDbfs: rms,
      integratedLufs: rms - 3,
      crestFactorDb: 12,
      integratedLufsStatus: "measured",
    },
    stereo: { balance: 0, correlation: 0.9, width: 0.2, midRmsDbfs: rms, sideRmsDbfs: rms - 12 },
    dynamics: {
      dynamicRangeDb: 8,
      onsetDensityPerSecond: 2,
      activePercent,
      silentPercent: Math.max(0, 100 - activePercent),
    },
    spectral: { centroidHz: 800, bandwidthHz: 1000, rolloffHz: 4000, flatness: 0.1 },
    bandEnergy: FREQUENCY_BANDS.map((band) => ({
      ...band,
      normalizedEnergy: band.id === "bass" || band.id === "sub" ? 0.4 : 0.05,
    })),
    spectrum: [],
    loudnessTimeline: timeline,
    spectrogram: { hopSeconds: 0.5, lowHz: 20, highHz: 20_000, bandCount: 1, columns: [] },
  });
  return parsed;
}

function song(tracks: Array<[string, string, TrackRole, number?]>, sections: ProjectDocument["sections"] = []): ProjectDocument {
  const document = createProject({
    id: "proj-balance",
    name: "Balance fixture",
    now: new Date(NOW),
    tracks: tracks.map(([id, name, role]) => ({
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
        durationSeconds: 60,
        fileSizeBytes: 1_000,
      },
    })),
  });
  return {
    ...document,
    sections,
    tracks: document.tracks.map((track) => {
      const gain = tracks.find((item) => item[0] === track.id)?.[3] ?? 0;
      return { ...track, gainDb: gain };
    }),
  };
}

function section(id: string, name: string, type: SectionType, startTime: number, endTime: number): ProjectDocument["sections"][number] {
  return {
    id,
    name,
    type,
    startTime,
    endTime,
    userIntent: null,
    source: "manual",
    confidence: null,
    structuralGroupId: null,
  };
}
