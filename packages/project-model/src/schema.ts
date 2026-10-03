import { z } from "zod";
import { assertSafeRelativePath } from "./paths";

export const SCHEMA_VERSION = 1;

export const GAIN_DB_MIN = -96;
export const GAIN_DB_MAX = 12;

export const TRACK_ROLE_IDS = [
  "kick",
  "snare-clap",
  "hi-hat",
  "percussion",
  "drums",
  "bass",
  "lead",
  "synth",
  "pad",
  "keys",
  "guitar",
  "vocal",
  "backing-vocal",
  "brass",
  "strings",
  "fx",
  "atmosphere",
  "other",
] as const;

export type TrackRole = (typeof TRACK_ROLE_IDS)[number];

export const TRACK_ROLE_LABELS: Record<TrackRole, string> = {
  kick: "Kick",
  "snare-clap": "Snare / Clap",
  "hi-hat": "Hi-Hat",
  percussion: "Percussion",
  drums: "Drums",
  bass: "Bass",
  lead: "Lead",
  synth: "Synth",
  pad: "Pad",
  keys: "Keys",
  guitar: "Guitar",
  vocal: "Vocal",
  "backing-vocal": "Backing Vocal",
  brass: "Brass",
  strings: "Strings",
  fx: "FX",
  atmosphere: "Atmosphere",
  other: "Other",
};

export const SECTION_TYPES = [
  "intro",
  "verse",
  "pre-chorus",
  "chorus",
  "build",
  "drop",
  "breakdown",
  "bridge",
  "interlude",
  "outro",
  "custom",
] as const;

export type SectionType = (typeof SECTION_TYPES)[number];

export const SECTION_TYPE_LABELS: Record<SectionType, string> = {
  intro: "Intro",
  verse: "Verse",
  "pre-chorus": "Pre-Chorus",
  chorus: "Chorus",
  build: "Build",
  drop: "Drop",
  breakdown: "Breakdown",
  bridge: "Bridge",
  interlude: "Interlude",
  outro: "Outro",
  custom: "Custom",
};

const idSchema = z.string().trim().min(1).max(80);
const timestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: "Expected a timestamp",
});
const secondsSchema = z.number().finite().nonnegative();

export const processingGraphSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(z.unknown()),
});

export type ProcessingGraph = z.infer<typeof processingGraphSchema>;

export const trackSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  role: z.enum(TRACK_ROLE_IDS),
  customLabel: z.string().trim().max(80).nullable(),
  file: z.object({
    relativePath: z.string().min(1).max(512),
    filename: z.string().trim().min(1).max(255),
  }),
  metadata: z.object({
    format: z.enum(["wav", "aiff"]),
    sampleRate: z.number().int().positive().max(384_000),
    channelCount: z.number().int().positive().max(64),
    bitDepth: z.number().int().positive().max(64).nullable(),
    durationSeconds: secondsSchema,
    fileSizeBytes: z.number().int().nonnegative(),
  }),
  gainDb: z.number().finite().min(GAIN_DB_MIN).max(GAIN_DB_MAX),
  pan: z.number().finite().min(-1).max(1),
  muted: z.boolean(),
  solo: z.boolean(),
});

export type Track = z.infer<typeof trackSchema>;

export const sectionSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(120),
  type: z.enum(SECTION_TYPES).nullable(),
  startTime: secondsSchema,
  endTime: secondsSchema,
  userIntent: z.string().max(8_000).nullable(),
  source: z.enum(["manual", "automatic", "automatic-edited"]),
  confidence: z.number().finite().min(0).max(1).nullable(),
  structuralGroupId: z.string().trim().min(1).max(80).nullable(),
});

export type SongSection = z.infer<typeof sectionSchema>;

export const trackSectionStateSchema = z.object({
  trackId: idSchema,
  sectionId: idSchema,
  userIntent: z.string().max(8_000).nullable(),
  prominence: z.enum(["primary", "focal", "supporting"]).nullable(),
  overrides: z.object({
    gainDb: z.number().finite().min(GAIN_DB_MIN).max(GAIN_DB_MAX).nullable(),
    pan: z.number().finite().min(-1).max(1).nullable(),
  }),
  processing: processingGraphSchema,
});

export type TrackSectionState = z.infer<typeof trackSectionStateSchema>;

export const mixVariantSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).nullable(),
  createdAt: timestampSchema,
  kind: z.enum(["original", "working", "custom"]),
});

export type MixVariant = z.infer<typeof mixVariantSchema>;

export const comparisonSchema = z.object({
  scope: z.enum(["entire-mix", "soloed-track", "track-in-mix"]),
  aVariantId: idSchema,
  bVariantId: idSchema,
  trackId: idSchema.nullable(),
});

export type MixComparison = z.infer<typeof comparisonSchema>;

export const uiStateSchema = z.object({
  selectedTrackId: idSchema.nullable(),
  selectedSectionId: idSchema.nullable(),
  timeRange: z
    .object({
      start: secondsSchema,
      end: secondsSchema,
    })
    .nullable(),
  loop: z
    .object({
      enabled: z.boolean(),
      start: secondsSchema,
      end: secondsSchema,
      sectionId: idSchema.nullable(),
    })
    .nullable(),
  playheadSeconds: secondsSchema,
  timelineZoom: z.number().finite().positive().max(10_000),
  timelineScroll: secondsSchema,
});

export type UiState = z.infer<typeof uiStateSchema>;

function issue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

function duplicate<T>(items: T[], idOf: (item: T) => string): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const item of items) {
    const id = idOf(item);
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return dupes;
}

export const projectDocumentSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    project: z.object({
      id: idSchema,
      name: z.string().trim().min(1).max(200),
      createdAt: timestampSchema,
      updatedAt: timestampSchema,
      sampleRate: z.number().int().positive().max(384_000),
      durationSeconds: secondsSchema,
    }),
    tracks: z.array(trackSchema).min(1),
    sections: z.array(sectionSchema),
    sectionTrackSettings: z.array(trackSectionStateSchema),
    mixVariants: z.array(mixVariantSchema).min(1),
    activeMixVariantId: idSchema,
    comparison: comparisonSchema,
    uiState: uiStateSchema,
  })
  .superRefine((doc, ctx) => {
    const duplicateTrackIds = duplicate(doc.tracks, (track) => track.id);
    const trackIds = new Set<string>();
    const mediaPaths = new Set<string>();
    for (const [index, track] of doc.tracks.entries()) {
      trackIds.add(track.id);
      if (duplicateTrackIds.has(track.id)) {
        issue(ctx, ["tracks", index, "id"], "Duplicate track id.");
      }
      if (mediaPaths.has(track.file.relativePath)) {
        issue(ctx, ["tracks", index, "file", "relativePath"], "Two stems use the same media path.");
      }
      mediaPaths.add(track.file.relativePath);
      try {
        assertSafeRelativePath(track.file.relativePath);
      } catch (error) {
        issue(ctx, ["tracks", index, "file", "relativePath"], error instanceof Error ? error.message : "Unsafe media path.");
      }
    }

    const duplicateSectionIds = duplicate(doc.sections, (section) => section.id);
    const sectionIds = new Set<string>();
    for (const [index, section] of doc.sections.entries()) {
      sectionIds.add(section.id);
      if (duplicateSectionIds.has(section.id)) {
        issue(ctx, ["sections", index, "id"], "Duplicate section id.");
      }
      if (section.endTime <= section.startTime) {
        issue(ctx, ["sections", index, "endTime"], "A section must have a duration.");
      }
      const previous = doc.sections[index - 1];
      if (previous && section.startTime < previous.startTime) {
        issue(ctx, ["sections", index, "startTime"], "Sections must be stored in start-time order.");
      }
      if (previous && section.startTime < previous.endTime) {
        issue(ctx, ["sections", index, "startTime"], "Sections cannot overlap.");
      }
    }

    const pairs = new Set<string>();
    for (const [index, setting] of doc.sectionTrackSettings.entries()) {
      const pair = `${setting.trackId}:${setting.sectionId}`;
      if (pairs.has(pair)) {
        issue(ctx, ["sectionTrackSettings", index], "Duplicate track and section pair.");
      }
      pairs.add(pair);
      if (!trackIds.has(setting.trackId)) {
        issue(ctx, ["sectionTrackSettings", index, "trackId"], "Unknown track.");
      }
      if (!sectionIds.has(setting.sectionId)) {
        issue(ctx, ["sectionTrackSettings", index, "sectionId"], "Unknown section.");
      }
    }

    const variantIds = new Set(doc.mixVariants.map((variant) => variant.id));
    if (duplicate(doc.mixVariants, (variant) => variant.id).size > 0) {
      issue(ctx, ["mixVariants"], "Mix variant ids must be unique.");
    }
    if (!variantIds.has(doc.activeMixVariantId)) {
      issue(ctx, ["activeMixVariantId"], "The active mix variant does not exist.");
    }
    if (!variantIds.has(doc.comparison.aVariantId) || !variantIds.has(doc.comparison.bVariantId)) {
      issue(ctx, ["comparison"], "Comparison variants must exist on the project.");
    }
    if (doc.comparison.scope === "entire-mix" && doc.comparison.trackId !== null) {
      issue(ctx, ["comparison", "trackId"], "An entire-mix comparison does not target one track.");
    }
    if (doc.comparison.scope !== "entire-mix" && !doc.comparison.trackId) {
      issue(ctx, ["comparison", "trackId"], "This comparison needs a track.");
    }
    if (doc.comparison.trackId && !trackIds.has(doc.comparison.trackId)) {
      issue(ctx, ["comparison", "trackId"], "Unknown comparison track.");
    }

    const { uiState } = doc;
    if (uiState.selectedTrackId && !trackIds.has(uiState.selectedTrackId)) {
      issue(ctx, ["uiState", "selectedTrackId"], "Unknown selected track.");
    }
    if (uiState.selectedSectionId && !sectionIds.has(uiState.selectedSectionId)) {
      issue(ctx, ["uiState", "selectedSectionId"], "Unknown selected section.");
    }
    if (uiState.timeRange && uiState.timeRange.end <= uiState.timeRange.start) {
      issue(ctx, ["uiState", "timeRange"], "The selected range must have a duration.");
    }
    if (uiState.loop && uiState.loop.end <= uiState.loop.start) {
      issue(ctx, ["uiState", "loop"], "The loop must have a duration.");
    }
    if (uiState.loop?.sectionId && !sectionIds.has(uiState.loop.sectionId)) {
      issue(ctx, ["uiState", "loop", "sectionId"], "Unknown loop section.");
    }
    if (uiState.playheadSeconds > doc.project.durationSeconds + 0.001) {
      issue(ctx, ["uiState", "playheadSeconds"], "The playhead is past the end of the project.");
    }
  });

export type ProjectDocument = z.infer<typeof projectDocumentSchema>;

export function emptyProcessingGraph(): ProcessingGraph {
  return { schemaVersion: 1, nodes: [] };
}

export function defaultUiState(): UiState {
  return {
    selectedTrackId: null,
    selectedSectionId: null,
    timeRange: null,
    loop: null,
    playheadSeconds: 0,
    timelineZoom: 1,
    timelineScroll: 0,
  };
}
