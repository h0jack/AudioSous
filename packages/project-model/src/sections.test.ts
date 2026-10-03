import { describe, expect, it } from "vitest";
import { createProject } from "./create-project";
import { projectDocumentSchema } from "./schema";
import { addManualSection, removeSection, updateSection } from "./sections";

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
});
