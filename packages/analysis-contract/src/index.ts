import { z } from "zod";

export {
  ANALYSIS_ENGINE_VERSION,
  ANALYSIS_SCHEMA_VERSION,
  EQ_BANDS_VERSION,
  FREQUENCY_BANDS,
  STEREO_BANDS,
  STEREO_FRAMES_VERSION,
  stereoFramesCachePath,
  stereoFramesCacheSchema,
  stereoFramesSchema,
  eqBandFramesSchema,
  eqBandsCachePath,
  eqBandsCacheSchema,
  analysisCacheEntrySchema,
  analysisCacheIsCurrent,
  analysisCachePath,
  analysisFileIdentitySchema,
  analysisIdentitySchema,
  bandEnergySchema,
  bandOverlap,
  levelDeltaDb,
  measurementScopeSchema,
  mixAnalysisCacheName,
  rangeAnalysisCacheName,
  sectionAnalysisCacheName,
  spectrogramSchema,
  trackFileMeasurementSchema,
  type AnalysisCacheEntry,
  type AnalysisFileIdentity,
  type AnalysisIdentity,
  type BandEnergy,
  type EqBandFrames,
  type EqBandsCacheEntry,
  type StereoFrames,
  type StereoFramesCacheEntry,
  type FrequencyBandId,
  type MeasurementScope,
  type TrackFileMeasurement,
} from "./measurements";

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

export interface StemEnergy {
  role: string;
  energy: number[];
}

/**
 * Experimental section guess from cached stem energy.
 * Cuts come from energy change plus how many stems are active. Labels use arrangement
 * heuristics (intro, build, drop, breakdown, outro). Similar shapes share a group id.
 * Spectral centroid, chroma, and tempo stay on the analysis contract for a later sidecar;
 * this pass does not decode PCM and does not start Python.
 */
export function suggestSections(input: { durationSeconds: number; energy: number[]; stems?: StemEnergy[] }): SectionAnalysisResult {
  const duration = input.durationSeconds;
  const energy = sanitize(input.energy);
  if (duration < MIN_SECTION_SECONDS || energy.length < 8) {
    return { contractVersion: ANALYSIS_CONTRACT_VERSION, suggestions: [] };
  }
  const peak = Math.max(...energy);
  if (peak <= 0) return { contractVersion: ANALYSIS_CONTRACT_VERSION, suggestions: [] };
  const normal = energy.map((value) => value / peak);
  const stems = (input.stems ?? [])
    .map((stem) => {
      const values = resample(sanitize(stem.energy), normal.length);
      const stemPeak = Math.max(...values);
      return { role: stem.role, values, peak: stemPeak };
    })
    .filter((stem) => stem.peak > 0.02);
  const activity = normal.map((_, index) => {
    if (stems.length === 0) return normal[index] ?? 0;
    const active = stems.filter((stem) => (stem.values[index] ?? 0) / stem.peak > 0.35).length;
    return active / stems.length;
  });
  const smooth = movingAverage(normal, Math.max(3, Math.round(normal.length / 48)));
  const smoothActivity = movingAverage(activity, Math.max(3, Math.round(activity.length / 48)));
  const novelty = smooth.map((value, index) => {
    const energyChange = Math.abs(value - (smooth[index - 1] ?? value));
    const currentActivity = smoothActivity[index] ?? 0;
    const activityChange = Math.abs(currentActivity - (smoothActivity[index - 1] ?? currentActivity));
    return energyChange + activityChange * 0.65;
  });
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

  const drafts = [];
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const startTime = cuts[index] ?? 0;
    const endTime = cuts[index + 1] ?? duration;
    if (endTime - startTime < 1) continue;
    const from = Math.round((startTime / duration) * (smooth.length - 1));
    const to = Math.max(from + 1, Math.round((endTime / duration) * (smooth.length - 1)));
    const slice = smooth.slice(from, to);
    const mean = average(slice);
    const rise = average(slice.slice(Math.floor(slice.length * 0.7))) - average(slice.slice(0, Math.max(1, Math.ceil(slice.length * 0.3))));
    const lowEnergy = roleMean(stems, LOW_ROLES, from, to);
    const kind = labelRegion(index, cuts.length - 1, mean, rise, lowEnergy);
    const boundary = Math.max(novelty[from] ?? 0, novelty[Math.min(novelty.length - 1, to)] ?? 0);
    drafts.push({
      startTime,
      endTime,
      kind,
      profile: resample(slice, 8),
      mean,
      confidence: roundSeconds(Math.min(0.9, 0.34 + 0.5 * (boundary / strongest))),
    });
  }
  const groups = assignGroups(drafts.map((draft) => ({ bins: draft.profile, mean: draft.mean })));
  const counts = new Map<string, number>();
  const suggestions = drafts.map((draft, index) => {
    const seen = (counts.get(draft.kind.type) ?? 0) + 1;
    counts.set(draft.kind.type, seen);
    return {
      startTime: draft.startTime,
      endTime: draft.endTime,
      suggestedName: seen === 1 ? draft.kind.label : `${draft.kind.label} ${seen}`,
      suggestedType: draft.kind.type,
      confidence: draft.confidence,
      structuralGroupId: groups[index] ?? null,
    };
  });
  const parsed = sectionAnalysisResultSchema.safeParse({ contractVersion: ANALYSIS_CONTRACT_VERSION, suggestions });
  return parsed.success ? parsed.data : { contractVersion: ANALYSIS_CONTRACT_VERSION, suggestions: [] };
}

const LOW_ROLES = new Set(["kick", "bass", "drums"]);

function labelRegion(index: number, count: number, mean: number, rise: number, lowEnergy: number): { type: string; label: string } {
  if (index === 0 && mean < 0.55) return { type: "intro", label: "Intro" };
  if (index === count - 1 && mean < 0.62) return { type: "outro", label: "Outro" };
  if (rise > 0.18 && mean < 0.8) return { type: "build", label: "Build" };
  if (mean >= 0.72 || lowEnergy >= 0.7) return { type: "drop", label: "Drop" };
  if (mean < 0.4) return { type: "breakdown", label: "Breakdown" };
  return { type: "verse", label: "Verse" };
}

function assignGroups(profiles: Array<{ bins: number[]; mean: number }>): Array<string | null> {
  const ids: Array<string | null> = profiles.map(() => null);
  let next = 1;
  for (let left = 0; left < profiles.length; left += 1) {
    if (ids[left]) continue;
    const matches: number[] = [];
    for (let right = left + 1; right < profiles.length; right += 1) {
      if (ids[right]) continue;
      const shape = cosine(profiles[left]?.bins ?? [], profiles[right]?.bins ?? []);
      const level = 1 - Math.abs((profiles[left]?.mean ?? 0) - (profiles[right]?.mean ?? 0));
      if (shape >= 0.9 && level >= 0.75) matches.push(right);
    }
    if (matches.length === 0) continue;
    const id = `group-${next}`;
    next += 1;
    ids[left] = id;
    for (const match of matches) ids[match] = id;
  }
  return ids;
}

function roleMean(stems: Array<{ role: string; values: number[]; peak: number }>, roles: Set<string>, from: number, to: number): number {
  const chosen = stems.filter((stem) => roles.has(stem.role));
  if (chosen.length === 0) return 0;
  const means = chosen.map((stem) => average(stem.values.slice(from, to)) / stem.peak);
  return average(means);
}

function sanitize(values: number[]): number[] {
  return values.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
}

function resample(values: number[], length: number): number[] {
  if (length <= 0) return [];
  if (values.length === 0) return new Array<number>(length).fill(0);
  return Array.from({ length }, (_, index) => {
    const at = Math.round((index / Math.max(1, length - 1)) * (values.length - 1));
    return values[Math.min(values.length - 1, Math.max(0, at))] ?? 0;
  });
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftEnergy += a * a;
    rightEnergy += b * b;
  }
  if (leftEnergy <= 0 || rightEnergy <= 0) return 0;
  return dot / Math.sqrt(leftEnergy * rightEnergy);
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
