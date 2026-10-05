import { describe, expect, it } from "vitest";
import { createProject } from "./create-project";
import {
  DYNAMICS_STAGE_ORDER,
  describeDynamicsNode,
  dynamicsChainAt,
  dynamicsChainForSection,
  dynamicsIdentity,
  dynamicsNodeRunnable,
  keyRoutingIssues,
  normalizeDynamicsNode,
  setSectionDynamicsNodes,
  setTrackDynamicsNodes,
} from "./dynamics";
import { deserializeProject, serializeProject } from "./migrate";
import { setTrackEqNodes } from "./processing";
import { projectDocumentSchema, type CompressorNode, type DuckingNode, type DynamicEqNode, type ProjectDocument, type TransientNode } from "./schema";
import { setTrackSectionState } from "./sections";

const NOW = new Date("2026-10-05T12:00:00.000Z");

function song(): ProjectDocument {
  const document = createProject({
    id: "proj-dyn",
    name: "Dynamics",
    now: NOW,
    tracks: ["kick", "bass", "lead", "pad"].map((id) => ({
      id,
      name: id[0]!.toUpperCase() + id.slice(1),
      role: id as "kick" | "bass" | "lead" | "pad",
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

function compressor(id: string, patch: Partial<CompressorNode> = {}): CompressorNode {
  return { id, type: "compressor", enabled: true, origin: "manual", note: null, thresholdDb: -18, ratio: 2.2, attackMs: 35, releaseMs: 140, kneeDb: 6, makeupDb: 0, ...patch };
}

function duck(id: string, keyTrackId: string, patch: Partial<DuckingNode> = {}): DuckingNode {
  return { id, type: "ducking", enabled: true, origin: "manual", note: null, keyTrackId, keyDetector: "transient", thresholdDb: -24, rangeDb: -2, attackMs: 5, releaseMs: 120, ...patch };
}

function dynEq(id: string, keyTrackId: string | null, patch: Partial<DynamicEqNode> = {}): DynamicEqNode {
  return {
    id,
    type: "dynamic-eq",
    enabled: true,
    origin: "manual",
    note: null,
    filter: { kind: "bell", frequencyHz: 2_400, q: 1.1 },
    keyTrackId,
    keyDetector: "smooth",
    thresholdDb: -30,
    rangeDb: -2,
    attackMs: 20,
    releaseMs: 250,
    ...patch,
  };
}

function transient(id: string, attack: number, sustain = 0): TransientNode {
  return { id, type: "transient", enabled: true, origin: "manual", note: null, attack, sustain };
}

function ok(result: ReturnType<typeof setTrackDynamicsNodes>): ProjectDocument {
  if (!result.ok) throw new Error(result.message);
  return result.document;
}

describe("dynamics graph", () => {
  it("migrates a v3 file to graph v2 with no dynamics, keeping its EQ", () => {
    const withEq = ok(setTrackEqNodes(song(), "pad", [{ id: "eq-1", type: "eq", enabled: true, filter: { kind: "bell", frequencyHz: 2_500, gainDb: -1.5, q: 1 }, origin: "eq-plan", note: null }]));
    const v3 = JSON.parse(serializeProject(withEq)) as { schemaVersion: number; tracks: Array<{ processing: Record<string, unknown> }> };
    v3.schemaVersion = 3;
    for (const track of v3.tracks) track.processing = { schemaVersion: 1, nodes: track.processing.nodes };
    const migrated = deserializeProject(JSON.stringify(v3));
    expect(migrated.schemaVersion).toBe(4);
    const pad = migrated.tracks.find((track) => track.id === "pad")!;
    expect(pad.processing).toEqual({ schemaVersion: 2, nodes: withEq.tracks.find((track) => track.id === "pad")!.processing.nodes, dynamics: [] });
    expect(migrated.tracks.every((track) => track.processing.dynamics.length === 0)).toBe(true);
  });

  it("runs stages in a fixed order whatever the list order, track nodes before section nodes", () => {
    let document = ok(setTrackDynamicsNodes(song(), "bass", [duck("d1", "kick"), compressor("c1"), transient("t1", 0.1), dynEq("q1", "lead")]));
    document = ok(setSectionDynamicsNodes(document, "bass", "drop", [compressor("c2", { ratio: 1.5 }), dynEq("q2", null, { filter: { kind: "bell", frequencyHz: 300, q: 1 } })]));
    expect(DYNAMICS_STAGE_ORDER).toEqual(["dynamic-eq", "compressor", "transient", "ducking"]);
    expect(dynamicsChainAt(document, "bass", 10).map((node) => node.id)).toEqual(["q1", "c1", "t1", "d1"]);
    expect(dynamicsChainAt(document, "bass", 40).map((node) => node.id)).toEqual(["q1", "q2", "c1", "c2", "t1", "d1"]);
    expect(dynamicsChainForSection(document, "bass", null).map((node) => node.id)).toEqual(["q1", "c1", "t1", "d1"]);
    const disabled = ok(setTrackDynamicsNodes(document, "bass", [compressor("c1", { enabled: false })]));
    expect(dynamicsChainAt(disabled, "bass", 10)).toEqual([]);
  });

  it("enforces the per-graph limits", () => {
    expect(setTrackDynamicsNodes(song(), "bass", [compressor("a"), compressor("b")])).toMatchObject({ ok: false });
    expect(setTrackDynamicsNodes(song(), "pad", [dynEq("a", "lead"), dynEq("b", "lead"), dynEq("c", "lead"), dynEq("d", "lead")])).toMatchObject({ ok: false });
    expect(setSectionDynamicsNodes(song(), "bass", "drop", [duck("a", "kick"), duck("b", "lead")])).toMatchObject({ ok: false });
    expect(setTrackDynamicsNodes(song(), "bass", [duck("a", "kick"), duck("b", "lead")])).toMatchObject({ ok: true });
    expect(() =>
      projectDocumentSchema.parse({ ...song(), tracks: song().tracks.map((track) => ({ ...track, processing: { ...track.processing, dynamics: [transient("a", 0.1), transient("b", 0.1)] } })) }),
    ).toThrow();
  });

  it("clamps and rounds node values to the stored bounds", () => {
    const node = normalizeDynamicsNode(compressor("c", { ratio: 50, thresholdDb: -71.234, attackMs: 0.01, releaseMs: 9_000, makeupDb: -3, kneeDb: 6.04 }));
    expect(node).toMatchObject({ ratio: 20, thresholdDb: -60, attackMs: 0.1, releaseMs: 2_000, makeupDb: 0, kneeDb: 6 });
    const bell = normalizeDynamicsNode(dynEq("q", "lead", { filter: { kind: "bell", frequencyHz: 2_437.7, q: 0.1 }, rangeDb: 3 }));
    expect(bell.filter).toEqual({ kind: "bell", frequencyHz: 2_440, q: 0.3 });
    expect(bell.rangeDb).toBe(0);
    expect(normalizeDynamicsNode(transient("t", 0.9, -0.9))).toMatchObject({ attack: 0.3, sustain: -0.2 });
    expect(normalizeDynamicsNode(compressor("n", { ratio: Number.NaN })).ratio).toBe(2);
  });

  it("rejects self-keys, missing keys, and loops; a missing key in a file is inert", () => {
    expect(setTrackDynamicsNodes(song(), "bass", [duck("d", "bass")])).toMatchObject({ ok: false, message: expect.stringMatching(/itself/) });
    expect(setTrackDynamicsNodes(song(), "bass", [duck("d", "nobody")])).toMatchObject({ ok: false, message: expect.stringMatching(/not in the project/) });
    const keyed = ok(setTrackDynamicsNodes(song(), "bass", [duck("d", "kick")]));
    expect(setTrackDynamicsNodes(keyed, "kick", [duck("k", "bass")])).toMatchObject({ ok: false, message: expect.stringMatching(/key each other/) });
    // A section node closes the loop too.
    expect(setSectionDynamicsNodes(keyed, "kick", "drop", [dynEq("k", "bass")])).toMatchObject({ ok: false });
    // Three-track loop: pad ← lead ← bass ← pad.
    const chain = ok(setTrackDynamicsNodes(ok(setTrackDynamicsNodes(song(), "pad", [duck("p", "lead")])), "lead", [duck("l", "bass")]));
    expect(setTrackDynamicsNodes(chain, "bass", [dynEq("b", "pad")])).toMatchObject({ ok: false });

    const selfKeyed = { ...song(), tracks: song().tracks.map((track) => (track.id === "bass" ? { ...track, processing: { ...track.processing, dynamics: [duck("d", "bass")] } } : track)) };
    expect(() => projectDocumentSchema.parse(selfKeyed)).toThrow(/itself/);
    const orphan = { ...song(), tracks: song().tracks.map((track) => (track.id === "bass" ? { ...track, processing: { ...track.processing, dynamics: [duck("d", "gone")] } } : track)) };
    const parsed = projectDocumentSchema.parse(orphan);
    expect(keyRoutingIssues(parsed)).toEqual([{ trackId: "bass", sectionId: null, nodeId: "d", problem: "missing" }]);
    expect(dynamicsNodeRunnable(parsed, "bass", parsed.tracks[1]!.processing.dynamics[0]!)).toBe(false);
    expect(dynamicsNodeRunnable(keyed, "bass", keyed.tracks[1]!.processing.dynamics[0]!)).toBe(true);
  });

  it("keeps ids unique across a graph's EQ and dynamics", () => {
    const withEq = ok(setTrackEqNodes(song(), "bass", [{ id: "n1", type: "eq", enabled: true, filter: { kind: "bell", frequencyHz: 60, gainDb: -2, q: 1 }, origin: "manual", note: null }]));
    expect(setTrackDynamicsNodes(withEq, "bass", [compressor("n1")])).toMatchObject({ ok: false });
  });

  it("keeps a Track × Section row that holds only dynamics, and drops it when they are cleared", () => {
    const document = ok(setSectionDynamicsNodes(song(), "lead", "drop", [compressor("c")]));
    expect(document.sectionTrackSettings).toHaveLength(1);
    const cleared = ok(setSectionDynamicsNodes(document, "lead", "drop", []));
    expect(cleared.sectionTrackSettings).toHaveLength(0);
    const noted = ok(setTrackSectionState(document, "lead", "drop", { userIntent: "Keep it natural." }));
    expect(ok(setSectionDynamicsNodes(noted, "lead", "drop", [])).sectionTrackSettings).toHaveLength(1);
    expect(serializeProject(document)).toContain('"dynamics"');
  });

  it("changes identity when a parameter changes, not when a note does", () => {
    const base = ok(setTrackDynamicsNodes(song(), "bass", [compressor("c")]));
    const renoted = ok(setTrackDynamicsNodes(base, "bass", [compressor("c", { note: "why" })]));
    const edited = ok(setTrackDynamicsNodes(base, "bass", [compressor("c", { ratio: 2.4 })]));
    expect(JSON.stringify(dynamicsIdentity(renoted))).toBe(JSON.stringify(dynamicsIdentity(base)));
    expect(JSON.stringify(dynamicsIdentity(edited))).not.toBe(JSON.stringify(dynamicsIdentity(base)));
    const moved = ok(setTrackDynamicsNodes(base, "pad", [dynEq("q", "lead")]));
    const retuned = ok(setTrackDynamicsNodes(base, "pad", [dynEq("q", "lead", { filter: { kind: "bell", frequencyHz: 2_600, q: 1.1 } })]));
    expect(JSON.stringify(dynamicsIdentity(moved))).not.toBe(JSON.stringify(dynamicsIdentity(retuned)));
  });

  it("describes nodes in words", () => {
    const tracks = song().tracks;
    expect(describeDynamicsNode(compressor("c"), tracks)).toBe("Compressor 2.2:1 at −18.0 dB, 35/140 ms");
    expect(describeDynamicsNode(duck("d", "kick"), tracks)).toBe("Duck from Kick, up to −2.0 dB");
    expect(describeDynamicsNode(dynEq("q", "lead", { rangeDb: -1.8 }), tracks)).toBe("Dynamic EQ 2.4 kHz, up to −1.8 dB, keyed from Lead");
    expect(describeDynamicsNode(transient("t", -0.1), tracks)).toBe("Transient attack −10%, sustain 0%");
  });
});
