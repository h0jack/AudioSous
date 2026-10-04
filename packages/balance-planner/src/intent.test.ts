import { createProject, type ProjectDocument, type TrackRole } from "@audiosous/project-model";
import { describe, expect, it } from "vitest";
import { indexSectionIntent, tierFromText, trackIntentTier } from "./intent";

describe("tierFromText", () => {
  it.each([
    "Trumpets should dominate.",
    "Make the trumpet more prominent.",
    "Bring the lead forward.",
    "Let it be more dominant here",
    "It should stand out",
    "More present in the hook",
    "Louder",
    "Push the lead forward",
    "Bring the vocal up",
    "Feature the guitar",
    "Up front",
    "Let the trumpet take the lead",
    "Guitar solo",
  ])("reads %j as focal", (text) => {
    expect(tierFromText(text)?.tier).toBe("focal");
  });

  it.each([
    "Make the pad quieter.",
    "Push the strings back.",
    "Less prominent here",
    "Pull back the keys",
    "Pull the keys back",
    "Let the pad recede",
    "Keep it underneath the vocal",
    "Tuck the pad behind the lead",
    "Subtle",
    "Background only",
    "Sit back in the verse",
    "Out of the way of the vocal",
    "Bring the pad down a little",
  ])("reads %j as background", (text) => {
    expect(tierFromText(text)?.tier).toBe("background");
  });

  it("keeps the existing structural words", () => {
    expect(tierFromText("This is the foundation")?.tier).toBe("primary");
    expect(tierFromText("Accompaniment only")?.tier).toBe("supporting");
  });

  it.each(["Big and punchy.", "Warm, airy and wide", "Aggressive, tight, crunchy", "Smooth"])(
    "ignores tone-only note %j",
    (text) => {
      expect(tierFromText(text)).toBeNull();
    },
  );

  it("uses only the level clause when tone words come first", () => {
    const read = tierFromText("Big and punchy. Trumpets should dominate.");
    expect(read?.tier).toBe("focal");
    expect(read?.text).toBe("Trumpets should dominate");
  });

  it("ignores negated and conflicting instructions instead of guessing", () => {
    expect(tierFromText("Don't make it louder")).toBeNull();
    expect(tierFromText("Not too prominent")).toBeNull();
    expect(tierFromText("Make it louder. Actually keep it subtle.")).toBeNull();
    expect(tierFromText("Push the pad back and bring the lead forward")).toBeNull();
  });
});

describe("indexSectionIntent", () => {
  it("targets one clearly named track", () => {
    const document = withSection(
      tracks([
        ["kick", "Kick", "kick"],
        ["trumpet", "Trumpets", "brass"],
        ["pad", "Pad", "pad"],
      ]),
      "Trumpets should dominate.",
    );
    const index = indexSectionIntent(document);
    expect([...(index.targets.get("drop")?.entries() ?? [])]).toEqual([["trumpet", { tier: "focal", text: "Trumpets should dominate" }]]);
    expect(index.ambiguous).toEqual([]);
  });

  it("matches singular and plural, custom labels, and role aliases", () => {
    const base = tracks([
      ["horn", "Stem 07", "brass"],
      ["pad", "Stem 08", "other"],
      ["str", "Violins", "strings"],
    ]);
    const document = { ...base, tracks: base.tracks.map((track) => (track.id === "pad" ? { ...track, customLabel: "Warm Pad" } : track)) };
    expect(indexSectionIntent(withSection(document, "Trumpet should dominate")).targets.get("drop")?.get("horn")?.tier).toBe("focal");
    expect(indexSectionIntent(withSection(document, "Keep the pad quieter")).targets.get("drop")?.get("pad")?.tier).toBe("background");
    expect(indexSectionIntent(withSection(document, "Push the strings back")).targets.get("drop")?.get("str")?.tier).toBe("background");
  });

  it("does not pick one of two matching tracks", () => {
    const document = withSection(
      tracks([
        ["t1", "Trumpet 1", "brass"],
        ["t2", "Trumpet 2", "brass"],
      ]),
      "Trumpet should dominate.",
    );
    const index = indexSectionIntent(document);
    expect(index.targets.get("drop")).toBeUndefined();
    expect(index.ambiguous).toEqual([{ sectionId: "drop", word: "trumpet", trackIds: ["t1", "t2"], text: "Trumpet should dominate" }]);
  });

  it("resolves a fully named track even when another shares a word", () => {
    const document = withSection(
      tracks([
        ["t1", "Trumpet 1", "brass"],
        ["t2", "Trumpet 2", "brass"],
      ]),
      "Trumpet 2 should dominate.",
    );
    expect([...(indexSectionIntent(document).targets.get("drop")?.keys() ?? [])]).toEqual(["t2"]);
  });

  it("prefers a name match over a role match", () => {
    const document = withSection(
      tracks([
        ["bass", "Bass", "bass"],
        ["sub", "Sub", "bass"],
      ]),
      "Bring the bass forward",
    );
    expect([...(indexSectionIntent(document).targets.get("drop")?.keys() ?? [])]).toEqual(["bass"]);
  });

  it("targets the subject, not the reference after a comparator", () => {
    const document = withSection(
      tracks([
        ["lead", "Lead", "lead"],
        ["pad", "Pad", "pad"],
      ]),
      "Make the pad quieter than the lead",
    );
    expect([...(indexSectionIntent(document).targets.get("drop")?.entries() ?? [])]).toEqual([
      ["pad", { tier: "background", text: "Make the pad quieter than the lead" }],
    ]);
  });

  it("does not read 'take the lead' as the Lead track or 'the drop' as a Drop FX stem", () => {
    const document = withSection(
      tracks([
        ["lead", "Lead", "lead"],
        ["trumpet", "Trumpet", "brass"],
        ["riser", "Drop FX", "fx"],
      ]),
      "Let the trumpet take the lead in the drop",
    );
    expect([...(indexSectionIntent(document).targets.get("drop")?.keys() ?? [])]).toEqual(["trumpet"]);
  });

  it("ignores level words with no track and tone words with a track", () => {
    const base = tracks([
      ["kick", "Kick", "kick"],
      ["trumpet", "Trumpet", "brass"],
    ]);
    expect(indexSectionIntent(withSection(base, "The drop should be louder")).targets.size).toBe(0);
    expect(indexSectionIntent(withSection(base, "Big punchy trumpet")).targets.size).toBe(0);
  });
});

describe("trackIntentTier", () => {
  it("skips a clause on this row that names a different track", () => {
    const document = tracks([
      ["lead", "Lead", "lead"],
      ["pad", "Pad", "pad"],
    ]);
    const pad = document.tracks.find((track) => track.id === "pad")!;
    expect(trackIntentTier(document, pad, "Let the lead dominate")).toBeNull();
    expect(trackIntentTier(document, pad, "Keep the pad tucked behind the lead")?.tier).toBe("background");
    expect(trackIntentTier(document, pad, "Make it quieter")?.tier).toBe("background");
  });
});

function tracks(list: Array<[string, string, TrackRole]>): ProjectDocument {
  return createProject({
    id: "proj-intent",
    name: "Intent fixture",
    now: new Date("2026-01-01T00:00:00.000Z"),
    tracks: list.map(([id, name, role]) => ({
      id,
      name,
      role,
      relativePath: `media/${id}.wav`,
      filename: `${id}.wav`,
      metadata: { format: "wav" as const, sampleRate: 48_000, channelCount: 2, bitDepth: 24, durationSeconds: 60, fileSizeBytes: 1_000 },
    })),
  });
}

function withSection(document: ProjectDocument, userIntent: string): ProjectDocument {
  return {
    ...document,
    sections: [
      { id: "drop", name: "Drop 2", type: "drop", startTime: 0, endTime: 60, userIntent, source: "manual", confidence: null, structuralGroupId: null },
    ],
  };
}
