import { describe, expect, it } from "vitest";
import { dynamicsClause, indexDynamicsIntent } from "./intent";
import { fixtureC } from "./fixtures";
import { setTrackSectionState } from "@audiosous/project-model";
import { wholeSong } from "./test-fixtures";

describe("dynamics phrase table", () => {
  it("reads the vocabulary and ignores negation and contradictions", () => {
    expect(dynamicsClause("Keep the bass controlled")?.words).toEqual(["control"]);
    expect(dynamicsClause("Keep the vocal natural")?.words).toEqual(["natural"]);
    expect(dynamicsClause("Make the snare snappy")?.words).toEqual(["punch"]);
    expect(dynamicsClause("Tame the hats, a bit softer")?.words).toEqual(["soften"]);
    expect(dynamicsClause("Make the pad pump with the kick")?.words).toEqual(["pump"]);
    expect(dynamicsClause("Don't compress the vocal")).toBeNull();
    expect(dynamicsClause("Controlled but natural")).toBeNull();
    expect(dynamicsClause("Big and warm")).toBeNull();
    // "punch through" is a pair phrase, not a request for punchier transients.
    expect(dynamicsClause("Let the kick punch through the bass")?.words).toEqual(["duck"]);
  });

  it("reads pair instructions with the key and the target on the right sides", () => {
    const base = fixtureC().document;
    const document = {
      ...base,
      sections: [{ ...wholeSong()[0]!, startTime: 0, endTime: 60, source: "manual" as const, confidence: null, structuralGroupId: null, userIntent: "Let the kick punch through the bass." }],
    };
    expect(indexDynamicsIntent(document).pairs).toEqual([{ sectionId: "all", keyTrackId: "kick", targetTrackId: "bass", pump: false, text: "Let the kick punch through the bass" }]);
    const behind = { ...document, sections: [{ ...document.sections[0]!, userIntent: "Keep the bass behind the kick." }] };
    expect(indexDynamicsIntent(behind).pairs[0]).toMatchObject({ keyTrackId: "kick", targetTrackId: "bass" });
    // A Track × Section note names its own stem as the target.
    const row = setTrackSectionState(document, "bass", "all", { userIntent: "Duck under the kick." });
    if (!row.ok) throw new Error(row.message);
    const onRow = { ...row.document, sections: [{ ...document.sections[0]!, userIntent: null }] };
    expect(indexDynamicsIntent(onRow).pairs[0]).toMatchObject({ keyTrackId: "kick", targetTrackId: "bass" });
  });

  it("files single-stem words under that stem and section", () => {
    const base = fixtureC().document;
    const document = { ...base, sections: [{ ...wholeSong()[0]!, startTime: 0, endTime: 60, source: "manual" as const, confidence: null, structuralGroupId: null, userIntent: "Keep the bass controlled. The kick should be punchy." }] };
    const index = indexDynamicsIntent(document);
    expect(index.tracks.get("bass")?.get("all")?.[0]?.words).toEqual(["control"]);
    expect(index.tracks.get("kick")?.get("all")?.[0]?.words).toEqual(["punch"]);
  });
});
