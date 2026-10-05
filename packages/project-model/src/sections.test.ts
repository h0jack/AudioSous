import { describe, expect, it } from "vitest";
import { createProject } from "./create-project";
import { projectDocumentSchema } from "./schema";
import { addManualSection, applyAutomaticSections, clearSuggestedSections, mergeSectionWithNext, moveSectionBoundary, removeSection, sectionAtTime, setTrackSectionState, splitSection, updateSection } from "./sections";

function document() {
  return createProject({
    name: "Night Drive",
    now: new Date("2026-10-03T14:00:00.000Z"),
    tracks: [
      {
        id: "track-kick",
        name: "Kick",
        role: "kick",
        filename: "kick.wav",
        relativePath: "media/track-kick__kick.wav",
        metadata: {
          format: "wav",
          sampleRate: 48_000,
          channelCount: 2,
          bitDepth: 24,
          durationSeconds: 120,
          fileSizeBytes: 1_000,
        },
      },
    ],
  });
}

describe("section at the playhead", () => {
  it("starts at the song start, then at the end of the previous section, and splits inside a section", () => {
    const first = sectionAtTime(document(), 16);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.document.sections.map((section) => [section.startTime, section.endTime])).toEqual([[0, 16]]);

    const second = sectionAtTime(first.document, 48);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.document.sections.map((section) => [section.startTime, section.endTime])).toEqual([[0, 16], [16, 48]]);
    const added = second.document.sections[1]!;
    expect(second.document.uiState.selectedSectionId).toBe(added.id);

    const split = sectionAtTime(second.document, 30);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.document.sections.map((section) => [section.startTime, section.endTime])).toEqual([[0, 16], [16, 30], [30, 48]]);
    expect(split.document.uiState.selectedSectionId).toBe(split.document.sections[2]!.id);
  });

  it("fills the gap after the nearest earlier section without touching a later one", () => {
    const later = addManualSection(document(), { startTime: 60, endTime: 90 });
    if (!later.ok) throw new Error(later.message);
    const early = addManualSection(later.document, { startTime: 0, endTime: 10 });
    if (!early.ok) throw new Error(early.message);
    const result = sectionAtTime(early.document, 40);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.sections.map((section) => [section.startTime, section.endTime])).toEqual([[0, 10], [10, 40], [60, 90]]);
  });

  it("refuses a section shorter than a quarter second and a split at a boundary", () => {
    expect(sectionAtTime(document(), 0.1).ok).toBe(false);
    const first = sectionAtTime(document(), 16);
    if (!first.ok) throw new Error(first.message);
    expect(sectionAtTime(first.document, 16.1).ok).toBe(false);
    expect(sectionAtTime(first.document, 15.9).ok).toBe(false);
  });
});

describe("manual sections", () => {
  it("stores a new section in start-time order and selects it", () => {
    const first = addManualSection(document(), { startTime: 30, endTime: 60, type: "chorus" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = addManualSection(first.document, { startTime: 0, endTime: 16, name: "Intro" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.document.sections.map((section) => section.name)).toEqual(["Intro", "Section"]);
    expect(second.document.sections[0]).toMatchObject({ source: "manual", type: null, startTime: 0, endTime: 16 });
    expect(second.document.sections[1]?.type).toBe("chorus");
    expect(second.document.uiState.selectedSectionId).toBe(second.document.sections[0]?.id);
    expect(projectDocumentSchema.safeParse(second.document).success).toBe(true);
  });

  it("rejects an overlap and a zero-length range, and allows sections that only touch", () => {
    const created = addManualSection(document(), { name: "Verse", startTime: 10, endTime: 20 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(addManualSection(created.document, { startTime: 19, endTime: 30 }).ok).toBe(false);
    expect(addManualSection(created.document, { startTime: 4, endTime: 4 }).ok).toBe(false);
    const touching = addManualSection(created.document, { name: "Chorus", startTime: 20, endTime: 40 });
    expect(touching.ok).toBe(true);
  });

  it("moves a section without overlapping and marks an automatic section as edited", () => {
    const created = addManualSection(document(), { name: "Drop", startTime: 40, endTime: 70 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.document.sections[0]!.id;
    const automatic = {
      ...created.document,
      sections: [{ ...created.document.sections[0]!, source: "automatic" as const, confidence: 0.4 }],
    };
    const moved = updateSection(automatic, id, { startTime: 8, endTime: 24, name: "Edited drop" });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.document.sections[0]).toMatchObject({
      name: "Edited drop",
      startTime: 8,
      endTime: 24,
      source: "automatic-edited",
      confidence: 0.4,
    });
    const blocked = updateSection(moved.document, id, { endTime: 4 });
    expect(blocked.ok).toBe(false);
  });

  it("removes the section, its track settings, and a dangling selection", () => {
    const created = addManualSection(document(), { startTime: 0, endTime: 8 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sectionId = created.document.sections[0]!.id;
    const withSetting = {
      ...created.document,
      sectionTrackSettings: [
        {
          trackId: "track-kick",
          sectionId,
          userIntent: "Keep it dry",
          prominence: null,
          overrides: { gainDb: null, pan: null },
          processing: { schemaVersion: 1 as const, nodes: [] },
        },
      ],
      uiState: {
        ...created.document.uiState,
        loop: { enabled: true, start: 0, end: 8, sectionId },
      },
    };
    const next = removeSection(withSetting, sectionId);
    expect(next.sections).toEqual([]);
    expect(next.sectionTrackSettings).toEqual([]);
    expect(next.uiState.selectedSectionId).toBeNull();
    expect(next.uiState.loop).toEqual({ enabled: true, start: 0, end: 8, sectionId: null });
    expect(projectDocumentSchema.safeParse(next).success).toBe(true);
  });

  it("stores section intent and one note per track", () => {
    const created = addManualSection(document(), { name: "Chorus", type: "chorus", startTime: 10, endTime: 30 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sectionId = created.document.sections[0]!.id;
    const withIntent = updateSection(created.document, sectionId, { userIntent: "  Open it up  " });
    expect(withIntent.ok).toBe(true);
    if (!withIntent.ok) return;
    expect(withIntent.document.sections[0]?.userIntent).toBe("Open it up");
    const noted = setTrackSectionState(withIntent.document, "track-kick", sectionId, {
      userIntent: "Leave the kick dry",
      prominence: "primary",
    });
    expect(noted.ok).toBe(true);
    if (!noted.ok) return;
    expect(noted.document.sectionTrackSettings).toEqual([
      expect.objectContaining({ trackId: "track-kick", sectionId, userIntent: "Leave the kick dry", prominence: "primary" }),
    ]);
    const cleared = setTrackSectionState(noted.document, "track-kick", sectionId, { userIntent: "  ", prominence: null });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.document.sectionTrackSettings).toEqual([]);
    expect(projectDocumentSchema.safeParse(cleared.document).success).toBe(true);
  });

  it("keeps a loop attached to a section and adds automatic sections only in the gaps", () => {
    const created = addManualSection(document(), { name: "Verse", startTime: 20, endTime: 40 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sectionId = created.document.sections[0]!.id;
    const looping = {
      ...created.document,
      uiState: { ...created.document.uiState, loop: { enabled: true, start: 20, end: 40, sectionId } },
    };
    const moved = updateSection(looping, sectionId, { startTime: 24, endTime: 48 });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.document.uiState.loop).toEqual({ enabled: true, start: 24, end: 48, sectionId });

    const applied = applyAutomaticSections(moved.document, [
      {
        startTime: 0,
        endTime: 24,
        suggestedName: "Intro",
        suggestedType: "intro",
        confidence: 0.4,
        structuralGroupId: null,
      },
      {
        startTime: 10,
        endTime: 30,
        suggestedName: "Overlap",
        suggestedType: "chorus",
        confidence: 0.5,
        structuralGroupId: "chorus",
      },
      {
        startTime: 48,
        endTime: 80,
        suggestedName: "Outro",
        suggestedType: "outro",
        confidence: 0.42,
        structuralGroupId: null,
      },
    ]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.document.sections.map((section) => [section.name, section.source])).toEqual([
      ["Intro", "automatic"],
      ["Verse", "manual"],
      ["Outro", "automatic"],
    ]);
    expect(projectDocumentSchema.safeParse(applied.document).success).toBe(true);
    expect(applyAutomaticSections(applied.document, []).ok).toBe(false);
  });

  it("drags a shared guide without letting sections cross", () => {
    const first = addManualSection(document(), { name: "Verse", startTime: 0, endTime: 20 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = addManualSection(first.document, { name: "Chorus", type: "chorus", startTime: 20, endTime: 40 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const moved = moveSectionBoundary(second.document, 20, 28);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.time).toBe(28);
    expect(moved.document.sections.map((section) => [section.startTime, section.endTime])).toEqual([
      [0, 28],
      [28, 40],
    ]);
    const clamped = moveSectionBoundary(moved.document, 28, 39.9);
    expect(clamped.ok).toBe(true);
    if (!clamped.ok) return;
    expect(clamped.time).toBe(39.75);
    const gapped = addManualSection(document(), { name: "Intro", startTime: 0, endTime: 10 });
    expect(gapped.ok).toBe(true);
    if (!gapped.ok) return;
    const later = addManualSection(gapped.document, { name: "Outro", startTime: 30, endTime: 40 });
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    const edge = moveSectionBoundary(later.document, 10, 36);
    expect(edge.ok).toBe(true);
    if (!edge.ok) return;
    expect(edge.document.sections.map((section) => [section.name, section.startTime, section.endTime])).toEqual([
      ["Intro", 0, 30],
      ["Outro", 30, 40],
    ]);
  });

  it("marks a suggested section edited and keeps a linked loop on the new bounds", () => {
    const added = addManualSection(document(), { name: "Intro", startTime: 0, endTime: 20 });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const section = added.document.sections[0];
    if (!section) return;
    const suggested = {
      ...added.document,
      sections: [{ ...section, source: "automatic" as const }],
      uiState: {
        ...added.document.uiState,
        loop: { enabled: true, start: 0, end: 20, sectionId: section.id },
      },
    };
    const moved = moveSectionBoundary(suggested, 20, 24);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.document.sections[0]).toMatchObject({ source: "automatic-edited", endTime: 24 });
    expect(moved.document.uiState.loop).toMatchObject({ start: 0, end: 24, sectionId: section.id });
  });

  it("splits a section and merges it back with the piece that follows", () => {
    const added = addManualSection(document(), { name: "Drop", type: "drop", startTime: 10, endTime: 40 });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const section = added.document.sections[0];
    if (!section) return;
    const split = splitSection(added.document, section.id, 25);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.document.sections.map((item) => [item.name, item.startTime, item.endTime])).toEqual([
      ["Drop", 10, 25],
      ["Drop 2", 25, 40],
    ]);
    expect(splitSection(split.document, section.id, 10.1).ok).toBe(false);
    const merged = mergeSectionWithNext(split.document, section.id);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.document.sections.map((item) => [item.name, item.startTime, item.endTime])).toEqual([["Drop", 10, 40]]);
    const gapped = addManualSection(merged.document, { name: "Outro", startTime: 50, endTime: 70 });
    expect(gapped.ok).toBe(true);
    if (!gapped.ok) return;
    expect(mergeSectionWithNext(gapped.document, section.id).ok).toBe(false);
  });

  it("clears unedited suggestions and leaves confirmed sections", () => {
    const manual = addManualSection(document(), { name: "Verse", startTime: 0, endTime: 20 });
    expect(manual.ok).toBe(true);
    if (!manual.ok) return;
    const suggested = {
      ...manual.document,
      sections: [
        ...manual.document.sections,
        {
          ...manual.document.sections[0]!,
          id: "section-auto",
          name: "Chorus",
          startTime: 20,
          endTime: 40,
          source: "automatic" as const,
        },
      ],
      uiState: { ...manual.document.uiState, selectedSectionId: "section-auto" },
    };
    const cleared = clearSuggestedSections(suggested);
    expect(cleared.sections.map((section) => section.name)).toEqual(["Verse"]);
    expect(cleared.uiState.selectedSectionId).toBeNull();
    expect(clearSuggestedSections(cleared)).toBe(cleared);
  });
});
