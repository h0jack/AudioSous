import { describe, expect, it } from "vitest";
import { sectionAnalysisRequestSchema, sectionAnalysisResultSchema, suggestSections } from "./index";

describe("analysis contract", () => {
  it("accepts an ordered suggestion list and rejects an overlap", () => {
    const request = sectionAnalysisRequestSchema.parse({
      contractVersion: 1,
      projectId: "project-night",
      sampleRate: 48_000,
      durationSeconds: 80,
      tracks: [{ trackId: "track-kick", role: "kick", mediaRelativePath: "media/track-kick__kick.wav" }],
    });
    expect(request.tracks).toHaveLength(1);

    const valid = sectionAnalysisResultSchema.safeParse({
      contractVersion: 1,
      suggestions: [
        {
          startTime: 0,
          endTime: 15,
          suggestedName: "Intro",
          suggestedType: "intro",
          confidence: 0.62,
          structuralGroupId: null,
        },
        {
          startTime: 15,
          endTime: 30,
          suggestedName: "Build",
          suggestedType: "build",
          confidence: 0.4,
          structuralGroupId: null,
        },
      ],
    });
    expect(valid.success).toBe(true);

    const overlap = sectionAnalysisResultSchema.safeParse({
      contractVersion: 1,
      suggestions: [
        {
          startTime: 0,
          endTime: 20,
          suggestedName: "Intro",
          suggestedType: "intro",
          confidence: 1.2,
          structuralGroupId: null,
        },
      ],
    });
    expect(overlap.success).toBe(false);
  });

  it("suggests ordered sections from an energy change and stays quiet when the song is flat", () => {
    const energy = Array.from({ length: 90 }, (_, index) => (index < 30 ? 0.15 : index < 60 ? 0.95 : 0.2));
    const result = suggestSections({ durationSeconds: 90, energy });
    expect(result.contractVersion).toBe(1);
    expect(result.suggestions.map((section) => section.suggestedType)).toEqual(["intro", "chorus", "outro"]);
    expect(result.suggestions[0]?.startTime).toBe(0);
    expect(result.suggestions.at(-1)?.endTime).toBe(90);
    expect(result.suggestions.every((section, index) => index === 0 || section.startTime >= (result.suggestions[index - 1]?.endTime ?? 0))).toBe(true);
    expect(suggestSections({ durationSeconds: 90, energy: Array.from({ length: 90 }, () => 0.4) }).suggestions).toEqual([]);
  });
});
