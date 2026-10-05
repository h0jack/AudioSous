import { z } from "zod";
import { assertSafeRelativePath } from "./paths";

export const SCHEMA_VERSION = 4;

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

export const EQ_FILTER_KINDS = ["high-pass", "low-pass", "bell", "low-shelf", "high-shelf"] as const;
export type EqFilterKind = (typeof EQ_FILTER_KINDS)[number];

export const EQ_FILTER_LABELS: Record<EqFilterKind, string> = {
  "high-pass": "High-pass",
  "low-pass": "Low-pass",
  bell: "Bell",
  "low-shelf": "Low shelf",
  "high-shelf": "High shelf",
};

/** Bounds for any stored filter, manual or planned. The planner uses narrower limits of its own. */
export const EQ_LIMITS = {
  minHz: 20,
  maxHz: 20_000,
  minGainDb: -18,
  maxGainDb: 12,
  minQ: 0.1,
  maxQ: 10,
} as const;

/**
 * Spatial controls. Pan is -1 (left) … +1 (right): equal-power pan on a mono stem, balance on a stereo stem.
 * Width scales the side signal of a stereo stem: 0 is mono, 1 leaves it as recorded, 2 is the technical cap.
 * Width does nothing on a mono stem; Audiosous never synthesizes stereo.
 */
export const SPATIAL_LIMITS = {
  minPan: -1,
  maxPan: 1,
  minWidth: 0,
  maxWidth: 2,
} as const;

/** Track-wide filters per track, and extra filters per Track × Section. The native engine reserves exactly these slots. */
export const MAX_TRACK_EQ_NODES = 6;
export const MAX_SECTION_EQ_NODES = 4;

export const eqFilterSchema = z.object({
  kind: z.enum(EQ_FILTER_KINDS),
  frequencyHz: z.number().finite().min(EQ_LIMITS.minHz).max(EQ_LIMITS.maxHz),
  /** Ignored by high-pass and low-pass. Stored as 0 there. */
  gainDb: z.number().finite().min(EQ_LIMITS.minGainDb).max(EQ_LIMITS.maxGainDb),
  q: z.number().finite().min(EQ_LIMITS.minQ).max(EQ_LIMITS.maxQ),
});

export type EqFilter = z.infer<typeof eqFilterSchema>;

/** One static filter. A node is one band; a graph runs its enabled nodes in order. */
export const eqNodeSchema = z.object({
  id: idSchema,
  type: z.literal("eq"),
  enabled: z.boolean(),
  filter: eqFilterSchema,
  origin: z.enum(["manual", "eq-plan"]),
  /** Short explanation kept with planned nodes so the saved project says why the filter exists. */
  note: z.string().max(400).nullable(),
});

export type EqNode = z.infer<typeof eqNodeSchema>;

/**
 * Dynamics processors. They are not ordered by their position in the list: every graph runs its stages in
 * DYNAMICS_STAGE_ORDER (see dynamics.ts), after the static EQ nodes and before width, pan, and gain.
 */
export const DYNAMICS_NODE_TYPES = ["dynamic-eq", "compressor", "transient", "ducking"] as const;
export type DynamicsNodeType = (typeof DYNAMICS_NODE_TYPES)[number];

export const DYNAMICS_NODE_LABELS: Record<DynamicsNodeType, string> = {
  "dynamic-eq": "Dynamic EQ",
  compressor: "Compressor",
  transient: "Transient",
  ducking: "Ducking",
};

/** Bounds for any stored dynamics node, manual or planned. The planner stays well inside them. */
export const DYNAMICS_LIMITS = {
  minThresholdDb: -60,
  maxThresholdDb: 0,
  minRatio: 1,
  maxRatio: 20,
  minAttackMs: 0.1,
  maxAttackMs: 250,
  minReleaseMs: 5,
  maxReleaseMs: 2_000,
  minKneeDb: 0,
  maxKneeDb: 24,
  minMakeupDb: 0,
  maxMakeupDb: 12,
  /** Ducking and dynamic EQ only reduce: range is the largest reduction, 0 … −12 dB. */
  minRangeDb: -12,
  maxRangeDb: 0,
  minHz: 20,
  maxHz: 20_000,
  minQ: 0.3,
  maxQ: 6,
  /** Transient amounts are fractions: 0.15 is +15%. */
  maxTransientAttack: 0.3,
  maxTransientSustain: 0.2,
} as const;

/** Per graph and type. The native engine reserves exactly these slots. */
export const MAX_TRACK_DYNAMICS: Record<DynamicsNodeType, number> = { "dynamic-eq": 3, compressor: 1, transient: 1, ducking: 2 };
export const MAX_SECTION_DYNAMICS: Record<DynamicsNodeType, number> = { "dynamic-eq": 2, compressor: 1, transient: 1, ducking: 1 };

/** How a sidechain key is followed: a fast peak follower for drums, a slower RMS follower for voices and leads. */
export const KEY_DETECTORS = ["transient", "smooth"] as const;
export type KeyDetector = (typeof KEY_DETECTORS)[number];

const dynamicsBase = {
  id: idSchema,
  enabled: z.boolean(),
  origin: z.enum(["manual", "dynamics-plan"]),
  note: z.string().max(400).nullable(),
};
const thresholdSchema = z.number().finite().min(DYNAMICS_LIMITS.minThresholdDb).max(DYNAMICS_LIMITS.maxThresholdDb);
const attackSchema = z.number().finite().min(DYNAMICS_LIMITS.minAttackMs).max(DYNAMICS_LIMITS.maxAttackMs);
const releaseSchema = z.number().finite().min(DYNAMICS_LIMITS.minReleaseMs).max(DYNAMICS_LIMITS.maxReleaseMs);
const rangeSchema = z.number().finite().min(DYNAMICS_LIMITS.minRangeDb).max(DYNAMICS_LIMITS.maxRangeDb);

export const compressorNodeSchema = z.object({
  ...dynamicsBase,
  type: z.literal("compressor"),
  thresholdDb: thresholdSchema,
  ratio: z.number().finite().min(DYNAMICS_LIMITS.minRatio).max(DYNAMICS_LIMITS.maxRatio),
  attackMs: attackSchema,
  releaseMs: releaseSchema,
  kneeDb: z.number().finite().min(DYNAMICS_LIMITS.minKneeDb).max(DYNAMICS_LIMITS.maxKneeDb),
  /** 0 unless someone sets it. The planner never adds makeup to win a comparison by being louder. */
  makeupDb: z.number().finite().min(DYNAMICS_LIMITS.minMakeupDb).max(DYNAMICS_LIMITS.maxMakeupDb),
});

/** Lowers the track by up to `rangeDb` while the key track plays, read from the key track's own source. */
export const duckingNodeSchema = z.object({
  ...dynamicsBase,
  type: z.literal("ducking"),
  keyTrackId: idSchema,
  keyDetector: z.enum(KEY_DETECTORS),
  thresholdDb: thresholdSchema,
  rangeDb: rangeSchema,
  attackMs: attackSchema,
  releaseMs: releaseSchema,
});

export const transientNodeSchema = z.object({
  ...dynamicsBase,
  type: z.literal("transient"),
  attack: z.number().finite().min(-DYNAMICS_LIMITS.maxTransientAttack).max(DYNAMICS_LIMITS.maxTransientAttack),
  sustain: z.number().finite().min(-DYNAMICS_LIMITS.maxTransientSustain).max(DYNAMICS_LIMITS.maxTransientSustain),
});

/** A bell that dips by up to `rangeDb` while its detector (the key track's band, or the track's own) is over threshold. */
export const dynamicEqNodeSchema = z.object({
  ...dynamicsBase,
  type: z.literal("dynamic-eq"),
  filter: z.object({
    kind: z.literal("bell"),
    frequencyHz: z.number().finite().min(DYNAMICS_LIMITS.minHz).max(DYNAMICS_LIMITS.maxHz),
    q: z.number().finite().min(DYNAMICS_LIMITS.minQ).max(DYNAMICS_LIMITS.maxQ),
  }),
  /** Null detects on the track's own signal in that band. */
  keyTrackId: idSchema.nullable(),
  keyDetector: z.enum(KEY_DETECTORS),
  thresholdDb: thresholdSchema,
  rangeDb: rangeSchema,
  attackMs: attackSchema,
  releaseMs: releaseSchema,
});

export const dynamicsNodeSchema = z.discriminatedUnion("type", [dynamicEqNodeSchema, compressorNodeSchema, transientNodeSchema, duckingNodeSchema]);

export type CompressorNode = z.infer<typeof compressorNodeSchema>;
export type DuckingNode = z.infer<typeof duckingNodeSchema>;
export type TransientNode = z.infer<typeof transientNodeSchema>;
export type DynamicEqNode = z.infer<typeof dynamicEqNodeSchema>;
export type DynamicsNode = z.infer<typeof dynamicsNodeSchema>;
export type ProcessingNode = EqNode | DynamicsNode;

function dynamicsList(limits: Record<DynamicsNodeType, number>) {
  return z
    .array(dynamicsNodeSchema)
    .max(Object.values(limits).reduce((total, count) => total + count, 0))
    .superRefine((nodes, ctx) => {
      for (const type of DYNAMICS_NODE_TYPES) {
        const count = nodes.filter((node) => node.type === type).length;
        if (count > limits[type]) ctx.addIssue({ code: "custom", message: `A graph holds up to ${limits[type]} ${DYNAMICS_NODE_LABELS[type]} ${limits[type] === 1 ? "node" : "nodes"}.` });
      }
    });
}

/**
 * Graph v2. `nodes` are static EQ bands in array order. `dynamics` are dynamics processors, run in the fixed stage
 * order after the EQ. Version 1 graphs held EQ only.
 */
export const processingGraphSchema = z.object({
  schemaVersion: z.literal(2),
  nodes: z.array(eqNodeSchema).max(MAX_TRACK_EQ_NODES),
  dynamics: dynamicsList(MAX_TRACK_DYNAMICS),
});

export type ProcessingGraph = z.infer<typeof processingGraphSchema>;

const sectionProcessingGraphSchema = z.object({
  schemaVersion: z.literal(2),
  nodes: z.array(eqNodeSchema).max(MAX_SECTION_EQ_NODES),
  dynamics: dynamicsList(MAX_SECTION_DYNAMICS),
});

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
  pan: z.number().finite().min(SPATIAL_LIMITS.minPan).max(SPATIAL_LIMITS.maxPan),
  /** Stereo width, 1 = as recorded. Applied after EQ and before pan/balance. Ignored on a mono stem. */
  width: z.number().finite().min(SPATIAL_LIMITS.minWidth).max(SPATIAL_LIMITS.maxWidth),
  muted: z.boolean(),
  solo: z.boolean(),
  /** Track-wide processing, before width, pan, and gain. Applies to the whole song. */
  processing: processingGraphSchema,
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
    pan: z.number().finite().min(SPATIAL_LIMITS.minPan).max(SPATIAL_LIMITS.maxPan).nullable(),
    /** Replaces the track's width inside this section, like the gain and pan overrides. */
    width: z.number().finite().min(SPATIAL_LIMITS.minWidth).max(SPATIAL_LIMITS.maxWidth).nullable(),
  }),
  /** Added after the track's own processing while playback is inside this section. It never replaces track nodes. */
  processing: sectionProcessingGraphSchema,
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
      if (duplicate([...track.processing.nodes, ...track.processing.dynamics], (node) => node.id).size > 0) {
        issue(ctx, ["tracks", index, "processing", "nodes"], "Processing node ids must be unique on a track.");
      }
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
      if (duplicate([...setting.processing.nodes, ...setting.processing.dynamics], (node) => node.id).size > 0) {
        issue(ctx, ["sectionTrackSettings", index, "processing", "nodes"], "Processing node ids must be unique in a Track × Section graph.");
      }
    }

    // Sidechain routing is track → track. A key never points at its own track, and keys never form a loop.
    // A key naming a track that is not in the project is kept but inert (see keyRoutingIssues).
    const keyEdges = new Map<string, Set<string>>();
    const addEdge = (from: string, node: { type: string; keyTrackId?: string | null }, path: (string | number)[]) => {
      const key = "keyTrackId" in node ? node.keyTrackId : null;
      if (!key) return;
      if (key === from) issue(ctx, path, "A sidechain key cannot be the track itself.");
      if (!keyEdges.has(from)) keyEdges.set(from, new Set());
      keyEdges.get(from)!.add(key);
    };
    doc.tracks.forEach((track, index) => track.processing.dynamics.forEach((node, at) => addEdge(track.id, node, ["tracks", index, "processing", "dynamics", at, "keyTrackId"])));
    doc.sectionTrackSettings.forEach((row, index) =>
      row.processing.dynamics.forEach((node, at) => addEdge(row.trackId, node, ["sectionTrackSettings", index, "processing", "dynamics", at, "keyTrackId"])),
    );
    if (keyCycle(keyEdges)) issue(ctx, ["tracks"], "Sidechain keys form a loop.");

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
  return { schemaVersion: 2, nodes: [], dynamics: [] };
}

/** True when following keys from some track leads back to it. Self-keys are reported separately. */
export function keyCycle(edges: Map<string, Set<string>>): boolean {
  const state = new Map<string, "visiting" | "done">();
  const visit = (track: string): boolean => {
    const mark = state.get(track);
    if (mark === "done") return false;
    if (mark === "visiting") return true;
    state.set(track, "visiting");
    for (const next of edges.get(track) ?? []) {
      if (next !== track && visit(next)) return true;
    }
    state.set(track, "done");
    return false;
  };
  return [...edges.keys()].some((track) => visit(track));
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
