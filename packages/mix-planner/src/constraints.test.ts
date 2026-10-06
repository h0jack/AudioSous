import { describe, expect, it } from "vitest";
import { fixtureA, fixtureB, fixtureH, multiProblem } from "./fixtures";
import {
  applyFullMixPlan,
  cleanNote,
  emptyConstraints,
  fullMixPlanIsStale,
  planFullMix,
  scaleChange,
  setChangeStatus,
  simplifyFullMix,
  type FullMixPlan,
  type MixConstraints,
} from "./index";
import { LEAD, PAD_MASKING, mixSong, type MixSong } from "./testing";

const NOW = "2026-10-05T00:00:00.000Z";

function plan(song: MixSong, constraints: Partial<MixConstraints> | null = null): FullMixPlan {
  return planFullMix({ ...song, now: NOW, constraints: constraints ? { ...emptyConstraints(), ...constraints } : null });
}

/** Fixture A over two sections, so a request can be confined to one of them. */
function twoSections(): MixSong {
  return mixSong({
    tracks: [
      { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD } },
      { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_MASKING }, stereo: { correlation: 0.95 } },
    ],
    sections: [
      { id: "verse", name: "Verse", type: "verse", start: 0, end: 30 },
      { id: "chorus", name: "Chorus", type: "chorus", start: 30, end: 60 },
    ],
    prominence: [
      { track: "lead", section: "verse", prominence: "focal" },
      { track: "lead", section: "chorus", prominence: "focal" },
    ],
  });
}

describe("constraints", () => {
  it("an empty constraint set plans exactly what no constraints plans", () => {
    const song = multiProblem();
    const free = plan(song);
    const empty = plan(song, {});
    expect(JSON.stringify(empty)).toBe(JSON.stringify(free));
    expect(free.constraints).toBeUndefined();
  });

  it("a protected stem is measured but never changed; the plan works around it", () => {
    const song = multiProblem();
    const free = plan(song);
    expect(free.changes.some((change) => change.trackId === "bass")).toBe(true);
    const result = plan(song, { protectedTrackIds: ["bass"] });
    expect(result.changes.filter((change) => change.domain !== "trim" && change.trackId === "bass")).toEqual([]);
    // The kick/bass problem is still measured and reported, with the constraint as the reason nothing was done.
    const lowEnd = result.problems.find((problem) => problem.id === "low-end:kick|bass")!;
    expect(lowEnd.outcome).toBe("left-alone");
    expect(lowEnd.explanation).toMatch(/left alone as asked/);
    expect(result.constraints?.protectedTrackIds).toEqual(["bass"]);
  });

  it("an excluded domain is never planned, and the same problem is solved another way or left alone", () => {
    const song = fixtureA();
    const free = plan(song);
    expect(free.changes.some((change) => change.domain === "eq")).toBe(true);
    const result = plan(song, { excludedDomains: ["eq"] });
    expect(result.changes.some((change) => change.domain === "eq")).toBe(false);
    for (const intervention of result.interventions) expect(intervention.items.some((item) => item.domain === "eq")).toBe(false);
  });

  it("an excluded processor (no ducking) is never planned", () => {
    const result = plan(fixtureB(), { excludedProcessors: ["ducking"] });
    expect(result.changes.some((change) => change.processing.type === "dynamics" && change.processing.processing.type === "ducking")).toBe(false);
  });

  it("focus plans only problems that involve the focused stems", () => {
    const song = multiProblem();
    const result = plan(song, { focusTrackIds: ["synth"] });
    expect(result.problems.length).toBeGreaterThan(0);
    for (const problem of result.problems) expect(problem.trackIds).toContain("synth");
    expect(result.changes.some((change) => change.trackId === "bass")).toBe(false);
  });

  it("a change that moves a problem outside the focus is scored as a regression there, not as a new problem", () => {
    // Focus on the kick: the kick/bass collision is planned; the bass's own level problems are measured, not planned.
    const result = plan(multiProblem(), { focusTrackIds: ["kick"] });
    const lowEnd = result.problems.find((problem) => problem.type === "low-end-collision")!;
    expect(lowEnd.outcome === "solved" || lowEnd.outcome === "improved").toBe(true);
    expect(result.changes.some((change) => change.trackId === "bass")).toBe(true);
    for (const regression of result.evaluation.regressions) expect(regression.kind).not.toBe("new-problem");
  });

  it("only-these-sections moves song-wide changes into the section and nothing outside it changes", () => {
    const song = twoSections();
    const free = plan(song);
    expect(free.changes.some((change) => change.scope.type === "global" && change.domain !== "trim")).toBe(true);
    const result = plan(song, { sectionIds: ["chorus"] });
    const real = result.changes.filter((change) => change.domain !== "trim");
    expect(real.length).toBeGreaterThan(0);
    for (const change of real) expect(change.scope).toEqual({ type: "section", sectionId: "chorus" });
    const applied = applyFullMixPlan(song.document, result, "all");
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    // The verse and the song-wide settings are untouched (apart from a uniform safety trim, if any).
    const trim = result.candidateTrim.gainDb;
    for (const track of applied.document.tracks) {
      const before = song.document.tracks.find((item) => item.id === track.id)!;
      expect(track.processing).toEqual(before.processing);
      expect(track.pan).toBe(before.pan);
      expect(track.width).toBe(before.width);
      expect(track.gainDb).toBeCloseTo(before.gainDb + trim, 2);
    }
    expect(applied.document.sectionTrackSettings.filter((row) => row.sectionId === "verse")).toEqual(song.document.sectionTrackSettings.filter((row) => row.sectionId === "verse").map((row) => ({ ...row, overrides: { ...row.overrides, gainDb: row.overrides.gainDb === null ? null : row.overrides.gainDb + trim } })));
  });

  it("constraints are part of the plan's identity but a plan stays fresh on its own project", () => {
    const song = multiProblem();
    const result = plan(song, { protectedTrackIds: ["pad"] });
    const free = plan(song);
    expect(result.stateIdentity).not.toBe(free.stateIdentity);
    expect(fullMixPlanIsStale(result, song.document)).toBe(false);
    expect(fullMixPlanIsStale(free, song.document)).toBe(false);
  });

  it("a request intent is planned like a section note, without being written or making the plan stale", () => {
    // Fixture H's drop note ("wider and punchier") as a request instead of a saved note.
    const song = fixtureH();
    const silent = { ...song, document: { ...song.document, sections: song.document.sections.map((section) => ({ ...section, userIntent: null })) } };
    const noted = plan(song);
    const without = plan(silent);
    const asked = plan(silent, { intents: [{ sectionId: "drop", trackId: null, note: "The drop should feel wider and punchier." }] });
    expect(noted.changes.length).toBeGreaterThan(0);
    expect(asked.changes.map((change) => change.id).sort()).toEqual(noted.changes.map((change) => change.id).sort());
    expect(without.changes.length).toBeLessThan(asked.changes.length);
    expect(fullMixPlanIsStale(asked, silent.document)).toBe(false);
    const applied = applyFullMixPlan(silent.document, asked, "all");
    expect(applied.ok && applied.document.sections.every((section) => section.userIntent === null)).toBe(true);
  });

  it("strips numbers from request intents, so a note cannot carry a value", () => {
    expect(cleanNote("Cut the pad 3.5 dB at 2400 Hz")).toBe("Cut the pad dB at Hz");
  });

  it("is deterministic", () => {
    const song = multiProblem();
    expect(JSON.stringify(plan(song, { protectedTrackIds: ["lead"], excludedDomains: ["space"] }))).toBe(JSON.stringify(plan(song, { excludedDomains: ["space"], protectedTrackIds: ["lead"] })));
  });
});

describe("refinement", () => {
  it("scales a change from its current value, inside the planner's bounds", () => {
    const result = plan(fixtureA());
    const eq = result.changes.find((change) => change.processing.type === "eq")!;
    expect(eq).toBeDefined();
    const before = eq.processing.type === "eq" ? eq.processing.filter.gainDb : 0;
    const half = scaleChange(result, eq.id, 0.5);
    expect(half.scaled).toBe(true);
    const after = half.plan.changes.find((change) => change.id === eq.id)!;
    expect(Math.abs((after.processing.type === "eq" ? after.processing.filter.gainDb : 0) - before * 0.5)).toBeLessThanOrEqual(0.26);
    expect(after.edited).toBe(true);
    // From the edited value, not the planned one: "a little less" again halves the edit.
    const again = scaleChange(half.plan, eq.id, 0.5).plan.changes.find((change) => change.id === eq.id)!;
    expect(Math.abs((again.processing.type === "eq" ? again.processing.filter.gainDb : 0) - (after.processing.type === "eq" ? after.processing.filter.gainDb : 0) * 0.5)).toBeLessThanOrEqual(0.26);
    // "Much more" is still clamped to the editor's bounds.
    const big = scaleChange(result, eq.id, 2).plan.changes.find((change) => change.id === eq.id)!;
    expect(big.processing.type === "eq" && big.processing.filter.gainDb).toBeGreaterThanOrEqual(-12);
    expect(scaleChange(result, "nope", 0.5).scaled).toBe(false);
  });

  it("simplifies a candidate by taking out what the re-measured mix misses least", () => {
    const song = multiProblem();
    const result = plan(song);
    expect(result.changes.length).toBeGreaterThan(2);
    const simple = simplifyFullMix({ ...song, now: NOW }, result, { keep: 0.6 });
    expect(simple.after.changes).toBe(simple.before.changes - simple.removed.length);
    expect(simple.after.cost).toBeLessThanOrEqual(simple.before.cost);
    if (simple.removed.length > 0) {
      expect(simple.kept).toBeGreaterThanOrEqual(0.6);
      for (const removed of simple.removed) expect(simple.plan.changes.find((change) => change.id === removed.changeId)?.status).toBe("rejected");
      expect(simple.plan.summary.notes[0]).toMatch(/^Simplified/);
    }
    // Nothing is deleted: a removed change can be brought back.
    const restored = simple.removed.reduce((current, item) => setChangeStatus(current, item.changeId, "proposed"), simple.plan);
    expect(restored.changes.length).toBe(result.changes.length);
  });
});
