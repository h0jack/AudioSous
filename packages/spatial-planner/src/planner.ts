import { ANALYSIS_ENGINE_VERSION, STEREO_BANDS, type EqBandFrames, type StereoFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import { TIER_RANK, confidenceLabel, type SourceFingerprint, type Tier } from "@audiosous/balance-planner";
import { analyzeInteractions, buildSpectralModel, stepsIn, type AnalysisScope, type InteractionAnalysis } from "@audiosous/eq-planner";
import { normalizePan, normalizeWidth, type ProjectDocument, type Track } from "@audiosous/project-model";
import { indexSpatialIntent, instructionFor, type SpatialInstruction, type SpatialIntentIndex } from "./intent";
import { CENTER_ANCHORS, buildSpatialPairs, conflictRange, currentConflict, type SpatialPair } from "./interaction";
import { buildStereoModel, meanStats, resolveSetting, sumBands, withOverlay, type SpatialOverlay, type StereoModel, type StereoTrack } from "./model";
import {
  describePan,
  describeWidth,
  evaluateSpatial,
  imageDto,
  needsReview,
  refreshSpatialTrim,
  round2,
  round3,
  safetyWarnings,
  spatialPlanSchema,
  spatialPlanStateIdentity,
  spatialRecommendationId,
  type MixMetrics,
  type SpatialEvaluation,
  type SpatialEvidence,
  type SpatialInteraction,
  type SpatialPlan,
  type SpatialRecommendation,
  type SpatialScope,
} from "./plan";
import {
  AUTO_PAN_LIMIT,
  AUTO_WIDTH_MAX,
  AUTO_WIDTH_MIN,
  CORRELATION_FLOOR,
  DEFAULT_SPATIAL_SETTINGS,
  LOW_END_SHARE_LIMIT,
  MIN_STEREO_SPREAD,
  MIX_BALANCE_LIMIT,
  MONO_LOSS_ALLOWANCE_DB,
  MONO_LOSS_LIMIT_DB,
  PHASE_RISK_CORRELATION,
  SPATIAL_LIMITS_BY_STRENGTH,
  SURROUND_MAX_SPREAD,
  SPATIAL_PLAN_VERSION,
  SPATIAL_PLANNER_VERSION,
  WIDEN_MIN_CORRELATION,
  type SpatialLimits,
  type SpatialSettings,
} from "./settings";
import { fieldShares, imageOf, occupancy, placeStats, stereoPower, type Lrc, type SpatialSetting } from "./stereo";

export interface PlanSpaceInput {
  document: ProjectDocument;
  /** Whole-track measurements from the analysis cache, keyed by track id. */
  measurements: Record<string, TrackFileMeasurement | null | undefined>;
  /** Proxy EQ band frames (frequency competition). Without them the sidecar spectrogram is used. */
  bands?: Record<string, EqBandFrames | null | undefined>;
  /** Proxy stereo frames (position, width, correlation over time). Without them whole-file stereo figures are used. */
  stereo?: Record<string, StereoFrames | null | undefined>;
  settings?: Partial<SpatialSettings>;
  fingerprints?: SourceFingerprint[];
  now?: string;
  /** Receives each stage's moves. For acceptance scripts and debugging; the plan does not depend on it. */
  trace?: (stage: string, detail: unknown) => void;
}

type Purpose = SpatialRecommendation["purpose"];

interface Move {
  trackId: string;
  scope: SpatialScope;
  processing: { pan: number | null; width: number | null };
  purpose: Purpose;
  relatedIds: string[];
  interactionIds: string[];
  confidence: number;
  forceReview: boolean;
  reviewReason: string | null;
  pass: 1 | 2;
  benefit: number;
  /** Which part of the objective chose the move. */
  driver: "conflict" | "surround" | "mono" | "intent";
  /** Builds the reasons from the final evaluation, so numbers in the text match the row. */
  explain: (evaluation: Omit<SpatialEvaluation, "passes" | "proxy">, move: Move) => string[];
}

interface Context {
  document: ProjectDocument;
  limits: SpatialLimits;
  analysis: InteractionAnalysis;
  intents: SpatialIntentIndex;
  base: StereoModel;
  /** Scopes that partition the song: marked sections and unmarked gaps. The whole song when there are no sections. */
  partition: AnalysisScope[];
  pairs: SpatialPair[];
  notes: string[];
  levelNotes: Map<string, string>;
  /** sectionId set per track where a note asks to keep the stem centered or puts it on a side. */
  panLocks: Map<string, Set<string>>;
  overlay: SpatialOverlay;
  working: StereoModel;
  workingPairs: SpatialPair[];
  moves: Move[];
}

/** Move costs grow with the square of the move, so a modest move wins over the strength's cap unless the cap clearly helps more. */
const PAN_COST = 0.1;
const PAN_COST_SQUARED = 0.8;
const WIDTH_COST = 0.06;
const WIDTH_COST_SQUARED = 0.8;
const MONO_COST = 0.08;
const BALANCE_COST = 1;
const LEVEL_COST = 0.03;
const SECTION_COST = 0.03;
/**
 * Narrowing back toward 100% undoes a widening someone already made, so it costs half; moving away from
 * 100% in either direction costs the full amount.
 */
function widthCost(from: number, delta: number): number {
  const to = from + delta;
  const towardUnity = from > 1 && delta < 0 ? Math.min(-delta, from - Math.max(1, to)) : 0;
  const rest = Math.abs(delta) - towardUnity;
  const scaled = rest + 0.5 * towardUnity;
  return WIDTH_COST * scaled + WIDTH_COST_SQUARED * scaled * Math.abs(delta);
}

/** Pan and width together are the last step of the hierarchy; the pair has to beat either move alone by this much. */
const COMBINED_COST = 0.03;
const SURROUND_GAIN = 1.5;
const SURROUND_SPREAD = 0.7;
const MONO_SAFETY_GAIN = 0.2;
const STEP = 0.05;
/** A whole-song row needs its conflict in at least this share of the stem's playing time. */
const GLOBAL_COVERAGE = 0.5;
/** Smaller automatic moves are not worth a row. */
const MIN_PAN_MOVE = 0.1;
const MIN_WIDTH_MOVE = 0.1;

/**
 * Deterministic spatial plan: pan or balance and width, global first, section only with a reason.
 * Same project, gains, EQ, spatial state, analysis, roles, sections, intent, and settings give the same plan.
 */
export function planSpace(input: PlanSpaceInput): SpatialPlan {
  const settings: SpatialSettings = { strength: input.settings?.strength ?? DEFAULT_SPATIAL_SETTINGS.strength };
  const limits = SPATIAL_LIMITS_BY_STRENGTH[settings.strength];
  const { document } = input;
  const spectral = buildSpectralModel({ document, measurements: input.measurements, bands: input.bands });
  const analysis = analyzeInteractions(document, spectral);
  const base = buildStereoModel({ document, spectral, measurements: input.measurements, stereo: input.stereo });
  const partition = analysis.scopes.filter((scope) => scope.key !== "song");
  const pairs = buildSpatialPairs(analysis, base);
  const ctx: Context = {
    document,
    limits,
    analysis,
    intents: indexSpatialIntent(document),
    base,
    partition: partition.length > 0 ? partition : analysis.scopes.filter((scope) => scope.key === "song"),
    pairs,
    notes: [],
    levelNotes: new Map(),
    panLocks: new Map(),
    overlay: new Map(),
    working: base,
    workingPairs: pairs,
    moves: [],
  };
  const trace = (stage: string) =>
    input.trace?.(stage, ctx.moves.map((move) => ({ track: move.trackId, scope: move.scope, processing: move.processing, purpose: move.purpose, benefit: round3(move.benefit) })));

  levelNotes(ctx);
  // Notes that put a stem in the center or on a side hold it there; the separation passes work around them.
  intentLocks(ctx);
  separationPass(ctx, 1);
  trace("pass1");
  separationPass(ctx, 2);
  trace("pass2");
  // Section notes last, read against the whole-song moves, so a note's row never undoes one.
  intentMoves(ctx);
  trace("intent");
  wholePlanCheck(ctx);
  trace("whole-plan");

  const changes = toRecommendations(ctx);
  const interactions = interactionList(ctx, changes);
  const proposed = new Set(changes.filter((change) => change.status !== "needs-review").map((change) => change.id));
  const after = withOverlay(document, base, overlayFor(document, ctx.moves.filter((move) => proposed.has(spatialRecommendationId(move.trackId, move.scope)))));
  const draft: SpatialPlan = {
    planVersion: SPATIAL_PLAN_VERSION,
    plannerVersion: SPATIAL_PLANNER_VERSION,
    kind: "spatial-balance",
    createdAt: input.now ?? new Date().toISOString(),
    projectId: document.project.id,
    sourceAnalysisVersion: ANALYSIS_ENGINE_VERSION,
    settings,
    stateIdentity: spatialPlanStateIdentity(document, settings, input.fingerprints ?? []),
    summary: summarize(ctx, changes),
    changes,
    interactions,
    fields: fieldsOf(ctx),
    mix: { before: mixMetrics(base, ctx.partition), after: mixMetrics(after, ctx.partition) },
    candidateTrim: { gainDb: 0, reason: null },
    levels: document.tracks.map((track) => {
      const entry = base.tracks.get(track.id);
      const stats = entry ? sumBands(meanStats(entry.source, activeSteps(entry, 0, base.steps))) : { l: 0, r: 0, c: 0 };
      // Statistics before the fader, so the headroom estimate adds the fader once.
      const fader = 10 ** (track.gainDb / 10);
      return {
        trackId: track.id,
        peakDbfs: input.measurements[track.id]?.levels.peakDbfs ?? null,
        muted: track.muted,
        gainDb: track.gainDb,
        mono: entry?.mono ?? track.metadata.channelCount < 2,
        stats: [stats.l / fader, stats.r / fader, stats.c / fader] as [number, number, number],
        current: { pan: track.pan, width: track.width },
      };
    }),
  };
  return spatialPlanSchema.parse(refreshSpatialTrim(draft));
}

/** A competitor much louder than the stem it should give way to is a level problem. Say so once per pair of stems. */
function levelNotes(ctx: Context): void {
  const planned = new Set(ctx.partition.map((scope) => scope.key));
  for (const pair of ctx.pairs) {
    if (pair.outcome !== "level" || !planned.has(pair.scope.key) || !pair.protectedId) continue;
    const reading = currentConflict(pair);
    if (reading.severity < ctx.limits.minConflict) continue;
    const loud = pair.protectedId === pair.a ? pair.b : pair.a;
    const key = [loud, pair.protectedId].join("|");
    if (ctx.levelNotes.has(key)) continue;
    const range = conflictRange(pair.weights, ctx.base.edgesHz);
    ctx.levelNotes.set(
      key,
      `${trackName(ctx, loud)} sits ${pair.levelGapDb.toFixed(1)} dB over ${trackName(ctx, pair.protectedId)} at ${formatRange(range.lowHz, range.highHz)}${pair.scope.marked ? ` in ${pair.scope.name}` : ""}. That is a level problem, not a spatial one, so it was not moved in the field. AutoBalance or the fader is the right tool.`,
    );
  }
}

/* ------------------------------------------------------------------ intent */

function intentLocks(ctx: Context): void {
  for (const section of ctx.document.sections) {
    for (const track of ctx.document.tracks) {
      const instruction = instructionFor(ctx.intents, section.id, track.id);
      if (instruction && (instruction.word === "center" || instruction.word === "left" || instruction.word === "right")) lockPan(ctx, track.id, section.id);
    }
  }
}

/** Section and Track × Section notes, read against the plan so far. A row a note asks for is merged with any section row the stem already has. */
function intentMoves(ctx: Context): void {
  const { document, limits, analysis } = ctx;
  for (const section of document.sections) {
    const scope = ctx.partition.find((item) => item.sectionId === section.id);
    if (!scope) continue;
    for (const track of document.tracks) {
      const entry = ctx.base.tracks.get(track.id);
      if (!entry) continue;
      const steps = activeSteps(entry, scope.start, scope.end, ctx.base);
      if (steps.length === 0) continue;
      const instruction = instructionFor(ctx.intents, section.id, track.id);
      if (!instruction) continue;
      const tier = analysis.tiers.get(track.id)?.get(section.id)?.tier ?? "unknown";
      const named = instruction.source !== "section-general";
      const anchor = CENTER_ANCHORS.has(track.role) || tier === "primary" || tier === "focal";
      if (!named && (anchor || tier === "unknown")) continue;
      if (!named && instruction.surround && tier !== "background") continue;
      const saved = document.sectionTrackSettings.find((row) => row.trackId === track.id && row.sectionId === section.id)?.overrides;
      const current = resolveSetting(document, track, section.id, ctx.overlay.get(track.id));
      const savedSetting = resolveSetting(document, track, section.id);
      const source = sourceImage(entry, steps);
      const name = track.name;
      if (instruction.word === "wider" || instruction.word === "narrower") {
        if (saved?.width !== null && saved?.width !== undefined) {
          ctx.notes.push(`${name} keeps its saved ${section.name} width of ${describeWidth(saved.width)}; a saved section setting outranks the note "${instruction.text}".`);
          continue;
        }
        if (entry.mono || source.spread < MIN_STEREO_SPREAD) {
          if (named) ctx.notes.push(`${name} has no stereo content to ${instruction.word === "wider" ? "widen" : "narrow"} in ${section.name}. Audiosous does not create width from a mono part.`);
          continue;
        }
        const wider = instruction.word === "wider";
        if (wider ? current.width >= AUTO_WIDTH_MAX - 0.04 : current.width <= AUTO_WIDTH_MIN + 0.04) {
          // Already at or past the furthest Audiosous goes on its own; never answer "wider" by narrowing.
          if (named || current.width > AUTO_WIDTH_MAX + 0.04) {
            ctx.notes.push(`${name} is already at ${describeWidth(current.width)} in ${section.name}, as far as Audiosous goes on its own for "${instruction.text}".`);
          }
          continue;
        }
        if (wider && (source.correlation < WIDEN_MIN_CORRELATION || (entry.lowShare >= LOW_END_SHARE_LIMIT && !named))) {
          ctx.notes.push(
            source.correlation < WIDEN_MIN_CORRELATION
              ? `${name} was not widened in ${section.name}: its correlation is already ${source.correlation.toFixed(2)}, so more width would thin it out in mono.`
              : `${name} was not widened in ${section.name}: most of its energy is low end, which stays centered.`,
          );
          continue;
        }
        let target = wider ? Math.min(AUTO_WIDTH_MAX, current.width + limits.intentWidthStep) : Math.max(AUTO_WIDTH_MIN, current.width - limits.intentWidthStep);
        // Back off a widening until the stem keeps a healthy correlation.
        while (wider && target > current.width + 0.04) {
          const after = imageOf(sumBands(meanStats(entry.source, steps).map((stats) => placeStats(stats, { pan: current.pan, width: target }, false))));
          if (after.correlation >= CORRELATION_FLOOR + 0.1) break;
          target -= STEP;
        }
        target = normalizeWidth(target);
        if (wider ? target < current.width + 0.04 : target > current.width - 0.04) {
          if (named) ctx.notes.push(`${name} cannot go ${wider ? "wider" : "narrower"} in ${section.name} without thinning out in mono, so "${instruction.text}" was not applied to it.`);
          continue;
        }
        addMove(ctx, intentMove(ctx, track, section.id, { pan: null, width: target }, instruction, tier, current, savedSetting));
        continue;
      }
      if (saved?.pan !== null && saved?.pan !== undefined) {
        ctx.notes.push(`${name} keeps its saved ${section.name} pan (${describePan(saved.pan)}); a saved section setting outranks the note "${instruction.text}".`);
        continue;
      }
      if (instruction.word === "center") {
        if (Math.abs(current.pan) > 0.02) addMove(ctx, intentMove(ctx, track, section.id, { pan: 0, width: null }, instruction, tier, current, savedSetting));
        continue;
      }
      const hard = /\bhard\b/i.test(instruction.text);
      const sign = instruction.word === "left" ? -1 : 1;
      const limit = hard ? 1 : AUTO_PAN_LIMIT;
      if (sign * current.pan >= limits.intentPanStep - 0.005 && !hard) {
        ctx.notes.push(`${name} already sits ${describePan(current.pan)} in ${section.name}, so "${instruction.text}" needs no change.`);
        continue;
      }
      const target = normalizePan(hard ? sign : Math.max(-limit, Math.min(limit, current.pan + sign * limits.intentPanStep)));
      if (Math.abs(target - current.pan) < 0.02) continue;
      addMove(ctx, intentMove(ctx, track, section.id, { pan: target, width: null }, instruction, tier, current, savedSetting));
    }
  }
  for (const ambiguous of ctx.intents.ambiguous) {
    const section = document.sections.find((item) => item.id === ambiguous.sectionId);
    const names = ambiguous.trackIds.map((id) => document.tracks.find((track) => track.id === id)?.name ?? id);
    ctx.notes.push(
      `The ${section?.name ?? "section"} note "${ambiguous.text}" could mean ${listNames(names, "or")}, so it was not applied. Name one stem in the note to use it.`,
    );
  }
}

function intentMove(
  ctx: Context,
  track: Track,
  sectionId: string,
  processing: Move["processing"],
  instruction: SpatialInstruction,
  tier: Tier,
  current: SpatialSetting,
  saved: SpatialSetting,
): Move {
  const section = ctx.document.sections.find((item) => item.id === sectionId)!;
  const confidence = instruction.source === "track-intent" ? 0.88 : instruction.source === "section-intent" ? 0.84 : 0.8;
  const origin = ctx.base.tracks.get(track.id)?.origin === "measurement" ? -0.06 : 0;
  return {
    trackId: track.id,
    scope: { type: "section", sectionId },
    processing,
    purpose: "intent",
    relatedIds: [],
    interactionIds: [],
    confidence: confidence + origin,
    forceReview: false,
    reviewReason: null,
    pass: 1,
    benefit: 1,
    driver: "intent",
    explain: (evaluation) => {
      // Described from where the plan's whole-song row leaves the stem, which is what this row changes.
      const planned = (processing.width !== null && Math.abs(current.width - saved.width) > 0.005) || (processing.pan !== null && Math.abs(current.pan - saved.pan) > 0.005);
      const change = describeChange(track, current, processing, ` in ${section.name}`) + (planned ? " (after the whole-song change above)" : "");
      const where = instruction.source === "track-intent" ? `the ${track.name} note in ${section.name}` : `the ${section.name} note`;
      const role = tierWord(tier);
      const lines = [`${change} because ${where} says "${trimQuote(instruction.text)}".${role ? ` ${track.name} is ${role} there.` : ""}`];
      if (processing.width !== null) lines.push(safetyLine(track, evaluation));
      return lines;
    },
  };
}

function lockPan(ctx: Context, trackId: string, sectionId: string): void {
  const set = ctx.panLocks.get(trackId) ?? new Set<string>();
  set.add(sectionId);
  ctx.panLocks.set(trackId, set);
}

/* ------------------------------------------------------------------ separation */

interface Eligibility {
  canPan: boolean;
  canWiden: boolean;
  canNarrow: boolean;
  surround: boolean;
  phaseRisk: boolean;
  sourceCorrelation: number;
}

/** One pass over the stems that should move: the search per stem, the global setting first, then sections with a reason. */
function separationPass(ctx: Context, pass: 1 | 2): void {
  const touched = new Set(ctx.moves.filter((move) => move.purpose !== "intent").map((move) => move.trackId));
  const candidates = new Map<string, number>();
  const planned = new Set(ctx.partition.map((scope) => scope.key));
  for (const pair of ctx.workingPairs) {
    if (!planned.has(pair.scope.key) || !pair.moverId || pair.outcome !== "mover") continue;
    const severity = currentConflict(pair).severity * pair.priority;
    if (severity < ctx.limits.minConflict * 0.75) continue;
    candidates.set(pair.moverId, Math.max(candidates.get(pair.moverId) ?? 0, severity));
  }
  if (pass === 1) {
    // Stems with their own reason to move: phase risk, or a background part that could surround a crowded center.
    for (const [trackId, entry] of ctx.working.tracks) {
      const eligibility = eligibilityOf(ctx, entry, null);
      if ((eligibility.phaseRisk || eligibility.surround) && !candidates.has(trackId)) candidates.set(trackId, 0.01);
    }
  }
  const order = [...candidates.entries()]
    .filter(([trackId]) => !touched.has(trackId))
    .sort((left, right) => right[1] - left[1] || trackIndex(ctx, left[0]) - trackIndex(ctx, right[0]));
  for (const [trackId] of order) {
    const entry = ctx.working.tracks.get(trackId);
    if (!entry) continue;
    const global = searchGlobal(ctx, entry, pass);
    if (global) addMove(ctx, global);
    for (const move of searchSections(ctx, entry, pass)) addMove(ctx, move);
  }
}

function eligibilityOf(ctx: Context, entry: StereoTrack, sectionId: string | null): Eligibility {
  const track = entry.track;
  const steps = sectionId ? activeSteps(entry, ...scopeBounds(ctx, sectionId), ctx.working) : activeSteps(entry, 0, ctx.working.steps);
  const source = sourceImage(entry, steps);
  const placed = imageOf(sumBands(meanStats(entry.heard, steps)));
  const anchor = CENTER_ANCHORS.has(track.role);
  const tier = ctx.analysis.tiers.get(track.id)?.get(sectionId ?? "song")?.tier ?? "unknown";
  const locks = ctx.panLocks.get(track.id);
  const locked = sectionId ? (locks?.has(sectionId) ?? false) : [...(locks ?? [])].some((id) => activeSteps(entry, ...scopeBounds(ctx, id), ctx.working).length > 0);
  const lowEnd = entry.lowShare >= LOW_END_SHARE_LIMIT;
  const stereo = !entry.mono && source.spread >= MIN_STEREO_SPREAD;
  // Out of phase, or widened past what it can take: a widening someone made left the stem thin in mono.
  const width = sectionId ? resolveSetting(ctx.document, track, sectionId, ctx.overlay.get(track.id)).width : track.width;
  const phaseRisk =
    !entry.mono && !anchor && source.spread >= MIN_STEREO_SPREAD && (placed.correlation < PHASE_RISK_CORRELATION || (width > 1.05 && placed.correlation < CORRELATION_FLOOR));
  const background = tier === "background";
  return {
    canPan: !anchor && !lowEnd && !locked && tier !== "primary" && tier !== "focal",
    canWiden: stereo && !anchor && !lowEnd && source.correlation >= WIDEN_MIN_CORRELATION && tier !== "primary" && tier !== "focal",
    canNarrow: stereo && !anchor,
    surround: background && stereo && !lowEnd && source.correlation >= 0.4 && placed.spread < SURROUND_MAX_SPREAD && entry.settings.some((setting) => setting.width < AUTO_WIDTH_MAX - 0.04),
    phaseRisk,
    sourceCorrelation: source.correlation,
  };
}

function searchGlobal(ctx: Context, entry: StereoTrack, pass: 1 | 2): Move | null {
  const track = entry.track;
  const evidence = buildEvidence(ctx, entry, null);
  if (evidence.scopes.length === 0) return null;
  const eligibility = eligibilityOf(ctx, entry, null);
  const current = { pan: track.pan, width: track.width };
  const atBaseline = evaluateSpatial(evidence, { pan: null, width: null }, true);
  if (eligibility.surround && atBaseline.mixBefore.centerLoad < 0.5) eligibility.surround = false;
  // A conflict in less than half of the stem's playing time is a section matter, as in EQ.
  const addressed = evidence.scopes.some((scope) => scope.pairs.some((pair) => pair.addressed));
  if (addressed && conflictCoverage(evidence) < GLOBAL_COVERAGE && !eligibility.surround && !eligibility.phaseRisk) return null;
  const best = search(ctx, evidence, true, current, eligibility, 0);
  if (!best) return null;
  return separationMove(ctx, entry, { type: "global" }, best, evidence, eligibility, pass, current);
}

/** Section moves need a reason the rest of the song does not have: prominence or a note there, or a protected stem that plays mostly there. */
function searchSections(ctx: Context, entry: StereoTrack, pass: 1 | 2): Move[] {
  const out: Move[] = [];
  for (const scope of ctx.partition) {
    if (!scope.sectionId) continue;
    const sectionId = scope.sectionId;
    const pairs = ctx.workingPairs.filter((pair) => pair.scope.key === scope.key && pair.moverId === entry.track.id && pair.outcome === "mover");
    const strong = pairs.filter((pair) => currentConflict(pair).severity * pair.priority >= ctx.limits.minConflict);
    if (strong.length === 0) continue;
    const reason = strong.some((pair) => {
      const tiers = ctx.analysis.tiers;
      const explicit = tiers.get(pair.a)?.get(sectionId)?.explicit || tiers.get(pair.b)?.get(sectionId)?.explicit;
      return explicit || concentrated(ctx, pair.protectedId, scope);
    });
    if (!reason) continue;
    const evidence = buildEvidence(ctx, entry, sectionId);
    if (evidence.scopes.length === 0) continue;
    const eligibility = eligibilityOf(ctx, entry, sectionId);
    if (eligibility.surround && evaluateSpatial(evidence, { pan: null, width: null }, false).mixBefore.centerLoad < 0.5) eligibility.surround = false;
    const current = resolveSetting(ctx.document, entry.track, sectionId, ctx.overlay.get(entry.track.id));
    const best = search(ctx, evidence, false, current, eligibility, SECTION_COST);
    if (!best) continue;
    out.push(separationMove(ctx, entry, { type: "section", sectionId }, best, evidence, eligibility, pass, resolveSetting(ctx.document, entry.track, sectionId)));
  }
  return out;
}

/** True when the protected stem plays at least 70% of its time inside this scope. */
function concentrated(ctx: Context, trackId: string | null, scope: AnalysisScope): boolean {
  if (!trackId) return false;
  const entry = ctx.working.tracks.get(trackId);
  if (!entry) return false;
  const inside = activeSteps(entry, scope.start, scope.end, ctx.working).length;
  const all = activeSteps(entry, 0, ctx.working.steps).length;
  return all > 0 && inside / all >= 0.7;
}

interface Best {
  delta: { pan: number; width: number };
  setting: SpatialSetting;
  gain: number;
  conflictGain: number;
  surroundGain: number;
  monoGain: number;
  evaluation: Omit<SpatialEvaluation, "passes" | "proxy">;
}

/**
 * Bounded search over pan and width around the current setting, inside the strength's limits.
 * Candidates are tried smallest first, so a tie keeps the smaller move.
 */
function search(ctx: Context, evidence: SpatialEvidence, global: boolean, current: SpatialSetting, eligibility: Eligibility, extraCost: number): Best | null {
  const { limits } = ctx;
  const pans: number[] = [0];
  if (eligibility.canPan) {
    const lighter = lighterSide(evidence);
    for (let step = STEP; step <= limits.maxPanMove + 1e-9; step += STEP) {
      for (const sign of [lighter, -lighter]) {
        const target = current.pan + sign * step;
        if (Math.abs(target) > AUTO_PAN_LIMIT + 1e-9 && Math.abs(target) > Math.abs(current.pan)) continue;
        pans.push(round2(sign * step));
      }
    }
  }
  const widths: number[] = [0];
  // Undoing a widening that hurt mono may go all the way back to 100%, past the strength's step.
  const maxNarrow = eligibility.phaseRisk ? Math.max(limits.maxWidthChange, current.width - 1) : limits.maxWidthChange;
  for (let step = STEP; step <= Math.max(limits.maxWidthChange, maxNarrow) + 1e-9; step += STEP) {
    if (eligibility.canNarrow && step <= maxNarrow + 1e-9) {
      const target = current.width - step;
      if (target >= AUTO_WIDTH_MIN - 1e-9 || target >= current.width) widths.push(round2(-step));
    }
    if (eligibility.canWiden && !eligibility.phaseRisk && step <= limits.maxWidthChange + 1e-9) {
      const target = current.width + step;
      if (target <= AUTO_WIDTH_MAX + 1e-9) widths.push(round2(step));
    }
  }
  const candidates: Array<{ pan: number; width: number }> = [];
  const meaningful = (value: number, minimum: number) => value === 0 || Math.abs(value) >= minimum - 1e-9;
  for (const pan of pans) {
    for (const width of widths) {
      if ((pan !== 0 || width !== 0) && meaningful(pan, MIN_PAN_MOVE) && meaningful(width, MIN_WIDTH_MOVE)) candidates.push({ pan, width });
    }
  }
  candidates.sort((left, right) => Math.abs(left.pan) + Math.abs(left.width) - (Math.abs(right.pan) + Math.abs(right.width)));
  const coverage = conflictCoverage(evidence);
  // Coarse to fine: 0.1 steps (and the caps) first, then the 0.05 neighbours of the best coarse candidate.
  const coarse = (value: number, cap: number) => Math.abs(Math.round(value * 10) - value * 10) < 1e-6 || Math.abs(Math.abs(value) - cap) < 1e-6;
  const first = candidates.filter((delta) => coarse(delta.pan, limits.maxPanMove) && (coarse(delta.width, limits.maxWidthChange) || coarse(delta.width, maxNarrow)));
  let best: Best | null = null;
  const consider = (delta: { pan: number; width: number }) => {
    const setting = { pan: normalizePan(current.pan + delta.pan), width: normalizeWidth(current.width + delta.width) };
    const processing = { pan: delta.pan !== 0 ? setting.pan : null, width: delta.width !== 0 ? setting.width : null };
    const evaluation = evaluateSpatial(evidence, processing, global);
    const widened = delta.width > 0;
    if (widened && evaluation.correlationAfter < CORRELATION_FLOOR) return;
    if (evaluation.monoLossAfterDb - evaluation.monoLossBeforeDb > MONO_LOSS_LIMIT_DB) return;
    if (evaluation.mixAfter.balance > MIX_BALANCE_LIMIT && evaluation.mixAfter.balance > evaluation.mixBefore.balance + 0.02) return;
    // Solve the conflicts this stem should give way in, where they happen, without crowding anyone else.
    const conflictGain = (evaluation.conflictBefore - evaluation.conflictAfter - evaluation.collateral) / coverage;
    const surroundGain = eligibility.surround && widened ? SURROUND_GAIN * (Math.min(1 - evaluation.correlationAfter, SURROUND_SPREAD) - Math.min(1 - evaluation.correlationBefore, SURROUND_SPREAD)) : 0;
    const monoGain = eligibility.phaseRisk ? MONO_SAFETY_GAIN * (evaluation.monoLossBeforeDb - evaluation.monoLossAfterDb) : 0;
    const cost =
      PAN_COST * Math.abs(delta.pan) +
      PAN_COST_SQUARED * delta.pan * delta.pan +
      widthCost(current.width, delta.width) +
      MONO_COST * Math.max(0, evaluation.monoLossAfterDb - evaluation.monoLossBeforeDb - MONO_LOSS_ALLOWANCE_DB) +
      BALANCE_COST * Math.max(0, evaluation.mixAfter.balance - Math.max(evaluation.mixBefore.balance, MIX_BALANCE_LIMIT * 0.6)) +
      // Only a level rise costs: narrowing a part a little quieter is no risk to headroom or balance.
      LEVEL_COST * Math.max(0, evaluation.levelChangeDb - 0.5) +
      (delta.pan !== 0 && delta.width !== 0 ? COMBINED_COST : 0) +
      extraCost;
    const gain = conflictGain + surroundGain + monoGain - cost;
    if (!best || gain > best.gain + 1e-9) best = { setting, gain, conflictGain, surroundGain, monoGain, evaluation, delta };
  };
  for (const delta of first) consider(delta);
  const anchor = (best as Best | null)?.delta ?? { pan: 0, width: 0 };
  for (const delta of candidates) {
    if (first.includes(delta)) continue;
    if (Math.abs(delta.pan - anchor.pan) <= STEP + 1e-9 && Math.abs(delta.width - anchor.width) <= STEP + 1e-9) consider(delta);
  }
  const chosen = best as Best | null;
  if (!chosen) return null;
  const driver = Math.max(chosen.conflictGain, chosen.surroundGain, chosen.monoGain);
  if (chosen.gain < limits.minBenefit || driver < limits.minBenefit) return null;
  return chosen;
}

function separationMove(
  ctx: Context,
  entry: StereoTrack,
  scope: SpatialScope,
  best: Best,
  evidence: SpatialEvidence,
  eligibility: Eligibility,
  pass: 1 | 2,
  saved: SpatialSetting,
): Move {
  const track = entry.track;
  const searchedFrom = scope.type === "global" ? { pan: track.pan, width: track.width } : resolveSetting(ctx.document, track, scope.sectionId, ctx.overlay.get(track.id));
  const processing = {
    pan: Math.abs(best.setting.pan - searchedFrom.pan) >= 0.005 ? best.setting.pan : null,
    width: Math.abs(best.setting.width - searchedFrom.width) >= 0.005 ? best.setting.width : null,
  };
  const relatedPairs = evidence.scopes.flatMap((item) => item.pairs).filter((pair) => pair.addressed);
  const related = [...new Set(relatedPairs.sort((left, right) => right.priority - left.priority).map((pair) => pair.trackId))].slice(0, 4);
  const interactionIds = [...new Set(relatedPairs.map((pair) => pair.interactionId))].slice(0, 8);
  const purpose: Purpose =
    best.monoGain >= Math.max(best.conflictGain, best.surroundGain)
      ? "mono-safety"
      : best.surroundGain > best.conflictGain
        ? "widen"
        : processing.pan === null && processing.width !== null
          ? processing.width < searchedFrom.width
            ? "narrow"
            : "widen"
          : "separation";
  const pairs = ctx.workingPairs.filter((pair) => interactionIds.includes(pair.id));
  const pairConfidence = pairs.length > 0 ? pairs.reduce((sum, pair) => sum + pair.confidence, 0) / pairs.length : 0.7;
  let confidence = purpose === "separation" || purpose === "narrow" ? pairConfidence : 0.72;
  if (entry.origin === "measurement") confidence -= 0.08;
  if (track.role === "other") confidence -= 0.1;
  if (pairs.some((pair) => pair.protectedId && TIER_RANK[tierIn(ctx, pair.protectedId, pair.scope.key)] === TIER_RANK[tierIn(ctx, track.id, pair.scope.key)])) confidence -= 0.06;
  const improvement = best.evaluation.conflictBefore > 0 ? (best.evaluation.conflictBefore - best.evaluation.conflictAfter) / best.evaluation.conflictBefore : 0;
  confidence += 0.08 * Math.min(1, improvement);
  if (scope.type === "section") confidence -= 0.03;
  if (pass === 2) confidence -= 0.02;
  if (purpose === "widen" && eligibility.sourceCorrelation < 0.5) confidence -= 0.06;
  let forceReview = false;
  let reviewReason: string | null = null;
  if (purpose === "mono-safety" && (processing.width ?? saved.width) < 1 - 0.005) {
    forceReview = true;
    reviewReason = `${track.name} is out of phase between its own channels. Narrowing it below 100% trades width for mono safety, so it waits for review.`;
  }
  return {
    trackId: track.id,
    scope,
    processing,
    purpose,
    relatedIds: related,
    interactionIds,
    confidence,
    forceReview,
    reviewReason,
    pass,
    benefit: best.gain,
    driver: best.monoGain >= Math.max(best.conflictGain, best.surroundGain) ? "mono" : best.surroundGain > best.conflictGain ? "surround" : "conflict",
    explain: (evaluation, move) => separationReasons(ctx, entry, move, saved, evaluation, eligibility),
  };
}

function addMove(ctx: Context, move: Move): void {
  const existing = ctx.moves.find((item) => item.trackId === move.trackId && sameScope(item.scope, move.scope));
  const next = existing && move.purpose === "intent" && existing.purpose !== "intent" ? mergeMoves(existing, move) : move;
  ctx.moves = [...ctx.moves.filter((item) => item !== existing), next];
  ctx.overlay = overlayFor(ctx.document, ctx.moves);
  refreshWorking(ctx, [move.trackId]);
}

/** One row for one stem in one section: a note's value added to a separation row there. */
function mergeMoves(earlier: Move, later: Move): Move {
  return {
    ...earlier,
    processing: { pan: later.processing.pan ?? earlier.processing.pan, width: later.processing.width ?? earlier.processing.width },
    purpose: "intent",
    relatedIds: [...new Set([...earlier.relatedIds, ...later.relatedIds])],
    interactionIds: [...new Set([...earlier.interactionIds, ...later.interactionIds])],
    confidence: Math.min(earlier.confidence, later.confidence),
    forceReview: earlier.forceReview || later.forceReview,
    reviewReason: earlier.reviewReason ?? later.reviewReason,
    benefit: earlier.benefit + later.benefit,
    driver: "intent",
    explain: (evaluation, move) => [...later.explain(evaluation, move).slice(0, 1), ...earlier.explain(evaluation, move)],
  };
}

function refreshWorking(ctx: Context, trackIds: string[]): void {
  ctx.working = withOverlay(ctx.document, ctx.base, ctx.overlay);
  const changed = new Set(trackIds);
  ctx.workingPairs = ctx.workingPairs.map((pair) => {
    if (!changed.has(pair.a) && !changed.has(pair.b)) return pair;
    const a = ctx.working.tracks.get(pair.a)!;
    const b = ctx.working.tracks.get(pair.b)!;
    return { ...pair, heardA: meanStats(a.heard, pair.coSteps), heardB: meanStats(b.heard, pair.coSteps) };
  });
}

function overlayFor(document: ProjectDocument, moves: Move[]): SpatialOverlay {
  const overlay: SpatialOverlay = new Map();
  for (const move of moves) {
    const entry = overlay.get(move.trackId) ?? {};
    if (move.scope.type === "global") {
      const track = document.tracks.find((item) => item.id === move.trackId)!;
      entry.global = { pan: move.processing.pan ?? track.pan, width: move.processing.width ?? track.width };
    } else {
      const sections = entry.sections ?? new Map<string, { pan: number | null; width: number | null }>();
      const existing = sections.get(move.scope.sectionId) ?? { pan: null, width: null };
      sections.set(move.scope.sectionId, { pan: move.processing.pan ?? existing.pan, width: move.processing.width ?? existing.width });
      entry.sections = sections;
    }
    overlay.set(move.trackId, entry);
  }
  return overlay;
}

/* ------------------------------------------------------------------ evidence */

/**
 * The numbers a row is judged on. For a whole-song row: every scope the stem plays in, with saved section
 * overrides that will still win there. For a section row: that section only.
 */
function buildEvidence(ctx: Context, entry: StereoTrack, sectionId: string | null, exclude?: Move): SpatialEvidence {
  const model = ctx.working;
  const track = entry.track;
  const scopes = sectionId ? ctx.partition.filter((scope) => scope.sectionId === sectionId) : ctx.partition;
  const overlay = exclude ? overlayFor(ctx.document, ctx.moves.filter((move) => move !== exclude)) : ctx.overlay;
  const total = activeSteps(entry, 0, model.steps).length;
  const out: SpatialEvidence["scopes"] = [];
  const windows: Array<[number, number]> = [];
  const baseById = new Map(ctx.pairs.map((pair) => [pair.id, pair]));
  for (const scope of scopes) {
    const steps = activeSteps(entry, scope.start, scope.end, model);
    if (steps.length === 0) continue;
    const baseline = resolveSetting(ctx.document, track, scope.sectionId, overlay.get(track.id));
    const savedOverride = scope.sectionId
      ? (overlay.get(track.id)?.sections?.get(scope.sectionId) ?? ctx.document.sectionTrackSettings.find((row) => row.trackId === track.id && row.sectionId === scope.sectionId)?.overrides ?? null)
      : null;
    const rest: Lrc[] = Array.from({ length: STEREO_BANDS }, () => ({ l: 0, r: 0, c: 0 }));
    const restCenter = new Array<number>(STEREO_BANDS).fill(0);
    for (const [otherId, other] of model.tracks) {
      if (otherId === track.id) continue;
      const mean = meanStats(other.heard, steps);
      mean.forEach((stats, band) => {
        rest[band] = { l: rest[band]!.l + stats.l, r: rest[band]!.r + stats.r, c: rest[band]!.c + stats.c };
        restCenter[band] += stereoPower(stats) * fieldShares(occupancy(imageOf(stats))).center;
      });
    }
    const pairs = ctx.workingPairs
      .filter((pair) => pair.scope.key === scope.key && (pair.a === track.id || pair.b === track.id) && pair.outcome !== "level")
      .map((pair) => {
        const self = pair.a === track.id;
        const other = model.tracks.get(self ? pair.b : pair.a)!;
        // Addressed: a conflict this stem should give way in, as the saved mix has it or as it stands now.
        // Judged without this row, so re-reading a kept row does not see its own conflict as already solved.
        const original = baseById.get(pair.id) ?? pair;
        const threshold = ctx.limits.minConflict * 0.75;
        const addressed =
          pair.moverId === track.id &&
          pair.outcome === "mover" &&
          (currentConflict(original).severity * original.priority >= threshold || (!exclude && currentConflict(pair).severity * pair.priority >= threshold));
        return {
          pair,
          trackId: other.track.id,
          interactionId: pair.id,
          addressed,
          priority: round3(Math.min(1, pair.priority)),
          weights: pair.weights.map(round6),
          frequency: round3(pair.frequency),
          activity: round3(Math.min(1, pair.activity)),
          target: toTuples(meanStats(entry.source, pair.coSteps)),
          other: toTuples(meanStats(other.heard, pair.coSteps)),
        };
      })
      .sort((left, right) => Number(right.addressed) - Number(left.addressed) || right.frequency * right.priority - left.frequency * left.priority)
      .slice(0, 8);
    for (const item of pairs) windows.push(...windowsOf(model, item.pair.coSteps));
    out.push({
      key: scope.key,
      name: scope.name,
      sectionId: scope.sectionId,
      weight: total > 0 ? round6(steps.length / total) : 0,
      override: sectionId ? { pan: null, width: null } : { pan: savedOverride?.pan ?? null, width: savedOverride?.width ?? null },
      baseline: { pan: baseline.pan, width: baseline.width },
      target: toTuples(meanStats(entry.source, steps)),
      rest: toTuples(rest),
      restCenter: restCenter.map(round6),
      pairs: pairs.map(({ pair: _pair, ...rest }) => rest),
    });
  }
  if (windows.length === 0) windows.push(...windowsOf(model, activeSteps(entry, sectionId ? scopes[0]?.start ?? 0 : 0, sectionId ? scopes[0]?.end ?? model.steps * model.stepSeconds : model.steps * model.stepSeconds, model)));
  return { mono: entry.mono, edgesHz: ctx.working.edgesHz.map((hz) => Math.round(hz * 100) / 100), scopes: out, windows: mergeWindows(windows).slice(0, 24) };
}

/* ------------------------------------------------------------------ whole plan */

/**
 * Every kept move is re-read with all the others in place. A separation move that no longer removes
 * conflict, or a move that now breaks a safety limit, is dropped.
 */
function wholePlanCheck(ctx: Context): void {
  const dropped: string[] = [];
  for (const move of [...ctx.moves]) {
    if (move.purpose === "intent") continue;
    const entry = ctx.working.tracks.get(move.trackId);
    if (!entry) continue;
    const evidence = buildEvidence(ctx, entry, move.scope.type === "section" ? move.scope.sectionId : null, move);
    const evaluation = evaluateSpatial(evidence, move.processing, move.scope.type === "global");
    const conflictGain = (evaluation.conflictBefore - evaluation.conflictAfter - evaluation.collateral) / conflictCoverage(evidence);
    const unsafe = evaluation.monoLossAfterDb - evaluation.monoLossBeforeDb > MONO_LOSS_LIMIT_DB || (evaluation.mixAfter.balance > MIX_BALANCE_LIMIT && evaluation.mixAfter.balance > evaluation.mixBefore.balance + 0.02);
    const needsConflict = move.purpose === "separation" || move.purpose === "narrow";
    if (unsafe || (needsConflict && conflictGain < ctx.limits.minBenefit * 0.5)) {
      ctx.moves = ctx.moves.filter((item) => item !== move);
      ctx.overlay = overlayFor(ctx.document, ctx.moves);
      refreshWorking(ctx, [move.trackId]);
      dropped.push(ctx.document.tracks.find((track) => track.id === move.trackId)?.name ?? move.trackId);
    }
  }
  if (dropped.length > 0) {
    ctx.notes.push(`With every move in place, ${listNames(dropped)} no longer ${dropped.length === 1 ? "helped" : "helped"} enough and ${dropped.length === 1 ? "was" : "were"} left out.`);
  }
}

/* ------------------------------------------------------------------ output */

function toRecommendations(ctx: Context): SpatialRecommendation[] {
  const trackOrder = new Map(ctx.document.tracks.map((track, index) => [track.id, index]));
  const sectionOrder = new Map(ctx.document.sections.map((section, index) => [section.id, index]));
  const ordered = [...ctx.moves].sort((left, right) => {
    const tracks = (trackOrder.get(left.trackId) ?? 0) - (trackOrder.get(right.trackId) ?? 0);
    if (tracks !== 0) return tracks;
    return (left.scope.type === "global" ? -1 : (sectionOrder.get(left.scope.sectionId) ?? 0)) - (right.scope.type === "global" ? -1 : (sectionOrder.get(right.scope.sectionId) ?? 0));
  });
  return ordered.map((move) => {
    const entry = ctx.working.tracks.get(move.trackId)!;
    const track = entry.track;
    const sectionId = move.scope.type === "section" ? move.scope.sectionId : null;
    const evidence = buildEvidence(ctx, entry, sectionId, move);
    const global = move.scope.type === "global";
    const evaluation = { ...evaluateSpatial(evidence, move.processing, global), passes: move.pass, proxy: null };
    const current = sectionId ? resolveSetting(ctx.document, track, sectionId) : { pan: track.pan, width: track.width };
    const warnings = safetyWarnings({ current, scope: move.scope }, move.processing, evaluation);
    const confidence = Math.max(0.2, Math.min(0.95, round2(move.confidence)));
    const status = move.forceReview || needsReview({ current }, move.processing, confidence, warnings) ? "needs-review" : "proposed";
    const reasons = move.explain(evaluation, move).filter((line) => line.length > 0);
    if (move.reviewReason) reasons.push(move.reviewReason);
    else if (status === "needs-review") reasons.push(confidence < 0.55 ? "Confidence is low, so this waits for review before Apply all." : "This move is larger or riskier than Audiosous applies on its own, so it waits for review.");
    const savedOverride = sectionId ? ctx.document.sectionTrackSettings.find((row) => row.trackId === track.id && row.sectionId === sectionId)?.overrides : undefined;
    return {
      id: spatialRecommendationId(move.trackId, move.scope),
      trackId: move.trackId,
      scope: move.scope,
      processing: { type: "spatial" as const, pan: move.processing.pan, width: move.processing.width },
      current,
      planned: { pan: move.processing.pan, width: move.processing.width },
      replacesOverride: Boolean(savedOverride && ((move.processing.pan !== null && savedOverride.pan !== null) || (move.processing.width !== null && savedOverride.width !== null))),
      relatedTrackIds: move.relatedIds.slice(0, 4),
      interactionIds: move.interactionIds.slice(0, 8),
      purpose: move.purpose,
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      status,
      edited: false,
      reasons: reasons.slice(0, 6).map((line) => (line.length > 600 ? `${line.slice(0, 597)}…` : line)),
      warnings,
      evaluation,
      evidence,
    } satisfies SpatialRecommendation;
  });
}

function interactionList(ctx: Context, changes: SpatialRecommendation[]): SpatialInteraction[] {
  const shown = ctx.pairs.filter((pair) => pair.scope.key === "song" || pair.scope.marked);
  const readings = new Map(shown.map((pair) => [pair.id, currentConflict(pair)]));
  const ranked = [...shown].sort((left, right) => readings.get(right.id)!.severity * right.priority - readings.get(left.id)!.severity * left.priority || left.id.localeCompare(right.id));
  const picked = ranked.filter((pair) => readings.get(pair.id)!.severity >= 0.05).slice(0, 40);
  return picked.map((pair) => {
    const reading = readings.get(pair.id)!;
    const range = conflictRange(pair.weights, ctx.base.edgesHz);
    const outcome = outcomeOf(ctx, pair, reading.severity, changes);
    const moved = changes.find((change) => change.interactionIds.includes(pair.id))?.trackId ?? null;
    return {
      id: pair.id,
      scope: pair.scope.sectionId ? { type: "section" as const, sectionId: pair.scope.sectionId } : { type: "global" as const },
      scopeName: pair.scope.name,
      trackA: pair.a,
      trackB: pair.b,
      tierA: pair.tierA,
      tierB: pair.tierB,
      centerCompetition: round3(clamp01(reading.centerCompetition)),
      stereoOverlap: round3(clamp01(reading.overlap)),
      frequencyOverlap: round3(clamp01(pair.frequency)),
      simultaneousActivity: round3(clamp01(pair.eq.simultaneity)),
      severity: round3(clamp01(reading.severity)),
      confidence: round2(pair.confidence),
      imageA: imageDto(reading.targetImage),
      imageB: imageDto(reading.otherImage),
      lowHz: round2(range.lowHz),
      highHz: round2(range.highHz),
      levelGapDb: round2(pair.levelGapDb),
      protectedTrackId: pair.protectedId,
      movingTrackId: pair.moverId,
      outcome,
      explanation: explainPair(ctx, pair, reading, outcome, moved).slice(0, 600),
    };
  });
}

function outcomeOf(ctx: Context, pair: SpatialPair, severity: number, changes: SpatialRecommendation[]): SpatialInteraction["outcome"] {
  const related = changes.filter((change) => change.interactionIds.includes(pair.id) || (pair.scope.key === "song" && pair.moverId === change.trackId && change.relatedTrackIds.includes(pair.protectedId ?? "")));
  if (related.length > 0) return related.some((change) => change.status === "needs-review") ? "review" : "recommendation";
  if (pair.outcome === "level") return "level";
  if (pair.outcome === "anchors") return "anchors";
  if (pair.outcome === "no-priority") return severity >= ctx.limits.minConflict ? "no-priority" : "below-threshold";
  if (severity * pair.priority < ctx.limits.minConflict) return "below-threshold";
  return pair.frequency >= 0.6 ? "eq" : "no-benefit";
}

function explainPair(ctx: Context, pair: SpatialPair, reading: ReturnType<typeof currentConflict>, outcome: SpatialInteraction["outcome"], moved: string | null): string {
  const a = trackName(ctx, pair.a);
  const b = trackName(ctx, pair.b);
  const range = conflictRange(pair.weights, ctx.base.edgesHz);
  const where = formatRange(range.lowHz, range.highHz);
  const sitting = `${a} sits ${placeWord(reading.targetImage.position)} and ${b} ${placeWord(reading.otherImage.position)}`;
  const together = `they play together ${Math.round(pair.eq.simultaneity * 100)}% of the time${pair.scope.key === "song" ? "" : ` in ${pair.scope.name}`}`;
  switch (outcome) {
    case "recommendation":
    case "review":
      return `${sitting}, they compete at ${where}, and ${together}. The Space plan moves ${trackName(ctx, moved ?? pair.moverId ?? pair.b)}.`;
    case "level":
      return `${trackName(ctx, pair.moverId ?? pair.b)} is ${pair.levelGapDb.toFixed(1)} dB louder than ${trackName(ctx, pair.protectedId ?? pair.a)} at ${where} where ${together}. That is a level problem, not a spatial one; AutoBalance or the fader is the right tool.`;
    case "anchors":
      return `${sitting} and they compete at ${where}, but ${pair.protectedId ? `${trackName(ctx, pair.protectedId === pair.a ? pair.b : pair.a)} is usually kept centered` : "both are usually kept centered"}, so no spatial change was proposed.`;
    case "no-priority":
      return `${sitting} and they compete at ${where}, but both are ${tierWord(pair.tierA)} and neither has a clear priority. No automatic spatial change was proposed.`;
    case "eq":
      return `${sitting}. They compete at ${where} (${Math.round(pair.frequency * 100)}% of the more important part's space) and ${together}, but moving in the field would not separate them enough. A frequency fix in the EQ plan suits this better.`;
    case "no-benefit":
      return `${sitting}. They compete at ${where} and ${together}, but no move inside the limits helped enough to be worth it.`;
    default:
      return `${sitting}. They ${pair.frequency >= 0.3 ? `compete at ${where}` : "share little of the spectrum"}, and overlap ${reading.overlap.toFixed(2)} in the field there, so the conflict (${reading.severity.toFixed(2)}) is below the threshold.`;
  }
}

function summarize(ctx: Context, changes: SpatialRecommendation[]): SpatialPlan["summary"] {
  const { base } = ctx;
  const reviewCount = changes.filter((change) => change.status === "needs-review").length;
  const sections = changes.filter((change) => change.scope.type === "section").length;
  const pans = changes.filter((change) => change.processing.pan !== null).length;
  const widths = changes.filter((change) => change.processing.width !== null).length;
  const notes: string[] = [];
  const muted = base.spectral.skipped.filter((item) => item.reason === "muted").length;
  const unmeasured = base.spectral.skipped.filter((item) => item.reason === "unmeasured").length;
  if (unmeasured > 0) notes.push(`${unmeasured} ${unmeasured === 1 ? "stem has" : "stems have"} no analysis yet and ${unmeasured === 1 ? "was" : "were"} left out.`);
  if (muted > 0) notes.push(`${muted} muted ${muted === 1 ? "stem was" : "stems were"} left out.`);
  const congestion = centerNote(ctx);
  if (congestion) notes.push(congestion);
  notes.push(...[...ctx.levelNotes.values()].slice(0, 2));
  notes.push(...[...new Set(ctx.notes)].slice(0, 5));
  const unordered = new Set(ctx.pairs.map((pair) => [pair.a, pair.b].sort().join("|")));
  let headline: string;
  if (base.tracks.size < 2) headline = "Spatial planning needs at least two measured, unmuted stems.";
  else if (changes.length === 0) headline = "No high-confidence spatial changes. The parts that compete in frequency already sit apart in the field, or the conflicts belong to level or EQ.";
  else {
    const kinds = [pans > 0 ? `pan or balance on ${pans}` : "", widths > 0 ? `width on ${widths}` : ""].filter(Boolean).join(" and ");
    headline = [`Space found ${changes.length} recommended ${changes.length === 1 ? "change" : "changes"}, setting ${kinds}.`, sections > 0 ? `${sections} ${sections === 1 ? "is" : "are"} section-specific.` : "", reviewCount > 0 ? `${reviewCount} ${reviewCount === 1 ? "needs" : "need"} review.` : ""]
      .filter(Boolean)
      .join(" ");
  }
  const confidence = changes.length === 0 ? clamp(0.82 - 0.05 * unmeasured, 0.4, 0.9) : clamp(round2(changes.reduce((sum, change) => sum + change.confidence, 0) / changes.length - 0.04 * unmeasured), 0.2, 0.95);
  const proxy = [...base.tracks.values()].filter((entry) => entry.origin === "proxy-stereo").length;
  const analysisSource =
    proxy === base.tracks.size
      ? "Position, width, and correlation come from stereo frames measured on the 48 kHz playback proxies."
      : proxy === 0
        ? "No proxy stereo frames: position and width come from each stem's whole-file balance and mid/side levels, so they do not change over time."
        : `${proxy} of ${base.tracks.size} stems have proxy stereo frames; the rest use whole-file balance and mid/side levels.`;
  return { goal: "separation", confidence, headline, notes: notes.slice(0, 10), changeCount: changes.length, reviewCount, pairsAnalyzed: unordered.size, analysisSource };
}

/** Names the stems sharing the middle where the center is most crowded. Context, not a target. */
function centerNote(ctx: Context): string | null {
  let worst: { scope: AnalysisScope; names: string[] } | null = null;
  for (const scope of ctx.partition) {
    const names: string[] = [];
    for (const track of ctx.document.tracks) {
      const entry = ctx.base.tracks.get(track.id);
      if (!entry) continue;
      const steps = activeSteps(entry, scope.start, scope.end, ctx.base);
      if (steps.length < Math.max(2, stepsIn(ctx.base, scope.start, scope.end).length * 0.4)) continue;
      const shares = fieldShares(occupancy(imageOf(sumBands(meanStats(entry.heard, steps)))));
      if (shares.center >= 0.6) names.push(track.name);
    }
    if (!worst || names.length > worst.names.length) worst = { scope, names };
  }
  if (!worst || worst.names.length < 4) return null;
  return `Center: ${worst.names.length} stems sit in the middle of the field${worst.scope.key === "song" ? "" : ` in ${worst.scope.name}`} (${listNames(worst.names.slice(0, 6))}${worst.names.length > 6 ? ", …" : ""}). That is only a problem where they also compete in frequency.`;
}

function fieldsOf(ctx: Context): SpatialPlan["fields"] {
  const scopes = ctx.analysis.scopes.filter((scope) => scope.key === "song" || scope.marked).slice(0, 24);
  return scopes.map((scope) => {
    const tracks = ctx.document.tracks
      .map((track) => {
        const entry = ctx.base.tracks.get(track.id);
        if (!entry) return null;
        const steps = activeSteps(entry, scope.start, scope.end, ctx.base);
        if (steps.length === 0) return null;
        const image = imageOf(sumBands(meanStats(entry.heard, steps)));
        return { trackId: track.id, image: imageDto(image), power: image.power, tier: tierIn(ctx, track.id, scope.key), mono: entry.mono };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    const loudest = Math.max(1e-20, ...tracks.map((item) => item.power));
    return {
      key: scope.key,
      name: scope.name,
      sectionId: scope.sectionId,
      tracks: tracks.slice(0, 64).map((item) => ({ trackId: item.trackId, image: item.image, levelDb: round2(10 * Math.log10(Math.max(item.power, 1e-20) / loudest)), tier: item.tier, mono: item.mono })),
    };
  });
}

function mixMetrics(model: StereoModel, scopes: AnalysisScope[]): MixMetrics {
  let centerPower = 0;
  let power = 0;
  let balance = 0;
  const sum: Lrc = { l: 0, r: 0, c: 0 };
  for (const scope of scopes) {
    const steps = stepsIn(model, scope.start, scope.end);
    if (steps.length === 0) continue;
    const weight = steps.length / model.steps;
    const scopeSum: Lrc = { l: 0, r: 0, c: 0 };
    for (const entry of model.tracks.values()) {
      for (const stats of meanStats(entry.heard, steps)) {
        const p = stereoPower(stats);
        centerPower += weight * p * fieldShares(occupancy(imageOf(stats))).center;
        power += weight * p;
        scopeSum.l += stats.l;
        scopeSum.r += stats.r;
        scopeSum.c += stats.c;
      }
    }
    sum.l += weight * scopeSum.l;
    sum.r += weight * scopeSum.r;
    sum.c += weight * scopeSum.c;
    const total = scopeSum.l + scopeSum.r;
    if (total > 0) balance = Math.max(balance, Math.abs(scopeSum.r - scopeSum.l) / total);
  }
  const image = imageOf(sum);
  return { centerLoad: round3(power > 0 ? Math.min(1, centerPower / power) : 0), balance: round3(Math.min(1, balance)), correlation: round3(image.correlation), monoLossDb: round2(image.monoLossDb) };
}

/* ------------------------------------------------------------------ reasons */

function separationReasons(
  ctx: Context,
  entry: StereoTrack,
  move: Move,
  saved: SpatialSetting,
  evaluation: Omit<SpatialEvaluation, "passes" | "proxy">,
  eligibility: Eligibility,
): string[] {
  const track = entry.track;
  const sectionName = move.scope.type === "section" ? ctx.document.sections.find((section) => section.id === (move.scope as { sectionId: string }).sectionId)?.name : null;
  const change = describeChange(track, saved, move.processing, sectionName ? ` in ${sectionName}` : "");
  const lines: string[] = [];
  if (move.purpose === "mono-safety") {
    const widened = saved.width > 1.05 ? ` at its saved ${describeWidth(saved.width)}` : "";
    lines.push(
      `${change} because its correlation is ${evaluation.correlationBefore.toFixed(2)}${widened}: folded to mono it loses ${evaluation.monoLossBeforeDb.toFixed(1)} dB. With this change correlation is ${evaluation.correlationAfter.toFixed(2)} and the loss is ${evaluation.monoLossAfterDb.toFixed(1)} dB.`,
    );
    if (move.processing.pan !== null) lines.push(safetyLine(track, evaluation));
    return lines;
  }
  if (move.driver === "surround") {
    const anchors = centerAnchorsNames(ctx, entry);
    lines.push(
      `${change} because ${track.name} is a Background part, its recorded correlation is healthy (${eligibility.sourceCorrelation.toFixed(2)}), and the center already holds ${anchors.length > 0 ? listNames(anchors) : "most of the mix"} while it plays.`,
    );
    lines.push(safetyLine(track, evaluation));
    return lines;
  }
  const pairs = ctx.workingPairs.filter((pair) => move.interactionIds.includes(pair.id));
  // The headline names the stem this one gives way to: pairs where it is the mover first.
  const weight = (pair: SpatialPair) => currentConflict(pair).severity * pair.priority + (pair.moverId === track.id ? 10 : 0);
  const main = [...ctx.pairs.filter((pair) => move.interactionIds.includes(pair.id))].sort((left, right) => weight(right) - weight(left) || left.id.localeCompare(right.id))[0];
  if (!main) {
    lines.push(`${change}.`);
    lines.push(safetyLine(track, evaluation));
    return lines;
  }
  const otherId = main.a === track.id ? main.b : main.a;
  const other = ctx.document.tracks.find((item) => item.id === otherId)!;
  const otherHeard = main.a === track.id ? main.heardB : main.heardA;
  const otherImage = imageOf(sumBands(otherHeard.map((stats, band) => scale(stats, main.weights[band] ?? 0))));
  const range = conflictRange(main.weights, ctx.base.edgesHz);
  // When the two compete: the scopes of this stem's pairs with the main competitor only.
  const withOther = pairs.filter((pair) => pair.a === otherId || pair.b === otherId);
  const scopes = new Set(withOther.map((pair) => pair.scope.key));
  const when =
    move.scope.type === "section"
      ? `in ${sectionName}`
      : scopes.size <= 1
        ? main.scope.marked
          ? `during ${main.eq.simultaneity >= 0.8 ? "most of " : ""}the ${main.scope.name}`
          : main.scope.key === "song"
            ? "across the song"
            : "in the unmarked time"
        : `in ${listNames([...new Set(withOther.map((pair) => (pair.scope.marked ? pair.scope.name : "the unmarked time")))].slice(0, 3))}`;
  const otherTier = tierIn(ctx, other.id, main.scope.key);
  const ownTier = tierIn(ctx, track.id, main.scope.key);
  const wide = (image: { spread: number }) => image.spread >= 0.6;
  const both = move.purpose === "narrow" && wide(otherImage) ? `both occupy nearly the same stereo width and frequency range` : `it overlaps the ${placeWord(otherImage.position)} ${other.name} from ${formatRange(range.lowHz, range.highHz)}`;
  const tiers =
    TIER_RANK[otherTier] !== TIER_RANK[ownTier]
      ? `${other.name} is ${tierWord(otherTier)} and ${track.name} is ${tierWord(ownTier)}.`
      : `Both are ${tierWord(ownTier)}; ${other.name} is the louder of the two there.`;
  lines.push(`${change} because ${both} ${when}. ${tiers}`);
  lines.push(
    `Where they compete, their overlap in the field drops from ${evaluation.overlapBefore.toFixed(2)} to ${evaluation.overlapAfter.toFixed(2)} and the weighted conflict from ${evaluation.conflictBefore.toFixed(2)} to ${evaluation.conflictAfter.toFixed(2)}.`,
  );
  lines.push(safetyLine(track, evaluation));
  if (pairs.length > 1) {
    const others = [...new Set(pairs.map((pair) => (pair.a === track.id ? pair.b : pair.a)).filter((id) => id !== other.id))].map((id) => trackName(ctx, id));
    if (others.length > 0) lines.push(`It also eases ${track.name}'s overlap with ${listNames(others.slice(0, 3))}.`);
  }
  return lines;
}

function safetyLine(track: Track, evaluation: Omit<SpatialEvaluation, "passes" | "proxy">): string {
  const corr = Math.abs(evaluation.correlationAfter - evaluation.correlationBefore) < 0.02 ? `stays at ${evaluation.correlationAfter.toFixed(2)}` : `goes from ${evaluation.correlationBefore.toFixed(2)} to ${evaluation.correlationAfter.toFixed(2)}`;
  const mono = Math.abs(evaluation.monoLossAfterDb - evaluation.monoLossBeforeDb) < 0.1 ? "its mono fold-down does not change" : `folded to mono it loses ${evaluation.monoLossAfterDb.toFixed(1)} dB instead of ${evaluation.monoLossBeforeDb.toFixed(1)} dB`;
  return `${track.name}'s correlation ${corr} and ${mono}.`;
}

function describeChange(track: Track, from: SpatialSetting, processing: { pan: number | null; width: number | null }, where: string): string {
  const parts: string[] = [];
  const mono = track.metadata.channelCount < 2;
  if (processing.pan !== null && Math.abs(processing.pan - from.pan) >= 0.005) {
    const delta = processing.pan - from.pan;
    const amount = `${Math.round(Math.abs(delta) * 100)}% ${delta < 0 ? "left" : "right"}`;
    parts.push(
      Math.abs(from.pan) < 0.005
        ? `Moved ${track.name}${where} ${amount}`
        : `Moved ${track.name}'s ${mono ? "pan" : "balance"}${where} from ${describePan(from.pan)} to ${describePan(processing.pan)}`,
    );
  }
  if (processing.width !== null && Math.abs(processing.width - from.width) >= 0.005) {
    const verb = processing.width < from.width ? "narrowed" : "widened";
    parts.push(parts.length === 0 ? `${capitalize(verb)} ${track.name}${where} from ${describeWidth(from.width)} to ${describeWidth(processing.width)}` : `${verb} it from ${describeWidth(from.width)} to ${describeWidth(processing.width)}`);
  }
  if (processing.pan !== null && Math.abs(processing.pan) < 0.005 && Math.abs(from.pan) >= 0.005 && parts.length === 0) parts.push(`Centered ${track.name}${where}`);
  return parts.length > 0 ? parts.join(" and ") : `Kept ${track.name}${where} as it is`;
}

function centerAnchorsNames(ctx: Context, entry: StereoTrack): string[] {
  const steps = activeSteps(entry, 0, ctx.working.steps);
  const names: string[] = [];
  for (const [id, other] of ctx.working.tracks) {
    if (id === entry.track.id || !CENTER_ANCHORS.has(other.track.role)) continue;
    const together = steps.filter((step) => other.active[step] === 1);
    if (together.length < steps.length * 0.3) continue;
    const shares = fieldShares(occupancy(imageOf(sumBands(meanStats(other.heard, together)))));
    if (shares.center >= 0.6) names.push(other.track.name);
  }
  return names.slice(0, 4);
}

/* ------------------------------------------------------------------ helpers */

function activeSteps(entry: StereoTrack, start: number, end: number, model?: StereoModel): number[] {
  if (model) return stepsIn(model, start, end).filter((step) => entry.active[step] === 1);
  const out: number[] = [];
  for (let step = start; step < end; step += 1) if (entry.active[step] === 1) out.push(step);
  return out;
}

function scopeBounds(ctx: Context, sectionId: string): [number, number] {
  const scope = ctx.partition.find((item) => item.sectionId === sectionId);
  return scope ? [scope.start, scope.end] : [0, 0];
}

function sourceImage(entry: StereoTrack, steps: number[]) {
  return imageOf(sumBands(meanStats(entry.source, steps)));
}

/**
 * Share of the stem's playing time covered by the conflicts a row addresses. Benefits are read where the
 * conflict happens, so a Chorus-only clash counts in full; side effects elsewhere count against that.
 * A row with nothing to address (surround, mono safety) has coverage 1.
 */
function conflictCoverage(evidence: SpatialEvidence): number {
  const covered = evidence.scopes.filter((scope) => scope.pairs.some((pair) => pair.addressed)).reduce((sum, scope) => sum + scope.weight, 0);
  return covered > 1e-6 ? Math.min(1, covered) : 1;
}

/** The side of the field with less energy where the stem plays, +1 right or −1 left. Right on a tie. */
function lighterSide(evidence: SpatialEvidence): number {
  let left = 0;
  let right = 0;
  for (const scope of evidence.scopes) {
    for (const [l, r] of scope.rest) {
      left += scope.weight * l;
      right += scope.weight * r;
    }
  }
  return left < right * 0.98 ? -1 : 1;
}

function windowsOf(model: StereoModel, steps: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const step of steps) {
    const start = step * model.stepSeconds;
    const end = start + model.stepSeconds;
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - start) < 1e-6) last[1] = end;
    else out.push([start, end]);
  }
  return out;
}

function mergeWindows(windows: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...windows].sort((left, right) => left[0] - right[0]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1e-6) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out
    .sort((left, right) => right[1] - right[0] - (left[1] - left[0]) || left[0] - right[0])
    .slice(0, 24)
    .map(([start, end]) => [Math.round(start * 1000) / 1000, Math.round(end * 1000) / 1000] as [number, number])
    .sort((left, right) => left[0] - right[0]);
}

function tierIn(ctx: Context, trackId: string, scopeKey: string): Tier {
  return ctx.analysis.tiers.get(trackId)?.get(scopeKey)?.tier ?? "unknown";
}

function tierWord(tier: Tier | string): string {
  switch (tier) {
    case "focal":
      return "Focal";
    case "primary":
      return "Primary";
    case "supporting":
      return "Supporting";
    case "background":
      return "Background";
    default:
      return "";
  }
}

function placeWord(position: number): string {
  if (Math.abs(position) < 0.08) return "centered";
  return `${Math.round(Math.abs(position) * 100)}% ${position < 0 ? "left" : "right"}`;
}

function trackIndex(ctx: Context, trackId: string): number {
  return ctx.document.tracks.findIndex((track) => track.id === trackId);
}

function trackName(ctx: Context, trackId: string): string {
  const track = ctx.document.tracks.find((item) => item.id === trackId);
  return track ? track.name : trackId;
}

/** "1.5–4 kHz", "630 Hz–3.6 kHz". */
export function formatRange(lowHz: number, highHz: number): string {
  if (lowHz >= 1_000) return `${formatHz(lowHz).replace(" kHz", "")}–${formatHz(highHz)}`;
  return `${formatHz(lowHz)}–${formatHz(highHz)}`;
}

export function formatHz(hz: number): string {
  if (hz >= 1_000) {
    const khz = hz / 1_000;
    return `${Number(khz >= 10 ? khz.toFixed(0) : khz.toFixed(1)).toString()} kHz`;
  }
  return `${Math.round(hz)} Hz`;
}

function listNames(names: string[], joiner = "and"): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${joiner} ${names[names.length - 1]}`;
}

function sameScope(left: SpatialScope, right: SpatialScope): boolean {
  return left.type === right.type && (left.type === "global" || left.sectionId === (right as { sectionId: string }).sectionId);
}

function trimQuote(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function scale(stats: Lrc, factor: number): Lrc {
  return { l: stats.l * factor, r: stats.r * factor, c: stats.c * factor };
}

function toTuples(stats: Lrc[]): Array<[number, number, number]> {
  return stats.map((value) => [round6(value.l), round6(value.r), round6(value.c)]);
}

/** Six significant figures: enough for the evaluation, small in JSON. */
function round6(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  return Number(value.toPrecision(6));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

