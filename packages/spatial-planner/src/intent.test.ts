import { createProject, setTrackSectionState, type ProjectDocument, type TrackRole } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import { indexSpatialIntent, instructionFor, spatialClause } from "./intent";

function project(names: Array<[string, TrackRole]>, sectionIntent: string | null): ProjectDocument {
  const created = createProject({
    id: "proj",
    name: "Intent",
    now: new Date("2026-10-04T00:00:00.000Z"),
    tracks: names.map(([name, role], index) => ({
      id: `t${index}`,
      name,
      role,
      relativePath: `media/t${index}.wav`,
      filename: `t${index}.wav`,
      metadata: { format: "wav" as const, sampleRate: 48_000, channelCount: 2, bitDepth: 24, durationSeconds: 60, fileSizeBytes: 1 },
    })),
  });
  return {
    ...created,
    sections: [{ id: "s", name: "Breakdown", type: "breakdown", startTime: 0, endTime: 60, userIntent: sectionIntent, source: "manual", confidence: null, structuralGroupId: null }],
  };
}

describe("spatial phrase table", () => {
  it("reads only spatial concepts", () => {
    expect(spatialClause("Make the breakdown wider")?.word).toBe("wider");
    expect(spatialClause("Spread the pads out")?.word).toBe("wider");
    expect(spatialClause("Let the atmosphere surround the drop")).toMatchObject({ word: "wider", surround: true });
    expect(spatialClause("Keep it narrow and intimate")?.word).toBe("narrower");
    expect(spatialClause("Keep the vocal centered")?.word).toBe("center");
    expect(spatialClause("Push the guitar left")?.word).toBe("left");
    expect(spatialClause("Pan the synth to the right")?.word).toBe("right");
    for (const tone of ["Warm and punchy", "Bright, aggressive", "Big chorus", "Make it louder"]) expect(spatialClause(tone)).toBeNull();
  });

  it("ignores negation, two directions at once, and 'right' as an adverb", () => {
    expect(spatialClause("Don't make it wider")).toBeNull();
    expect(spatialClause("Guitar left and keys right")).toBeNull();
    expect(spatialClause("Bring it in right after the drop")).toBeNull();
  });

  it("applies a whole-section width instruction to the section, and a named one to that stem only", () => {
    const general = indexSpatialIntent(project([["Pad", "pad"], ["Guitar", "guitar"]], "Make the breakdown wider."));
    expect(instructionFor(general, "s", "t0")?.source).toBe("section-general");
    expect(instructionFor(general, "s", "t1")?.source).toBe("section-general");
    const named = indexSpatialIntent(project([["Pad", "pad"], ["Guitar", "guitar"]], "Push the guitar left."));
    expect(instructionFor(named, "s", "t1")).toMatchObject({ word: "left", source: "section-intent" });
    expect(instructionFor(named, "s", "t0")).toBeNull();
  });

  it("does not read a side for a whole section, and does not guess an ambiguous stem", () => {
    const side = indexSpatialIntent(project([["Pad", "pad"]], "Move everything left."));
    expect(instructionFor(side, "s", "t0")).toBeNull();
    const ambiguous = indexSpatialIntent(project([["Trumpet 1", "brass"], ["Trumpet 2", "brass"]], "Push the trumpet left."));
    expect(instructionFor(ambiguous, "s", "t0")).toBeNull();
    expect(ambiguous.ambiguous).toHaveLength(1);
  });

  it("does not let a track named 'Left' be the target of 'push the guitar left'", () => {
    const index = indexSpatialIntent(project([["Gtr Left", "guitar"], ["Pad", "pad"]], "Push the pad left."));
    expect(instructionFor(index, "s", "t1")?.word).toBe("left");
    expect(instructionFor(index, "s", "t0")).toBeNull();
  });

  it("puts a Track × Section note above a section note, and skips a clause about another stem", () => {
    let document = project([["Pad", "pad"], ["Guitar", "guitar"]], "Push the guitar left.");
    const row = setTrackSectionState(document, "t1", "s", { userIntent: "Guitar right." });
    if (!row.ok) throw new Error(row.message);
    document = row.document;
    expect(instructionFor(indexSpatialIntent(document), "s", "t1")).toMatchObject({ word: "right", source: "track-intent" });
    const other = setTrackSectionState(document, "t0", "s", { userIntent: "Let the guitar sit wider." });
    if (!other.ok) throw new Error(other.message);
    expect(instructionFor(indexSpatialIntent(other.document), "s", "t0")).toBeNull();
  });
});
