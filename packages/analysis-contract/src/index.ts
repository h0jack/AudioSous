import { z } from "zod";

/** JSON exchanged with the Python analysis sidecar. The UI does not import Python objects. */
export const ANALYSIS_CONTRACT_VERSION = 1;

export const sectionAnalysisRequestSchema = z.object({
  contractVersion: z.literal(ANALYSIS_CONTRACT_VERSION),
  projectId: z.string().min(1),
  sampleRate: z.number().int().positive(),
  durationSeconds: z.number().finite().nonnegative(),
  tracks: z.array(
    z.object({
      trackId: z.string().min(1),
      role: z.string().min(1),
      mediaRelativePath: z.string().min(1),
    }),
  ),
});

export type SectionAnalysisRequest = z.infer<typeof sectionAnalysisRequestSchema>;

export const sectionSuggestionSchema = z.object({
  startTime: z.number().finite().nonnegative(),
  endTime: z.number().finite().positive(),
  suggestedName: z.string().trim().min(1),
  suggestedType: z.string().trim().min(1),
  confidence: z.number().finite().min(0).max(1),
  structuralGroupId: z.string().trim().min(1).nullable(),
});

export type SectionSuggestion = z.infer<typeof sectionSuggestionSchema>;

export const sectionAnalysisResultSchema = z
  .object({
    contractVersion: z.literal(ANALYSIS_CONTRACT_VERSION),
    suggestions: z.array(sectionSuggestionSchema),
  })
  .superRefine((result, ctx) => {
    for (const [index, suggestion] of result.suggestions.entries()) {
      if (suggestion.endTime <= suggestion.startTime) {
        ctx.addIssue({
          code: "custom",
          path: ["suggestions", index, "endTime"],
          message: "A suggested section must have a duration.",
        });
      }
      const previous = result.suggestions[index - 1];
      if (previous && suggestion.startTime < previous.startTime) {
        ctx.addIssue({
          code: "custom",
          path: ["suggestions", index, "startTime"],
          message: "Suggestions must be in start-time order.",
        });
      }
      if (previous && suggestion.startTime < previous.endTime) {
        ctx.addIssue({
          code: "custom",
          path: ["suggestions", index, "startTime"],
          message: "Suggestions cannot overlap.",
        });
      }
    }
  });

export type SectionAnalysisResult = z.infer<typeof sectionAnalysisResultSchema>;
