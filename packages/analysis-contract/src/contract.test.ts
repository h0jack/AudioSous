import { describe, expect, it } from "vitest";
import { sectionAnalysisRequestSchema, sectionAnalysisResultSchema } from "./index";

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
});
