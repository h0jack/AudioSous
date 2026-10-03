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

const MIN_SECTION_SECONDS = 8;

/**
 * Experimental section guess from a normalized energy envelope.
 * A later sidecar can return the same contract. This function does not read audio files.
 */
export function suggestSections(input: { durationSeconds: number; energy: number[] }): SectionAnalysisResult {
  const duration = input.durationSeconds;
  const energy = input.energy.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
  if (duration < MIN_SECTION_SECONDS || energy.length < 8) {
    return { contractVersion: ANALYSIS_CONTRACT_VERSION, suggestions: [] };
  }
  const peak = Math.max(...energy);
  if (peak <= 0) return { contractVersion: ANALYSIS_CONTRACT_VERSION, suggestions: [] };
  const normal = energy.map((value) => value / peak);
  const smooth = movingAverage(normal, Math.max(3, Math.round(normal.length / 48)));
  const novelty = smooth.map((value, index) => Math.abs(value - (smooth[index - 1] ?? value)));
  const strongest = Math.max(...novelty);
  if (strongest < 0.02) return { contractVersion: ANALYSIS_CONTRACT_VERSION, suggestions: [] };

  const minGap = Math.min(30, Math.max(MIN_SECTION_SECONDS, duration * 0.08));
  const threshold = Math.max(percentile(novelty, 0.82), strongest * 0.45);
  const cuts = [0];
  for (let index = 1; index < novelty.length - 1; index += 1) {
    const time = (index / (normal.length - 1)) * duration;
    const previousCut = cuts[cuts.length - 1] ?? 0;
    if (time - previousCut < minGap) continue;
    if (duration - time < minGap) continue;
    const value = novelty[index] ?? 0;
    if (value < threshold) continue;
    if (value < (novelty[index - 1] ?? 0) || value < (novelty[index + 1] ?? 0)) continue;
    cuts.push(roundSeconds(time));
  }
  cuts.push(roundSeconds(duration));

  const suggestions = [];
  const counts = new Map<string, number>();
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const startTime = cuts[index] ?? 0;
    const endTime = cuts[index + 1] ?? duration;
    if (endTime - startTime < 1) continue;
    const from = Math.round((startTime / duration) * (smooth.length - 1));
    const to = Math.max(from + 1, Math.round((endTime / duration) * (smooth.length - 1)));
    const slice = smooth.slice(from, to);
    const mean = slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length);
    const boundary = Math.max(novelty[from] ?? 0, novelty[Math.min(novelty.length - 1, to)] ?? 0);
    const kind = kindFor(index, cuts.length - 1, mean);
    const seen = (counts.get(kind.type) ?? 0) + 1;
    counts.set(kind.type, seen);
    suggestions.push({
      startTime,
      endTime,
      suggestedName: seen === 1 ? kind.label : `${kind.label} ${seen}`,
      suggestedType: kind.type,
      confidence: roundSeconds(Math.min(0.85, 0.34 + 0.5 * (boundary / strongest))),
      structuralGroupId: kind.group,
    });
  }
  const parsed = sectionAnalysisResultSchema.safeParse({ contractVersion: ANALYSIS_CONTRACT_VERSION, suggestions });
  return parsed.success ? parsed.data : { contractVersion: ANALYSIS_CONTRACT_VERSION, suggestions: [] };
}

function kindFor(index: number, count: number, mean: number): { type: string; label: string; group: string | null } {
  if (index === 0 && mean < 0.62) return { type: "intro", label: "Intro", group: null };
  if (index === count - 1 && mean < 0.62) return { type: "outro", label: "Outro", group: null };
  if (mean >= 0.72) return { type: "chorus", label: "Chorus", group: "chorus" };
  if (mean >= 0.45) return { type: "verse", label: "Verse", group: "verse" };
  return { type: "breakdown", label: "Breakdown", group: null };
}

function movingAverage(values: number[], radius: number): number[] {
  return values.map((_, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length, index + radius + 1);
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += values[cursor] ?? 0;
    return sum / (end - start);
  });
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index] ?? 0;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
