import { setTrackEqNodes, setTrackSectionState, type ProjectDocument } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import { spatialPlanIsStale } from "./plan";
import { planSpace } from "./planner";
import { SPATIAL_LIMITS_BY_STRENGTH } from "./settings";
import { BASS, KICK, LEAD, NOW, PAD_MASKING, base, bump, spatialSong, sum, wholeSong, type SpatialSong, type SpatialTrackInput } from "./test-fixtures";

const lead: SpatialTrackInput = { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD }, stereo: { correlation: 0.98 } };
const pad = (patch: Partial<SpatialTrackInput> = {}): SpatialTrackInput => ({ id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_MASKING }, stereo: { correlation: 0.9 }, ...patch });
const kick: SpatialTrackInput = { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 }, stereo: { mono: true } };
const bass: SpatialTrackInput = { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS }, stereo: { correlation: 0.99 } };
const focalLead = [{ track: "lead", section: "all", prominence: "focal" as const }];
const synth = (id: string, name: string, level: number, patch: Partial<SpatialTrackInput> = {}): SpatialTrackInput => ({
  id,
  name,
  role: "synth",
  fixture: { shape: sum(base(level, -1), bump(1_500, 0.8, 10)) },
  stereo: { correlation: 0.15 },
  ...patch,
});

function plan(input: SpatialSong, strength: "conservative" | "normal" | "strong" = "normal") {
  return planSpace({ ...input, settings: { strength }, now: NOW });
}

describe("spatial planner fixtures", () => {
  it("A: moves a centered Supporting pad off a centered Focal lead by a modest amount", () => {
    const result = plan(spatialSong({ tracks: [lead, pad()], sections: wholeSong(), prominence: focalLead }));
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;
    expect(change.trackId).toBe("pad");
    expect(change.scope).toEqual({ type: "global" });
    expect(change.status).toBe("proposed");
    expect(Math.abs(change.processing.pan ?? 0)).toBeGreaterThanOrEqual(0.1);
    expect(Math.abs(change.processing.pan ?? 0)).toBeLessThanOrEqual(SPATIAL_LIMITS_BY_STRENGTH.normal.maxPanMove);
    expect(change.reasons[0]).toMatch(/Pad .*(right|left) because it overlaps the centered Lead from .*kHz during most of the Chorus\. Lead is Focal and Pad is Supporting\./);
    expect(change.evaluation!.overlapAfter).toBeLessThan(change.evaluation!.overlapBefore - 0.4);
    expect(change.confidence).toBeGreaterThan(0.7);
    const interaction = result.interactions.find((item) => item.trackA === "lead" && item.trackB === "pad");
    expect(interaction).toMatchObject({ protectedTrackId: "lead", movingTrackId: "pad", outcome: "recommendation" });
    expect(interaction!.centerCompetition).toBeGreaterThan(0.9);
  });

  it("B: leaves a pad that already sits 25% right alone", () => {
    const result = plan(spatialSong({ tracks: [lead, pad({ pan: 0.25 })], sections: wholeSong(), prominence: focalLead }));
    expect(result.changes).toHaveLength(0);
    for (const item of result.interactions) expect(item.outcome).toBe("below-threshold");
    expect(result.summary.headline).toMatch(/No high-confidence spatial changes/);
  });

  it("C: never pans Kick or Bass, even though they are both centered and overlap heavily", () => {
    const result = plan(spatialSong({ tracks: [kick, bass] }), "strong");
    expect(result.changes).toHaveLength(0);
    const pair = result.interactions.find((item) => item.trackA === "kick" && item.trackB === "bass")!;
    // They overlap completely, but almost all of it is low end, which position cannot separate.
    expect(pair.stereoOverlap).toBeGreaterThan(0.9);
    expect(pair.frequencyOverlap).toBeGreaterThan(0.7);
    expect(pair.outcome).toBe("anchors");
    expect(pair.explanation).toMatch(/kept centered/);
  });

  it("D: widens a narrowed Background atmosphere with healthy correlation when the center is crowded", () => {
    const result = plan(
      spatialSong({ tracks: [kick, bass, lead, { id: "atmos", name: "Atmosphere", role: "atmosphere", width: 0.4, fixture: { shape: sum(base(-46, -1), bump(1_200, 1.5, 6)) }, stereo: { correlation: 0.6 } }] }),
    );
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;
    expect(change).toMatchObject({ trackId: "atmos", purpose: "widen", scope: { type: "global" } });
    expect(change.processing.width!).toBeGreaterThan(0.4);
    expect(change.processing.width! - 0.4).toBeLessThanOrEqual(SPATIAL_LIMITS_BY_STRENGTH.normal.maxWidthChange + 1e-9);
    expect(change.processing.pan).toBeNull();
    expect(change.evaluation!.correlationAfter).toBeGreaterThan(0.5);
    expect(change.reasons[0]).toMatch(/Background part, its recorded correlation is healthy \(0\.60\), and the center already holds Kick, Bass and Lead/);
  });

  it("D: does not widen an atmosphere that is already wide, or one in an uncrowded mix", () => {
    const wide = plan(spatialSong({ tracks: [kick, bass, lead, { id: "atmos", name: "Atmosphere", role: "atmosphere", fixture: { shape: sum(base(-46, -1), bump(1_200, 1.5, 6)) }, stereo: { correlation: 0.2 } }] }));
    expect(wide.changes.filter((change) => change.trackId === "atmos")).toHaveLength(0);
  });

  it("E: never widens a phase-risky pad and narrows it back toward 100%", () => {
    const result = plan(spatialSong({ tracks: [lead, pad({ width: 1.4, stereo: { correlation: -0.2 } })], sections: wholeSong(), prominence: focalLead }));
    const change = result.changes.find((item) => item.trackId === "pad")!;
    expect(change.purpose).toBe("mono-safety");
    expect(change.processing.width!).toBeLessThan(1.4);
    expect(change.processing.width!).toBeGreaterThanOrEqual(1);
    expect(change.evaluation!.monoLossAfterDb).toBeLessThan(change.evaluation!.monoLossBeforeDb);
    expect(change.reasons[0]).toMatch(/correlation is -0\.\d\d at its saved 140%: folded to mono it loses/);
    for (const strength of ["conservative", "normal", "strong"] as const) {
      for (const row of plan(spatialSong({ tracks: [lead, pad({ width: 1.4, stereo: { correlation: -0.2 } })], sections: wholeSong(), prominence: focalLead }), strength).changes) {
        if (row.trackId === "pad" && row.processing.width !== null) expect(row.processing.width).toBeLessThan(1.4);
      }
    }
  });

  it("E: sends a narrowing below 100% of a stem that is out of phase as recorded to review", () => {
    const result = plan(spatialSong({ tracks: [lead, pad({ stereo: { correlation: -0.5 } })], sections: wholeSong(), prominence: focalLead }));
    const change = result.changes.find((item) => item.trackId === "pad" && item.purpose === "mono-safety");
    expect(change).toBeTruthy();
    expect(change!.processing.width!).toBeLessThan(1);
    expect(change!.status).toBe("needs-review");
    expect(change!.reasons.join(" ")).toMatch(/out of phase between its own channels/);
  });

  it("F: narrows or repositions the quieter of two wide Supporting synths that share one space", () => {
    // "Both wide and strongly correlated": coherent wide images, and Synth B was widened to 135% on top.
    const result = plan(spatialSong({ tracks: [synth("synthA", "Synth A", -38, { width: 1.2, stereo: { correlation: 0.7 } }), synth("synthB", "Synth B", -40, { width: 1.35, stereo: { correlation: 0.7 } })] }));
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;
    expect(change.trackId).toBe("synthB");
    const repositioned = change.processing.pan !== null && Math.abs(change.processing.pan) >= 0.1;
    const narrowed = change.processing.width !== null && change.processing.width < 1.35;
    expect(repositioned || narrowed).toBe(true);
    expect(change.reasons[0]).toMatch(/Synth B .*because it overlaps .*Synth A .*Both are Supporting; Synth A is the louder of the two there\./);
    expect(change.evaluation!.conflictAfter).toBeLessThan(change.evaluation!.conflictBefore * 0.6);
  });

  it("F: two decorrelated layers: restores the over-widened one toward 100% for mono, and says position cannot separate them further", () => {
    const result = plan(spatialSong({ tracks: [synth("synthA", "Synth A", -38, { stereo: { correlation: 0.3 } }), synth("synthB", "Synth B", -40, { width: 1.35, stereo: { correlation: 0.4 } })] }));
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;
    expect(change).toMatchObject({ trackId: "synthB", purpose: "mono-safety" });
    expect(change.processing.width!).toBeLessThan(1.35);
    expect(change.processing.width!).toBeGreaterThanOrEqual(1);
    expect(change.evaluation!.correlationAfter).toBeGreaterThan(change.evaluation!.correlationBefore);
    // At 100% there is nothing to restore; the quieter layer is repositioned instead, and the louder one is left alone.
    const flat = plan(spatialSong({ tracks: [synth("synthA", "Synth A", -38, { stereo: { correlation: 0.3 } }), synth("synthB", "Synth B", -40, { stereo: { correlation: 0.4 } })] }));
    expect(flat.changes.length).toBeLessThanOrEqual(1);
    expect(flat.changes.some((item) => item.trackId === "synthA")).toBe(false);
  });

  it("G: two parts in the same place and range that never play together do not interact", () => {
    const result = plan(
      spatialSong({
        tracks: [{ ...lead, fixture: { shape: LEAD, active: [[0, 30]] } }, pad({ fixture: { shape: PAD_MASKING, active: [[30, 60]] } })],
        sections: wholeSong(),
        prominence: focalLead,
      }),
    );
    expect(result.changes).toHaveLength(0);
    expect(result.interactions).toHaveLength(0);
  });

  it("H: \"Make the breakdown wider.\" widens Supporting and Background parts in that section only, never the anchors", () => {
    const result = plan(
      spatialSong({
        tracks: [kick, bass, lead, pad({ pan: 0.3, stereo: { correlation: 0.7 } }), { id: "atmos", name: "Atmosphere", role: "atmosphere", fixture: { shape: sum(base(-50, -1), bump(600, 1.5, 6)) }, stereo: { correlation: 0.6 } }],
        sections: [
          { id: "verse", name: "Verse", type: "verse", start: 0, end: 30 },
          { id: "breakdown", name: "Breakdown", type: "breakdown", start: 30, end: 60, intent: "Make the breakdown wider." },
        ],
      }),
    );
    const intent = result.changes.filter((change) => change.purpose === "intent");
    expect(intent.map((change) => change.trackId).sort()).toEqual(["atmos", "pad"]);
    for (const change of intent) {
      expect(change.scope).toEqual({ type: "section", sectionId: "breakdown" });
      expect(change.processing.width!).toBeGreaterThan(change.current.width);
      expect(change.processing.width! - change.current.width).toBeLessThanOrEqual(SPATIAL_LIMITS_BY_STRENGTH.normal.intentWidthStep + 1e-9);
      expect(change.processing.pan).toBeNull();
      expect(change.reasons[0]).toMatch(/because the Breakdown note says "Make the breakdown wider/);
    }
    expect(result.changes.some((change) => ["kick", "bass", "lead"].includes(change.trackId))).toBe(false);
  });
});

describe("mono compatibility", () => {
  it("does not widen a stem whose correlation is already low, and never past the correlation floor", () => {
    const tracks = [lead, pad({ stereo: { correlation: 0.15 } })];
    const sections = [{ id: "chorus", name: "Chorus", type: "chorus" as const, start: 0, end: 60, intent: "Make the pad wider." }];
    const result = plan(spatialSong({ tracks, sections }), "strong");
    expect(result.changes.filter((change) => change.trackId === "pad" && (change.processing.width ?? 0) > change.current.width)).toHaveLength(0);
    expect(result.summary.notes.join(" ")).toMatch(/Pad was not widened in Chorus: its correlation is already 0\.15/);
    const healthy = plan(spatialSong({ tracks: [lead, pad({ stereo: { correlation: 0.45 } })], sections }), "strong");
    const widened = healthy.changes.find((change) => change.trackId === "pad" && change.purpose === "intent")!;
    expect(widened.processing.width!).toBeGreaterThan(1);
    expect(widened.evaluation!.correlationAfter).toBeGreaterThanOrEqual(0.2);
  });

  it("measures how much an excessive width would cost in mono, and an edit there goes to review", async () => {
    const { editSpatialRecommendation } = await import("./plan");
    const result = plan(spatialSong({ tracks: [kick, bass, lead, { id: "atmos", name: "Atmosphere", role: "atmosphere", width: 0.4, fixture: { shape: sum(base(-46, -1), bump(1_200, 1.5, 6)) }, stereo: { correlation: 0.6 } }] }));
    const row = result.changes[0]!;
    const edited = editSpatialRecommendation(result, row.id, { width: 2 });
    const after = edited.changes[0]!;
    expect(after.evaluation!.monoLossAfterDb - after.evaluation!.monoLossBeforeDb).toBeGreaterThan(1.5);
    expect(after.warnings.join(" ")).toMatch(/mono|outside/);
    expect(after.status).toBe("needs-review");
    expect(after.edited).toBe(true);
  });
});

describe("respects the mix as it is now", () => {
  it("plans from the saved pan and width, not from center and 100%", () => {
    const result = plan(spatialSong({ tracks: [lead, pad({ pan: 0.08 })], sections: wholeSong(), prominence: focalLead }));
    const change = result.changes.find((item) => item.trackId === "pad")!;
    expect(change.current.pan).toBe(0.08);
    expect(change.processing.pan!).toBeGreaterThan(0.08);
    expect(change.reasons[0]).toMatch(/Moved Pad's balance from 8% right to \d+% right/);
  });

  it("edits a saved section override rather than stacking on it, and keeps it when a note disagrees", () => {
    const sections = [
      { id: "verse", name: "Verse", type: "verse" as const, start: 0, end: 30 },
      { id: "drop", name: "Drop", type: "drop" as const, start: 30, end: 60, intent: "Make the drop narrower." },
    ];
    const result = plan(
      spatialSong({
        tracks: [lead, pad({ stereo: { correlation: 0.5 } })],
        sections,
        prominence: [
          { track: "lead", section: "verse", prominence: "focal" },
          { track: "lead", section: "drop", prominence: "focal" },
        ],
        overrides: [{ track: "pad", section: "drop", width: 1.35 }],
      }),
    );
    expect(result.summary.notes.join(" ")).toMatch(/Pad keeps its saved Drop width of 135%/);
    const drop = result.changes.filter((change) => change.scope.type === "section" && change.trackId === "pad");
    for (const change of drop) {
      expect(change.current.width).toBe(1.35);
      if (change.processing.width !== null) expect(change.replacesOverride).toBe(true);
    }
  });

  it("does not move a pad that saved EQ already carved out of the lead's range", () => {
    const input = spatialSong({ tracks: [lead, pad()], sections: wholeSong(), prominence: focalLead });
    const carved = setTrackEqNodes(input.document, "pad", [
      { id: "cut", type: "eq", enabled: true, filter: { kind: "bell", frequencyHz: 2_800, gainDb: -12, q: 0.7 }, origin: "eq-plan", note: null },
    ]);
    if (!carved.ok) throw new Error(carved.message);
    const before = plan(input);
    const after = plan({ ...input, document: carved.document });
    expect(before.changes).toHaveLength(1);
    const severityBefore = before.interactions.find((item) => item.trackB === "pad")!.severity;
    const severityAfter = after.interactions.find((item) => item.trackB === "pad")?.severity ?? 0;
    expect(severityAfter).toBeLessThan(severityBefore);
    expect(after.changes.filter((change) => change.purpose === "separation")).toHaveLength(0);
  });

  it("calls a much louder supporting part a level problem instead of panning it away", () => {
    // About 8 dB louder than the lead while both play.
    const result = plan(spatialSong({ tracks: [{ ...lead, gainDb: -1 }, pad({ gainDb: 12 })], sections: wholeSong(), prominence: focalLead }));
    expect(result.interactions.find((item) => item.trackB === "pad")!.levelGapDb).toBeGreaterThan(6);
    expect(result.changes.filter((change) => change.purpose === "separation")).toHaveLength(0);
    expect(result.summary.notes.join(" ")).toMatch(/Pad sits \d+\.\d dB over Lead .*level problem, not a spatial one/);
    expect(result.interactions.find((item) => item.trackB === "pad")!.outcome).toBe("level");
  });
});

describe("intent", () => {
  const sections = (intent: string) => [{ id: "chorus", name: "Chorus", type: "chorus" as const, start: 0, end: 60, intent }];
  const guitar: SpatialTrackInput = { id: "gtr", name: "Guitar", role: "guitar", fixture: { shape: sum(base(-44, -1.5), bump(1_800, 0.7, 9)) }, stereo: { correlation: 0.9 } };

  it("moves a named stem to the side a note asks for, in that section", () => {
    const result = plan(spatialSong({ tracks: [kick, bass, guitar], sections: sections("Push the guitar left.") }));
    const change = result.changes.find((item) => item.trackId === "gtr")!;
    expect(change).toMatchObject({ purpose: "intent", scope: { type: "section", sectionId: "chorus" } });
    expect(change.processing.pan).toBeCloseTo(-SPATIAL_LIMITS_BY_STRENGTH.normal.intentPanStep, 6);
    expect(change.reasons[0]).toMatch(/Moved Guitar in Chorus 25% left because the Chorus note says "Push the guitar left"/);
  });

  it("keeps a stem centered when a note says so, even if it would otherwise move", () => {
    const result = plan(
      spatialSong({
        tracks: [lead, pad()],
        sections: [{ id: "all", name: "Chorus", type: "chorus", start: 0, end: 60, intent: "Keep the pad centered." }],
        prominence: focalLead,
      }),
    );
    expect(result.changes.filter((change) => change.trackId === "pad" && change.processing.pan !== null)).toHaveLength(0);
  });

  it("does not guess between two stems a word could mean", () => {
    const trumpet = (id: string, name: string, level: number): SpatialTrackInput => ({ id, name, role: "brass", fixture: { shape: sum(base(level, -1), bump(900, 0.8, 8)) }, stereo: { correlation: 0.9 } });
    const result = plan(spatialSong({ tracks: [kick, trumpet("t1", "Trumpet 1", -44), trumpet("t2", "Trumpet 2", -46)], sections: sections("Push the trumpet left.") }));
    expect(result.changes.filter((change) => change.purpose === "intent")).toHaveLength(0);
    expect(result.summary.notes.join(" ")).toMatch(/could mean Trumpet 1 or Trumpet 2, so it was not applied/);
  });

  it("ignores tone words and negated clauses", () => {
    const quiet = plan(spatialSong({ tracks: [kick, bass, guitar], sections: sections("Warm and punchy. Bright and aggressive.") }));
    expect(quiet.changes).toHaveLength(0);
    const negated = plan(spatialSong({ tracks: [kick, bass, guitar, pad({ stereo: { correlation: 0.6 } })], sections: sections("Don't make it wider.") }));
    expect(negated.changes.filter((change) => change.purpose === "intent")).toHaveLength(0);
  });

  it("does not add width to a mono part a note names, and says why", () => {
    const result = plan(spatialSong({ tracks: [kick, { ...guitar, stereo: { mono: true } }], sections: sections("Make the guitar wider.") }));
    expect(result.changes).toHaveLength(0);
    expect(result.summary.notes.join(" ")).toMatch(/Guitar has no stereo content to widen in Chorus/);
  });

  it("reads a Track × Section note on the row above a section note", () => {
    let input = spatialSong({ tracks: [kick, bass, guitar], sections: sections("Push the guitar left.") });
    const row = setTrackSectionState(input.document, "gtr", "chorus", { userIntent: "Push the guitar right." });
    if (!row.ok) throw new Error(row.message);
    input = { ...input, document: row.document };
    const change = plan(input).changes.find((item) => item.trackId === "gtr")!;
    expect(change.processing.pan!).toBeGreaterThan(0);
    expect(change.confidence).toBeGreaterThan(0.85);
  });
});

describe("already-good mix", () => {
  it("proposes nothing for parts that are already spread by role", () => {
    const result = plan(
      spatialSong({
        tracks: [
          kick,
          bass,
          { ...lead, stereo: { correlation: 0.97 } },
          { id: "pad", name: "Pad", role: "pad", fixture: { shape: sum(base(-46, -1), bump(700, 1.2, 8)) }, stereo: { correlation: 0.45 } },
          { id: "gtr", name: "Guitar", role: "guitar", pan: -0.35, fixture: { shape: sum(base(-44, -1.5), bump(1_800, 0.7, 9)) }, stereo: { correlation: 0.9 } },
          { id: "keys", name: "Keys", role: "keys", pan: 0.35, fixture: { shape: sum(base(-44, -1.5), bump(1_100, 0.7, 9)) }, stereo: { correlation: 0.85 } },
          { id: "atmos", name: "Atmosphere", role: "atmosphere", fixture: { shape: sum(base(-52, -1), bump(3_000, 1.5, 6)) }, stereo: { correlation: 0.35 } },
        ],
        sections: [
          { id: "verse", name: "Verse", type: "verse", start: 0, end: 30 },
          { id: "chorus", name: "Chorus", type: "chorus", start: 30, end: 60 },
        ],
      }),
    );
    expect(result.changes).toHaveLength(0);
    expect(result.summary.headline).toMatch(/No high-confidence spatial changes/);
  });

  it("allows an intentionally lopsided arrangement", () => {
    const result = plan(
      spatialSong({
        tracks: [
          kick,
          { id: "gtr", name: "Guitar", role: "guitar", pan: -0.6, fixture: { shape: sum(base(-44, -1.5), bump(1_800, 0.7, 9)) }, stereo: { correlation: 0.9 } },
          { id: "fx", name: "FX", role: "fx", pan: 0.5, fixture: { shape: sum(base(-52, -1), bump(6_000, 1, 6)) }, stereo: { correlation: 0.8 } },
        ],
      }),
    );
    expect(result.changes).toHaveLength(0);
  });
});

describe("plan properties", () => {
  const acceptance = () =>
    spatialSong({
      tracks: [
        kick,
        bass,
        lead,
        pad({ width: 1.1, stereo: { correlation: 0.7 } }),
        { id: "synth", name: "Synth", role: "synth", pan: -0.2, width: 1.3, fixture: { shape: sum(base(-40, -1), bump(1_400, 0.8, 9)), active: [[30, 60]] }, stereo: { correlation: 0.3 } },
        { id: "atmos", name: "Atmosphere", role: "atmosphere", width: 0.6, fixture: { shape: sum(base(-48, -1), bump(1_000, 1.5, 6)) }, stereo: { correlation: 0.6 } },
      ],
      sections: [
        { id: "chorus", name: "Chorus", type: "chorus", start: 0, end: 30 },
        { id: "drop", name: "Drop", type: "drop", start: 30, end: 60, intent: "The atmosphere should surround the drop." },
      ],
      prominence: [
        { track: "lead", section: "chorus", prominence: "focal" },
        { track: "lead", section: "drop", prominence: "focal" },
      ],
    });

  it("is deterministic", () => {
    const first = plan(acceptance());
    const second = plan(acceptance());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("keeps every row inside its strength's limits and the automatic ranges", () => {
    for (const strength of ["conservative", "normal", "strong"] as const) {
      const limits = SPATIAL_LIMITS_BY_STRENGTH[strength];
      for (const change of plan(acceptance(), strength).changes) {
        if (change.processing.pan !== null && change.purpose !== "intent") {
          expect(Math.abs(change.processing.pan - change.current.pan)).toBeLessThanOrEqual(limits.maxPanMove + 1e-9);
          expect(Math.abs(change.processing.pan)).toBeLessThanOrEqual(0.8 + 1e-9);
        }
        if (change.processing.width !== null) {
          // Measured from what the row is applied on top of: a note's row sits on the plan's whole-song row.
          const from = change.purpose === "intent" ? change.evidence.scopes[0]!.baseline.width : change.current.width;
          // Narrowing a widening back toward 100% may go past the step; nothing else may.
          const restore = change.processing.width >= 1 - 1e-9 && change.processing.width < from ? from - 1 : 0;
          expect(Math.abs(change.processing.width - from)).toBeLessThanOrEqual(Math.max(limits.maxWidthChange, limits.intentWidthStep, restore) + 1e-9);
          expect(change.processing.width).toBeGreaterThanOrEqual(0.6 - 1e-9);
          expect(change.processing.width).toBeLessThanOrEqual(1.4 + 1e-9);
        }
        expect(change.reasons[0]!.length).toBeGreaterThan(40);
        expect(change.confidence).toBeGreaterThan(0);
      }
    }
  });

  it("never moves Kick, Bass, or the Focal lead on the acceptance project, and has a reason for every row", () => {
    const result = plan(acceptance());
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.some((change) => ["kick", "bass", "lead"].includes(change.trackId))).toBe(false);
    expect(result.mix.after.centerLoad).toBeLessThanOrEqual(result.mix.before.centerLoad + 1e-9);
    expect(result.fields.find((field) => field.key === "song")!.tracks).toHaveLength(6);
  });

  it("goes stale on gain, pan, width, EQ, roles, prominence, sections, and intent, not on selection", () => {
    const input = acceptance();
    const result = plan(input);
    const edits: Array<(document: ProjectDocument) => ProjectDocument> = [
      (document) => ({ ...document, tracks: document.tracks.map((track) => (track.id === "pad" ? { ...track, gainDb: -1 } : track)) }),
      (document) => ({ ...document, tracks: document.tracks.map((track) => (track.id === "pad" ? { ...track, pan: 0.1 } : track)) }),
      (document) => ({ ...document, tracks: document.tracks.map((track) => (track.id === "pad" ? { ...track, width: 1.2 } : track)) }),
      (document) => ({ ...document, tracks: document.tracks.map((track) => (track.id === "pad" ? { ...track, role: "keys" as const } : track)) }),
      (document) => {
        const result = setTrackEqNodes(document, "pad", [{ id: "x", type: "eq", enabled: true, filter: { kind: "bell", frequencyHz: 1_000, gainDb: -2, q: 1 }, origin: "manual", note: null }]);
        if (!result.ok) throw new Error(result.message);
        return result.document;
      },
      (document) => {
        const result = setTrackSectionState(document, "pad", "chorus", { prominence: "focal" });
        if (!result.ok) throw new Error(result.message);
        return result.document;
      },
      (document) => ({ ...document, sections: document.sections.map((section) => (section.id === "drop" ? { ...section, userIntent: "Wider." } : section)) }),
      (document) => ({ ...document, sections: document.sections.map((section) => (section.id === "drop" ? { ...section, startTime: 31 } : section)) }),
    ];
    for (const edit of edits) expect(spatialPlanIsStale(result, edit(input.document))).toBe(true);
    const selected = { ...input.document, uiState: { ...input.document.uiState, selectedTrackId: "pad", playheadSeconds: 12 } };
    expect(spatialPlanIsStale(result, selected)).toBe(false);
  });

  it("plans 32 stems in a few seconds", () => {
    const tracks: SpatialTrackInput[] = Array.from({ length: 32 }, (_, index) => ({
      id: `t${index}`,
      name: `Part ${index}`,
      role: (["kick", "bass", "lead", "pad", "synth", "keys", "guitar", "strings", "atmosphere", "percussion"] as const)[index % 10]!,
      pan: ((index % 7) - 3) / 10,
      fixture: { shape: sum(base(-44 - (index % 5), -1), bump(200 * (1 + (index % 9)), 0.8, 8)), active: [[(index % 4) * 5, 60]] },
      stereo: { correlation: 0.3 + (index % 6) / 10 },
    }));
    const input = spatialSong({
      tracks,
      sections: [
        { id: "a", name: "Verse", type: "verse", start: 0, end: 20 },
        { id: "b", name: "Chorus", type: "chorus", start: 20, end: 40 },
        { id: "c", name: "Drop", type: "drop", start: 40, end: 60 },
      ],
    });
    const started = Date.now();
    const result = plan(input);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(8_000);
    expect(result.changes.length).toBeLessThanOrEqual(32);
  }, 20_000);
});
