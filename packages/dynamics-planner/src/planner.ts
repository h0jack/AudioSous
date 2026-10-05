import {
  ANALYSIS_ENGINE_VERSION,
  decodeEnvelopeSeries,
  encodeEnvelopeSeries,
  type EnvelopeFrames,
  type EqBandFrames,
  type TrackFileMeasurement,
} from "@audiosous/analysis-contract";
import { TIER_RANK, confidenceLabel, defaultTierFor, formatSignedDb, readTier, type SourceFingerprint, type Tier } from "@audiosous/balance-planner";
import {
  analysisScopes,
  analyzeInteractions,
  buildSpectralModel,
  musicalFrequency,
  qForOctaves,
  regionWeight,
  stepsIn,
  type AnalysisScope,
  type InteractionAnalysis,
  type PairAnalysis,
  type SpectralModel,
} from "@audiosous/eq-planner";
import {
  type CompressorNode,
  type DuckingNode,
  type DynamicEqNode,
  type DynamicsNode,
  type ProjectDocument,
  type Track,
  sectionDynamicsNodes,
  trackDynamicsNodes,
} from "@audiosous/project-model";
import {
  HOP_SECONDS,
  buildEnvelopeModel,
  meanDb,
  onsetsOf,
  percentile,
  segmentAt,
  selfSimilarity,
  type SelfSimilarity,
  spreadOf,
  sustainedLevels,
  transientRatioDb,
  type EnvelopeModel,
  type EnvelopeTrack,
  type SpreadReading,
} from "./envelope";
import { indexDynamicsIntent, wordsFor, type DynamicsIntentIndex, type DynamicsWord } from "./intent";
import {
  dynamicsPlanSchema,
  dynamicsPlanStateIdentity,
  dynamicsRecommendationId,
  dynamicsWarnings,
  evaluateDynamics,
  formatHz,
  needsReview,
  normalizeProcessing,
  round2,
  round3,
  type CompressorProcessing,
  type DuckingProcessing,
  type DynamicEqProcessing,
  type DynamicsEvaluation,
  type DynamicsEvidence,
  type DynamicsInteraction,
  type DynamicsPlan,
  type DynamicsProblem,
  type DynamicsProcessing,
  type DynamicsReading,
  type DynamicsRecommendation,
  type DynamicsScope,
  type TransientProcessing,
} from "./plan";
import {
  DEFAULT_DYNAMICS_SETTINGS,
  DYNAMICS_LIMITS_BY_STRENGTH,
  DYNAMICS_PLAN_VERSION,
  DYNAMICS_PLANNER_VERSION,
  MIN_AHEAD_SHARE,
  MIN_COLLISION_SHARE,
  MIN_FREE_SHARE,
  MIN_IRREGULARITY,
  MIN_SWING_RATE,
  MIN_WINDOWS,
  SPREAD_THRESHOLD_DB,
  SWING_DB,
  type DynamicsLimits,
  type DynamicsSettings,
} from "./settings";
import { simulateCompressor, simulateDucking } from "./simulate";

export interface PlanDynamicsInput {
  document: ProjectDocument;
  /** Whole-track measurements from the analysis cache (frequency competition for event masking). */
  measurements: Record<string, TrackFileMeasurement | null | undefined>;
  /** Proxy envelope frames (10 ms level, peak, low band). Required for every dynamics decision. */
  envelopes: Record<string, EnvelopeFrames | null | undefined>;
  /** Proxy EQ band frames (phrase-level masking). Without them the sidecar spectrogram is used. */
  bands?: Record<string, EqBandFrames | null | undefined>;
  settings?: Partial<DynamicsSettings>;
  fingerprints?: SourceFingerprint[];
  now?: string;
  /** Receives each stage's decisions. For acceptance scripts and debugging; the plan does not depend on it. */
  trace?: (stage: string, detail: unknown) => void;
}

/** A stem as heard now on the 10 ms grid: fader or section gain, saved EQ, and saved dynamics included. */
interface Heard {
  env: EnvelopeTrack;
  /** RMS after the saved EQ, before the fader and any dynamics: what a compressor on this stem would see. */
  detector: Float32Array;
  /** Reduction of the saved dynamics (compressors and ducks), dB ≥ 0, or null when there are none. */
  saved: Float32Array | null;
  rms: Float32Array;
  low: Float32Array;
  peak: Float32Array;
}

interface Row {
  trackId: string;
  scope: DynamicsScope;
  problem: DynamicsProblem;
  processing: DynamicsProcessing;
  replacesNodeId: string | null;
  targetReductionDb: { min: number; max: number } | null;
  relatedTrackIds: string[];
  interactionIds: string[];
  confidence: number;
  forceReview: string | null;
  evidence: DynamicsEvidence;
  evaluation: Omit<DynamicsEvaluation, "passes" | "proxy">;
  pass: 1 | 2;
  benefit: number;
  explain: (evaluation: Omit<DynamicsEvaluation, "passes" | "proxy">) => string[];
}

interface Context {
  document: ProjectDocument;
  limits: DynamicsLimits;
  model: EnvelopeModel;
  spectral: SpectralModel;
  analysis: InteractionAnalysis;
  intents: DynamicsIntentIndex;
  scopes: AnalysisScope[];
  /** Marked sections and unmarked gaps; the whole song when there are no sections. */
  partition: AnalysisScope[];
  heard: Map<string, Heard>;
  raw: Map<string, { rms: Float32Array; peak: Float32Array; low: Float32Array }>;
  rows: Row[];
  interactions: DynamicsInteraction[];
  readings: DynamicsReading[];
  notes: string[];
  /** Protected stem name → stems that mask it persistently (one note each, written after planning). */
  staticMasking: Map<string, string[]>;
  trace: (stage: string, detail: unknown) => void;
}

const PERCUSSIVE = new Set(["kick", "snare-clap", "hi-hat", "percussion", "drums"]);
const LOW_END_ROLES = new Set(["bass"]);
const LEAD_ROLES = new Set(["lead", "vocal"]);
const SUPPORT_ROLES = new Set(["pad", "synth", "keys", "guitar", "strings", "brass", "backing-vocal", "atmosphere", "fx", "other"]);
/** Base cost of each processor: the regularization that keeps a plan small. A row must earn more than this. */
const PROCESSOR_COST: Record<DynamicsProcessing["type"], number> = { compressor: 0.06, transient: 0.06, ducking: 0.08, "dynamic-eq": 0.1 };
const SECTION_COST = 0.04;

/**
 * Deterministic dynamics plan: compression for broad level instability, transient shaping for attack/body
 * imbalance, ducking for a kick/bass collision or a lead that a supporting part covers only while it plays,
 * dynamic EQ for frequency-specific time-varying masking. Same project, gains, EQ, space, dynamics, analysis,
 * roles, sections, intent, and settings give the same plan.
 */
export function planDynamics(input: PlanDynamicsInput): DynamicsPlan {
  const settings: DynamicsSettings = { ...DEFAULT_DYNAMICS_SETTINGS, ...input.settings };
  const { document } = input;
  const model = buildEnvelopeModel({ document, envelopes: input.envelopes, bands: input.bands });
  const spectral = buildSpectralModel({ document, measurements: input.measurements, bands: input.bands });
  const analysis = analyzeInteractions(document, spectral);
  const scopes = analysisScopes(document);
  const partition = scopes.length > 1 ? scopes.filter((scope) => scope.key !== "song") : scopes;
  const ctx: Context = {
    document,
    limits: DYNAMICS_LIMITS_BY_STRENGTH[settings.strength],
    model,
    spectral,
    analysis,
    intents: indexDynamicsIntent(document),
    scopes,
    partition,
    heard: new Map(),
    raw: new Map(),
    rows: [],
    interactions: [],
    readings: [],
    notes: [],
    staticMasking: new Map(),
    trace: input.trace ?? (() => {}),
  };
  for (const [trackId, envelope] of Object.entries(input.envelopes)) {
    if (!envelope) continue;
    ctx.raw.set(trackId, { rms: fit(decodeEnvelopeSeries(envelope.rms), model.frames), peak: fit(decodeEnvelopeSeries(envelope.peak), model.frames), low: fit(decodeEnvelopeSeries(envelope.low), model.frames) });
  }
  rebuildHeard(ctx, []);

  // Pass 1: each stem on its own. Compression for level instability, transient shaping for attack/body.
  for (const env of model.tracks.values()) planLevel(ctx, env);
  for (const env of model.tracks.values()) planTransient(ctx, env);
  ctx.trace("pass1", ctx.rows.map(summaryOf));
  // Pass 2: relationships, heard with the first pass in place (a compressed bass collides differently).
  rebuildHeard(ctx, ctx.rows);
  planCollisions(ctx);
  planMasking(ctx);
  for (const [protectedName, maskers] of ctx.staticMasking) {
    const list = maskers.length === 1 ? maskers[0]! : `${maskers.slice(0, -1).join(", ")} and ${maskers[maskers.length - 1]}`;
    ctx.notes.push(`${list} ${maskers.length === 1 ? "masks" : "mask"} ${protectedName} most of the time they play: static EQ (the EQ tab) is the right class of tool there, so no dynamic EQ was proposed.`);
  }
  ctx.trace("pass2", ctx.rows.map(summaryOf));
  limitPerTrack(ctx);

  for (const ambiguous of ctx.intents.ambiguous.slice(0, 2)) {
    const names = ambiguous.trackIds.map((id) => document.tracks.find((track) => track.id === id)?.name ?? id).join(" or ");
    ctx.notes.push(`"${ambiguous.text}" could mean ${names}, so it was not applied. Name the stem.`);
  }
  const changes: DynamicsRecommendation[] = ctx.rows.map((row) => finish(row));
  const unmeasured = model.skipped.filter((item) => item.reason === "unmeasured").length;
  const plan: DynamicsPlan = {
    planVersion: DYNAMICS_PLAN_VERSION,
    plannerVersion: DYNAMICS_PLANNER_VERSION,
    kind: "dynamics-balance",
    createdAt: input.now ?? new Date().toISOString(),
    projectId: document.project.id,
    sourceAnalysisVersion: ANALYSIS_ENGINE_VERSION,
    settings,
    stateIdentity: dynamicsPlanStateIdentity(document, settings, input.fingerprints ?? []),
    summary: {
      goal: "dynamics",
      confidence: changes.length > 0 ? round2(changes.reduce((total, change) => total + change.confidence, 0) / changes.length) : 0.9,
      headline: headline(changes, document),
      notes: ctx.notes.slice(0, 12),
      changeCount: changes.length,
      reviewCount: changes.filter((change) => change.status === "needs-review").length,
      tracksAnalyzed: model.tracks.size,
      pairsAnalyzed: ctx.interactions.length,
      analysisSource:
        unmeasured > 0
          ? `Envelopes measured from the playback proxies for ${model.tracks.size} stems; ${unmeasured} ${unmeasured === 1 ? "stem has" : "stems have"} no envelope yet and ${unmeasured === 1 ? "was" : "were"} left out.`
          : `Envelopes (10 ms level, peak, and low band) measured from the playback proxies for ${model.tracks.size} stems.`,
    },
    changes,
    interactions: [...ctx.interactions].sort((left, right) => Number(right.outcome === "recommendation") - Number(left.outcome === "recommendation") || right.confidence - left.confidence).slice(0, 48),
    readings: ctx.readings.slice(0, 400),
  };
  return dynamicsPlanSchema.parse(plan);
}

function fit(values: Float32Array, frames: number): Float32Array {
  if (values.length === frames) return values;
  const out = new Float32Array(frames).fill(-100);
  out.set(values.subarray(0, Math.min(values.length, frames)));
  return out;
}

/* ------------------------------------------------------------------ the mix as heard */

/**
 * Rebuilds every stem's heard level from the raw envelopes, its fader and section gain, its saved EQ, its saved
 * dynamics, and the given plan rows (compressors and ducks change what other rows hear).
 */
function rebuildHeard(ctx: Context, rows: Row[]): void {
  ctx.heard.clear();
  for (const env of ctx.model.tracks.values()) {
    const frames = env.frames;
    const detector = new Float32Array(frames);
    const peak = new Float32Array(frames);
    for (const segment of env.segments) {
      for (let frame = segment.start; frame < segment.end; frame += 1) {
        detector[frame] = env.rms[frame]! + segment.eqBroadDb;
        peak[frame] = env.peak[frame]! + segment.eqBroadDb;
      }
    }
    let saved: Float32Array | null = null;
    const add = (reduction: Float32Array, start: number) => {
      saved ??= new Float32Array(frames);
      for (let at = 0; at < reduction.length; at += 1) saved[start + at] = saved[start + at]! + reduction[at]!;
    };
    const planned = rows.filter((row) => row.trackId === env.track.id);
    const replaced = new Set(planned.map((row) => row.replacesNodeId).filter((id): id is string => id !== null));
    const runNode = (node: DynamicsNode | DynamicsProcessing, start: number, end: number) => {
      if (node.type === "compressor") add(simulateCompressor(detector, node, start, end), start);
      if (node.type === "ducking") {
        const key = ctx.raw.get(node.keyTrackId);
        if (key && node.keyTrackId !== env.track.id) add(simulateDucking(key.peak, key.rms, node, start, end), start);
      }
    };
    for (const node of trackDynamicsNodes(ctx.document, env.track.id)) if (node.enabled && !replaced.has(node.id)) runNode(node, 0, frames);
    for (const segment of env.segments) {
      if (!segment.sectionId) continue;
      for (const node of sectionDynamicsNodes(ctx.document, env.track.id, segment.sectionId)) if (node.enabled && !replaced.has(node.id)) runNode(node, segment.start, segment.end);
    }
    for (const row of planned) {
      const [start, end] = row.scope.type === "global" ? [0, frames] : framesOfSection(ctx, row.scope.sectionId);
      runNode(row.processing, start, end);
    }
    const rms = new Float32Array(frames);
    const low = new Float32Array(frames);
    const heardPeak = new Float32Array(frames);
    for (const segment of env.segments) {
      for (let frame = segment.start; frame < segment.end; frame += 1) {
        const reduction = saved ? (saved as Float32Array)[frame]! : 0;
        rms[frame] = detector[frame]! - reduction + segment.gainDb;
        low[frame] = env.low[frame]! + segment.eqLowDb - reduction + segment.gainDb;
        heardPeak[frame] = peak[frame]! - reduction + segment.gainDb;
      }
    }
    ctx.heard.set(env.track.id, { env, detector, saved, rms, low, peak: heardPeak });
  }
}

function framesOfSection(ctx: Context, sectionId: string): [number, number] {
  const section = ctx.document.sections.find((item) => item.id === sectionId);
  if (!section) return [0, 0];
  return [Math.max(0, Math.round(section.startTime / HOP_SECONDS)), Math.min(ctx.model.frames, Math.round(section.endTime / HOP_SECONDS))];
}

function framesOf(ctx: Context, scope: AnalysisScope): [number, number] {
  return [Math.max(0, Math.round(scope.start / HOP_SECONDS)), Math.min(ctx.model.frames, Math.round(scope.end / HOP_SECONDS))];
}

function tierOf(ctx: Context, track: Track, scope: AnalysisScope): { tier: Tier; explicit: boolean } {
  const read = ctx.analysis.tiers.get(track.id)?.get(scope.key);
  if (read) return { tier: read.tier, explicit: read.explicit };
  if (scope.section) {
    const tier = readTier(ctx.document, track, scope.section, ctx.analysis.intents);
    return { tier: tier.tier, explicit: tier.explicit };
  }
  return { tier: defaultTierFor(track, ctx.document.tracks), explicit: false };
}

function wordsIn(ctx: Context, trackId: string, scope: AnalysisScope | null): { words: Set<DynamicsWord>; text: string | null } {
  if (scope?.sectionId) return wordsFor(ctx.intents, trackId, scope.sectionId);
  // Whole song: a word counts when it was written for every section the stem is judged in.
  const sections = ctx.document.sections.map((section) => wordsFor(ctx.intents, trackId, section.id));
  if (sections.length === 0) return { words: new Set(), text: null };
  const common = [...(sections[0]?.words ?? [])].filter((word) => sections.every((item) => item.words.has(word)));
  return { words: new Set(common), text: sections.find((item) => item.text)?.text ?? null };
}

function nameOf(ctx: Context, trackId: string): string {
  return ctx.document.tracks.find((track) => track.id === trackId)?.name ?? trackId;
}

function scopeName(scope: AnalysisScope): string {
  return scope.key === "song" ? "the whole song" : scope.marked ? `the ${scope.name}` : "unmarked time";
}

function toScope(scope: AnalysisScope): DynamicsScope {
  return scope.sectionId ? { type: "section", sectionId: scope.sectionId } : { type: "global" };
}

/**
 * Windows (seconds) for the proxy check: the scope, trimmed to where the stem plays, at most 24 pieces. A 500 ms block
 * counts as playing when any frame in it plays, so a sparse part (a clap on the off-beats) still has windows.
 */
function windowsOf(start: number, end: number, playing: (frame: number) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open: number | null = null;
  const step = 50;
  for (let frame = start; frame < end; frame += step) {
    let on = false;
    for (let at = frame; at < Math.min(end, frame + step) && !on; at += 1) on = playing(at);
    if (on && open === null) open = frame;
    if ((!on || frame + step >= end) && open !== null) {
      const close = on ? Math.min(end, frame + step) : frame;
      if (close - open >= 100) out.push([round2(open * HOP_SECONDS), round2(close * HOP_SECONDS)]);
      open = null;
    }
  }
  return out.sort((left, right) => right[1] - right[0] - (left[1] - left[0])).slice(0, 24).sort((left, right) => left[0] - right[0]);
}

/* ------------------------------------------------------------------ level: compression */

interface LevelScope {
  scope: AnalysisScope;
  reading: SpreadReading;
  threshold: number;
  minSwing: number;
  /** The swing does not repeat with the music. */
  irregular: boolean;
  pattern: SelfSimilarity | null;
  /** For a Supporting or Background part: share of windows its level rises ahead of the stem it should sit under. Null for Primary and Focal. */
  aheadShare: number | null;
  aheadOf: string | null;
  problem: boolean;
  severity: number;
  playingFrames: number;
}

/** Single drums: their sustained level is not what a compressor is for here; attack/body is the transient planner's. */
const SINGLE_DRUMS = new Set(["kick", "snare-clap", "hi-hat", "percussion"]);

/**
 * Where a Supporting or Background stem's sustained level comes within its tier's margin of the loudest Primary or
 * Focal stem playing at the same moment. Null when the stem leads, or nothing leads it.
 */
function aheadOfHierarchy(ctx: Context, env: EnvelopeTrack, scope: AnalysisScope, start: number, end: number): { share: number; leader: string } | null {
  const tier = tierOf(ctx, env.track, scope).tier;
  if (tier === "primary" || tier === "focal") return null;
  const margin = tier === "background" ? 9 : 2.5;
  const own = sustainedLevels(ctx.heard.get(env.track.id)!.rms, env.rms, env.loudestCellDb, start, end);
  const leaders = [...ctx.model.tracks.values()].filter((other) => other !== env && ["primary", "focal"].includes(tierOf(ctx, other.track, scope).tier));
  if (leaders.length === 0 || own.levels.length === 0) return null;
  const leaderLevels = leaders.map((other) => {
    const levels = sustainedLevels(ctx.heard.get(other.track.id)!.rms, other.rms, other.loudestCellDb, start, end);
    return { name: other.track.name, at: new Map(levels.starts.map((at, index) => [at, levels.levels[index]!])) };
  });
  let ahead = 0;
  let counted = 0;
  const hits = new Map<string, number>();
  own.starts.forEach((at, index) => {
    let reference = -Infinity;
    let leader = "";
    for (const item of leaderLevels) {
      const level = item.at.get(at);
      if (level !== undefined && level > reference) {
        reference = level;
        leader = item.name;
      }
    }
    if (!Number.isFinite(reference)) return;
    counted += 1;
    if (own.levels[index]! > reference - margin) {
      ahead += 1;
      hits.set(leader, (hits.get(leader) ?? 0) + 1);
    }
  });
  if (counted === 0) return null;
  const leader = [...hits.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? leaderLevels[0]!.name;
  return { share: ahead / counted, leader };
}

function planLevel(ctx: Context, env: EnvelopeTrack): void {
  const heard = ctx.heard.get(env.track.id)!;
  const role = env.track.role;
  if (SINGLE_DRUMS.has(role)) return;
  const allowance = ctx.limits.spreadAllowanceDb;
  const read = (scope: AnalysisScope): LevelScope => {
    const [start, end] = framesOf(ctx, scope);
    const words = wordsIn(ctx, env.track.id, scope.key === "song" ? null : scope).words;
    let threshold = (SPREAD_THRESHOLD_DB[role] ?? 7) + allowance;
    if (words.has("control")) threshold -= 1.5;
    if (words.has("natural")) threshold += 3;
    const reading = spreadOf(sustainedLevels(heard.rms, env.rms, env.loudestCellDb, start, end), SWING_DB);
    // Asked for control, phrase-like movement counts too: half the usual share of swings is enough.
    const minSwing = words.has("control") ? MIN_SWING_RATE / 2 : MIN_SWING_RATE;
    const swings = reading.windows >= MIN_WINDOWS && reading.spreadDb >= threshold && reading.swingRate >= minSwing;
    // Self-similarity only for stems that swing: it is the expensive test.
    const pattern = swings ? selfSimilarity(heard.rms, env.rms, env.loudestCellDb, start, end) : null;
    const irregular = pattern !== null && pattern.ratio >= MIN_IRREGULARITY;
    const unstable = swings && irregular;
    const ahead = unstable ? aheadOfHierarchy(ctx, env, scope, start, end) : null;
    const problem = unstable && (ahead === null || ahead.share >= MIN_AHEAD_SHARE);
    const severity = problem ? clamp((reading.spreadDb - threshold) / 4 + 0.45, 0, 1) * clamp(reading.swingRate / 0.4, 0.6, 1) : 0;
    return { scope, reading, threshold, minSwing, irregular, pattern, aheadShare: ahead?.share ?? null, aheadOf: ahead?.leader ?? null, problem, severity, playingFrames: reading.windows * 40 };
  };
  const song = read(ctx.scopes[0]!);
  const parts = ctx.partition.length > 1 || ctx.partition[0]!.key !== "song" ? ctx.partition.map(read) : [song];
  for (const part of parts) {
    if (part.reading.windows < MIN_WINDOWS) continue;
    ctx.readings.push({
      trackId: env.track.id,
      scope: toScope(part.scope),
      scopeName: part.scope.name,
      spreadDb: round2(part.reading.spreadDb),
      swingRate: round3(part.reading.swingRate),
      transientDb: null,
      attackOverMixDb: null,
      onsetsPerSecond: 0,
      classification: part.problem ? "level-inconsistency" : part.reading.spreadDb >= part.threshold ? "phrased" : "steady",
      explanation: part.problem
        ? `Sustained level swings ${part.reading.spreadDb.toFixed(1)} dB, ${Math.round(part.reading.swingRate * 100)}% of neighbouring windows jumping more than ${SWING_DB} dB, without a repeating pattern.`
        : part.reading.spreadDb < part.threshold
          ? `Sustained level holds within ${part.reading.spreadDb.toFixed(1)} dB.`
          : part.reading.swingRate < part.minSwing || part.pattern === null
            ? `Sustained level spreads ${part.reading.spreadDb.toFixed(1)} dB but moves like phrasing (${Math.round(part.reading.swingRate * 100)}% of neighbouring windows jump), so it is left dynamic.`
          : !part.irregular
            ? `Sustained level spreads ${part.reading.spreadDb.toFixed(1)} dB, but the level repeats itself every ${(part.pattern?.lagSeconds ?? 0).toFixed(2)} s (it differs from itself there only ${Math.round((part.pattern?.ratio ?? 0) * 100)}% as much as at other spacings): a pattern in the arrangement, left as it is.`
            : part.aheadShare !== null && part.aheadShare < MIN_AHEAD_SHARE
              ? `Sustained level swings ${part.reading.spreadDb.toFixed(1)} dB but stays under ${part.aheadOf ?? "the lead"} even at its loudest, so the hierarchy holds.`
              : `Sustained level spreads ${part.reading.spreadDb.toFixed(1)} dB but moves like phrasing (${Math.round(part.reading.swingRate * 100)}% swings), so it is left dynamic.`,
    });
  }
  const savedGlobal = trackDynamicsNodes(ctx.document, env.track.id).find((node): node is CompressorNode => node.type === "compressor" && node.enabled) ?? null;
  const covered = parts.filter((part) => part.problem).reduce((total, part) => total + part.playingFrames, 0);
  const total = parts.reduce((sum, part) => sum + part.playingFrames, 0);
  const problemNames = parts.filter((part) => part.problem).map((part) => part.scope.name);
  // Global is preferred: an unstable stem across most of its playing time gets one compressor for the song.
  if (song.problem && (parts.length === 1 || covered >= (2 / 3) * total)) {
    proposeCompressor(ctx, env, ctx.scopes[0]!, song, savedGlobal, parts.length === 1 ? null : problemNames);
    return;
  }
  // A section compressor needs strong evidence in that section and calm elsewhere (clearly under the threshold).
  const calm = parts.filter((part) => !part.problem && part.reading.windows >= MIN_WINDOWS && part.reading.spreadDb <= part.threshold - 1);
  const strong = parts
    .filter((part) => part.problem && part.scope.marked && part.severity >= 0.5 && part.reading.windows >= 15 && part.reading.spreadDb >= part.threshold + 1)
    .sort((left, right) => right.severity - left.severity);
  if (strong.length === 0 || calm.length === 0) {
    // Uneven across the song with no section clearly calm: one compressor for the song, not a patchwork.
    if (song.problem) proposeCompressor(ctx, env, ctx.scopes[0]!, song, savedGlobal, problemNames);
    return;
  }
  if (savedGlobal) {
    ctx.notes.push(`${env.track.name} swings in ${strong[0]!.scope.name} only, but a saved compressor already runs on it for the whole song. Adjust that compressor rather than stacking another.`);
    return;
  }
  for (const part of strong.slice(0, 2)) {
    const savedSection = sectionDynamicsNodes(ctx.document, env.track.id, part.scope.sectionId!).find((node): node is CompressorNode => node.type === "compressor" && node.enabled) ?? null;
    proposeCompressor(ctx, env, part.scope, part, savedSection, null, calm);
  }
}

/** Attack by role: let a note's start through on sustained parts, catch voices a little sooner. */
function compressorAttack(role: string, natural: boolean): number {
  const base = LEAD_ROLES.has(role) || role === "backing-vocal" ? 15 : PERCUSSIVE.has(role) ? 25 : role === "atmosphere" || role === "fx" ? 40 : 30;
  return natural ? base + 10 : base;
}

function proposeCompressor(ctx: Context, env: EnvelopeTrack, scope: AnalysisScope, level: LevelScope, saved: CompressorNode | null, problemScopes: string[] | null, calm: LevelScope[] = []): void {
  const heard = ctx.heard.get(env.track.id)!;
  const [start, end] = framesOf(ctx, scope);
  const words = wordsIn(ctx, env.track.id, scope.key === "song" ? null : scope).words;
  const natural = words.has("natural");
  // The detector excludes the compressor being replaced: rebuild it without that node's reduction.
  const detector = heard.detector.subarray(start, end);
  const savedReduction = saved ? simulateCompressor(heard.detector, saved, start, end) : null;
  const otherReduction = new Float32Array(end - start);
  if (heard.saved) for (let frame = start; frame < end; frame += 1) otherReduction[frame - start] = heard.saved[frame]! - (savedReduction ? savedReduction[frame - start]! : 0);
  // Ducks and other stages after the compressor do not change what it hears, so the detector is the EQ'd stem.
  const offsets = env.segments
    .filter((segment) => segment.end > start && segment.start < end)
    .map((segment) => ({ start: Math.max(0, segment.start - start), end: Math.min(end, segment.end) - start, db: round2(segment.gainDb) }))
    .slice(0, 64);
  const evidence: DynamicsEvidence = {
    detail: {
      kind: "level",
      start,
      end,
      detector: encodeEnvelopeSeries(detector),
      peak: encodeEnvelopeSeries(heard.peak.subarray(start, end).map((value, at) => value - (heard.saved ? heard.saved[start + at]! : 0) + (savedReduction ? savedReduction[at]! : 0) - segmentAt(env, start + at).gainDb)),
      reference: encodeEnvelopeSeries(env.rms.subarray(start, end)),
      loudestCellDb: round2(env.loudestCellDb),
      offsets,
      existing: saved ? { type: "compressor", thresholdDb: saved.thresholdDb, ratio: saved.ratio, attackMs: saved.attackMs, releaseMs: saved.releaseMs, kneeDb: saved.kneeDb, makeupDb: saved.makeupDb } : null,
    },
    windows: windowsOf(start, end, (frame) => env.rms[frame]! > env.loudestCellDb - 30 && env.rms[frame]! > -60),
    band: null,
  };
  // Release from the note rate: recover by about half the time between notes, 60–300 ms.
  const onsets = onsetsOf(env.peak, start, end);
  const intervals = onsets.slice(1).map((onset, index) => (onset - onsets[index]!) * HOP_SECONDS * 1_000);
  const release = intervals.length >= 8 ? clamp(Math.round((0.5 * percentile(intervals, 0.5)) / 10) * 10, 60, 300) : 200;
  const attack = compressorAttack(env.track.role, natural);
  const maxRatio = natural ? Math.min(2, ctx.limits.maxRatio) : ctx.limits.maxRatio;
  const target = { min: ctx.limits.grTarget.min, max: natural ? Math.max(ctx.limits.grTarget.min, ctx.limits.grTarget.max - 1) : ctx.limits.grTarget.max };
  // Thresholds from the detector's own sustained levels: between its median and its loud passages.
  const detectorLevels = sustainedLevels(heard.detector, env.rms, env.loudestCellDb, start, end).levels;
  const p50 = percentile(detectorLevels, 0.5);
  const p90 = percentile(detectorLevels, 0.9);
  let best: { processing: CompressorProcessing; evaluation: ReturnType<typeof evaluateDynamics>; score: number } | null = null;
  const consider = (ratio: number, thresholdDb: number, releaseMs: number) => {
    const processing = normalizeProcessing({ type: "compressor", thresholdDb, ratio, attackMs: attack, releaseMs, kneeDb: 6, makeupDb: 0 }) as CompressorProcessing;
    const evaluation = evaluateDynamics(evidence, processing, toScope(scope));
    const before = evaluation.spreadBeforeDb ?? 0;
    const after = evaluation.spreadAfterDb ?? before;
    const removed = before - after;
    if (removed < 1) return;
    if (evaluation.reductionP95Db < target.min * 0.6 || evaluation.reductionP95Db > target.max) return;
    // Do not flatten the stem: its crest may fall a little, not collapse.
    if ((evaluation.crestBeforeDb ?? 0) - (evaluation.crestAfterDb ?? 0) > 3) return;
    const mid = (target.min + target.max) / 2;
    const cost = 0.04 * (ratio - 1) + 0.02 * evaluation.reductionP95Db + 0.05 * Math.abs(evaluation.reductionP95Db - mid) + 0.03 * Math.max(0, -evaluation.levelChangeDb - 2);
    const score = removed / Math.max(1, before) - cost;
    if (!best || score > best.score + 1e-9) best = { processing, evaluation, score };
  };
  const ratios = [1.5, 2, 2.5, 3, 4].filter((ratio) => ratio <= maxRatio + 1e-9);
  for (const ratio of ratios) for (let thresholdDb = Math.round(p50 - 6); thresholdDb <= Math.round(p90); thresholdDb += 1) consider(ratio, thresholdDb, release);
  // Adjust once: if the best still overshoots its target, try a gentler knee point at the same ratio.
  const found = best as { processing: CompressorProcessing; evaluation: ReturnType<typeof evaluateDynamics>; score: number } | null;
  if (!found) {
    ctx.notes.push(`${env.track.name} swings ${level.reading.spreadDb.toFixed(1)} dB in ${scopeName(scope)}, but no compression within ${target.min}–${target.max} dB of reduction narrowed it by 1 dB or more, so it was left alone.`);
    return;
  }
  const { processing, evaluation } = found;
  const removed = (evaluation.spreadBeforeDb ?? 0) - (evaluation.spreadAfterDb ?? 0);
  const benefit = level.severity * clamp(removed / Math.max(1, evaluation.spreadBeforeDb ?? 1), 0, 1) * tierWeight(tierOf(ctx, env.track, scope).tier) * 2;
  const cost = PROCESSOR_COST.compressor + (scope.key === "song" ? 0 : SECTION_COST);
  if (benefit < cost) {
    ctx.notes.push(`${env.track.name}: compression would narrow its ${level.reading.spreadDb.toFixed(1)} dB swing by only ${removed.toFixed(1)} dB, not worth a processor.`);
    return;
  }
  let confidence = 0.5 + 0.1 * Number(env.track.role !== "other") + (level.reading.windows >= 30 ? 0.08 : 0.03) + 0.12 * clamp(level.reading.swingRate / 0.5, 0, 1) + 0.1 * clamp(removed / 3, 0, 1);
  if (words.has("control")) confidence += 0.05;
  if (scope.key !== "song") confidence -= 0.05;
  if (saved && Math.abs(saved.ratio - processing.ratio) < 0.3 && Math.abs(saved.thresholdDb - processing.thresholdDb) < 1.5) {
    ctx.notes.push(`${env.track.name}'s saved compressor is already close to what the planner would set.`);
    return;
  }
  const name = env.track.name;
  const where = scope.key === "song" ? (problemScopes && problemScopes.length > 0 ? `through ${problemScopes.slice(0, 3).join(", ")}` : "through the song") : `in the ${scope.name}`;
  ctx.rows.push({
    trackId: env.track.id,
    scope: toScope(scope),
    problem: "level-inconsistency",
    processing,
    replacesNodeId: saved?.id ?? null,
    targetReductionDb: target,
    relatedTrackIds: [],
    interactionIds: [],
    confidence: clamp(round2(confidence), 0.2, 0.95),
    forceReview: null,
    evidence,
    evaluation,
    pass: 1,
    benefit,
    explain: (result) => {
      const reasons = [
        `${saved ? "Adjusts the saved compressor on" : "Compresses"} ${name} because its sustained level swings ${(result.spreadBeforeDb ?? 0).toFixed(1)} dB ${where} (90th to 10th percentile of 400 ms windows), with ${Math.round(level.reading.swingRate * 100)}% of neighbouring windows jumping more than ${SWING_DB} dB. A ${processing.ratio.toFixed(1)}:1 ratio at ${formatSignedDb(processing.thresholdDb)} dB gives about ${result.reductionP95Db.toFixed(1)} dB of reduction on the loudest sustained passages (target ${target.min}–${target.max} dB) and narrows the swing to ${(result.spreadAfterDb ?? 0).toFixed(1)} dB.`,
        `Attack ${processing.attackMs} ms lets each note's start through; release ${processing.releaseMs} ms ${intervals.length >= 8 ? "is about half the time between notes, so it recovers before the next" : "suits a sustained part"}. Makeup is 0 dB: the stem gets ${formatSignedDb(result.levelChangeDb)} dB quieter on average and the A/B is level-matched, so it does not win by being louder.`,
      ];
      if (calm.length > 0) reasons.push(`Only in the ${scope.name}: elsewhere it holds within ${Math.max(...calm.map((part) => part.reading.spreadDb)).toFixed(1)} dB.`);
      if (level.aheadShare !== null && level.aheadOf) reasons.push(`At its loudest it rises ahead of ${level.aheadOf} in ${Math.round(level.aheadShare * 100)}% of the windows, which is where the swing disturbs the hierarchy.`);
      reasons.push(`The swing does not repeat with the music (even at its best-matching spacing the level differs from itself ${Math.round((level.pattern?.ratio ?? 1) * 100)}% as much as at any other), so it reads as uneven level rather than a pattern.`);
      if (natural) reasons.push(`The note asks for a natural sound, so the ratio stays at or under ${maxRatio}:1 and the reduction lighter.`);
      if ((result.crestBeforeDb ?? 0) - (result.crestAfterDb ?? 0) > 0.5) reasons.push(`Its peak-to-average falls ${((result.crestBeforeDb ?? 0) - (result.crestAfterDb ?? 0)).toFixed(1)} dB; transients stay.`);
      return reasons;
    },
  });
}

function tierWeight(tier: Tier): number {
  return tier === "primary" || tier === "focal" ? 1 : tier === "supporting" ? 0.85 : tier === "background" ? 0.6 : 0.7;
}

/* ------------------------------------------------------------------ transients */

interface OnsetReading {
  frame: number;
  attackDb: number;
  bodyDb: number;
  riseDb: number;
  mixDb: number;
}

function onsetReadings(ctx: Context, env: EnvelopeTrack, start: number, end: number): OnsetReading[] {
  const heard = ctx.heard.get(env.track.id)!;
  const others = [...ctx.heard.values()].filter((item) => item.env.track.id !== env.track.id);
  const out: OnsetReading[] = [];
  for (const onset of onsetsOf(env.peak, start, end)) {
    const ratio = transientRatioDb(heard.rms, onset);
    if (ratio === null) continue;
    let mix = 0;
    for (const other of others) mix += 10 ** (meanDb(other.rms, onset, 2) / 10);
    out.push({
      frame: onset,
      attackDb: meanDb(heard.rms, onset, 2),
      bodyDb: meanDb(heard.rms, onset + 4, 10),
      riseDb: env.peak[onset]! - Math.min(env.peak[onset - 1]!, env.peak[onset - 2]!, env.peak[onset - 3]!),
      mixDb: Math.max(-100, 10 * Math.log10(Math.max(mix, 1e-20))),
    });
  }
  return out;
}

function planTransient(ctx: Context, env: EnvelopeTrack): void {
  const role = env.track.role;
  if (ctx.rows.some((row) => row.trackId === env.track.id && row.processing.type === "compressor")) return;
  const scope = ctx.scopes[0]!;
  const [start, end] = framesOf(ctx, scope);
  const onsets = onsetReadings(ctx, env, start, end);
  const seconds = Math.max(1, (end - start) * HOP_SECONDS);
  const rate = onsets.length / seconds;
  if (onsets.length < 8 || !PERCUSSIVE.has(role)) return;
  const ratio = percentile(onsets.map((onset) => onset.attackDb - onset.bodyDb), 0.5);
  // Against the rest of the mix only where there is a rest of the mix.
  const mixed = onsets.filter((onset) => onset.mixDb > -90);
  const hasMix = mixed.length >= onsets.length / 2;
  const overMix = hasMix ? percentile(mixed.map((onset) => onset.attackDb - onset.mixDb), 0.5) : 0;
  const words = wordsIn(ctx, env.track.id, null).words;
  const tiers = ctx.partition.map((part) => tierOf(ctx, env.track, part));
  const focal = tiers.some((tier) => tier.tier === "focal");
  const lowTier = tiers.every((tier) => TIER_RANK[tier.tier] <= TIER_RANK.supporting);
  const soften = words.has("soften");
  const punch = words.has("punch");
  // Excess: a supporting part whose attacks poke out of the whole mix, or a stem asked to be softer.
  // A Primary drum qualifies only when its attacks are very spiky and stand far out; a Focal one never does by measurement alone.
  const primary = !focal && tiers.some((tier) => tier.tier === "primary");
  const excess = hasMix && ((lowTier && overMix >= 3 && ratio >= 12) || (primary && overMix >= 6 && ratio >= 14) || (soften && overMix >= 0 && ratio >= 10));
  // Weakness: a focal drum (or one asked for punch) whose attack is soft and buried under the mix.
  const weak = hasMix && (focal || punch) && ratio <= (punch ? 10 : 8) && overMix <= -2;
  let classification: DynamicsReading["classification"] = "steady";
  if (excess) classification = "transient-excess";
  else if (weak) classification = "transient-weakness";
  ctx.readings.push({
    trackId: env.track.id,
    scope: { type: "global" },
    scopeName: "Whole song",
    spreadDb: null,
    swingRate: null,
    transientDb: round2(ratio),
    attackOverMixDb: hasMix ? round2(overMix) : null,
    onsetsPerSecond: round2(rate),
    classification,
    explanation: `Attacks ${ratio.toFixed(1)} dB over their body${hasMix ? ` and ${formatSignedDb(overMix)} dB against the rest of the mix` : ""}, ${rate.toFixed(1)} hits a second.`,
  });
  if (!excess && !weak) return;
  const saved = trackDynamicsNodes(ctx.document, env.track.id).find((node) => node.type === "transient" && node.enabled) ?? null;
  const amount = excess
    ? -clamp(roundTo(0.05 + Math.max(0, overMix - 3) * 0.02 + Math.max(0, ratio - 12) * 0.01, 0.05), 0.05, Math.min(ctx.limits.maxTransient, 0.15))
    : clamp(roundTo(0.05 + Math.max(0, 8 - ratio) * 0.02 + Math.max(0, -overMix - 2) * 0.01, 0.05), 0.05, Math.min(ctx.limits.maxTransient, 0.2));
  const processing = normalizeProcessing({ type: "transient", attack: amount, sustain: 0 }) as TransientProcessing;
  const heard = ctx.heard.get(env.track.id)!;
  let playing = 0;
  let power = 0;
  for (let frame = start; frame < end; frame += 1) {
    if (heard.rms[frame]! <= -70) continue;
    playing += 1;
    power += 10 ** (heard.rms[frame]! / 10);
  }
  const evidence: DynamicsEvidence = {
    detail: {
      kind: "transient",
      onsets: onsets.slice(0, 4_000).map((onset) => ({ frame: onset.frame, attackDb: round2(onset.attackDb), bodyDb: round2(onset.bodyDb), riseDb: round2(onset.riseDb), mixDb: round2(onset.mixDb) })),
      levelDb: round2(10 * Math.log10(Math.max(power / Math.max(1, playing), 1e-20))),
      frames: playing,
      existing: saved && saved.type === "transient" ? { type: "transient", attack: saved.attack, sustain: saved.sustain } : null,
    },
    windows: windowsOf(start, end, (frame) => env.rms[frame]! > env.loudestCellDb - 30 && env.rms[frame]! > -60),
    band: null,
  };
  const evaluation = evaluateDynamics(evidence, processing, { type: "global" });
  const moved = Math.abs((evaluation.transientAfterDb ?? 0) - (evaluation.transientBeforeDb ?? 0));
  if (moved < 0.5) {
    ctx.notes.push(`${env.track.name}'s attacks read ${excess ? "sharp" : "soft"}, but a small transient change would move them by under 0.5 dB, so nothing was changed.`);
    return;
  }
  const severity = excess ? clamp((overMix - 3) / 6 + 0.45, 0, 1) : clamp((8 - ratio) / 6 + 0.45, 0, 1);
  const benefit = severity * clamp(moved / 2, 0, 1) * 1.5;
  if (benefit < PROCESSOR_COST.transient) return;
  let confidence = 0.52 + 0.1 * Number(role !== "other") + (onsets.length >= 20 ? 0.08 : 0.03) + 0.1 * clamp(moved / 2, 0, 1);
  if (soften || punch) confidence += 0.05;
  if (focal) confidence += 0.04;
  const name = env.track.name;
  const tierWord = focal ? "Focal" : lowTier ? "Supporting" : "Primary";
  ctx.rows.push({
    trackId: env.track.id,
    scope: { type: "global" },
    problem: excess ? "transient-excess" : "transient-weakness",
    processing,
    replacesNodeId: saved?.id ?? null,
    targetReductionDb: null,
    relatedTrackIds: [],
    interactionIds: [],
    confidence: clamp(round2(confidence), 0.2, 0.9),
    forceReview: null,
    evidence,
    evaluation,
    pass: 1,
    benefit,
    explain: (result) => [
      excess
        ? `Lowers ${name}'s attack by ${Math.round(-processing.attack * 100)}% because its hits peak ${formatSignedDb(result.attackOverMixBeforeDb ?? overMix)} dB against the rest of the mix while it is a ${primary ? "Primary" : tierWord} part${soften ? " and the note asks for it softer" : ""}, with attacks ${(result.transientBeforeDb ?? ratio).toFixed(1)} dB over their body. The change takes about ${result.reductionP50Db.toFixed(1)} dB off each attack, to ${(result.transientAfterDb ?? 0).toFixed(1)} dB over the body.`
        : `Raises ${name}'s attack by ${Math.round(processing.attack * 100)}% because it is ${focal ? "Focal" : "asked to punch"} but its attacks sit only ${(result.transientBeforeDb ?? ratio).toFixed(1)} dB over their body and ${formatSignedDb(result.attackOverMixBeforeDb ?? overMix)} dB under the rest of the mix. The change adds about ${result.reductionP50Db.toFixed(1)} dB to each attack.`,
      `Transient shaping changes the attack against the body; the stem's level otherwise stays (${formatSignedDb(result.levelChangeDb)} dB on average). It is not compression: ${name}'s sustained level is not the problem.`,
    ],
  });
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/* ------------------------------------------------------------------ kick / bass collision */

interface CollisionScope {
  scope: AnalysisScope;
  onsets: number[];
  hits: number;
  share: number;
  meanGap: number;
}

function planCollisions(ctx: Context): void {
  const tracks = [...ctx.model.tracks.values()];
  const kicks = tracks.filter((env) => env.track.role === "kick");
  const pairs: Array<{ key: EnvelopeTrack; target: EnvelopeTrack; requested: { pump: boolean; text: string } | null }> = [];
  for (const kick of kicks) for (const target of tracks) if (target !== kick && isLowEnd(target)) pairs.push({ key: kick, target, requested: null });
  for (const instruction of ctx.intents.pairs) {
    const key = ctx.model.tracks.get(instruction.keyTrackId);
    const target = ctx.model.tracks.get(instruction.targetTrackId);
    if (!key || !target || !PERCUSSIVE.has(key.track.role)) continue;
    const existing = pairs.find((pair) => pair.key === key && pair.target === target);
    if (existing) existing.requested = { pump: instruction.pump, text: instruction.text };
    else pairs.push({ key, target, requested: { pump: instruction.pump, text: instruction.text } });
  }
  for (const pair of pairs) planCollision(ctx, pair.key, pair.target, pair.requested);
}

function isLowEnd(env: EnvelopeTrack): boolean {
  if (LOW_END_ROLES.has(env.track.role)) return true;
  if (env.track.role !== "synth" && env.track.role !== "keys") return false;
  // A synth or keys part that lives in the low end: its low band within 3 dB of its whole level where it plays.
  let low = 0;
  let all = 0;
  for (let frame = 0; frame < env.frames; frame += 1) {
    if (env.rms[frame]! < env.loudestCellDb - 30) continue;
    low += 10 ** (env.low[frame]! / 10);
    all += 10 ** (env.rms[frame]! / 10);
  }
  return all > 0 && 10 * Math.log10(Math.max(low, 1e-20) / all) >= -3;
}

function collisionIn(ctx: Context, key: EnvelopeTrack, target: EnvelopeTrack, scope: AnalysisScope): CollisionScope {
  const [start, end] = framesOf(ctx, scope);
  const keyHeard = ctx.heard.get(key.track.id)!;
  const targetHeard = ctx.heard.get(target.track.id)!;
  // The target's own playing low level: a hit only counts where the bass is actually playing, not resting.
  const lows: number[] = [];
  for (let frame = start; frame < end; frame += 1) if (target.rms[frame]! > target.loudestCellDb - 30) lows.push(targetHeard.low[frame]!);
  const playingLow = percentile(lows, 0.5);
  const onsets = onsetsOf(key.peak, start, end).filter((onset) => onset + 8 <= end && meanDb(targetHeard.low, onset, 8) >= playingLow - 18);
  const gaps = onsets.map((onset) => meanDb(targetHeard.low, onset, 8) - meanDb(keyHeard.low, onset, 8));
  return {
    scope,
    onsets,
    hits: onsets.length,
    share: gaps.length > 0 ? gaps.filter((gap) => gap >= -3).length / gaps.length : 0,
    meanGap: gaps.length > 0 ? gaps.reduce((total, gap) => total + gap, 0) / gaps.length : -60,
  };
}

function planCollision(ctx: Context, key: EnvelopeTrack, target: EnvelopeTrack, requested: { pump: boolean; text: string } | null): void {
  const song = collisionIn(ctx, key, target, ctx.scopes[0]!);
  const parts = ctx.partition.length > 1 || ctx.partition[0]!.key !== "song" ? ctx.partition.map((scope) => collisionIn(ctx, key, target, scope)) : [song];
  const minShare = requested ? MIN_COLLISION_SHARE - 0.1 : MIN_COLLISION_SHARE;
  const interaction = (scope: AnalysisScope, reading: CollisionScope, outcome: DynamicsInteraction["outcome"], explanation: string, tool: DynamicsInteraction["recommendedTool"]) => {
    const id = `${scope.key}::${key.track.id}::${target.track.id}::low`;
    const allOnsets = onsetsOf(key.peak, ...framesOf(ctx, scope)).length;
    ctx.interactions.push({
      id,
      scope: toScope(scope),
      scopeName: scope.name,
      trackA: key.track.id,
      trackB: target.track.id,
      kind: "low-end",
      onsetOverlap: round3(allOnsets > 0 ? reading.hits / allOnsets : 0),
      lowBandCompetition: round3(reading.share),
      levelMasking: 0,
      freeShare: 0,
      recommendedTool: tool,
      confidence: round2(clamp(0.5 + 0.3 * reading.share + (reading.hits >= 30 ? 0.1 : 0), 0.2, 0.95)),
      outcome,
      explanation: explanation.slice(0, 600),
    });
    return id;
  };
  const keyName = key.track.name;
  const targetName = target.track.name;
  if (song.hits < 8) {
    interaction(ctx.scopes[0]!, song, "below-threshold", `${keyName} and ${targetName} rarely play together on ${keyName}'s hits (${song.hits} hits), so there is nothing to duck.`, "none");
    return;
  }
  if (song.share < 0.2 && parts.every((part) => part.share < minShare)) {
    interaction(
      ctx.scopes[0]!,
      song,
      "already-separated",
      `${keyName} and ${targetName} already coexist: on ${keyName}'s hits ${targetName}'s low end sits ${(-song.meanGap).toFixed(1)} dB under it on average and collides on only ${Math.round(song.share * 100)}% of hits. No duck.`,
      "none",
    );
    if (requested) ctx.notes.push(`"${requested.text}": ${keyName} already sits ${(-song.meanGap).toFixed(1)} dB over ${targetName} on its hits, so no duck was added.`);
    return;
  }
  const colliding = parts.filter((part) => part.hits >= 8 && part.share >= minShare && part.meanGap >= -4);
  const hitsTotal = parts.reduce((total, part) => total + part.hits, 0);
  const hitsColliding = colliding.reduce((total, part) => total + part.hits, 0);
  // A section duck: that section collides past the threshold and the rest of the song clearly does not.
  const quiet = parts.filter((part) => !colliding.includes(part) && part.hits >= 8 && part.share < 0.75 * minShare);
  let chosen: Array<{ scope: AnalysisScope; reading: CollisionScope }> = [];
  if (song.share >= minShare && song.meanGap >= -4 && (parts.length === 1 || hitsColliding >= (2 / 3) * hitsTotal)) chosen = [{ scope: ctx.scopes[0]!, reading: song }];
  else if (quiet.length > 0) chosen = colliding.filter((part) => part.scope.marked && part.share >= minShare + 0.05).slice(0, 2).map((part) => ({ scope: part.scope, reading: part }));
  else if (song.share >= minShare && song.meanGap >= -4) chosen = [{ scope: ctx.scopes[0]!, reading: song }];
  if (chosen.length === 0) {
    interaction(ctx.scopes[0]!, song, "below-threshold", `${targetName}'s low end meets ${keyName} on ${Math.round(song.share * 100)}% of hits, under the ${Math.round(minShare * 100)}% that calls for a duck.`, "none");
    return;
  }
  for (const { scope, reading } of chosen) proposeDuck(ctx, key, target, scope, reading, requested, interaction(scope, reading, "recommendation", `${targetName}'s low end collides with ${keyName} on ${Math.round(reading.share * 100)}% of hits in ${scopeName(scope)}, ${formatSignedDb(reading.meanGap)} dB against it on average.`, "ducking"));
}

function proposeDuck(ctx: Context, key: EnvelopeTrack, target: EnvelopeTrack, scope: AnalysisScope, reading: CollisionScope, requested: { pump: boolean; text: string } | null, interactionId: string): void {
  const [start, end] = framesOf(ctx, scope);
  const keyRaw = ctx.raw.get(key.track.id)!;
  const keyHeard = ctx.heard.get(key.track.id)!;
  const targetHeard = ctx.heard.get(target.track.id)!;
  const savedNodes = scope.sectionId ? sectionDynamicsNodes(ctx.document, target.track.id, scope.sectionId) : trackDynamicsNodes(ctx.document, target.track.id);
  const saved = savedNodes.find((node): node is DuckingNode => node.type === "ducking" && node.enabled && node.keyTrackId === key.track.id) ?? null;
  // The target as heard before this duck: take a saved duck from the same key back out.
  const savedReduction = saved ? simulateDucking(keyRaw.peak, keyRaw.rms, saved, start, end) : null;
  const without = (series: Float32Array) => series.subarray(start, end).map((value, at) => value + (savedReduction ? savedReduction[at]! : 0));
  const evidence: DynamicsEvidence = {
    detail: {
      kind: "collision",
      start,
      end,
      keyPeak: encodeEnvelopeSeries(keyRaw.peak.subarray(start, end)),
      keyRms: encodeEnvelopeSeries(keyRaw.rms.subarray(start, end)),
      keyLow: encodeEnvelopeSeries(keyHeard.low.subarray(start, end)),
      targetLow: encodeEnvelopeSeries(without(targetHeard.low)),
      targetRms: encodeEnvelopeSeries(without(targetHeard.rms)),
      onsets: reading.onsets.map((onset) => onset - start).slice(0, 4_000),
      existing: saved ? { type: "ducking", keyTrackId: saved.keyTrackId, keyDetector: saved.keyDetector, thresholdDb: saved.thresholdDb, rangeDb: saved.rangeDb, attackMs: saved.attackMs, releaseMs: saved.releaseMs } : null,
    },
    windows: windowsOf(start, end, (frame) => target.rms[frame]! > target.loudestCellDb - 30 && key.peak[frame]! > -60),
    band: [40, 150],
  };
  // Threshold from the kick's own hits (its raw source is the key): full depth within 4 dB of a typical hit.
  const peaks = reading.onsets.map((onset) => Math.max(keyRaw.peak[onset]!, keyRaw.peak[onset + 1] ?? -100));
  const thresholdDb = Math.round(percentile(peaks, 0.5) - 10);
  // Release: about the kick's own low-end decay, inside 60% of the time between hits so the bass is back in time.
  const decays = reading.onsets.map((onset) => {
    const top = meanDb(keyHeard.low, onset, 2);
    let frame = onset + 1;
    while (frame < Math.min(end, onset + 40) && keyHeard.low[frame]! > top - 10) frame += 1;
    return (frame - onset) * HOP_SECONDS * 1_000;
  });
  const intervals = reading.onsets.slice(1).map((onset, index) => (onset - reading.onsets[index]!) * HOP_SECONDS * 1_000).filter((value) => value < 2_000);
  const ceiling = intervals.length > 0 ? 0.6 * percentile(intervals, 0.5) : 180;
  const pump = requested?.pump ?? false;
  let releaseMs = clamp(Math.round((1.2 * percentile(decays, 0.5)) / 10) * 10, 80, 180);
  releaseMs = Math.max(60, Math.min(releaseMs, Math.round(ceiling / 10) * 10));
  if (pump) releaseMs = clamp(Math.round(releaseMs * 1.5), 100, 400);
  // Depth: enough to bring the bass about 3 dB under the kick on a typical hit, within the strength's cap.
  const cap = pump ? Math.min(ctx.limits.maxDuckDb + 1.5, 5) : ctx.limits.maxDuckDb;
  const needed = Math.max(...[percentile(reading.onsets.map((onset) => meanDb(targetHeard.low, onset, 8) - meanDb(keyHeard.low, onset, 8)), 0.5) + 3, 1]);
  let depth = clamp(Math.round(needed * 2) / 2, 1, cap);
  const build = (rangeDb: number, release: number) => normalizeProcessing({ type: "ducking", keyTrackId: key.track.id, keyDetector: "transient", thresholdDb, rangeDb: -rangeDb, attackMs: 5, releaseMs: release }) as DuckingProcessing;
  let processing = build(depth, releaseMs);
  let evaluation = evaluateDynamics(evidence, processing, toScope(scope));
  // Adjust once: release shorter if the bass stays down between hits; depth smaller if it costs too much level.
  if ((evaluation.recovery ?? 1) < 0.6 || (evaluation.outsideChangeDb ?? 0) < -0.6) {
    releaseMs = Math.max(60, Math.round((releaseMs * 0.7) / 10) * 10);
    processing = build(depth, releaseMs);
    evaluation = evaluateDynamics(evidence, processing, toScope(scope));
  }
  if (evaluation.levelChangeDb < -1.5) {
    depth = clamp(depth - 1, 1, cap);
    processing = build(depth, releaseMs);
    evaluation = evaluateDynamics(evidence, processing, toScope(scope));
  }
  const relief = (evaluation.collisionBefore ?? 0) - (evaluation.collisionAfter ?? 0);
  const gapRelief = (evaluation.conflictBeforeDb ?? 0) - (evaluation.conflictAfterDb ?? 0);
  if (relief < 0.15 && gapRelief < 1) {
    ctx.notes.push(`A duck from ${key.track.name} would barely change how ${target.track.name} meets it (${Math.round(relief * 100)}% fewer collisions), so none was added.`);
    return;
  }
  const benefit = clamp(reading.share, 0, 1) * clamp(gapRelief / 3, 0, 1) * 2;
  const cost = PROCESSOR_COST.ducking + (scope.key === "song" ? 0 : SECTION_COST) + 0.03 * depth;
  if (benefit < cost) return;
  let confidence = 0.52 + 0.15 * reading.share + (reading.hits >= 30 ? 0.08 : 0.03) + 0.1 * clamp(gapRelief / 3, 0, 1);
  if (requested) confidence += 0.05;
  if (scope.key !== "song") confidence -= 0.04;
  const keyName = key.track.name;
  const targetName = target.track.name;
  ctx.rows.push({
    trackId: target.track.id,
    scope: toScope(scope),
    problem: "low-end-collision",
    processing,
    replacesNodeId: saved?.id ?? null,
    targetReductionDb: null,
    relatedTrackIds: [key.track.id],
    interactionIds: [interactionId],
    confidence: clamp(round2(confidence), 0.2, 0.92),
    forceReview: pump && depth > 3 ? "An audible, pumping duck was asked for; it waits for a listen." : null,
    evidence,
    evaluation,
    pass: 2,
    benefit,
    explain: (result) => [
      `Ducks ${targetName} by up to ${(-processing.rangeDb).toFixed(1)} dB from the ${keyName} because their low end (under 150 Hz) overlaps around each ${keyName} hit${scope.key === "song" ? "" : ` in the ${scope.name}`}: on ${Math.round((result.collisionBefore ?? 0) * 100)}% of the hits ${targetName} sits within 3 dB of the ${keyName} or over it (${formatSignedDb(result.conflictBeforeDb ?? 0)} dB on average). With the duck it sits ${formatSignedDb(result.conflictAfterDb ?? 0)} dB against the ${keyName} on those hits${(result.collisionAfter ?? 0) < (result.collisionBefore ?? 0) - 0.05 ? `, and ${Math.round((result.collisionAfter ?? 0) * 100)}% of hits still collide` : ""}.`,
      `Attack ${processing.attackMs} ms catches the hit; release ${processing.releaseMs} ms returns ${targetName} within about ${Math.round(processing.releaseMs * 1.5)} ms, so it is back to full level ${Math.round((result.recovery ?? 1) * 100)}% of the time between hits. ${targetName}'s average level changes ${formatSignedDb(result.levelChangeDb)} dB.`,
      ...(requested ? [`The note "${requested.text}" asks for this${pump ? ", including an audible pump" : ""}; the measurements support it.`] : []),
      `The key is the ${keyName}'s own source, before its EQ and fader, so a fader move on the ${keyName} does not change when ${targetName} ducks.`,
    ],
  });
}

/* ------------------------------------------------------------------ event masking */

function planMasking(ctx: Context): void {
  const byPair = new Map<string, PairAnalysis[]>();
  for (const pair of ctx.analysis.pairs) {
    if (!pair.protectedId || !pair.yieldingId) continue;
    const protectedTrack = pair.protectedId === pair.a.track.id ? pair.a.track : pair.b.track;
    const yielding = pair.yieldingId === pair.a.track.id ? pair.a.track : pair.b.track;
    const protectedTier = pair.protectedId === pair.a.track.id ? pair.tierA : pair.tierB;
    // Leads, voices, and Focal melodic parts. Drum conflicts are EQ or kick/bass questions, not event masking.
    if (PERCUSSIVE.has(protectedTrack.role) || !(LEAD_ROLES.has(protectedTrack.role) || protectedTier === "focal")) continue;
    if (PERCUSSIVE.has(yielding.role) || LOW_END_ROLES.has(yielding.role)) continue;
    if (!SUPPORT_ROLES.has(yielding.role) && !(TIER_RANK[pair.yieldingId === pair.a.track.id ? pair.tierA : pair.tierB] <= TIER_RANK.supporting)) continue;
    if (!ctx.model.tracks.has(yielding.id)) continue;
    const key = `${protectedTrack.id}::${yielding.id}`;
    byPair.set(key, [...(byPair.get(key) ?? []), pair]);
  }
  for (const [key, pairs] of byPair) {
    const [protectedId, yieldingId] = key.split("::") as [string, string];
    planMaskingPair(ctx, protectedId, yieldingId, pairs);
  }
}

function planMaskingPair(ctx: Context, protectedId: string, yieldingId: string, pairs: PairAnalysis[]): void {
  const spectral = ctx.spectral;
  const protectedSpectra = spectral.tracks.get(protectedId);
  const yieldingSpectra = spectral.tracks.get(yieldingId);
  if (!protectedSpectra || !yieldingSpectra) return;
  const song = pairs.find((pair) => pair.scope.key === "song") ?? pairs[0]!;
  const direction = (pair: PairAnalysis) => (pair.protectedId === pair.a.track.id ? pair.bOnA : pair.aOnB);
  const protectedName = nameOf(ctx, protectedId);
  const yieldingName = nameOf(ctx, yieldingId);
  const requested = ctx.intents.pairs.find((item) => item.keyTrackId === protectedId && item.targetTrackId === yieldingId) ?? null;
  const minSeverity = requested ? ctx.limits.minSeverity - 0.08 : ctx.limits.minSeverity;
  // Free share: of the time the yielding part plays, how much the protected part is silent.
  const freeShareIn = (scope: AnalysisScope) => {
    const steps = stepsIn(spectral, scope.start, scope.end).filter((step) => yieldingSpectra.active[step] === 1);
    const free = steps.filter((step) => protectedSpectra.active[step] !== 1).length;
    return { steps, free: steps.length > 0 ? free / steps.length : 0 };
  };
  const report = (pair: PairAnalysis, outcome: DynamicsInteraction["outcome"], tool: DynamicsInteraction["recommendedTool"], explanation: string, freeShare: number) => {
    const id = `${pair.scope.key}::${protectedId}::${yieldingId}::mask`;
    ctx.interactions.push({
      id,
      scope: toScope(pair.scope),
      scopeName: pair.scope.name,
      trackA: protectedId,
      trackB: yieldingId,
      kind: tool === "static-eq" ? "sustained-masking" : "event-masking",
      onsetOverlap: round3(pair.simultaneity),
      lowBandCompetition: 0,
      levelMasking: round3(direction(pair).severity),
      freeShare: round3(freeShare),
      recommendedTool: tool,
      confidence: round2(pair.confidence),
      outcome,
      explanation: explanation.slice(0, 600),
    });
    return id;
  };
  const strongest = [...pairs].sort((left, right) => direction(right).severity - direction(left).severity)[0]!;
  const severity = direction(strongest).severity;
  if (severity < minSeverity) {
    const solved = ctx.document.tracks.find((track) => track.id === yieldingId)?.processing.nodes.some((node) => node.enabled) ?? false;
    report(strongest, solved ? "solved" : "below-threshold", "none", `${yieldingName} competes with ${protectedName} only lightly where they meet (severity ${severity.toFixed(2)})${solved ? "; its saved EQ already makes room" : ""}.`, freeShareIn(strongest.scope).free);
    return;
  }
  const wholeFree = freeShareIn(ctx.scopes[0]!);
  if (wholeFree.free < MIN_FREE_SHARE) {
    report(
      strongest,
      "static",
      "static-eq",
      `${yieldingName} masks ${protectedName} whenever both play, and ${protectedName} plays during ${Math.round((1 - wholeFree.free) * 100)}% of ${yieldingName}'s time. The conflict is persistent, so static EQ is the right tool, not a dynamic one.`,
      wholeFree.free,
    );
    ctx.staticMasking.set(protectedName, [...(ctx.staticMasking.get(protectedName) ?? []), yieldingName]);
    return;
  }
  const region = direction(strongest).regions[0];
  if (!region) return;
  // Already well under the protected stem where they compete: what masking remains is weak.
  if (region.levelDifferenceDb <= -6) {
    report(
      strongest,
      "already-separated",
      "none",
      `${yieldingName} sits ${(-region.levelDifferenceDb).toFixed(1)} dB under ${protectedName} in ${protectedName}'s ${formatHz(region.lowHz)}–${formatHz(region.highHz)}, so it competes only weakly; no dynamic move.`,
      wholeFree.free,
    );
    return;
  }
  // Concentrated in one region → dynamic EQ; spread over the protected stem's range → a smooth duck.
  const concentrated = region.maskedShare >= 0.5 * Math.max(1e-6, direction(strongest).maskedFraction) && Math.log2(region.highHz / region.lowHz) <= 3.2;
  const scope = ctx.scopes[0]!;
  const steps = wholeFree.steps;
  const toBands = (spectra: typeof protectedSpectra, step: number) => Array.from({ length: 24 }, (_, band) => round2(10 * Math.log10(Math.max(spectra.power[step * 24 + band]!, 1e-20))));
  const keyRawBands = (step: number) => rawBandsAt(ctx, protectedId, step);
  const weights = Array.from({ length: 24 }, (_, band) => regionWeight(ctx.document.tracks.find((track) => track.id === protectedId)!.role, "focal", spectral.grid.centers[band]!));
  const savedNodes = trackDynamicsNodes(ctx.document, yieldingId);
  const saved =
    savedNodes.find(
      (node): node is DynamicEqNode | DuckingNode =>
        node.enabled &&
        ((node.type === "dynamic-eq" && node.keyTrackId === protectedId && Math.abs(Math.log2(node.filter.frequencyHz / region.centerHz)) <= 0.5) || (node.type === "ducking" && node.keyTrackId === protectedId)),
    ) ?? null;
  const evidence: DynamicsEvidence = {
    detail: {
      kind: "masking",
      stepSeconds: spectral.stepSeconds,
      edgesHz: spectral.grid.edges.map((edge) => round2(edge)),
      steps: steps.slice(0, 400),
      keyActive: steps.slice(0, 400).map((step) => protectedSpectra.active[step] === 1),
      keyBands: steps.slice(0, 400).map((step) => keyRawBands(step)),
      targetBands: steps.slice(0, 400).map((step) => toBands(yieldingSpectra, step)),
      protectedBands: steps.slice(0, 400).map((step) => toBands(protectedSpectra, step)),
      weights: weights.map(round3),
      existing: saved
        ? saved.type === "dynamic-eq"
          ? { type: "dynamic-eq", filter: saved.filter, keyTrackId: saved.keyTrackId, keyDetector: saved.keyDetector, thresholdDb: saved.thresholdDb, rangeDb: saved.rangeDb, attackMs: saved.attackMs, releaseMs: saved.releaseMs }
          : { type: "ducking", keyTrackId: saved.keyTrackId, keyDetector: saved.keyDetector, thresholdDb: saved.thresholdDb, rangeDb: saved.rangeDb, attackMs: saved.attackMs, releaseMs: saved.releaseMs }
        : null,
    },
    windows: maskingWindows(ctx, protectedSpectra, yieldingSpectra, scope),
    band: [round2(region.lowHz), round2(region.highHz)],
  };
  const frequencyHz = musicalFrequency(region.centerHz);
  const q = clamp(Math.round(qForOctaves(Math.max(0.6, Math.log2(region.highHz / region.lowHz))) * 10) / 10, 0.7, 2);
  const keyed = steps.filter((step) => protectedSpectra.active[step] === 1);
  const keyLevel = (step: number, hz: number | null) => {
    const bands = keyRawBands(step);
    if (hz === null) return 10 * Math.log10(Math.max(1e-20, bands.reduce((total, db) => total + 10 ** (db / 10), 0)));
    let total = 0;
    bands.forEach((db, band) => {
      const center = spectral.grid.centers[band]!;
      const ratio = center / hz - hz / center;
      total += 10 ** (db / 10) / (1 + q * q * ratio * ratio);
    });
    return 10 * Math.log10(Math.max(total, 1e-20));
  };
  const cap = concentrated ? ctx.limits.maxDynamicEqDb : ctx.limits.maxDuckDb;
  // Size like the EQ planner: aim for the part about 6 dB under a Focal or lead stem, take the strength's share of that.
  const protectedTier = tierOf(ctx, ctx.document.tracks.find((track) => track.id === protectedId)!, ctx.scopes[0]!).tier;
  const gapTarget = protectedTier === "focal" || LEAD_ROLES.has(nameRole(ctx, protectedId)) ? 6 : 4;
  const needed = clamp(Math.round(Math.max(0, region.levelDifferenceDb + gapTarget) * ctx.limits.moveShare * 2) / 2, 1, cap);
  const build = (depth: number): DynamicEqProcessing | DuckingProcessing => {
    if (concentrated) {
      const thresholdDb = Math.round(percentile(keyed.map((step) => keyLevel(step, frequencyHz)), 0.5) - 8);
      return normalizeProcessing({ type: "dynamic-eq", filter: { kind: "bell", frequencyHz, q }, keyTrackId: protectedId, keyDetector: "smooth", thresholdDb: Math.max(-60, thresholdDb), rangeDb: -depth, attackMs: 20, releaseMs: 250 }) as DynamicEqProcessing;
    }
    const thresholdDb = Math.round(percentile(keyed.map((step) => keyLevel(step, null)), 0.5) - 8);
    return normalizeProcessing({ type: "ducking", keyTrackId: protectedId, keyDetector: "smooth", thresholdDb: Math.max(-60, thresholdDb), rangeDb: -depth, attackMs: 40, releaseMs: 300 }) as DuckingProcessing;
  };
  let depth = needed;
  let processing = build(depth);
  let evaluation = evaluateDynamics(evidence, processing, { type: "global" });
  // Adjust once: a dip that changes the part when the lead is silent is not doing its job.
  if ((evaluation.outsideChangeDb ?? 0) < -0.4 && depth > 1) {
    depth = Math.max(1, depth - 0.5);
    processing = build(depth);
    evaluation = evaluateDynamics(evidence, processing, { type: "global" });
  }
  // Across the protected stem's defining range, while it plays, the target already sits this far under: weak masking.
  if ((evaluation.conflictBeforeDb ?? 0) <= -8) {
    report(
      strongest,
      "already-separated",
      "none",
      `Across ${protectedName}'s defining range ${yieldingName} already sits ${(-(evaluation.conflictBeforeDb ?? 0)).toFixed(1)} dB under it while it plays, so the competition is weak; no dynamic move.`,
      wholeFree.free,
    );
    return;
  }
  const relief = (evaluation.collisionBefore ?? 0) - (evaluation.collisionAfter ?? 0);
  const relative = relief / Math.max(1e-6, evaluation.collisionBefore ?? 0);
  // Like the EQ planner: the move must pull the target at least 0.4 dB, and 30% of its own depth, further under.
  const gapRelief = (evaluation.conflictBeforeDb ?? 0) - (evaluation.conflictAfterDb ?? 0);
  const pulls = gapRelief >= Math.max(0.4, 0.3 * depth);
  const interactionId = report(
    strongest,
    "recommendation",
    concentrated ? "dynamic-eq" : "ducking",
    `${yieldingName} competes for ${protectedName}'s ${formatHz(region.lowHz)}–${formatHz(region.highHz)} while both play, but ${protectedName} is silent for ${Math.round(wholeFree.free * 100)}% of ${yieldingName}'s time, so a static cut would change ${yieldingName} where nothing needs it.`,
    wholeFree.free,
  );
  if (!pulls || (relief < 0.03 && relative < 0.15)) {
    ctx.interactions[ctx.interactions.length - 1] = { ...ctx.interactions[ctx.interactions.length - 1]!, outcome: "no-benefit", recommendedTool: "none" };
    ctx.notes.push(`A dynamic move on ${yieldingName} would barely relieve ${protectedName} (${Math.round(relief * 100)}% less competition), so none was added.`);
    return;
  }
  // The pair's priority (EQ planner: lead over support 1.0, a Background part under a Focal stem lower) weighs the relief.
  const benefit = severity * strongest.priority * clamp(relative * 2, 0, 1) * 1.5;
  const cost = PROCESSOR_COST[processing.type] + 0.02 * depth;
  if (benefit < cost) return;
  let confidence = 0.5 + 0.1 * Number(SUPPORT_ROLES.has(nameRole(ctx, yieldingId))) + 0.1 * clamp(relative * 2, 0, 1) + 0.08 * clamp(wholeFree.free, 0, 1) + 0.05 * Number(song.coSeconds >= 8);
  if (requested) confidence += 0.05;
  ctx.rows.push({
    trackId: yieldingId,
    scope: { type: "global" },
    problem: "event-masking",
    processing,
    replacesNodeId: saved?.id ?? null,
    targetReductionDb: null,
    relatedTrackIds: [protectedId],
    interactionIds: [interactionId],
    confidence: clamp(round2(confidence), 0.2, 0.9),
    forceReview: null,
    evidence,
    evaluation,
    pass: 2,
    benefit,
    explain: (result) => {
      const what =
        processing.type === "dynamic-eq"
          ? `Dips ${yieldingName} by up to ${(-processing.rangeDb).toFixed(1)} dB around ${formatHz(processing.filter.frequencyHz)} (Q ${processing.filter.q.toFixed(1)}) only while ${protectedName} plays`
          : `Ducks ${yieldingName} by up to ${(-processing.rangeDb).toFixed(1)} dB only while ${protectedName} plays`;
      return [
        `${what}: there ${yieldingName} covers ${Math.round((result.collisionBefore ?? 0) * 100)}% of ${protectedName}'s defining range (${formatHz(region.lowHz)}–${formatHz(region.highHz)} matters most), but ${protectedName} is silent for ${Math.round(wholeFree.free * 100)}% of ${yieldingName}'s playing time, so a static cut would thin ${yieldingName} needlessly.`,
        `The move lowers that competition to ${Math.round((result.collisionAfter ?? 0) * 100)}% and changes ${yieldingName} by ${formatSignedDb(result.outsideChangeDb ?? 0)} dB when ${protectedName} rests. The key is ${protectedName}'s own source${processing.type === "dynamic-eq" ? " in that band" : ""}, followed smoothly (attack ${processing.attackMs} ms, release ${processing.releaseMs} ms), so it does not pump.`,
        ...(requested ? [`The note "${requested.text}" asks for this, and the measurements support it.`] : []),
      ];
    },
  });
}

function nameRole(ctx: Context, trackId: string): string {
  return ctx.document.tracks.find((track) => track.id === trackId)?.role ?? "other";
}

/** The protected stem's raw band levels at one step (its key reads the source, before fader and EQ). */
function rawBandsAt(ctx: Context, trackId: string, step: number): number[] {
  const spectra = ctx.spectral.tracks.get(trackId)!;
  const track = spectra.track;
  const seconds = (step + 0.5) * ctx.spectral.stepSeconds;
  const section = ctx.document.sections.find((item) => seconds >= item.startTime && seconds < item.endTime);
  const row = section ? ctx.document.sectionTrackSettings.find((item) => item.trackId === track.id && item.sectionId === section.id) : undefined;
  const gain = row?.overrides.gainDb ?? track.gainDb;
  // Heard power minus the fader. Saved EQ on the key is small next to the detector's own band-pass.
  return Array.from({ length: 24 }, (_, band) => round2(10 * Math.log10(Math.max(spectra.power[step * 24 + band]!, 1e-20)) - gain));
}

function maskingWindows(ctx: Context, protectedSpectra: { active: Uint8Array }, yieldingSpectra: { active: Uint8Array }, scope: AnalysisScope): Array<[number, number]> {
  const steps = stepsIn(ctx.spectral, scope.start, scope.end);
  const out: Array<[number, number]> = [];
  let open: number | null = null;
  for (const [index, step] of steps.entries()) {
    const on = yieldingSpectra.active[step] === 1;
    if (on && open === null) open = step;
    const last = index === steps.length - 1;
    if ((!on || last) && open !== null) {
      const close = on ? step + 1 : step;
      if (close > open) out.push([round2(open * ctx.spectral.stepSeconds), round2(close * ctx.spectral.stepSeconds)]);
      open = null;
    }
  }
  void protectedSpectra;
  return out.slice(0, 24);
}

/* ------------------------------------------------------------------ limits and finishing */

/** Automatic graph limits: one compressor, one transient shaper, one duck, two dynamic EQs per track. */
function limitPerTrack(ctx: Context): void {
  const keep: Row[] = [];
  const limits: Record<DynamicsProcessing["type"], number> = { compressor: 1, transient: 1, ducking: 1, "dynamic-eq": 2 };
  const ordered = [...ctx.rows].sort((left, right) => right.benefit - left.benefit);
  for (const row of ordered) {
    const same = keep.filter((item) => item.trackId === row.trackId && item.processing.type === row.processing.type && item.scope.type === row.scope.type && (item.scope.type === "global" || (item.scope as { sectionId: string }).sectionId === (row.scope as { sectionId?: string }).sectionId));
    if (same.length >= limits[row.processing.type]) {
      ctx.notes.push(`${nameOf(ctx, row.trackId)} would need another ${row.processing.type === "dynamic-eq" ? "dynamic EQ" : row.processing.type}; Audiosous keeps at most ${limits[row.processing.type]} per track and kept the strongest.`);
      continue;
    }
    keep.push(row);
  }
  // A plan holds at most 64 rows; a mix that wants more keeps the strongest and says so.
  const strongest = new Set(keep.slice(0, 64));
  if (keep.length > 64) ctx.notes.push(`${keep.length - 64} weaker dynamics changes were left out; a plan holds at most 64.`);
  ctx.rows = ctx.rows.filter((row) => strongest.has(row));
}

function finish(row: Row): DynamicsRecommendation {
  const id = dynamicsRecommendationId(row.trackId, row.scope, row.processing.type, row.processing.type === "ducking" || row.processing.type === "dynamic-eq" ? row.processing.keyTrackId : null);
  const explained = row.explain(row.evaluation).map((text) => text.slice(0, 600));
  // The review note is kept even when the explanation is long.
  const reasons = row.forceReview ? [...explained.slice(0, 5), row.forceReview] : explained.slice(0, 6);
  const warnings = dynamicsWarnings({ targetReductionDb: row.targetReductionDb }, row.processing, row.evaluation);
  const review = row.forceReview !== null || needsReview(row.processing, row.confidence, warnings);
  return {
    id,
    trackId: row.trackId,
    scope: row.scope,
    problem: row.problem,
    processing: row.processing,
    planned: row.processing,
    replacesNodeId: row.replacesNodeId,
    targetReductionDb: row.targetReductionDb,
    relatedTrackIds: row.relatedTrackIds.slice(0, 4),
    interactionIds: row.interactionIds.slice(0, 8),
    confidence: row.confidence,
    confidenceLabel: confidenceLabel(row.confidence),
    status: review ? "needs-review" : "proposed",
    edited: false,
    reasons: reasons.slice(0, 6),
    warnings,
    evaluation: { ...row.evaluation, passes: row.pass, proxy: null },
    evidence: row.evidence,
  };
}

function headline(changes: DynamicsRecommendation[], document: ProjectDocument): string {
  if (changes.length === 0) return "The dynamics already serve the mix. No compression, ducking, transient shaping, or dynamic EQ was proposed.";
  const name = (id: string) => document.tracks.find((track) => track.id === id)?.name ?? id;
  const parts = changes.slice(0, 4).map((change) => {
    const what = change.processing.type === "compressor" ? "compress" : change.processing.type === "ducking" ? `duck from ${name(change.processing.keyTrackId)}` : change.processing.type === "transient" ? (change.processing.attack < 0 ? "soften attacks" : "sharpen attacks") : "dynamic EQ";
    return `${name(change.trackId)} (${what})`;
  });
  return `${changes.length} dynamics ${changes.length === 1 ? "change" : "changes"}: ${parts.join(", ")}${changes.length > 4 ? ", …" : ""}.`;
}

function summaryOf(row: Row) {
  return { track: row.trackId, scope: row.scope, type: row.processing.type, problem: row.problem, benefit: round3(row.benefit), confidence: row.confidence };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
