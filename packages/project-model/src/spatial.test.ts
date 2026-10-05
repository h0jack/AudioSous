import { describe, expect, it } from "vitest";
import { createProject } from "./create-project";
import { deserializeProject, serializeProject } from "./migrate";
import { projectDocumentSchema, type ProjectDocument } from "./schema";
import { setTrackSectionState } from "./sections";
import {
  hasSavedSpatial,
  isMonoTrack,
  normalizePan,
  normalizeWidth,
  setSectionSpatial,
  setTrackSpatial,
  spatialAt,
  spatialForSection,
  spatialIdentity,
} from "./spatial";

const NOW = new Date("2026-10-04T12:00:00.000Z");

function song(): ProjectDocument {
  const document = createProject({
    id: "proj-space",
    name: "Space",
    now: NOW,
    tracks: [
      { id: "pad", channels: 2 },
      { id: "lead", channels: 1 },
    ].map(({ id, channels }) => ({
      id,
      name: id,
      role: id === "pad" ? ("pad" as const) : ("lead" as const),
      relativePath: `media/${id}.wav`,
      filename: `${id}.wav`,
      metadata: { format: "wav" as const, sampleRate: 48_000, channelCount: channels, bitDepth: 24, durationSeconds: 60, fileSizeBytes: 1 },
    })),
  });
  return {
    ...document,
    sections: [
      { id: "verse", name: "Verse", type: "verse", startTime: 0, endTime: 30, userIntent: null, source: "manual", confidence: null, structuralGroupId: null },
      { id: "drop", name: "Drop", type: "drop", startTime: 30, endTime: 60, userIntent: null, source: "manual", confidence: null, structuralGroupId: null },
    ],
  };
}

describe("spatial state", () => {
  it("starts every track centered at 100% width", () => {
    const document = song();
    expect(document.schemaVersion).toBe(3);
    expect(document.tracks.map((track) => [track.pan, track.width])).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(projectDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("migrates a v2 file without changing how it sounds", () => {
    const panned = setTrackSpatial(song(), "pad", { pan: 0.3 });
    if (!panned.ok) throw new Error(panned.message);
    const withPan = setSectionSpatial(panned.document, "pad", "drop", { pan: -0.2 });
    if (!withPan.ok) throw new Error(withPan.message);
    const v2 = JSON.parse(serializeProject(withPan.document)) as Record<string, unknown> & {
      tracks: Array<Record<string, unknown>>;
      sectionTrackSettings: Array<{ overrides: Record<string, unknown> }>;
    };
    v2.schemaVersion = 2;
    for (const track of v2.tracks) delete track.width;
    for (const row of v2.sectionTrackSettings) delete row.overrides.width;
    const migrated = deserializeProject(JSON.stringify(v2));
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.tracks.map((track) => track.width)).toEqual([1, 1]);
    expect(migrated.tracks.find((track) => track.id === "pad")!.pan).toBe(0.3);
    expect(migrated.sectionTrackSettings[0]!.overrides).toEqual({ gainDb: null, pan: -0.2, width: null });
  });

  it("refuses a width outside 0–200%", () => {
    const document = song();
    const bad = { ...document, tracks: document.tracks.map((track) => ({ ...track, width: 2.5 })) };
    expect(projectDocumentSchema.safeParse(bad).success).toBe(false);
    const negative = { ...document, tracks: document.tracks.map((track) => ({ ...track, width: -0.1 })) };
    expect(projectDocumentSchema.safeParse(negative).success).toBe(false);
  });

  it("lets a section override replace the track's pan or width inside that section only", () => {
    let document = song();
    const own = setTrackSpatial(document, "pad", { pan: 0.18, width: 1.1 });
    if (!own.ok) throw new Error(own.message);
    document = own.document;
    const drop = setSectionSpatial(document, "pad", "drop", { width: 1.35 });
    if (!drop.ok) throw new Error(drop.message);
    document = drop.document;
    expect(spatialForSection(document, "pad", null)).toEqual({ pan: 0.18, width: 1.1 });
    expect(spatialForSection(document, "pad", "verse")).toEqual({ pan: 0.18, width: 1.1 });
    expect(spatialForSection(document, "pad", "drop")).toEqual({ pan: 0.18, width: 1.35 });
    expect(spatialAt(document, "pad", 10)).toEqual({ pan: 0.18, width: 1.1 });
    expect(spatialAt(document, "pad", 45)).toEqual({ pan: 0.18, width: 1.35 });
    expect(hasSavedSpatial(document, "pad")).toBe(true);
    expect(hasSavedSpatial(document, "lead")).toBe(false);
  });

  it("does not store an override equal to the track setting, and drops the row when nothing else is on it", () => {
    let document = song();
    const set = setSectionSpatial(document, "pad", "drop", { pan: 0.4 });
    if (!set.ok) throw new Error(set.message);
    document = set.document;
    expect(document.sectionTrackSettings).toHaveLength(1);
    const same = setSectionSpatial(document, "pad", "drop", { pan: 0 });
    if (!same.ok) throw new Error(same.message);
    expect(same.document.sectionTrackSettings).toHaveLength(0);
  });

  it("keeps intent and prominence when a spatial override is cleared", () => {
    let document = song();
    const intent = setTrackSectionState(document, "pad", "drop", { userIntent: "Wider here." });
    if (!intent.ok) throw new Error(intent.message);
    document = intent.document;
    const set = setSectionSpatial(document, "pad", "drop", { width: 1.3 });
    if (!set.ok) throw new Error(set.message);
    const cleared = setSectionSpatial(set.document, "pad", "drop", { width: null });
    if (!cleared.ok) throw new Error(cleared.message);
    expect(cleared.document.sectionTrackSettings[0]).toMatchObject({ userIntent: "Wider here.", overrides: { pan: null, width: null } });
  });

  it("clamps and rounds to what the controls show", () => {
    expect(normalizePan(0.1234)).toBe(0.12);
    expect(normalizePan(3)).toBe(1);
    expect(normalizeWidth(1.234)).toBe(1.23);
    expect(normalizeWidth(-1)).toBe(0);
    expect(normalizeWidth(9)).toBe(2);
    expect(normalizeWidth(Number.NaN)).toBe(1);
  });

  it("knows a mono stem", () => {
    const document = song();
    expect(isMonoTrack(document.tracks[1]!)).toBe(true);
    expect(isMonoTrack(document.tracks[0]!)).toBe(false);
  });

  it("changes the spatial identity for pan, width, and section overrides, not for gain", () => {
    const document = song();
    const base = JSON.stringify(spatialIdentity(document));
    const panned = setTrackSpatial(document, "pad", { pan: 0.1 });
    const widened = setTrackSpatial(document, "pad", { width: 1.2 });
    const section = setSectionSpatial(document, "pad", "drop", { width: 0.8 });
    if (!panned.ok || !widened.ok || !section.ok) throw new Error("edit failed");
    expect(JSON.stringify(spatialIdentity(panned.document))).not.toBe(base);
    expect(JSON.stringify(spatialIdentity(widened.document))).not.toBe(base);
    expect(JSON.stringify(spatialIdentity(section.document))).not.toBe(base);
    const louder = { ...document, tracks: document.tracks.map((track) => ({ ...track, gainDb: -3 })) };
    expect(JSON.stringify(spatialIdentity(louder))).toBe(base);
  });
});
