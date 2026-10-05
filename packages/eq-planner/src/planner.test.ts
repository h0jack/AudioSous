import { setTrackSectionState, setTrackEqNodes } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import { eqPlanIsStale, type EqPlan, type EqRecommendation } from "./plan";
import { planEq } from "./planner";
import { BASS, KICK, LEAD, NOW, PAD_MASKING, PAD_NO_SUB, PAD_SEPARATED, PAD_WITH_SUB, bandFramesFor, base, bump, coarseLowEnd, song, sum, wholeSong } from "./test-fixtures";

function plan(input: ReturnType<typeof song>, strength: "conservative" | "normal" | "strong" = "normal"): EqPlan {
  return planEq({ document: input.document, measurements: input.measurements, settings: { strength }, now: NOW });
}

function moves(result: EqPlan, trackId: string): EqRecommendation[] {
  return result.changes.filter((change) => change.trackId === trackId);
}

const leadPad = (padShape = PAD_MASKING, padGain = 0) =>
  song({
    tracks: [
      { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD } },
      { id: "pad", name: "Pad", role: "pad", gainDb: padGain, fixture: { shape: padShape } },
    ],
    sections: wholeSong(),
    prominence: [
      { track: "lead", section: "all", prominence: "focal" },
      { track: "pad", section: "all", prominence: "supporting" },
    ],
  });

describe("Fixture A: Lead Focal vs Pad Supporting", () => {
  it("cuts the Pad broadly where it competes with the Lead, not the Lead", () => {
    const result = plan(leadPad());
    expect(moves(result, "lead").filter((change) => change.processing.filter.gainDb < 0)).toEqual([]);
    const pad = moves(result, "pad").filter((change) => change.purpose === "separation");
    expect(pad).toHaveLength(1);
    const filter = pad[0]!.processing.filter;
    expect(filter.kind).toBe("bell");
    expect(filter.frequencyHz).toBeGreaterThanOrEqual(1_800);
    expect(filter.frequencyHz).toBeLessThanOrEqual(4_000);
    expect(filter.gainDb).toBeLessThanOrEqual(-0.5);
    expect(filter.gainDb).toBeGreaterThanOrEqual(-3.5);
    expect(filter.q).toBeLessThanOrEqual(2);
    expect(pad[0]!.scope).toEqual({ type: "global" });
    expect(pad[0]!.status).toBe("proposed");
    expect(pad[0]!.confidence).toBeGreaterThanOrEqual(0.7);
    expect(pad[0]!.reasons[0]).toMatch(/Reduced Pad by \d\.\d dB around \d\.\d+ kHz because Pad and Lead are both strong/);
    expect(pad[0]!.reasons[0]).toMatch(/Lead is marked Focal/);
    expect(pad[0]!.reasons.join(" ")).not.toMatch(/masking fixed/i);
    expect(pad[0]!.evaluation!.after).toBeLessThan(pad[0]!.evaluation!.before);
    expect(pad[0]!.protectedTrackIds).toEqual(["lead"]);
  });

  it("reports the interaction with a protected and a yielding track", () => {
    const result = plan(leadPad());
    const interaction = result.interactions.find((item) => item.protectedTrackId === "lead" && item.yieldingTrackId === "pad");
    expect(interaction).toBeTruthy();
    expect(interaction!.severity).toBeGreaterThan(0.35);
    expect(interaction!.regions[0]!.lowHz).toBeLessThan(3_000);
    expect(interaction!.regions[0]!.highHz).toBeGreaterThan(2_500);
    expect(interaction!.outcome).toBe("recommendation");
  });
});

describe("Fixture B: Kick Primary vs Bass Supporting", () => {
  it("makes a small Bass cut near the Kick's strongest low band", () => {
    const result = plan(
      song({
        tracks: [
          { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 } },
          { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS, crest: 8 } },
        ],
        sections: wholeSong(),
        prominence: [{ track: "bass", section: "all", prominence: "supporting" }],
      }),
    );
    expect(moves(result, "kick")).toEqual([]);
    const bass = moves(result, "bass").filter((change) => change.purpose === "separation");
    expect(bass).toHaveLength(1);
    const filter = bass[0]!.processing.filter;
    expect(filter.frequencyHz).toBeGreaterThanOrEqual(55);
    expect(filter.frequencyHz).toBeLessThanOrEqual(110);
    expect(filter.gainDb).toBeLessThanOrEqual(-0.5);
    expect(filter.gainDb).toBeGreaterThanOrEqual(-3.5);
    expect(bass[0]!.reasons.join(" ")).toMatch(/Kick is the Primary rhythmic anchor/);
    expect(bass[0]!.reasons.join(" ")).toMatch(/should improve their hierarchy/);
  });
});

describe("proxy band frames", () => {
  const kickBass = () =>
    song({
      tracks: [
        { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 } },
        { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS, crest: 8 } },
      ],
      sections: wholeSong(),
      prominence: [{ track: "bass", section: "all", prominence: "supporting" }],
    });

  it("uses proxy bands over a spectrogram that smears the low end, and places the cut where the kick really is", () => {
    const input = kickBass();
    const coarse = Object.fromEntries(Object.entries(input.measurements).map(([id, value]) => [id, coarseLowEnd(value)]));
    const smeared = planEq({ document: input.document, measurements: coarse, now: NOW });
    const bands = { kick: bandFramesFor({ shape: KICK }, 60), bass: bandFramesFor({ shape: BASS }, 60) };
    const sharp = planEq({ document: input.document, measurements: coarse, bands, now: NOW });
    expect(smeared.summary.analysisSource).toMatch(/coarse below a few hundred Hz/);
    expect(sharp.summary.analysisSource).toMatch(/measured from the 48 kHz playback proxies/);
    const cut = sharp.changes.find((change) => change.trackId === "bass" && change.purpose === "separation");
    expect(cut).toBeTruthy();
    expect(cut!.processing.filter.frequencyHz).toBeGreaterThanOrEqual(55);
    expect(cut!.processing.filter.frequencyHz).toBeLessThanOrEqual(110);
    const coarseRegion = smeared.interactions.find((item) => item.kind === "kick-bass")?.regions[0];
    if (coarseRegion) expect(coarseRegion.lowHz).toBeGreaterThan(140);
  });

  it("ignores band frames on a different grid", () => {
    const input = kickBass();
    const odd = { ...bandFramesFor({ shape: KICK }, 60), edgesHz: Array.from({ length: 25 }, (_, index) => 30 * 1.3 ** index) };
    const plan = planEq({ ...input, bands: { kick: odd }, now: NOW });
    expect(plan.summary.analysisSource).toMatch(/Cached analysis spectrogram/);
  });
});

describe("Fixture C: Kick Primary vs Bass Primary", () => {
  it("does not let either yield automatically", () => {
    const result = plan(
      song({
        tracks: [
          { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 8, onsets: 0.5 } },
          { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS, crest: 8 } },
        ],
      }),
    );
    expect(result.changes.filter((change) => change.status !== "needs-review")).toEqual([]);
    expect(result.summary.notes.join(" ")).toMatch(/Kick and Bass overlap strongly from .* but both are Primary and neither has a clear priority\. No automatic EQ change was proposed\./);
    expect(result.interactions.find((item) => item.kind === "kick-bass")?.outcome).toBe("ambiguous");
  });

  it("offers a review-only Bass cut when the Kick clearly owns a transient fundamental", () => {
    const result = plan(
      song({
        tracks: [
          { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 } },
          { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS, crest: 8 } },
        ],
      }),
    );
    for (const change of result.changes) {
      expect(change.status).toBe("needs-review");
      expect(change.confidence).toBeLessThan(0.6);
    }
  });
});

describe("Fixture D: never together", () => {
  it("does not flag tracks that share frequencies but never play at the same time", () => {
    const result = plan(
      song({
        tracks: [
          { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD, active: [[0, 30]] } },
          { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_MASKING, active: [[30, 60]] } },
        ],
      }),
    );
    expect(result.changes).toEqual([]);
    expect(result.interactions.filter((item) => item.trackA === "lead" || item.trackB === "lead")).toEqual([]);
  });
});

describe("Fixture E: already separated", () => {
  it("plans nothing when the important region is not competed for", () => {
    const result = plan(leadPad(PAD_SEPARATED));
    expect(result.changes.filter((change) => change.purpose === "separation")).toEqual([]);
    expect(result.summary.headline).toMatch(/No high-confidence EQ changes|EQ found/);
  });
});

describe("Fixture F: sparse Focal", () => {
  const sparse = () =>
    song({
      duration: 120,
      tracks: [
        { id: "pad", name: "Pad", role: "pad", fixture: { shape: sum(base(-30, -1), bump(1_800, 0.8, 9)) } },
        { id: "trumpet", name: "Trumpet", role: "brass", fixture: { shape: sum(base(-38, -2), bump(1_800, 0.6, 14)), active: [[90, 120]] } },
        { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 } },
      ],
      sections: [
        { id: "verse", name: "Verse", type: "verse", start: 0, end: 30 },
        { id: "build", name: "Build", type: "build", start: 30, end: 60 },
        { id: "drop", name: "Drop", type: "drop", start: 60, end: 90 },
        { id: "drop2", name: "Drop 2", type: "drop", start: 90, end: 120 },
      ],
      prominence: [{ track: "trumpet", section: "drop2", prominence: "focal" }],
    });

  it("puts the Pad cut in Drop 2 only", () => {
    const result = plan(sparse());
    const pad = moves(result, "pad").filter((change) => change.purpose === "separation");
    expect(pad.filter((change) => change.scope.type === "global")).toEqual([]);
    expect(pad).toHaveLength(1);
    expect(pad[0]!.scope).toEqual({ type: "section", sectionId: "drop2" });
    expect(pad[0]!.processing.filter.frequencyHz).toBeGreaterThanOrEqual(1_200);
    expect(pad[0]!.processing.filter.frequencyHz).toBeLessThanOrEqual(2_700);
    expect(pad[0]!.reasons.join(" ")).toMatch(/Only in Drop 2/);
    expect(pad[0]!.reasons[0]).toMatch(/marked Focal in Drop 2/);
  });

  it("reads Focal from a section note the same way AutoBalance does", () => {
    const noted = sparse();
    const document = {
      ...noted.document,
      sectionTrackSettings: [],
      sections: noted.document.sections.map((section) => (section.id === "drop2" ? { ...section, userIntent: "Trumpet should be more prominent." } : section)),
    };
    const result = planEq({ document, measurements: noted.measurements, now: NOW });
    const pad = moves(result, "pad").filter((change) => change.purpose === "separation");
    expect(pad.map((change) => change.scope)).toEqual([{ type: "section", sectionId: "drop2" }]);
    expect(pad[0]!.reasons[0]).toMatch(/Trumpet should be more prominent/);
  });
});

describe("global versus section", () => {
  it("prefers one track-wide cut when the conflict holds in every section", () => {
    const sections = [
      { id: "verse", name: "Verse", type: "verse" as const, start: 0, end: 30 },
      { id: "chorus", name: "Chorus", type: "chorus" as const, start: 30, end: 60 },
    ];
    const result = plan(
      song({
        tracks: [
          { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD } },
          { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_MASKING } },
        ],
        sections,
        prominence: sections.flatMap((section) => [
          { track: "lead", section: section.id, prominence: "focal" as const },
          { track: "pad", section: section.id, prominence: "supporting" as const },
        ]),
      }),
    );
    const pad = moves(result, "pad").filter((change) => change.purpose === "separation");
    expect(pad).toHaveLength(1);
    expect(pad[0]!.scope).toEqual({ type: "global" });
    expect(pad[0]!.reasons.join(" ")).toMatch(/Applied track-wide because the overlap holds in Verse and Chorus/);
  });
});

describe("high-pass", () => {
  const lowEnd = (padShape: typeof PAD_WITH_SUB) =>
    song({
      tracks: [
        { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 } },
        { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS } },
        { id: "pad", name: "Pad", role: "pad", fixture: { shape: padShape } },
      ],
    });

  it("adds a gentle high-pass to a supporting pad with real energy under the kick and bass", () => {
    const result = plan(lowEnd(PAD_WITH_SUB));
    const hpf = moves(result, "pad").find((change) => change.processing.filter.kind === "high-pass");
    expect(hpf).toBeTruthy();
    expect(hpf!.processing.filter.frequencyHz).toBeGreaterThanOrEqual(30);
    expect(hpf!.processing.filter.frequencyHz).toBeLessThanOrEqual(140);
    expect(hpf!.reasons[0]).toMatch(/Added a gentle high-pass at \d+ Hz because Pad keeps \d+% of its level below/);
    expect(hpf!.reasons[0]).toMatch(/Kick and Bass own the low end/);
    expect(result.changes.filter((change) => change.trackId !== "pad" && change.processing.filter.kind === "high-pass")).toEqual([]);
  });

  it("does not high-pass a pad that has no low end to remove", () => {
    const result = plan(lowEnd(PAD_NO_SUB));
    expect(moves(result, "pad").filter((change) => change.processing.filter.kind === "high-pass")).toEqual([]);
  });

  it("never high-passes everything by preset", () => {
    const result = plan(lowEnd(PAD_WITH_SUB));
    expect(result.changes.filter((change) => change.processing.filter.kind === "high-pass").length).toBeLessThanOrEqual(1);
  });
});

describe("current mix state", () => {
  it("uses the fader: a pad already pulled down does not need the cut", () => {
    const loud = plan(leadPad(PAD_MASKING, 0));
    const quiet = plan(leadPad(PAD_MASKING, -14));
    expect(moves(loud, "pad").length).toBeGreaterThan(0);
    expect(moves(quiet, "pad").filter((change) => change.purpose === "separation")).toEqual([]);
  });

  it("hears saved EQ, and replaces a nearby saved cut instead of stacking a second one", () => {
    const base = leadPad();
    const saved = setTrackEqNodes(base.document, "pad", [
      { id: "manual-1", type: "eq", enabled: true, filter: { kind: "bell", frequencyHz: 2_800, gainDb: -1, q: 1 }, origin: "manual", note: null },
    ]);
    if (!saved.ok) throw new Error(saved.message);
    const result = planEq({ document: saved.document, measurements: base.measurements, now: NOW });
    const pad = moves(result, "pad").filter((change) => change.purpose === "separation");
    for (const change of pad) {
      expect(change.replacesNodeId).toBe("manual-1");
      expect(change.processing.filter.gainDb).toBeLessThan(-1);
    }
    const first = plan(base);
    expect(eqPlanIsStale(first, saved.document)).toBe(true);
  });
});

describe("layering and stereo context", () => {
  it("leaves two stacked synths alone", () => {
    const result = plan(
      song({
        tracks: [
          { id: "s1", name: "Synth Stack 1", role: "synth", fixture: { shape: PAD_MASKING } },
          { id: "s2", name: "Synth Stack 2", role: "synth", fixture: { shape: PAD_MASKING } },
        ],
      }),
    );
    expect(result.changes.filter((change) => change.purpose === "separation")).toEqual([]);
  });

  it("scores the same overlap lower when the parts sit on opposite sides", () => {
    const centered = plan(leadPad());
    const wide = leadPad();
    const panned = {
      ...wide,
      document: { ...wide.document, tracks: wide.document.tracks.map((track) => ({ ...track, pan: track.id === "lead" ? -1 : 1 })) },
    };
    const apart = plan(panned);
    const severity = (result: EqPlan) => result.interactions.find((item) => item.protectedTrackId === "lead")?.severity ?? 0;
    expect(severity(apart)).toBeLessThan(severity(centered));
    expect(apart.interactions.find((item) => item.protectedTrackId === "lead")?.stereoSeparation).toBeGreaterThan(0.5);
  });
});

describe("tone words", () => {
  const brass = (shape: typeof LEAD, note: string) =>
    song({
      tracks: [
        { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 } },
        { id: "trumpet", name: "Trumpets", role: "brass", fixture: { shape } },
      ],
      sections: [
        { id: "verse", name: "Verse", type: "verse", start: 0, end: 30 },
        { id: "drop", name: "Drop", type: "drop", start: 30, end: 60, intent: note },
      ],
    });

  it("acts on a harsh note only where the spectrum confirms it", () => {
    const harsh = plan(brass(sum(base(-36, -2), bump(3_200, 0.4, 10)), "Trumpets are too harsh here."));
    const cut = moves(harsh, "trumpet").find((change) => change.purpose === "intent");
    expect(cut?.scope).toEqual({ type: "section", sectionId: "drop" });
    expect(cut!.processing.filter.frequencyHz).toBeGreaterThanOrEqual(2_000);
    expect(cut!.processing.filter.frequencyHz).toBeLessThanOrEqual(5_000);
    expect(cut!.processing.filter.gainDb).toBeLessThan(0);
    expect(cut!.reasons[0]).toMatch(/Trumpets are too harsh here/);

    const smooth = plan(brass(sum(base(-36, -2), bump(600, 0.8, 8)), "Trumpets are too harsh here."));
    expect(moves(smooth, "trumpet").filter((change) => change.purpose === "intent")).toEqual([]);
    expect(smooth.summary.notes.join(" ")).toMatch(/calls Trumpets harsh, but .* do not support an EQ change/);
  });

  it("keeps a level note a level note", () => {
    const result = plan(brass(sum(base(-36, -2), bump(3_200, 0.4, 10)), "Trumpets should dominate."));
    expect(result.changes.filter((change) => change.purpose === "intent")).toEqual([]);
  });

  it("ignores a negated tone word", () => {
    const result = plan(brass(sum(base(-36, -2), bump(3_200, 0.4, 10)), "The trumpets are not harsh."));
    expect(result.changes.filter((change) => change.purpose === "intent")).toEqual([]);
  });
});

describe("already-good mix", () => {
  it("returns few recommendations for a mix where parts already sit in their own ranges", () => {
    const result = plan(
      song({
        tracks: [
          { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 } },
          { id: "bass", name: "Bass", role: "bass", gainDb: -4, fixture: { shape: sum(base(-62, -3), bump(110, 0.5, 34), bump(700, 0.8, 6)) } },
          { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD } },
          { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_SEPARATED } },
          { id: "hat", name: "Hats", role: "hi-hat", fixture: { shape: sum(base(-70, 2), bump(9_000, 0.5, 30)) } },
          { id: "keys", name: "Keys", role: "keys", gainDb: -6, fixture: { shape: sum(base(-48, -2), bump(600, 0.7, 10)) } },
          { id: "fx", name: "Riser", role: "fx", gainDb: -8, fixture: { shape: sum(base(-50, 0), bump(6_000, 1, 6)), active: [[20, 30]] } },
        ],
      }),
    );
    expect(result.changes.filter((change) => change.status !== "needs-review").length).toBeLessThanOrEqual(2);
    const perTrack = new Map<string, number>();
    for (const change of result.changes) perTrack.set(change.trackId, (perTrack.get(change.trackId) ?? 0) + 1);
    for (const count of perTrack.values()) expect(count).toBeLessThanOrEqual(2);
  });
});

describe("limits, determinism, and contract", () => {
  it("is deterministic", () => {
    const input = leadPad();
    expect(JSON.stringify(plan(input))).toBe(JSON.stringify(plan(input)));
  });

  it("keeps automatic moves inside the strength limits", () => {
    for (const strength of ["conservative", "normal", "strong"] as const) {
      const result = plan(leadPad(), strength);
      const max = { conservative: 2, normal: 3.5, strong: 6 }[strength];
      for (const change of result.changes) {
        expect(change.processing.filter.gainDb).toBeGreaterThanOrEqual(-max);
        expect(change.processing.filter.q).toBeGreaterThanOrEqual(0.4);
        expect(change.processing.filter.q).toBeLessThanOrEqual(4);
      }
    }
  });

  it("caps the number of filters per track", () => {
    const tracks = [
      { id: "pad", name: "Pad", role: "pad" as const, fixture: { shape: sum(base(-26, 0), bump(90, 0.4, 8), bump(500, 0.4, 8), bump(2_500, 0.4, 8), bump(8_000, 0.4, 8)) } },
      { id: "kick", name: "Kick", role: "kick" as const, fixture: { shape: KICK, crest: 16, onsets: 2 } },
      { id: "lead", name: "Lead", role: "lead" as const, fixture: { shape: LEAD } },
      { id: "vox", name: "Vox", role: "vocal" as const, fixture: { shape: sum(base(-34, -2), bump(500, 0.5, 12)) } },
      { id: "hat", name: "Hats", role: "hi-hat" as const, fixture: { shape: sum(base(-60, 2), bump(8_000, 0.5, 20)) } },
    ];
    for (const strength of ["conservative", "normal"] as const) {
      const result = plan(song({ tracks }), strength);
      const max = strength === "conservative" ? 2 : 3;
      expect(moves(result, "pad").filter((change) => change.scope.type === "global").length).toBeLessThanOrEqual(max);
    }
  });

  it("goes stale on role, gain, sections, section intent, prominence, and EQ changes, and not on selection", () => {
    const input = leadPad();
    const result = plan(input);
    const doc = input.document;
    expect(eqPlanIsStale(result, doc)).toBe(false);
    expect(eqPlanIsStale(result, { ...doc, uiState: { ...doc.uiState, selectedTrackId: "pad", playheadSeconds: 12 } })).toBe(false);
    expect(eqPlanIsStale(result, { ...doc, tracks: doc.tracks.map((track) => (track.id === "pad" ? { ...track, role: "keys" as const } : track)) })).toBe(true);
    expect(eqPlanIsStale(result, { ...doc, tracks: doc.tracks.map((track) => (track.id === "pad" ? { ...track, gainDb: -1 } : track)) })).toBe(true);
    expect(eqPlanIsStale(result, { ...doc, sections: doc.sections.map((section) => ({ ...section, endTime: 50 })) })).toBe(true);
    expect(eqPlanIsStale(result, { ...doc, sections: doc.sections.map((section) => ({ ...section, userIntent: "Pad is muddy" })) })).toBe(true);
    const prominence = setTrackSectionState(doc, "pad", "all", { prominence: "primary" });
    if (!prominence.ok) throw new Error("setup");
    expect(eqPlanIsStale(result, prominence.document)).toBe(true);
    expect(eqPlanIsStale(result, doc, [], { strength: "strong" })).toBe(true);
  });

  it("finishes quickly on 32 stems", () => {
    const tracks = Array.from({ length: 32 }, (_, index) => ({
      id: `t${index}`,
      name: `Track ${index}`,
      role: (["kick", "bass", "lead", "pad", "synth", "keys", "guitar", "hi-hat"] as const)[index % 8],
      fixture: { shape: sum(base(-40, -1), bump(60 * 1.5 ** (index % 14), 0.6, 12)), active: [[(index % 4) * 10, 60 - (index % 3) * 10]] as Array<[number, number]> },
    }));
    const started = Date.now();
    const result = planEq({
      ...song({ tracks, duration: 180, sections: [
        { id: "a", name: "Intro", type: "intro", start: 0, end: 30 },
        { id: "b", name: "Verse", type: "verse", start: 30, end: 90 },
        { id: "c", name: "Drop", type: "drop", start: 90, end: 180 },
      ] }),
      now: NOW,
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000);
    expect(result.summary.pairsAnalyzed).toBeLessThanOrEqual(496);
    for (const change of result.changes) expect(change.reasons.length).toBeGreaterThan(0);
  });
});
