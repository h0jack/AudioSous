import { multiProblem } from "@audiosous/mix-planner/testing";
import type { ProjectDocument, Track, TrackRole } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import { emptySession } from "./contract";
import { readApproval, readConstraints, readDirectEdits, readStatedFactors } from "./language";
import { findMentions, referenceContext, resolveSection, resolveTrack } from "./references";

/** A project with the names people actually use: two trumpets, a bass and a bass drum, several synths, five sections. */
export function namedProject(): ProjectDocument {
  const base = multiProblem().document;
  const template = base.tracks[0]!;
  const track = (id: string, name: string, role: TrackRole, extra: Partial<Track> = {}): Track => ({ ...template, id, name, role, customLabel: null, ...extra });
  return {
    ...base,
    tracks: [
      track("kick", "Kick", "kick"),
      track("bassdrum", "Bass Drum Room", "kick"),
      track("bass", "Bass Bus", "bass"),
      track("tp1", "Trumpet Main", "brass"),
      track("tp2", "Trumpet Double", "brass"),
      track("arp", "Arp", "synth"),
      track("pad", "Pad", "pad"),
      track("lead", "Lead Synth", "lead"),
      track("subway", "Subway Synth", "synth"),
      track("vox", "VOX_take3", "vocal", { customLabel: "Lead Vocal" }),
    ],
    sections: [
      { id: "intro", name: "Intro", type: "intro", startTime: 0, endTime: 10, userIntent: null, source: "manual", confidence: null, structuralGroupId: null },
      { id: "drop1", name: "Drop", type: "drop", startTime: 10, endTime: 20, userIntent: null, source: "manual", confidence: null, structuralGroupId: null },
      { id: "break", name: "Breakdown", type: "breakdown", startTime: 20, endTime: 30, userIntent: null, source: "manual", confidence: null, structuralGroupId: null },
      { id: "drop2", name: "Drop 2", type: "drop", startTime: 30, endTime: 40, userIntent: null, source: "manual", confidence: null, structuralGroupId: null },
      { id: "outro", name: "Outro", type: "outro", startTime: 40, endTime: 60, userIntent: null, source: "manual", confidence: null, structuralGroupId: null },
    ],
    sectionTrackSettings: [],
    uiState: { ...base.uiState, selectedTrackId: null, selectedSectionId: null, playheadSeconds: 0 },
  };
}

const ctxOf = (document: ProjectDocument) => referenceContext(document, emptySession(document.project.id).focus);

describe("track references", () => {
  const document = namedProject();
  const ctx = ctxOf(document);
  it("resolves names, labels, and roles", () => {
    expect(resolveTrack(document, "the pad", ctx)).toMatchObject({ kind: "match", trackIds: ["pad"] });
    expect(resolveTrack(document, "Bass Bus", ctx)).toMatchObject({ kind: "match", trackIds: ["bass"] });
    expect(resolveTrack(document, "the vocal", ctx)).toMatchObject({ kind: "match", trackIds: ["vox"] });
    expect(resolveTrack(document, "lead vocal", ctx)).toMatchObject({ kind: "match", trackIds: ["vox"] });
    expect(resolveTrack(document, "the lead", ctx)).toMatchObject({ kind: "match", trackIds: ["lead"] });
  });
  it("prefers the stem whose role matches when a word names several", () => {
    // "bass" is in "Bass Bus" and "Bass Drum Room"; the bass role decides.
    expect(resolveTrack(document, "the bass", ctx)).toMatchObject({ kind: "match", trackIds: ["bass"] });
  });
  it("reports genuine ambiguity instead of guessing", () => {
    expect(resolveTrack(document, "the trumpet", ctx)).toEqual({ kind: "ambiguous", trackIds: ["tp1", "tp2"] });
    expect(resolveTrack(document, "that synth", ctx)).toMatchObject({ kind: "ambiguous" });
  });
  it("lets the selection or the conversation settle an ambiguous reference", () => {
    const selected = { ...document, uiState: { ...document.uiState, selectedTrackId: "tp2" } };
    expect(resolveTrack(selected, "the trumpet", ctxOf(selected))).toMatchObject({ kind: "match", trackIds: ["tp2"], via: "selection" });
    const focused = referenceContext(document, { trackIds: ["subway"], sectionId: null, problemId: null, changeId: null });
    expect(resolveTrack(document, "that synth", focused)).toMatchObject({ kind: "match", trackIds: ["subway"] });
    expect(resolveTrack(selected, "this", ctxOf(selected))).toMatchObject({ kind: "match", trackIds: ["tp2"] });
  });
  it("reads plurals as the group", () => {
    expect(resolveTrack(document, "the trumpets", ctx)).toMatchObject({ kind: "match", trackIds: ["tp1", "tp2"], via: "group" });
    expect(resolveTrack(document, "all the synths", ctx)).toMatchObject({ kind: "match", via: "group" });
  });
  it("finds nothing for words that are not stems", () => {
    expect(resolveTrack(document, "the cowbell", ctx)).toEqual({ kind: "none" });
  });
});

describe("section references", () => {
  const document = namedProject();
  const ctx = ctxOf(document);
  it("resolves names, ordinals, numbers, and types", () => {
    expect(resolveSection(document, "Drop 2", ctx)).toMatchObject({ sectionIds: ["drop2"] });
    expect(resolveSection(document, "the second drop", ctx)).toMatchObject({ sectionIds: ["drop2"] });
    expect(resolveSection(document, "the first drop", ctx)).toMatchObject({ sectionIds: ["drop1"] });
    expect(resolveSection(document, "the last drop", ctx)).toMatchObject({ sectionIds: ["drop2"] });
    expect(resolveSection(document, "the breakdown", ctx)).toMatchObject({ sectionIds: ["break"] });
    // A type names every section of it.
    expect(resolveSection(document, "the drops", ctx)).toMatchObject({ sectionIds: ["drop1", "drop2"], via: "type" });
  });
  it("reads 'here' as the selected section, else the one under the playhead", () => {
    const playing = { ...document, uiState: { ...document.uiState, playheadSeconds: 25 } };
    expect(resolveSection(playing, "here", ctxOf(playing))).toMatchObject({ sectionIds: ["break"], via: "playhead" });
    const selected = { ...playing, uiState: { ...playing.uiState, selectedSectionId: "drop2" } };
    expect(resolveSection(selected, "this section", ctxOf(selected))).toMatchObject({ sectionIds: ["drop2"], via: "selection" });
    expect(resolveSection(selected, "where we are now", ctxOf(selected))).toMatchObject({ sectionIds: ["drop2"] });
  });
  it("finds the stems and sections a message mentions", () => {
    const found = findMentions(document, "The trumpets should stand out more in the second drop, but not over the Lead Vocal", ctx);
    expect(found.sections.map((item) => item.resolution)).toContainEqual(expect.objectContaining({ sectionIds: ["drop2"] }));
    expect(found.tracks.map((item) => item.resolution)).toContainEqual(expect.objectContaining({ trackIds: ["tp1", "tp2"] }));
    expect(found.tracks.map((item) => item.resolution)).toContainEqual(expect.objectContaining({ trackIds: ["vox"] }));
  });
});

describe("constraints", () => {
  const document = namedProject();
  const ctx = ctxOf(document);
  it("protects stems the person names", () => {
    expect(readConstraints(document, "Make the chorus punchier but don't change the vocal.", ctx).protectedTrackIds).toEqual(["vox"]);
    expect(readConstraints(document, "Make the vocal clearer, but don't touch the vocal itself.", ctx).protectedTrackIds).toEqual(["vox"]);
    expect(readConstraints(document, "Leave the pad alone", ctx).protectedTrackIds).toEqual(["pad"]);
    expect(readConstraints(document, "Don't touch the kick.", ctx).protectedTrackIds).toEqual(["kick"]);
    expect(readConstraints(document, "Make the drop wider without changing the lead.", ctx).protectedTrackIds).toEqual(["lead"]);
    expect(readConstraints(document, "Clean it up without touching the pad", ctx).protectedTrackIds).toEqual(["pad"]);
  });
  it("reports an ambiguous protected stem instead of guessing", () => {
    expect(readConstraints(document, "don't touch the trumpet", ctx).unresolved).toEqual([{ phrase: "trumpet", options: ["tp1", "tp2"] }]);
  });
  it("rules out domains and processors", () => {
    expect(readConstraints(document, "Fix the low end without moving anything in stereo.", ctx).excludedDomains).toContain("space");
    expect(readConstraints(document, "Keep the stereo image exactly as it is.", ctx).excludedDomains).toEqual(["space"]);
    expect(readConstraints(document, "No compression.", ctx).excludedProcessors).toEqual(["compressor"]);
    expect(readConstraints(document, "Leave EQ alone", ctx).excludedDomains).toEqual(["eq"]);
    expect(readConstraints(document, "Try it without the sidechain.", ctx).excludedProcessors).toEqual(["ducking"]);
    expect(readConstraints(document, "No stereo changes please", ctx).excludedDomains).toEqual(["space"]);
  });
  it("reads scope", () => {
    expect(readConstraints(document, "Only make changes in Drop 2.", ctx).onlySectionIds).toEqual(["drop2"]);
    expect(readConstraints(document, "Only change the breakdown", ctx).onlySectionIds).toEqual(["break"]);
    expect(readConstraints(document, "Don't change the intro.", ctx).excludedSectionIds).toEqual(["intro"]);
  });
  it("places a request in a section when the person says where", () => {
    const selected = { ...document, uiState: { ...document.uiState, selectedTrackId: "tp1", selectedSectionId: "drop2" } };
    expect(readConstraints(selected, "Make this stand out more here.", ctxOf(selected)).onlySectionIds).toEqual(["drop2"]);
    expect(readConstraints(document, "The trumpets should stand out more in the second drop", ctx).onlySectionIds).toEqual(["drop2"]);
    expect(readConstraints(document, "The trumpet should stand out more.", ctx).onlySectionIds).toBeNull();
    expect(readConstraints(document, "Fix the low end without moving anything in stereo.", ctx).onlySectionIds).toBeNull();
    // A question about a section is not an instruction to change only that section.
    expect(readConstraints(document, "Why is it crowded in the breakdown?", ctx).onlySectionIds).toBeNull();
  });

  it("reads strength words, and when they are a standing preference", () => {
    expect(readConstraints(document, "Keep this subtle.", ctx).strength).toBe("conservative");
    expect(readConstraints(document, "Try something more conservative.", ctx).strength).toBe("conservative");
    expect(readConstraints(document, "Push it, more aggressive", ctx).strength).toBe("strong");
    expect(readConstraints(document, "From now on keep changes subtle", ctx).standingStrength).toBe(true);
    expect(readConstraints(document, "Make the chorus feel bigger", ctx).strength).toBeNull();
  });
  it("reads narrow routes", () => {
    expect(readConstraints(document, "Only fix the levels.", ctx).route).toBe("level");
    expect(readConstraints(document, "Just work on compression.", ctx).route).toBe("dynamics");
    expect(readConstraints(document, "Only fix EQ on the vocal.", ctx).route).toBe("eq");
  });
  it("releases a protected stem", () => {
    expect(readConstraints(document, "You can touch the vocal now.", ctx).releasedTrackIds).toEqual(["vox"]);
  });
});

describe("approval", () => {
  const ready = { candidateReady: true, candidatePresented: true, offeredToBuild: false, canUndoApply: false };
  it("approves only explicit applies", () => {
    expect(readApproval("Apply it.", ready).apply).toBe(true);
    expect(readApproval("Apply that", ready).apply).toBe(true);
    expect(readApproval("Can you apply it?", ready).apply).toBe(true);
    expect(readApproval("Apply those two.", ready)).toMatchObject({ apply: true, applyMode: "accepted" });
    expect(readApproval("Do it.", ready).apply).toBe(true);
  });
  it("does not treat hearing, questions, or holding off as apply", () => {
    expect(readApproval("Let's hear it.", ready)).toMatchObject({ apply: false, preview: true });
    expect(readApproval("Should I apply it?", ready).apply).toBe(false);
    expect(readApproval("What would applying do?", ready).apply).toBe(false);
    expect(readApproval("Don't apply it yet", ready).apply).toBe(false);
    expect(readApproval("Make the chorus punchier.", ready).apply).toBe(false);
  });
  it("needs a presented, fresh candidate for a bare 'do it'", () => {
    expect(readApproval("Do it.", { ...ready, candidatePresented: false }).apply).toBe(false);
    expect(readApproval("Yes, do it", { ...ready, offeredToBuild: true }).apply).toBe(false);
    expect(readApproval("Apply it", { ...ready, candidateReady: false }).apply).toBe(false);
  });
  it("reads undo, only when there is an agent apply to undo", () => {
    expect(readApproval("Undo that.", { ...ready, canUndoApply: true }).undo).toBe(true);
    expect(readApproval("Undo that.", ready).undo).toBe(false);
    expect(readApproval("Go back to the first one", { ...ready, canUndoApply: true }).undo).toBe(false);
  });
});

describe("explicit values", () => {
  const document = namedProject();
  const ctx = ctxOf(document);
  it("reads gain, pan, and width instructions", () => {
    expect(readDirectEdits(document, "Make Bass 1 dB quieter.", ctx).edits).toEqual([{ phrase: "bass", trackIds: ["bass"], control: "gain", mode: "delta", value: -1, sectionIds: null }]);
    expect(readDirectEdits(document, "lower the pad by 2.5 dB", ctx).edits[0]).toMatchObject({ trackIds: ["pad"], value: -2.5 });
    expect(readDirectEdits(document, "Pan the arp 20% left.", ctx).edits[0]).toMatchObject({ trackIds: ["arp"], control: "pan", mode: "set", value: -20 });
    expect(readDirectEdits(document, "set the pad width to 80%", ctx).edits[0]).toMatchObject({ trackIds: ["pad"], control: "width", value: 80 });
    expect(readDirectEdits(document, "Make the pad 2 dB louder in Drop 2", ctx).edits[0]).toMatchObject({ trackIds: ["pad"], value: 2, sectionIds: ["drop2"] });
  });
  it("reads no value from an intent request", () => {
    expect(readDirectEdits(document, "Move the arp out of the vocal's way.", ctx).edits).toEqual([]);
    expect(readDirectEdits(document, "Make the bass tighter.", ctx).edits).toEqual([]);
  });
  it("flags an ambiguous stem in an explicit instruction", () => {
    expect(readDirectEdits(document, "Make the trumpet 1 dB louder", ctx).ambiguous).toHaveLength(1);
  });
  it("reads stated factors", () => {
    expect(readStatedFactors("Make that 25% weaker.")).toEqual([0.75]);
    expect(readStatedFactors("half as much")).toEqual([0.5]);
    expect(readStatedFactors("20% more width")).toEqual([1.2]);
    expect(readStatedFactors("a little less")).toEqual([]);
  });
});
