import { describe, expect, it } from "vitest";
import { createProject } from "./create-project";
import { deserializeProject, serializeProject } from "./migrate";
import { eqChainAt, normalizeEqFilter, processingIdentity, setSectionEqNodes, setTrackEqNodes } from "./processing";
import { projectDocumentSchema, type EqNode, type ProjectDocument } from "./schema";
import { setTrackSectionState } from "./sections";

const NOW = new Date("2026-10-04T12:00:00.000Z");

function song(): ProjectDocument {
  const document = createProject({
    id: "proj-eq",
    name: "EQ",
    now: NOW,
    tracks: ["pad", "lead"].map((id) => ({
      id,
      name: id,
      role: id === "pad" ? ("pad" as const) : ("lead" as const),
      relativePath: `media/${id}.wav`,
      filename: `${id}.wav`,
      metadata: { format: "wav" as const, sampleRate: 48_000, channelCount: 2, bitDepth: 24, durationSeconds: 60, fileSizeBytes: 1 },
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

function node(id: string, frequencyHz: number, gainDb: number, enabled = true): EqNode {
  return { id, type: "eq", enabled, filter: { kind: "bell", frequencyHz, gainDb, q: 1 }, origin: "manual", note: null };
}

describe("processing graph", () => {
  it("migrates a v1 file by giving every track an empty graph", () => {
    const v2 = song();
    const v1 = JSON.parse(serializeProject(v2)) as Record<string, unknown> & { tracks: Array<Record<string, unknown>> };
    v1.schemaVersion = 1;
    for (const track of v1.tracks) {
      delete track.processing;
      delete track.width;
    }
    const migrated = deserializeProject(JSON.stringify(v1));
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.tracks.every((track) => track.processing.nodes.length === 0)).toBe(true);
  });

  it("adds Track × Section filters after the track's own filters, only inside that section", () => {
    let document = song();
    const own = setTrackEqNodes(document, "pad", [node("pad-1", 2_500, -1.2)]);
    expect(own.ok).toBe(true);
    if (!own.ok) return;
    const extra = setSectionEqNodes(own.document, "pad", "drop", [node("pad-drop-1", 1_800, -1)]);
    expect(extra.ok).toBe(true);
    if (!extra.ok) return;
    document = extra.document;
    expect(eqChainAt(document, "pad", 10).map((filter) => filter.frequencyHz)).toEqual([2_500]);
    expect(eqChainAt(document, "pad", 40).map((filter) => filter.frequencyHz)).toEqual([2_500, 1_800]);
    expect(eqChainAt(document, "lead", 40)).toEqual([]);
    expect(projectDocumentSchema.parse(JSON.parse(serializeProject(document)))).toEqual(document);
  });

  it("keeps a section row that holds only filters, and drops it when they are removed", () => {
    const added = setSectionEqNodes(song(), "pad", "drop", [node("a", 1_000, -1)]);
    expect(added.ok && added.document.sectionTrackSettings.length).toBe(1);
    if (!added.ok) return;
    const cleared = setSectionEqNodes(added.document, "pad", "drop", []);
    expect(cleared.ok && cleared.document.sectionTrackSettings.length).toBe(0);
    const prominence = setTrackSectionState(added.document, "pad", "drop", { prominence: "supporting" });
    expect(prominence.ok && prominence.document.sectionTrackSettings[0]?.processing.nodes.length).toBe(1);
  });

  it("skips disabled filters and refuses too many filters or duplicate ids", () => {
    const result = setTrackEqNodes(song(), "pad", [node("a", 500, -2, false), node("b", 900, -1)]);
    expect(result.ok && eqChainAt(result.document, "pad", 1).map((filter) => filter.frequencyHz)).toEqual([900]);
    expect(setTrackEqNodes(song(), "pad", Array.from({ length: 7 }, (_, index) => node(`n${index}`, 100 * (index + 1), -1))).ok).toBe(false);
    expect(setSectionEqNodes(song(), "pad", "drop", Array.from({ length: 5 }, (_, index) => node(`n${index}`, 100 * (index + 1), -1))).ok).toBe(false);
    expect(setTrackEqNodes(song(), "pad", [node("a", 500, -2), node("a", 900, -1)]).ok).toBe(false);
  });

  it("clamps and rounds filters, and stores 0 dB on pass filters", () => {
    expect(normalizeEqFilter({ kind: "bell", frequencyHz: 2_173.4, gainDb: -1.44, q: 0.913 })).toEqual({
      kind: "bell",
      frequencyHz: 2_170,
      gainDb: -1.4,
      q: 0.91,
    });
    expect(normalizeEqFilter({ kind: "high-pass", frequencyHz: 5, gainDb: -3, q: 50 })).toEqual({
      kind: "high-pass",
      frequencyHz: 20,
      gainDb: 0,
      q: 10,
    });
    expect(() =>
      projectDocumentSchema.parse({
        ...song(),
        tracks: song().tracks.map((track) => ({ ...track, processing: { schemaVersion: 2, nodes: [node("x", 30_000, 0)], dynamics: [] } })),
      }),
    ).toThrow();
  });

  it("changes the processing identity when a filter changes", () => {
    const base = setTrackEqNodes(song(), "pad", [node("a", 1_000, -1)]);
    const moved = setTrackEqNodes(song(), "pad", [node("a", 1_000, -1.5)]);
    const off = setTrackEqNodes(song(), "pad", [node("a", 1_000, -1, false)]);
    if (!base.ok || !moved.ok || !off.ok) throw new Error("setup");
    const identity = JSON.stringify(processingIdentity(base.document));
    expect(JSON.stringify(processingIdentity(moved.document))).not.toBe(identity);
    expect(JSON.stringify(processingIdentity(off.document))).not.toBe(identity);
  });
});
