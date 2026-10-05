import { ANALYSIS_ENGINE_VERSION, type EqBandFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import { TIER_RANK, formatSignedDb, type SourceFingerprint, type Tier } from "@audiosous/balance-planner";
import {
  EQ_FILTER_LABELS,
  MAX_SECTION_EQ_NODES,
  MAX_TRACK_EQ_NODES,
  isPassFilter,
  normalizeEqFilter,
  sectionEqNodes,
  trackEqNodes,
  type EqFilter,
  type EqNode,
  type ProjectDocument,
  type Track,
} from "@audiosous/project-model";
import {
  activityFactor,
  analyzeInteractions,
  assessDirection,
  maskCurve,
  meanBands,
  roleLabel,
  separation,
  stereoFactor,
  type ConflictRegion,
  type DirectionResult,
  type InteractionAnalysis,
  type PairAnalysis,
} from "./interaction";
import {
  describeFilter,
  eqPlanSchema,
  eqPlanStateIdentity,
  eqRecommendationId,
  evaluateFilter,
  formatHz,
  labelConfidence,
  needsReview,
  refreshEqTrim,
  type EqEvaluation,
  type EqEvidence,
  type EqPlan,
  type EqRecommendation,
  type EqScope,
  type TrackInteraction,
} from "./plan";
import { bandPowerGain, chainMagnitudeDb, qForOctaves } from "./response";
import {
  AUTO_MIN_CUT_DB,
  BROAD_Q_MAX,
  DEFAULT_EQ_SETTINGS,
  EQ_LIMITS_BY_STRENGTH,
  EQ_PLAN_VERSION,
  EQ_PLANNER_VERSION,
  LEVEL_PROBLEM_DB,
  type EqLimits,
  type EqSettings,
} from "./settings";
import { GRID_BANDS, buildSpectralModel, stepsIn, toDb, type SpectralModel, type TrackSpectra } from "./spectra";
import { readTonalNotes, tonalEvidence, type TonalRequest } from "./tonal";

export interface PlanEqInput {
  document: ProjectDocument;
  /** Whole-track measurements from the analysis cache, keyed by track id. */
  measurements: Record<string, TrackFileMeasurement | null | undefined>;
  /** Proxy band frames, keyed by track id. Without them the sidecar spectrogram is used, which is coarse below a few hundred Hz. */
  bands?: Record<string, EqBandFrames | null | undefined>;
  settings?: Partial<EqSettings>;
  fingerprints?: SourceFingerprint[];
  now?: string;
  /** Receives each stage's candidate filters. For acceptance scripts and debugging; the plan does not depend on it. */
  trace?: (stage: string, detail: unknown) => void;
}

type Purpose = EqRecommendation["purpose"];

interface Move {
  trackId: string;
  scope: EqScope;
  filter: EqFilter;
  purpose: Purpose;
  protectedIds: string[];
  interactionIds: string[];
  confidence: number;
  reasons: string[];
  severity: number;
  priority: number;
  evidence: EqEvidence;
  replacesNodeId: string | null;
  forceReview: boolean;
  targetTier: Tier;
  /** Steps and direction used to re-check the move on a re-filtered model. */
  check: { victimId: string; maskerId: string; steps: number[]; victimTier: Tier; scale: number } | null;
  evaluation: EqEvaluation | null;
  benefit: number;
  /** Renders the first reason from the final filter, so later resizing never leaves stale numbers. */
  headline?: (filter: EqFilter) => string;
}

interface Context {
  document: ProjectDocument;
  model: SpectralModel;
  analysis: InteractionAnalysis;
  limits: EqLimits;
  notes: string[];
  /** Interaction id → outcome decided by the planner. */
  outcomes: Map<string, TrackInteraction["outcome"]>;
  /** One "this is a level problem" note per protected track. */
  levelNotes: Map<string, string>;
  /** Saved nodes an earlier pass already replaced. */
  replaced: Set<string>;
  bands: PlanEqInput["bands"];
}

const REGION_AGREE_OCTAVES = 0.75;
const MERGE_OCTAVES = 0.6;

/**
 * Deterministic static-EQ plan. Measurements stay measurements; this decides what they imply.
 * Same project, analysis, roles, intent, gains, saved EQ, and settings give the same plan.
 */
export function planEq(input: PlanEqInput): EqPlan {
  const settings: EqSettings = { strength: input.settings?.strength ?? DEFAULT_EQ_SETTINGS.strength };
  const limits = EQ_LIMITS_BY_STRENGTH[settings.strength];
  const { document } = input;
  const model = buildSpectralModel({ document, measurements: input.measurements, bands: input.bands });
  const analysis = analyzeInteractions(document, model);
  const ctx: Context = { document, model, analysis, limits, notes: [], outcomes: new Map(), levelNotes: new Map(), replaced: new Set(), bands: input.bands };

  let moves: Move[] = [
    ...separationMoves(ctx),
    ...kickBassReviewMoves(ctx),
    ...lowEndMoves(ctx),
    ...highEndMoves(ctx),
    ...tonalMoves(ctx),
    ...presenceMoves(ctx),
  ];
  const trace = (stage: string) =>
    input.trace?.(stage, moves.map((move) => ({ track: move.trackId, scope: move.scope, filter: move.filter, purpose: move.purpose, evaluation: move.evaluation, benefit: move.benefit })));
  trace("candidates");
  moves = withSavedFilters(ctx, moves);
  moves = mergeMoves(ctx, moves);
  moves = stackOnGlobal(ctx, moves);
  trace("merged");
  moves = evaluateMoves(ctx, moves);
  trace("evaluated");
  moves = regularize(ctx, moves);
  trace("regularized");
  const corrections = correctionPass(ctx, moves, input.measurements);
  if (corrections.length > 0) {
    ctx.notes.push(
      `A second pass, with the first ${moves.length === 1 ? "filter" : "filters"} in place, found ${corrections.length} more ${corrections.length === 1 ? "conflict" : "conflicts"} worth a filter.`,
    );
    moves = [...moves, ...corrections];
    trace("corrected");
  }
  const simulation = simulate(ctx, moves);
  moves = simulation.moves;

  const changes = toRecommendations(ctx, moves);
  for (const move of moves) {
    const outcome = changes.find((change) => change.interactionIds.some((id) => move.interactionIds.includes(id)))?.status === "needs-review" ? "review" : "recommendation";
    for (const id of move.interactionIds) ctx.outcomes.set(id, outcome);
  }
  const interactions = interactionList(ctx);
  const summary = summarize(ctx, changes, simulation.note);
  const draft: EqPlan = {
    planVersion: EQ_PLAN_VERSION,
    plannerVersion: EQ_PLANNER_VERSION,
    kind: "frequency-balance",
    createdAt: input.now ?? new Date().toISOString(),
    projectId: document.project.id,
    sourceAnalysisVersion: ANALYSIS_ENGINE_VERSION,
    settings,
    stateIdentity: eqPlanStateIdentity(document, settings, input.fingerprints ?? []),
    summary,
    changes,
    interactions,
    candidateTrim: { gainDb: 0, reason: null },
    levels: document.tracks.map((track) => ({
      trackId: track.id,
      peakDbfs: input.measurements[track.id]?.levels.peakDbfs ?? null,
      muted: track.muted,
      gainDb: track.gainDb,
      shares: shares(model.tracks.get(track.id), model),
    })),
  };
  return eqPlanSchema.parse(refreshEqTrim(draft));
}

/* ------------------------------------------------------------------ separation */

/** Pairs with a clear hierarchy: the lower tier yields where the two compete. */
function separationMoves(ctx: Context): Move[] {
  const { analysis, document, limits } = ctx;
  const hasSections = document.sections.length > 0;
  const evidencePairs = analysis.pairs.filter((pair) => (hasSections ? pair.scope.key !== "song" : pair.scope.key === "song"));
  const groups = new Map<string, PairAnalysis[]>();
  for (const pair of evidencePairs) {
    if (!pair.protectedId || !pair.yieldingId) continue;
    // Only a Primary or Focal part makes another part give way. Supporting parts share their space.
    const protectedTier = pair.a.track.id === pair.protectedId ? pair.tierA : pair.tierB;
    if (protectedTier !== "primary" && protectedTier !== "focal") {
      ctx.outcomes.set(pair.id, "below-threshold");
      continue;
    }
    const key = `${pair.yieldingId}>${pair.protectedId}`;
    groups.set(key, [...(groups.get(key) ?? []), pair]);
  }
  const moves: Move[] = [];
  for (const key of orderedKeys(document, groups)) {
    const pairs = groups.get(key)!;
    const yieldingId = pairs[0]!.yieldingId!;
    const protectedId = pairs[0]!.protectedId!;
    const yielder = ctx.model.tracks.get(yieldingId)!;
    const conflicts = pairs.filter((pair) => {
      const result = directionOf(pair, protectedId);
      return result.severity >= limits.minSeverity && result.regions.length > 0;
    });
    for (const pair of pairs) if (!conflicts.includes(pair)) ctx.outcomes.set(pair.id, "below-threshold");
    if (conflicts.length === 0) continue;
    const center = weightedCenterOf(conflicts.map((pair) => ({ hz: directionOf(pair, protectedId).regions[0]!.centerHz, weight: pair.coSeconds })));
    const agreeing = conflicts.filter((pair) => Math.abs(Math.log2(directionOf(pair, protectedId).regions[0]!.centerHz / center)) <= REGION_AGREE_OCTAVES);
    const agreeCo = agreeing.reduce((sum, pair) => sum + pair.coSeconds, 0);
    const yielderActive = activeSeconds(ctx.model, yielder, hasSections ? null : { start: 0, end: ctx.model.durationSeconds });
    const global = !hasSections || agreeCo / Math.max(1e-6, yielderActive) >= 0.5;
    const used = new Set<PairAnalysis>();
    if (global) {
      const move = separationMove(ctx, agreeing, protectedId, yieldingId, { type: "global" });
      if (move) {
        moves.push(move);
        for (const pair of agreeing) used.add(pair);
        const songPair = analysis.pairs.find((pair) => pair.scope.key === "song" && sameTracks(pair, yieldingId, protectedId));
        if (songPair) move.interactionIds.push(songPair.id);
      }
    }
    for (const pair of conflicts) {
      if (used.has(pair) || !pair.scope.marked || !pair.scope.sectionId) continue;
      const result = directionOf(pair, protectedId);
      const explicitHere = (pair.a.track.id === protectedId ? pair.explicitA : pair.explicitB) || (pair.a.track.id === yieldingId ? pair.explicitA : pair.explicitB);
      const protector = ctx.model.tracks.get(protectedId)!;
      const concentrated = activeSeconds(ctx.model, protector, { start: pair.scope.start, end: pair.scope.end }) >= 0.7 * activeSeconds(ctx.model, protector, null);
      // A section filter needs a reason the rest of the song does not have: stated intent there,
      // or a protected part that plays mostly in that section.
      if ((!explicitHere && !concentrated) || result.severity < limits.minSeverity) {
        ctx.outcomes.set(pair.id, "below-threshold");
        continue;
      }
      const move = separationMove(ctx, [pair], protectedId, yieldingId, { type: "section", sectionId: pair.scope.sectionId });
      if (move) moves.push(move);
    }
  }
  return moves;
}

function separationMove(
  ctx: Context,
  pairs: PairAnalysis[],
  protectedId: string,
  yieldingId: string,
  scope: EqScope,
): Move | null {
  const { model, limits } = ctx;
  const victim = model.tracks.get(protectedId)!;
  const masker = model.tracks.get(yieldingId)!;
  const steps = [...new Set(pairs.flatMap((pair) => pair.coSteps))].sort((left, right) => left - right);
  const victimTier = scope.type === "global" ? tierOf(ctx, protectedId, "song") : tierOf(ctx, protectedId, scope.sectionId);
  const maskerTier = scope.type === "global" ? tierOf(ctx, yieldingId, "song") : tierOf(ctx, yieldingId, scope.sectionId);
  const meanVictim = meanBands(victim, steps);
  const meanMasker = meanBands(masker, steps);
  const simultaneity = weighted(pairs, (pair) => pair.simultaneity);
  const coverage = weighted(pairs, (pair) => pair.coverage);
  const scale = activityFactor(simultaneity, coverage) * stereoFactor(separation(victim, masker));
  const result = assessDirection(model.grid, victim, masker, meanVictim, meanMasker, victimTier, steps, scale);
  const region = result.regions[0];
  if (!region || result.severity < limits.minSeverity) return null;
  const kind = pairs[0]!.kind;
  // Everything else playing at the same time. A cut is judged against this, not against one competitor alone.
  const context = new Float64Array(GRID_BANDS);
  for (const other of model.tracks.values()) {
    if (other.track.id === protectedId) continue;
    meanBands(other, steps).forEach((value, band) => (context[band] += value));
  }
  let contextRegion = 0;
  let victimRegion = 0;
  for (let band = region.lowBand; band <= region.highBand; band += 1) {
    contextRegion += context[band]!;
    victimRegion += meanVictim[band]!;
  }
  const buried = toDb(contextRegion) - toDb(victimRegion);
  // A saved boost on the competitor inside the conflict is the first thing to undo, and undoing it is allowed beyond the cut limit.
  const boostNode = savedBoostIn(ctx, yieldingId, scope, model.grid.edges[region.lowBand]!, model.grid.edges[region.highBand + 1]!);
  const correctionCap = limits.maxCutDb + (boostNode?.boostDb ?? 0);
  if (Math.min(region.levelDifferenceDb, buried) - correctionCap > LEVEL_PROBLEM_DB) {
    for (const pair of pairs) ctx.outcomes.set(pair.id, "level");
    ctx.levelNotes.set(
      protectedId,
      `${victim.track.name} sits ${buried.toFixed(0)} dB under the rest of the mix in ${formatRange(region.lowHz, region.highHz)}${scope.type === "section" ? ` in ${pairs[0]!.scope.name}` : ""}, and ${masker.track.name} alone is ${region.levelDifferenceDb.toFixed(0)} dB above it there. A conservative EQ cut cannot close that, so no filter was planned. Level or arrangement is the better fix.`,
    );
    return null;
  }
  // Target gap after the move, read off the competition curve: about 0.3 for Focal, 0.4 otherwise.
  const margin = kind === "kick-bass" ? 3 : victimTier === "focal" || maskerTier === "background" ? 6 : 4;
  const need = region.levelDifferenceDb + margin;
  const raw = need * limits.correctionMix * (0.6 + 0.4 * result.severity);
  if (raw < AUTO_MIN_CUT_DB) {
    for (const pair of pairs) ctx.outcomes.set(pair.id, "below-threshold");
    return null;
  }
  const gainDb = -Math.min(correctionCap, raw);
  const octaves = Math.log2(region.highHz / region.lowHz);
  const [qLow, qHigh] = kind === "kick-bass" ? [0.9, BROAD_Q_MAX] : [0.6, BROAD_Q_MAX];
  const q = clamp(qForOctaves(Math.max(0.5, octaves * 0.8)), qLow, qHigh);
  const centerHz = placeCenter(victim, masker, region, kind);
  // Undoing a saved boost stops at a shallow cut; deeper carving is a separate decision with its own limits.
  const filter = boostNode
    ? normalizeEqFilter({ ...boostNode.node.filter, gainDb: roundTenth(Math.max(-1, boostNode.node.filter.gainDb + gainDb)) })
    : normalizeEqFilter({ kind: "bell", frequencyHz: musicalFrequency(centerHz), gainDb: roundTenth(gainDb), q: roundTenth(q) });
  const confidence = separationConfidence(ctx, pairs, protectedId, yieldingId, result, region, victimTier, maskerTier, scope);
  const scopeNames = [...new Set(pairs.filter((pair) => pair.scope.marked).map((pair) => pair.scope.name))];
  const headline = (final: EqFilter) =>
    boostNode
      ? `Reduce ${masker.track.name}'s saved ${lowerFirst(describeFilter(boostNode.node.filter))} to ${final.gainDb > 0 ? formatSignedDb(final.gainDb) : final.gainDb === 0 ? "0" : final.gainDb.toFixed(1)} dB because it pushes ${masker.track.name} ${region.levelDifferenceDb >= 0 ? `${region.levelDifferenceDb.toFixed(1)} dB above` : "close to"} ${victim.track.name} in ${formatRange(region.lowHz, region.highHz)} while they play together, and ${victim.track.name} is ${tierPhrase(ctx, victim.track, victimTier, scope, pairs)}. This should improve separation.`
      : separationReasons(ctx, victim.track, masker.track, final, region, victimTier, scope, scopeNames, pairs, kind)[0]!;
  const reasons = separationReasons(ctx, victim.track, masker.track, filter, region, victimTier, scope, scopeNames, pairs, kind);
  if (boostNode) reasons[1] = `Undoing part of a saved boost is preferred over adding a second filter on top of it.`;
  if (scope.type === "global" && ctx.document.sections.length > 0) {
    const share = Math.round((steps.length * model.stepSeconds / Math.max(1e-6, activeSeconds(model, masker, null))) * 100);
    reasons.push(
      `Applied track-wide because the overlap holds ${scopeNames.length > 0 ? `in ${listNames(scopeNames)}` : "through the song"} (${Math.min(100, share)}% of the time ${masker.track.name} plays).`,
    );
  }
  if (scope.type === "section") {
    reasons.push(`Only in ${pairs[0]!.scope.name}. Elsewhere ${masker.track.name} does not compete with ${victim.track.name} enough to justify a track-wide filter.`);
  }
  return {
    trackId: yieldingId,
    scope,
    filter,
    purpose: "separation",
    protectedIds: [protectedId],
    interactionIds: pairs.map((pair) => pair.id),
    confidence,
    reasons,
    severity: result.severity,
    priority: Math.max(...pairs.map((pair) => pair.priority)),
    evidence: evidenceFor(model, meanMasker, meanVictim, result.weights, steps, region, context, boostNode?.node.filter ?? null),
    replacesNodeId: boostNode?.node.id ?? null,
    forceReview: false,
    targetTier: maskerTier,
    check: { victimId: protectedId, maskerId: yieldingId, steps, victimTier, scale },
    evaluation: null,
    benefit: 0,
    headline,
  };
}

/**
 * Kick and Bass with no stated priority. Neither yields automatically. When the kick is clearly the
 * transient owner of a concentrated fundamental and the bass sustains over it, a small bass cut is
 * offered for review only. Otherwise the overlap is reported and nothing is planned.
 */
function kickBassReviewMoves(ctx: Context): Move[] {
  const { analysis, model, document } = ctx;
  const hasSections = document.sections.length > 0;
  const pairs = analysis.pairs.filter(
    (pair) => pair.kind === "kick-bass" && !pair.protectedId && (hasSections ? pair.scope.key !== "song" : pair.scope.key === "song"),
  );
  const byTracks = new Map<string, PairAnalysis[]>();
  for (const pair of pairs) byTracks.set(pairKey(pair.a.track.id, pair.b.track.id), [...(byTracks.get(pairKey(pair.a.track.id, pair.b.track.id)) ?? []), pair]);
  const moves: Move[] = [];
  for (const group of byTracks.values()) {
    const first = group[0]!;
    const kick = first.a.track.role === "kick" ? first.a : first.b;
    const bass = first.a.track.role === "kick" ? first.b : first.a;
    const steps = [...new Set(group.flatMap((pair) => pair.coSteps))].sort((left, right) => left - right);
    const meanKick = meanBands(kick, steps);
    const meanBass = meanBands(bass, steps);
    const scale = activityFactor(weighted(group, (pair) => pair.simultaneity), weighted(group, (pair) => pair.coverage)) * stereoFactor(separation(kick, bass));
    const result = assessDirection(model.grid, kick, bass, meanKick, meanBass, "primary", steps, scale);
    const region = result.regions[0];
    const kickCrest = kick.measurement.levels.crestFactorDb ?? 0;
    const bassCrest = bass.measurement.levels.crestFactorDb ?? 0;
    const lowShare = shareBetween(model, meanKick, 40, 150);
    const transient = kickCrest >= 10 && kick.measurement.dynamics.onsetDensityPerSecond >= 0.8 && bassCrest <= kickCrest - 2;
    const lowText = region ? formatRange(region.lowHz, region.highHz) : "the low end";
    if (!region || result.severity < ctx.limits.minSeverity) {
      for (const pair of group) ctx.outcomes.set(pair.id, "below-threshold");
      continue;
    }
    if (!transient || lowShare < 0.3 || result.severity < 0.5 || region.highHz > 300) {
      for (const pair of group) ctx.outcomes.set(pair.id, "ambiguous");
      ctx.notes.push(
        `${kick.track.name} and ${bass.track.name} overlap strongly from ${lowText}, but both are Primary and neither has a clear priority. No automatic EQ change was proposed. Mark one of them Supporting or Focal in a section to let the planner choose.`,
      );
      continue;
    }
    const centerHz = placeCenter(kick, bass, region, "kick-bass");
    const filter = normalizeEqFilter({ kind: "bell", frequencyHz: musicalFrequency(centerHz), gainDb: -Math.min(1.5, ctx.limits.maxCutDb), q: 1.2 });
    moves.push({
      trackId: bass.track.id,
      scope: { type: "global" },
      filter,
      purpose: "separation",
      protectedIds: [kick.track.id],
      interactionIds: group.map((pair) => pair.id),
      confidence: 0.48,
      reasons: [
        `${kick.track.name} and ${bass.track.name} are both Primary and both strong around ${lowText} while they play together, so neither yields automatically.`,
        `${kick.track.name} is the transient part (crest ${kickCrest.toFixed(0)} dB, ${kick.measurement.dynamics.onsetDensityPerSecond.toFixed(1)} hits a second) with ${Math.round(lowShare * 100)}% of its level at 40–150 Hz, and ${bass.track.name} sustains over it.`,
        `A small ${bass.track.name} cut near ${formatHz(filter.frequencyHz)} is offered for review only. Mark ${bass.track.name} Supporting to make this an automatic recommendation.`,
      ],
      severity: result.severity,
      priority: 1,
      evidence: evidenceFor(model, meanBass, meanKick, result.weights, steps, region),
      replacesNodeId: null,
      forceReview: true,
      targetTier: "primary",
      check: { victimId: kick.track.id, maskerId: bass.track.id, steps, victimTier: "primary", scale },
      evaluation: null,
      benefit: 0,
    });
  }
  return moves;
}

/* ------------------------------------------------------------------ pass filters */

/** Highest high-pass corner per role. Kick, bass, drums, and unlabeled stems never get one. */
const HPF_CAP_HZ: Partial<Record<Track["role"], number>> = {
  "hi-hat": 300,
  percussion: 150,
  pad: 140,
  atmosphere: 140,
  fx: 120,
  synth: 110,
  keys: 100,
  guitar: 100,
  strings: 90,
  brass: 110,
  "backing-vocal": 130,
  lead: 100,
  vocal: 90,
  "snare-clap": 90,
};

/**
 * A gentle high-pass only where the measurements show it: a supporting track with real low-frequency
 * energy under its own body, while the low-end owners are playing and clearly louder there.
 */
function lowEndMoves(ctx: Context): Move[] {
  const { model } = ctx;
  const owners = [...model.tracks.values()].filter((item) => item.track.role === "kick" || item.track.role === "bass");
  if (owners.length === 0) return [];
  const moves: Move[] = [];
  for (const target of model.tracks.values()) {
    const cap = HPF_CAP_HZ[target.track.role];
    if (!cap) continue;
    const tier = tierOf(ctx, target.track.id, "song");
    if (TIER_RANK[tier] >= TIER_RANK.primary && target.track.role !== "lead" && target.track.role !== "vocal") continue;
    if (tier === "focal") continue;
    const activeSteps = rangeSteps(model).filter((step) => target.active[step] === 1);
    const steps = activeSteps.filter((step) => owners.some((owner) => owner.active[step] === 1));
    if (activeSteps.length === 0 || steps.length < Math.max(2, activeSteps.length * 0.25)) continue;
    const mean = meanBands(target, steps);
    const ownerMean = new Float64Array(GRID_BANDS);
    for (const owner of owners) {
      const ownerBands = meanBands(owner, steps);
      for (let band = 0; band < GRID_BANDS; band += 1) ownerMean[band] += ownerBands[band]!;
    }
    const total = mean.reduce((sum, value) => sum + value, 0);
    const capBand = model.grid.edges.findIndex((edge) => edge > cap) - 1;
    // Highest corner where everything removed sits well under the low-end owners and the track keeps at least 85% of itself.
    let cornerBand = -1;
    let lowPower = 0;
    let lowOwners = 0;
    let bestShare = 0;
    let bestLead = 0;
    for (let band = 0; band < Math.max(0, capBand); band += 1) {
      lowPower += mean[band]!;
      lowOwners += ownerMean[band]!;
      const share = total > 0 ? lowPower / total : 0;
      if (share > 0.15) break;
      const lead = toDb(lowOwners) - toDb(lowPower);
      if (lead >= 6) {
        cornerBand = band + 1;
        bestShare = share;
        bestLead = lead;
      }
    }
    if (cornerBand <= 0 || bestShare < 0.02) continue;
    const lowShare = bestShare;
    const ownersLead = bestLead;
    const persistence = steps.filter((step) => {
      let low = 0;
      let all = 0;
      for (let band = 0; band < GRID_BANDS; band += 1) {
        const value = target.power[step * GRID_BANDS + band]!;
        all += value;
        if (band < cornerBand) low += value;
      }
      return all > 0 && low / all >= 0.015;
    }).length / steps.length;
    if (persistence < 0.5) continue;
    const corner = musicalFrequency(Math.max(30, model.grid.edges[cornerBand]! * 0.85));
    const filter = normalizeEqFilter({ kind: "high-pass", frequencyHz: corner, gainDb: 0, q: 0.71 });
    const ownerNames = listNames(owners.filter((owner) => steps.some((step) => owner.active[step] === 1)).map((owner) => owner.track.name));
    const tierWord = tier === "background" ? "a background part" : "Supporting";
    let confidence = 0.62 + (persistence >= 0.75 ? 0.1 : 0) + (ownersLead >= 8 ? 0.08 : 0) + (tier === "background" ? 0.05 : 0);
    if (target.track.role === "lead" || target.track.role === "vocal") confidence -= 0.15;
    const evidence = evidenceFor(model, mean, ownerMean, model.grid.centers.map((hz) => (hz < 250 ? 1 : 0.2)), steps);
    moves.push({
      trackId: target.track.id,
      scope: { type: "global" },
      filter,
      purpose: "low-end",
      protectedIds: owners.map((owner) => owner.track.id).slice(0, 4),
      interactionIds: ctx.analysis.pairs
        .filter((pair) => pair.scope.key === "song" && owners.some((owner) => sameTracks(pair, owner.track.id, target.track.id)))
        .map((pair) => pair.id)
        .slice(0, 8),
      confidence: clamp(round2(confidence), 0.2, 0.85),
      reasons: [
        `Added a gentle high-pass at ${formatHz(filter.frequencyHz)} because ${target.track.name} keeps ${Math.round(lowShare * 100)}% of its level below ${formatHz(model.grid.edges[cornerBand]!)} but is ${tierWord}, while ${ownerNames} own the low end there.`,
        `${ownerNames} ${owners.length === 1 ? "is" : "are"} ${ownersLead.toFixed(0)} dB louder than ${target.track.name} below that point in ${Math.round(persistence * 100)}% of the time they play together, so the removed energy mostly adds weight without being heard as part of ${target.track.name}.`,
      ],
      severity: clamp(lowShare * 6, 0, 1),
      priority: 0.7,
      evidence,
      replacesNodeId: null,
      forceReview: false,
      targetTier: tier,
      check: null,
      evaluation: null,
      benefit: 0,
    });
  }
  return moves;
}

/** Low-pass stays rare: a background or pad part whose top end competes with a part that owns it. */
function highEndMoves(ctx: Context): Move[] {
  const { model } = ctx;
  const moves: Move[] = [];
  for (const target of model.tracks.values()) {
    const tier = tierOf(ctx, target.track.id, "song");
    if (!(tier === "background" || target.track.role === "pad")) continue;
    const owners = [...model.tracks.values()].filter((other) => {
      if (other === target) return false;
      const otherTier = tierOf(ctx, other.track.id, "song");
      return other.track.role === "hi-hat" || ((otherTier === "focal" || otherTier === "primary") && ["lead", "vocal", "snare-clap"].includes(other.track.role));
    });
    if (owners.length === 0) continue;
    const activeSteps = rangeSteps(model).filter((step) => target.active[step] === 1);
    const steps = activeSteps.filter((step) => owners.some((owner) => owner.active[step] === 1));
    if (steps.length < Math.max(2, activeSteps.length * 0.4)) continue;
    const mean = meanBands(target, steps);
    const ownerMean = new Float64Array(GRID_BANDS);
    for (const owner of owners) meanBands(owner, steps).forEach((value, band) => (ownerMean[band] += value));
    const topBand = model.grid.edges.findIndex((edge) => edge >= 8_000);
    const total = mean.reduce((sum, value) => sum + value, 0);
    let top = 0;
    let ownersTop = 0;
    for (let band = topBand; band < GRID_BANDS; band += 1) {
      top += mean[band]!;
      ownersTop += ownerMean[band]!;
    }
    const topShare = total > 0 ? top / total : 0;
    const ownerShare = ownerMean.reduce((sum, value) => sum + value, 0);
    if (topShare < 0.1 || ownerShare <= 0 || ownersTop / ownerShare < 0.05) continue;
    if (toDb(top) < toDb(ownersTop) - 3) continue;
    const corner = musicalFrequency(Math.max(6_000, model.grid.edges[topBand]! * 1.1));
    const filter = normalizeEqFilter({ kind: "low-pass", frequencyHz: corner, gainDb: 0, q: 0.71 });
    moves.push({
      trackId: target.track.id,
      scope: { type: "global" },
      filter,
      purpose: "high-end",
      protectedIds: owners.map((owner) => owner.track.id).slice(0, 4),
      interactionIds: [],
      confidence: 0.52,
      reasons: [
        `${target.track.name} keeps ${Math.round(topShare * 100)}% of its level above 8 kHz and sits within 3 dB of ${listNames(owners.map((owner) => owner.track.name))} up there while they play together.`,
        `A gentle low-pass at ${formatHz(filter.frequencyHz)} would leave that range to them. Low-pass moves are offered for review because top end is often part of a part's character.`,
      ],
      severity: clamp(topShare * 3, 0, 1),
      priority: 0.5,
      evidence: evidenceFor(model, mean, ownerMean, model.grid.centers.map((hz) => (hz >= 6_000 ? 1 : 0.2)), steps),
      replacesNodeId: null,
      forceReview: true,
      targetTier: tier,
      check: null,
      evaluation: null,
      benefit: 0,
    });
  }
  return moves;
}

/* ------------------------------------------------------------------ intent */

function tonalMoves(ctx: Context): Move[] {
  const { document } = ctx;
  const { requests, ambiguous } = readTonalNotes(document);
  for (const item of ambiguous.slice(0, 2)) {
    const section = document.sections.find((entry) => entry.id === item.sectionId);
    const names = [...new Set(item.trackIds)].map((id) => document.tracks.find((track) => track.id === id)?.name ?? id);
    ctx.notes.push(`The ${section?.name ?? "section"} note "${item.clause}" could mean ${listNames(names, "or")}, so the "${item.word}" request was not applied.`);
  }
  const moves: Move[] = [];
  for (const request of requests) {
    const move = tonalMove(ctx, request);
    if (move) moves.push(move);
  }
  return moves;
}

function tonalMove(ctx: Context, request: TonalRequest): Move | null {
  const { model, document, limits } = ctx;
  const target = model.tracks.get(request.trackId);
  const section = document.sections.find((item) => item.id === request.sectionId);
  if (!target || !section) return null;
  const steps = stepsIn(model, section.startTime, section.endTime).filter((step) => target.active[step] === 1);
  const where = request.source === "section-note" ? `the ${section.name} note` : `the ${target.track.name} note for ${section.name}`;
  if (steps.length < 2) {
    ctx.notes.push(`${where[0]!.toUpperCase()}${where.slice(1)} asks about ${target.track.name}, but it barely plays in ${section.name}, so nothing was changed.`);
    return null;
  }
  const mean = meanBands(target, steps);
  const evidence = tonalEvidence(model.grid, mean, request.word);
  const range = formatRange(request.word.lowHz, request.word.highHz);
  if (!evidence.confirmed) {
    ctx.notes.push(
      `${capitalize(where)} calls ${target.track.name} ${request.word.label}, but its ${range} level is ${formatSignedDb(evidence.excessDb)} dB against its own spectral trend, so the measurements do not support an EQ change there.`,
    );
    return null;
  }
  const cut = request.word.direction === "cut";
  const amount = Math.min(cut ? limits.maxCutDb : limits.maxBoostDb, Math.max(cut ? 1 : 0.5, Math.abs(evidence.excessDb) * 0.6));
  const centerHz = request.word.shape === "bell" ? model.grid.centers[evidence.peakBand]! : request.word.shape === "high-shelf" ? request.word.lowHz : request.word.highHz;
  const filter = normalizeEqFilter({
    kind: request.word.shape,
    frequencyHz: musicalFrequency(centerHz),
    gainDb: roundTenth(cut ? -amount : amount),
    q: request.word.shape === "bell" ? 1 : 0.71,
  });
  const rest = new Float64Array(GRID_BANDS);
  for (const other of model.tracks.values()) {
    if (other === target) continue;
    meanBands(other, steps).forEach((value, band) => (rest[band] += value));
  }
  const weights = model.grid.centers.map((hz) => (hz >= request.word.lowHz && hz < request.word.highHz ? 1 : 0.2));
  return {
    trackId: target.track.id,
    scope: { type: "section", sectionId: section.id },
    filter,
    purpose: "intent",
    protectedIds: [],
    interactionIds: [],
    confidence: request.source === "track-note" ? 0.7 : 0.64,
    reasons: [
      `${capitalize(where)} says "${quote(request.clause)}". ${target.track.name} measures ${formatSignedDb(evidence.excessDb)} dB against its own spectral trend in ${range} during ${section.name}, so ${lowerFirst(describeFilter(filter))} matches the note.`,
      `The note only chose where to look. The size of the move comes from the measured ${evidence.excessDb > 0 ? "excess" : "shortfall"}, kept small.`,
    ],
    severity: clamp(Math.abs(evidence.excessDb) / 6, 0, 1),
    priority: 0.8,
    evidence: evidenceFor(model, mean, rest, weights, steps),
    replacesNodeId: null,
    forceReview: !cut && Math.abs(filter.gainDb) > 1.5,
    targetTier: tierOf(ctx, target.track.id, section.id),
    check: null,
    evaluation: null,
    benefit: 0,
  };
}

/* ------------------------------------------------------------------ presence boost */

/**
 * A small broad lift on a lead or Focal part, only when the rest of the mix crowds its presence range
 * and no single lower-tier part is responsible (if one were, cutting it is the better move).
 */
function presenceMoves(ctx: Context): Move[] {
  const { model, limits } = ctx;
  const moves: Move[] = [];
  for (const target of model.tracks.values()) {
    const songTier = tierOf(ctx, target.track.id, "song");
    const leadish = target.track.role === "lead" || target.track.role === "vocal" || songTier === "focal";
    if (!leadish || (songTier !== "focal" && songTier !== "primary")) continue;
    const steps = rangeSteps(model).filter((step) => target.active[step] === 1);
    if (steps.length < 4) continue;
    const mean = meanBands(target, steps);
    const rest = new Float64Array(GRID_BANDS);
    const contributors = new Map<string, Float64Array>();
    for (const other of model.tracks.values()) {
      if (other === target) continue;
      const bands = meanBands(other, steps);
      contributors.set(other.track.id, bands);
      bands.forEach((value, band) => (rest[band] += value));
    }
    const result = assessDirection(model.grid, target, { ...target, track: { ...target.track, id: "__rest__" } }, mean, rest, songTier, steps, 1);
    const region = result.regions[0];
    if (!region || result.severity < 0.6 || region.lowHz < 300 || region.highHz > 12_000) continue;
    let largest = 0;
    let largestLower = false;
    for (const [id, bands] of contributors) {
      let inRegion = 0;
      let restInRegion = 0;
      for (let band = region.lowBand; band <= region.highBand; band += 1) {
        inRegion += bands[band]!;
        restInRegion += rest[band]!;
      }
      const share = restInRegion > 0 ? inRegion / restInRegion : 0;
      if (share > largest) {
        largest = share;
        largestLower = TIER_RANK[tierOf(ctx, id, "song")] < TIER_RANK[songTier];
      }
    }
    if (largest >= 0.5 && largestLower) continue;
    const gainDb = Math.min(limits.maxBoostDb, 1.5);
    const filter = normalizeEqFilter({ kind: "bell", frequencyHz: musicalFrequency(region.centerHz), gainDb: roundTenth(gainDb), q: 0.8 });
    moves.push({
      trackId: target.track.id,
      scope: { type: "global" },
      filter,
      purpose: "presence",
      protectedIds: [target.track.id],
      interactionIds: [],
      confidence: 0.58,
      reasons: [
        `${target.track.name} is ${songTier === "focal" ? "Focal" : "the Primary lead part"}, but the rest of the mix sits ${formatSignedDb(region.levelDifferenceDb)} dB against it in ${formatRange(region.lowHz, region.highHz)} while it plays.`,
        `No single lower-priority part is responsible (the largest supplies ${Math.round(largest * 100)}% of that energy), so a small broad lift on ${target.track.name} is offered instead of a cut. Boosts need stronger evidence than cuts.`,
      ],
      severity: result.severity,
      priority: 0.8,
      evidence: evidenceFor(model, mean, rest, result.weights, steps, region),
      replacesNodeId: null,
      forceReview: false,
      targetTier: songTier,
      check: null,
      evaluation: null,
      benefit: 0,
    });
  }
  return moves;
}

/* ------------------------------------------------------------------ shaping the set */

/** A saved filter of the same kind close by is replaced (deepened) instead of stacked. */
function withSavedFilters(ctx: Context, moves: Move[]): Move[] {
  return moves.map((move) => {
    if (move.replacesNodeId) return move;
    const nodes: EqNode[] = move.scope.type === "global" ? trackEqNodes(ctx.document, move.trackId) : sectionEqNodes(ctx.document, move.trackId, move.scope.sectionId);
    const near = nodes.find(
      (node) => node.enabled && node.filter.kind === move.filter.kind && Math.abs(Math.log2(node.filter.frequencyHz / move.filter.frequencyHz)) <= 0.5,
    );
    if (!near) return move;
    if (isPassFilter(move.filter.kind)) {
      // The saved pass filter already covers this; the measured spectra include it.
      return { ...move, confidence: 0 };
    }
    const combined = clamp(near.filter.gainDb + move.filter.gainDb, -ctx.limits.maxCutDb - Math.max(0, -near.filter.gainDb), ctx.limits.maxBoostDb);
    return {
      ...move,
      replacesNodeId: near.id,
      evidence: { ...move.evidence, replaces: near.filter },
      filter: normalizeEqFilter({ ...move.filter, frequencyHz: near.filter.frequencyHz, gainDb: roundTenth(combined) }),
      reasons: [...move.reasons, `This replaces the saved ${lowerFirst(describeFilter(near.filter))} instead of stacking a second filter on it.`].slice(0, 6),
    };
  }).filter((move) => move.confidence > 0);
}

/** Two cuts on one track and scope less than 0.6 octave apart become one broader cut. */
function mergeMoves(ctx: Context, moves: Move[]): Move[] {
  const out: Move[] = [];
  for (const move of moves) {
    const twin = out.find(
      (other) =>
        other.trackId === move.trackId &&
        sameScope(other.scope, move.scope) &&
        other.filter.kind === "bell" &&
        move.filter.kind === "bell" &&
        other.filter.gainDb < 0 &&
        move.filter.gainDb < 0 &&
        other.replacesNodeId === null &&
        move.replacesNodeId === null &&
        Math.abs(Math.log2(other.filter.frequencyHz / move.filter.frequencyHz)) <= MERGE_OCTAVES,
    );
    if (!twin) {
      out.push(move);
      continue;
    }
    const weightA = Math.abs(twin.filter.gainDb);
    const weightB = Math.abs(move.filter.gainDb);
    const center = Math.exp((Math.log(twin.filter.frequencyHz) * weightA + Math.log(move.filter.frequencyHz) * weightB) / (weightA + weightB));
    const deeper = Math.max(weightA, weightB) + 0.3 * Math.min(weightA, weightB);
    const spread = Math.abs(Math.log2(twin.filter.frequencyHz / move.filter.frequencyHz));
    const q = clamp(Math.min(twin.filter.q, move.filter.q) / (1 + spread), 0.6, BROAD_Q_MAX);
    twin.filter = normalizeEqFilter({ kind: "bell", frequencyHz: musicalFrequency(center), gainDb: -roundTenth(Math.min(ctx.limits.maxCutDb, deeper)), q: roundTenth(q) });
    twin.protectedIds = [...new Set([...twin.protectedIds, ...move.protectedIds])].slice(0, 4);
    twin.interactionIds = [...new Set([...twin.interactionIds, ...move.interactionIds])].slice(0, 8);
    twin.reasons = [...twin.reasons.slice(0, 2), ...move.reasons.slice(0, 1), `One broader cut covers both conflicts instead of two filters a fraction of an octave apart.`].slice(0, 6);
    twin.confidence = round2(Math.max(twin.confidence, move.confidence) - 0.02);
    twin.severity = Math.max(twin.severity, move.severity);
    twin.priority = Math.max(twin.priority, move.priority);
    twin.forceReview = twin.forceReview || move.forceReview;
    twin.headline = undefined;
    twin.reasons = [`${describeFilter(twin.filter)} on ${trackName(ctx, twin.trackId)} covers two neighbouring conflicts.`, ...twin.reasons].slice(0, 6);
  }
  return out;
}

/**
 * A section filter runs after the track's own filters, so it only plans what the track-wide cut leaves.
 * When the track-wide cut already covers the section's conflict, the section filter is not needed.
 */
function stackOnGlobal(ctx: Context, moves: Move[]): Move[] {
  const out: Move[] = [];
  for (const move of moves) {
    if (move.scope.type !== "section" || move.purpose !== "separation" || move.filter.kind !== "bell" || move.filter.gainDb >= 0) {
      out.push(move);
      continue;
    }
    const globals = moves.filter((other) => other.trackId === move.trackId && other.scope.type === "global" && other !== move).map((other) => other.filter);
    if (globals.length === 0) {
      out.push(move);
      continue;
    }
    const covered = -chainMagnitudeDb(globals, move.filter.frequencyHz);
    const remaining = Math.abs(move.filter.gainDb) - Math.max(0, covered);
    if (covered < 0.3) {
      out.push(move);
      continue;
    }
    const section = ctx.document.sections.find((item) => item.id === (move.scope as { sectionId: string }).sectionId)?.name ?? "that section";
    if (remaining < AUTO_MIN_CUT_DB) {
      ctx.notes.push(`${trackName(ctx, move.trackId)} needs no extra filter in ${section}: the track-wide cut already covers the conflict with ${listNames(move.protectedIds.map((id) => trackName(ctx, id)))} there.`);
      continue;
    }
    // Evidence and gain now describe what the section filter adds on top of the track-wide one.
    const evidence = {
      ...move.evidence,
      targetDb: move.evidence.targetDb.map((value, band) =>
        Math.round((value + 10 * Math.log10(bandPowerGain(globals, move.evidence.edgesHz[band]!, move.evidence.edgesHz[band + 1]!))) * 10) / 10,
      ),
    };
    out.push({
      ...move,
      evidence,
      filter: normalizeEqFilter({ ...move.filter, gainDb: -roundTenth(remaining) }),
      reasons: [
        ...move.reasons.slice(0, 4),
        `The track-wide ${trackName(ctx, move.trackId)} cut already gives ${covered.toFixed(1)} dB here, so this ${section} filter only adds the rest.`,
      ],
    });
  }
  return out;
}

/**
 * Evaluation, at most two passes, on the band levels each move was planned from.
 * Pass 1 checks the move. A move that would not reduce the competition is dropped. A cut that takes
 * too much of its own track is made smaller and checked once more.
 */
function evaluateMoves(ctx: Context, moves: Move[]): Move[] {
  const kept: Move[] = [];
  let dropped = 0;
  for (const move of moves) {
    let evaluation = evaluateFilter(move.evidence, move.filter, move.purpose);
    let passes = 1;
    if (move.purpose === "intent") {
      const intended = move.filter.gainDb < 0 ? evaluation.regionChangeDb <= -0.3 : evaluation.regionChangeDb >= 0.3;
      if (!intended) {
        dropped += 1;
        continue;
      }
    } else if (move.filter.kind === "high-pass" || move.filter.kind === "low-pass") {
      if (evaluation.identityChangeDb < -1.5) {
        const softer = normalizeEqFilter({
          ...move.filter,
          frequencyHz: musicalFrequency(move.filter.kind === "high-pass" ? move.filter.frequencyHz * 0.75 : move.filter.frequencyHz * 1.3),
        });
        move.filter = softer;
        move.reasons = [...move.reasons, `The first corner took too much of ${trackName(ctx, move.trackId)}, so it was moved to ${formatHz(softer.frequencyHz)}.`].slice(0, 6);
        evaluation = evaluateFilter(move.evidence, move.filter, move.purpose);
        passes = 2;
        if (evaluation.identityChangeDb < -2) move.forceReview = true;
      }
    } else {
      if (!helps(move, evaluation)) {
        dropped += 1;
        for (const id of move.interactionIds) ctx.outcomes.set(id, "no-benefit");
        continue;
      }
      const limit = ctx.limits.maxIdentityLossDb;
      const before = move.evidence.replaces?.gainDb ?? 0;
      const change = move.filter.gainDb - before;
      // Taking back a saved boost returns the track toward its own source, so it is not capped as a loss of identity.
      const undoesBoost = before > 0 && move.filter.gainDb >= -1;
      if (evaluation.identityChangeDb < -limit && change < 0 && !undoesBoost) {
        const scaled = change * (limit / Math.abs(evaluation.identityChangeDb));
        move.filter = normalizeEqFilter({ ...move.filter, gainDb: roundTenth(before + Math.min(-AUTO_MIN_CUT_DB, scaled)) });
        move.reasons = [...move.reasons, `The first size took more than ${limit.toFixed(1)} dB from ${trackName(ctx, move.trackId)} overall, so the cut was reduced to keep its tone.`].slice(0, 6);
        evaluation = evaluateFilter(move.evidence, move.filter, move.purpose);
        passes = 2;
        if (!helps(move, evaluation)) {
          dropped += 1;
          for (const id of move.interactionIds) ctx.outcomes.set(id, "no-benefit");
          continue;
        }
        if (evaluation.identityChangeDb < -limit - 0.5) move.forceReview = true;
      }
    }
    move.evaluation = { ...evaluation, passes, proxy: null };
    if (evaluation.contextGapReductionDb !== null && evaluation.contextGapReductionDb < 1) move.confidence = round2(move.confidence - 0.1);
    if (move.purpose === "presence") {
      move.reasons = [
        ...move.reasons.slice(0, 5),
        `Checked on the analysis spectra: the lift raises ${trackName(ctx, move.trackId)} ${evaluation.gapReductionDb.toFixed(1)} dB against the rest of the mix inside that range.`,
      ];
    } else if (move.purpose !== "intent" && move.purpose !== "low-end" && move.purpose !== "high-end") {
      move.reasons = [
        ...move.reasons.slice(0, 5),
        `Checked on the analysis spectra: inside the conflict it moves ${trackName(ctx, move.trackId)} ${evaluation.gapReductionDb.toFixed(1)} dB further under ${listNames(move.protectedIds.map((id) => trackName(ctx, id)))}${evaluation.contextGapReductionDb !== null && evaluation.contextGapReductionDb < evaluation.gapReductionDb - 0.05 ? ` (${evaluation.contextGapReductionDb.toFixed(1)} dB counting everything else playing)` : ""}, and the competed-for share of ${protectedNames(ctx, move)} drops from ${Math.round(evaluation.before * 100)}% to ${Math.round(evaluation.after * 100)}%. ${trackName(ctx, move.trackId)} loses ${Math.abs(evaluation.identityChangeDb).toFixed(1)} dB overall.`,
      ];
    }
    kept.push(move);
  }
  if (dropped > 0) {
    ctx.notes.push(`${dropped} candidate ${dropped === 1 ? "filter was" : "filters were"} dropped because the check on the analysis spectra showed no real reduction in the overlap.`);
  }
  return kept;
}

/**
 * A filter helps when it pulls the competitor under the protected part by a real amount inside the
 * conflict: at least 0.4 dB, and at least 30% of its own peak gain (so a misplaced filter fails),
 * without making the competition share worse.
 */
function helps(move: Move, evaluation: Omit<EqEvaluation, "passes" | "proxy">): boolean {
  const peak = Math.abs(move.filter.gainDb - (move.evidence.replaces?.gainDb ?? 0));
  const pairwise = evaluation.gapReductionDb >= Math.max(0.4, 0.3 * peak) && evaluation.after <= evaluation.before + 1e-9 && evaluation.improvement >= 0;
  // In context: the whole rest of the mix has to move under the protected part, not just this one competitor.
  const inContext = evaluation.contextGapReductionDb === null || evaluation.contextGapReductionDb >= Math.max(0.5, 0.2 * peak);
  return pairwise && inContext;
}

/**
 * Fewer, smaller, broader, track-wide, and cuts over boosts. A move survives when its expected
 * benefit beats its cost; then per-track and per-section counts are capped.
 */
function regularize(ctx: Context, moves: Move[], already: Move[] = []): Move[] {
  const { limits } = ctx;
  for (const move of moves) {
    const improvement = move.evaluation ? Math.min(1, (move.evaluation.contextGapReductionDb ?? move.evaluation.gapReductionDb) / 3) : 0.3;
    const gain = isPassFilter(move.filter.kind) ? 1 : Math.abs(move.filter.gainDb);
    const cost =
      0.12 +
      0.03 * gain +
      0.05 * Math.max(0, move.filter.q - 1.5) +
      (move.scope.type === "section" ? 0.06 : 0) +
      (!isPassFilter(move.filter.kind) && move.filter.gainDb > 0 ? 0.1 : 0) +
      (TIER_RANK[move.targetTier] >= TIER_RANK.primary ? 0.1 : 0);
    move.benefit = move.severity * move.priority * (0.6 + improvement);
    if (move.purpose === "intent" || move.forceReview) move.benefit = Math.max(move.benefit, cost * limits.benefitRatio);
    (move as Move & { cost: number }).cost = cost;
  }
  let kept = moves.filter((move) => move.benefit >= (move as Move & { cost: number }).cost * limits.benefitRatio);
  const weak = moves.length - kept.length;
  if (weak > 0) ctx.notes.push(`${weak} small ${weak === 1 ? "conflict was" : "conflicts were"} left alone because the expected improvement was not worth another filter.`);

  // One protected part does not need three tracks carved at the same place.
  const crowd = new Map<string, Move[]>();
  for (const move of kept) {
    if (move.purpose !== "separation") continue;
    for (const id of move.protectedIds) {
      const key = `${id}:${scopeKey(move.scope)}:${Math.round(Math.log2(move.filter.frequencyHz) / MERGE_OCTAVES)}`;
      crowd.set(key, [...(crowd.get(key) ?? []), move]);
    }
  }
  const crowded = new Set<Move>();
  for (const group of crowd.values()) {
    if (group.length <= 2) continue;
    for (const move of [...group].sort(byBenefit).slice(2)) crowded.add(move);
  }
  kept = kept.filter((move) => !crowded.has(move));

  // Never cut A for B and B for A in the same place.
  const mutual = new Set<Move>();
  for (const move of kept) {
    for (const other of kept) {
      if (move === other || mutual.has(other) || !sameScope(move.scope, other.scope)) continue;
      if (move.protectedIds.includes(other.trackId) && other.protectedIds.includes(move.trackId) && Math.abs(Math.log2(move.filter.frequencyHz / other.filter.frequencyHz)) <= MERGE_OCTAVES) {
        mutual.add(byBenefit(move, other) <= 0 ? other : move);
      }
    }
  }
  kept = kept.filter((move) => !mutual.has(move));

  const capped = new Set<Move>();
  const byTrack = new Map<string, Move[]>();
  for (const move of kept) {
    const key = `${move.trackId}:${scopeKey(move.scope)}`;
    byTrack.set(key, [...(byTrack.get(key) ?? []), move]);
  }
  for (const [key, group] of byTrack) {
    const [trackId, scope] = splitKey(key);
    const saved = scope === "global" ? trackEqNodes(ctx.document, trackId).length : sectionEqNodes(ctx.document, trackId, scope).length;
    const replacing = group.filter((move) => move.replacesNodeId !== null).length;
    const earlier = already.filter((move) => `${move.trackId}:${scopeKey(move.scope)}` === key);
    const earlierAdded = earlier.filter((move) => move.replacesNodeId === null).length;
    const capacity = (scope === "global" ? MAX_TRACK_EQ_NODES : MAX_SECTION_EQ_NODES) - saved - earlierAdded;
    const allowed = Math.min((scope === "global" ? limits.maxGlobalFilters : limits.maxSectionFilters) - earlier.length, capacity + replacing);
    const ranked = [...group].sort(byBenefit);
    for (const move of ranked.slice(Math.max(0, allowed))) capped.add(move);
    // Wanting more filters than allowed says the track is a poor fit for corrective EQ; trust the rest less.
    if (ranked.length > allowed) for (const move of ranked.slice(0, allowed)) move.confidence = round2(move.confidence - 0.08);
  }
  if (capped.size + crowded.size + mutual.size > 0) {
    ctx.notes.push(
      `${capped.size + crowded.size + mutual.size} further ${capped.size + crowded.size + mutual.size === 1 ? "filter was" : "filters were"} held back to keep each track to ${limits.maxGlobalFilters} track-wide and ${limits.maxSectionFilters} section ${limits.maxSectionFilters === 1 ? "filter" : "filters"} and to avoid carving several parts at one place.`,
    );
  }
  return kept.filter((move) => !capped.has(move));
}

/**
 * Correction pass (the second and last): measure again with the first-pass filters in place.
 * A fix in one place can expose the next conflict (a lead buried under a boosted pad is also under a
 * boosted synth). Only new separation moves on tracks and ranges the first pass did not touch are added.
 */
function correctionPass(ctx: Context, first: Move[], measurements: PlanEqInput["measurements"]): Move[] {
  if (first.length === 0) return [];
  const model = buildSpectralModel({ document: ctx.document, measurements, bands: ctx.bands, overlay: overlayFor(first) });
  const analysis = analyzeInteractions(ctx.document, model);
  const replaced = new Set(first.filter((move) => move.replacesNodeId !== null).map((move) => `${move.trackId}:${move.replacesNodeId}`));
  const pass: Context = { ...ctx, model, analysis, notes: [], outcomes: new Map(), levelNotes: new Map(), replaced };
  const fresh = separationMoves(pass).filter(
    (move) =>
      !(move.replacesNodeId && replaced.has(`${move.trackId}:${move.replacesNodeId}`)) &&
      !first.some((done) => done.trackId === move.trackId && sameScope(done.scope, move.scope) && Math.abs(Math.log2(done.filter.frequencyHz / move.filter.frequencyHz)) <= MERGE_OCTAVES),
  );
  // The cut limit holds for everything planned on a track at one frequency, track-wide plus section.
  const limited: Move[] = [];
  for (const move of fresh) {
    if (move.replacesNodeId || move.filter.kind !== "bell" || move.filter.gainDb >= 0) {
      limited.push(move);
      continue;
    }
    const used = existingCut(first, move);
    const room = ctx.limits.maxCutDb - used;
    if (room < AUTO_MIN_CUT_DB) {
      const where = move.scope.type === "section" ? (ctx.document.sections.find((item) => item.id === (move.scope as { sectionId: string }).sectionId)?.name ?? "that section") : "the song";
      ctx.notes.push(`${trackName(ctx, move.trackId)} needs no extra filter in ${where}: the cut already planned there reaches the ${ctx.limits.maxCutDb} dB limit.`);
      continue;
    }
    if (Math.abs(move.filter.gainDb) > room) move.filter = normalizeEqFilter({ ...move.filter, gainDb: -roundTenth(room) });
    limited.push(move);
  }
  const kept = regularize(pass, evaluateMoves(pass, limited), first);
  for (const move of kept) {
    move.reasons = [...move.reasons.slice(0, 5), "Found on the second pass, measured with the first-pass filters already in place."];
    for (const id of move.interactionIds) ctx.outcomes.set(id, "recommendation");
  }
  return kept;
}

/** Cut (positive dB) that earlier moves already put on this move's track at its frequency, in its scope. */
function existingCut(earlier: Move[], move: Move): number {
  const filters = earlier
    .filter((other) => other.trackId === move.trackId && (other.scope.type === "global" || sameScope(other.scope, move.scope)))
    .map((other) => other.filter);
  return Math.max(0, -chainMagnitudeDb(filters, move.filter.frequencyHz));
}

function overlayFor(moves: Move[]): Map<string, { global: EqFilter[]; sections: Map<string, EqFilter[]>; removed: Set<string> }> {
  const overlay = new Map<string, { global: EqFilter[]; sections: Map<string, EqFilter[]>; removed: Set<string> }>();
  for (const move of moves) {
    const entry = overlay.get(move.trackId) ?? { global: [], sections: new Map<string, EqFilter[]>(), removed: new Set<string>() };
    if (move.replacesNodeId) entry.removed.add(move.replacesNodeId);
    if (move.scope.type === "global") entry.global.push(move.filter);
    else entry.sections.set(move.scope.sectionId, [...(entry.sections.get(move.scope.sectionId) ?? []), move.filter]);
    overlay.set(move.trackId, entry);
  }
  return overlay;
}

/**
 * Whole-plan check: every kept filter applied to the spectral model at once, then each targeted
 * relationship measured again. A boost that makes its track crowd others more is dropped.
 */
function simulate(ctx: Context, moves: Move[]): { moves: Move[]; note: string | null } {
  if (moves.length === 0) return { moves, note: null };
  const overlay = overlayFor(moves);
  const measurements = Object.fromEntries([...ctx.model.tracks.values()].map((item) => [item.track.id, item.measurement]));
  const after = buildSpectralModel({ document: ctx.document, measurements, bands: ctx.bands, overlay });
  let moved = 0;
  let checked = 0;
  for (const move of moves) {
    if (!move.check || !move.evidence.focus) continue;
    const [low, high] = move.evidence.focus;
    const gap = (model: SpectralModel, weights: number[] | null) => {
      const victim = model.tracks.get(move.check!.victimId);
      const masker = model.tracks.get(move.check!.maskerId);
      if (!victim || !masker) return { gap: 0, weights: [] as number[] };
      const meanVictim = meanBands(victim, move.check!.steps);
      const meanMasker = meanBands(masker, move.check!.steps);
      const total = meanVictim.reduce((sum, value) => sum + value, 0);
      const used: number[] = [];
      let weight = 0;
      let value = 0;
      for (let band = low; band <= high; band += 1) {
        const difference = toDb(meanMasker[band]!) - toDb(meanVictim[band]!);
        const contested = weights ? weights[band - low]! : (total > 0 ? meanVictim[band]! / total : 0) * maskCurve(difference);
        used.push(contested);
        weight += contested;
        value += contested * difference;
      }
      return { gap: weight > 0 ? value / weight : 0, weights: used };
    };
    const first = gap(ctx.model, null);
    const second = gap(after, first.weights);
    moved += first.gap - second.gap;
    checked += 1;
  }
  const kept = moves.filter((move) => {
    if (move.filter.kind !== "bell" || move.filter.gainDb <= 0) return true;
    const boosted = after.tracks.get(move.trackId);
    const original = ctx.model.tracks.get(move.trackId);
    if (!boosted || !original) return true;
    for (const other of after.tracks.values()) {
      if (other.track.id === move.trackId || TIER_RANK[tierOf(ctx, other.track.id, "song")] < TIER_RANK[move.targetTier]) continue;
      const steps = rangeSteps(after).filter((step) => boosted.active[step] === 1 && other.active[step] === 1);
      if (steps.length < 2) continue;
      const tier = tierOf(ctx, other.track.id, "song");
      const was = assessDirection(ctx.model.grid, ctx.model.tracks.get(other.track.id)!, original, meanBands(ctx.model.tracks.get(other.track.id)!, steps), meanBands(original, steps), tier, steps, 1).severity;
      const now = assessDirection(after.grid, other, boosted, meanBands(other, steps), meanBands(boosted, steps), tier, steps, 1).severity;
      if (now - was > 0.1) {
        ctx.notes.push(`A lift on ${move.trackId === other.track.id ? "" : trackName(ctx, move.trackId)} was dropped because it made it crowd ${other.track.name} more.`);
        return false;
      }
    }
    return true;
  });
  const note =
    checked > 0
      ? `Checked with every included filter applied to the analysis spectra at once: inside the ${checked} targeted ${checked === 1 ? "conflict" : "conflicts"}, the competing part sits on average ${(moved / checked).toFixed(1)} dB further under the part it protects.`
      : null;
  return { moves: kept, note };
}

/* ------------------------------------------------------------------ output */

function toRecommendations(ctx: Context, moves: Move[]): EqRecommendation[] {
  const trackOrder = new Map(ctx.document.tracks.map((track, index) => [track.id, index]));
  const sectionOrder = new Map(ctx.document.sections.map((section, index) => [section.id, index]));
  const ordered = [...moves].sort((left, right) => {
    const tracks = (trackOrder.get(left.trackId) ?? 0) - (trackOrder.get(right.trackId) ?? 0);
    if (tracks !== 0) return tracks;
    const scopes = (left.scope.type === "global" ? -1 : (sectionOrder.get(left.scope.sectionId) ?? 0)) - (right.scope.type === "global" ? -1 : (sectionOrder.get(right.scope.sectionId) ?? 0));
    if (scopes !== 0) return scopes;
    return left.filter.frequencyHz - right.filter.frequencyHz;
  });
  const counters = new Map<string, number>();
  return ordered.map((move) => {
    const key = `${move.trackId}:${scopeKey(move.scope)}`;
    const index = (counters.get(key) ?? 0) + 1;
    counters.set(key, index);
    const confidence = clamp(round2(move.confidence), 0.2, 0.95);
    const status = move.forceReview || needsReview(move.filter, confidence, move.evidence.replaces) ? "needs-review" : "proposed";
    const lines = move.headline ? [move.headline(move.filter), ...move.reasons.slice(1)] : move.reasons;
    const reasons = lines.filter((reason) => reason.length > 0).map((reason) => (reason.length > 600 ? `${reason.slice(0, 597)}…` : reason));
    if (status === "needs-review" && !move.forceReview) {
      reasons.push(confidence < 0.55 ? "Confidence is low, so this waits for review before Apply all." : "This move is larger or narrower than the planner applies on its own, so it waits for review.");
    }
    return {
      id: eqRecommendationId(move.trackId, move.scope, index),
      trackId: move.trackId,
      scope: move.scope,
      processing: { type: "eq" as const, filter: move.filter },
      planned: move.filter,
      replacesNodeId: move.replacesNodeId,
      protectedTrackIds: move.protectedIds.slice(0, 4),
      interactionIds: move.interactionIds.slice(0, 8),
      purpose: move.purpose,
      confidence,
      confidenceLabel: labelConfidence(confidence),
      status,
      edited: false,
      reasons: reasons.slice(0, 6),
      evaluation: move.evaluation,
      evidence: move.evidence,
    };
  });
}

function interactionList(ctx: Context): TrackInteraction[] {
  const { analysis, document, model } = ctx;
  const hasSections = document.sections.length > 0;
  const shown = analysis.pairs.filter((pair) => pair.scope.key === "song" || pair.scope.marked);
  const ranked = [...shown].sort((left, right) => right.severity * right.priority - left.severity * left.priority || left.id.localeCompare(right.id));
  const picked: PairAnalysis[] = [];
  for (const pair of ranked) {
    if (picked.length >= 40) break;
    if (pair.severity < 0.15 && !ctx.outcomes.has(pair.id)) continue;
    picked.push(pair);
  }
  // Song-level rows inherit the outcome of their section rows when sections did the deciding.
  return picked.map((pair) => {
    let outcome = ctx.outcomes.get(pair.id);
    if (!outcome && pair.scope.key === "song" && hasSections) {
      const related = analysis.pairs.filter((other) => other !== pair && sameTracks(other, pair.a.track.id, pair.b.track.id)).map((other) => ctx.outcomes.get(other.id));
      outcome = related.find((value) => value === "recommendation") ?? related.find((value) => value === "review") ?? related.find((value) => value === "ambiguous");
    }
    if (!outcome) outcome = pair.kind === "layered" && pair.severity >= ctx.limits.minSeverity ? "layered" : pair.kind === "equal" && pair.severity >= ctx.limits.minSeverity ? "ambiguous" : "below-threshold";
    const protectedId = pair.protectedId;
    const result = protectedId ? directionOf(pair, protectedId) : pair.bOnA.severity >= pair.aOnB.severity ? pair.bOnA : pair.aOnB;
    const meanVictim = result.victimId === pair.a.track.id ? pair.meanA : pair.meanB;
    const meanMasker = result.victimId === pair.a.track.id ? pair.meanB : pair.meanA;
    return {
      id: pair.id,
      scope: pair.scope.sectionId ? { type: "section" as const, sectionId: pair.scope.sectionId } : { type: "global" as const },
      scopeName: pair.scope.name,
      trackA: pair.a.track.id,
      trackB: pair.b.track.id,
      kind: pair.kind,
      tierA: pair.tierA,
      tierB: pair.tierB,
      severity: round3(clamp(pair.severity, 0, 1)),
      confidence: pair.confidence,
      simultaneousActivity: round3(clamp(pair.simultaneity, 0, 1)),
      coverage: round3(clamp(pair.coverage, 0, 1)),
      overlap: round3(clamp(pair.overlap, 0, 1)),
      stereoSeparation: round3(pair.stereoSeparation),
      protectedTrackId: pair.protectedId,
      yieldingTrackId: pair.yieldingId,
      regions: result.regions.map((region) => regionDto(region)),
      outcome,
      explanation: explainPair(ctx, pair, result, outcome),
      evidence: evidenceFor(model, meanMasker, meanVictim, result.weights, pair.coSteps, result.regions[0] ?? null),
    };
  });
}

function summarize(ctx: Context, changes: EqRecommendation[], simulationNote: string | null): EqPlan["summary"] {
  const { model, document, analysis } = ctx;
  const reviewCount = changes.filter((change) => change.status === "needs-review").length;
  const sectionCount = changes.filter((change) => change.scope.type === "section").length;
  // Taking back part of a saved boost counts as a cut, even when some boost remains.
  const cuts = changes.filter(
    (change) => !isPassFilter(change.processing.filter.kind) && (change.processing.filter.gainDb < 0 || (change.evidence.replaces !== null && change.processing.filter.gainDb < change.evidence.replaces.gainDb)),
  ).length;
  const pass = changes.filter((change) => isPassFilter(change.processing.filter.kind)).length;
  const boosts = changes.length - cuts - pass;
  const notes: string[] = [];
  const muted = model.skipped.filter((item) => item.reason === "muted").length;
  const unmeasured = model.skipped.filter((item) => item.reason === "unmeasured").length;
  if (unmeasured > 0) notes.push(`${unmeasured} ${unmeasured === 1 ? "stem has" : "stems have"} no analysis yet and ${unmeasured === 1 ? "was" : "were"} left out.`);
  if (muted > 0) notes.push(`${muted} muted ${muted === 1 ? "stem was" : "stems were"} left out.`);
  notes.push(...[...ctx.levelNotes.values()].slice(0, 2));
  notes.push(...[...new Set(ctx.notes)].slice(0, 5));
  if (simulationNote) notes.push(simulationNote);
  const unordered = new Set(analysis.pairs.map((pair) => pairKey(pair.a.track.id, pair.b.track.id)));
  let headline: string;
  if (model.tracks.size < 2) {
    headline = "EQ planning needs at least two measured, unmuted stems.";
  } else if (changes.length === 0) {
    headline = "No high-confidence EQ changes. The parts that play together are already separated where it matters for their roles.";
  } else {
    const bits = [`EQ found ${changes.length} recommended ${changes.length === 1 ? "filter" : "filters"}`];
    const kinds: string[] = [];
    if (cuts > 0) kinds.push(`${cuts} ${cuts === 1 ? "cut" : "cuts"}`);
    if (pass > 0) kinds.push(`${pass} pass ${pass === 1 ? "filter" : "filters"}`);
    if (boosts > 0) kinds.push(`${boosts} ${boosts === 1 ? "boost" : "boosts"}`);
    bits[0] += kinds.length > 0 ? `: ${kinds.join(", ")}.` : ".";
    if (sectionCount > 0) bits.push(`${sectionCount} ${sectionCount === 1 ? "is" : "are"} section-specific.`);
    if (reviewCount > 0) bits.push(`${reviewCount} ${reviewCount === 1 ? "needs" : "need"} review.`);
    headline = bits.join(" ");
  }
  const confidence =
    changes.length === 0
      ? clamp(0.82 - 0.05 * unmeasured, 0.4, 0.9)
      : clamp(round2(changes.reduce((sum, change) => sum + change.confidence, 0) / changes.length - 0.04 * unmeasured), 0.2, 0.95);
  return {
    goal: "separation",
    confidence,
    headline,
    notes: notes.slice(0, 10),
    changeCount: changes.length,
    reviewCount,
    pairsAnalyzed: unordered.size,
    analysisSource: sourceText(model, document),
  };
}

/* ------------------------------------------------------------------ helpers */

function sourceText(model: SpectralModel, document: ProjectDocument): string {
  const tracks = [...model.tracks.values()];
  const proxy = tracks.filter((item) => item.source === "proxy-bands").length;
  const from =
    proxy === tracks.length
      ? "Band levels measured from the 48 kHz playback proxies"
      : proxy === 0
        ? "Cached analysis spectrogram (coarse below a few hundred Hz, so low-end findings are less certain)"
        : `Band levels from the playback proxies for ${proxy} of ${tracks.length} stems, the cached spectrogram for the rest`;
  return `${from}: ${GRID_BANDS} log bands from 20 Hz to 20 kHz on a ${model.stepSeconds.toFixed(2)} s grid. Current faders, section gain overrides, and saved EQ are included.${document.sections.length > 0 ? " Sections are judged separately." : ""}`;
}

function directionOf(pair: PairAnalysis, protectedId: string): DirectionResult {
  return pair.a.track.id === protectedId ? pair.bOnA : pair.aOnB;
}

function separationConfidence(
  ctx: Context,
  pairs: PairAnalysis[],
  protectedId: string,
  yieldingId: string,
  result: DirectionResult,
  region: ConflictRegion,
  victimTier: Tier,
  maskerTier: Tier,
  scope: EqScope,
): number {
  let confidence = weighted(pairs, (pair) => pair.confidence);
  if (TIER_RANK[victimTier] - TIER_RANK[maskerTier] >= 2) confidence += 0.05;
  if (pairs.some((pair) => (pair.a.track.id === protectedId ? pair.explicitA : pair.explicitB))) confidence += 0.05;
  confidence += 0.05 * clamp((result.severity - 0.5) / 0.3, -1, 1);
  if (region.levelDifferenceDb >= -1 && region.persistence >= 0.6) confidence += 0.04;
  if (TIER_RANK[maskerTier] >= TIER_RANK.primary) confidence -= 0.12;
  if (scope.type === "section") confidence -= 0.04;
  const roleOf = (id: string) => ctx.model.tracks.get(id)?.track.role;
  if (roleOf(protectedId) === "other" || roleOf(yieldingId) === "other") confidence -= 0.08;
  return clamp(round2(confidence), 0.2, 0.95);
}

function separationReasons(
  ctx: Context,
  victim: Track,
  masker: Track,
  filter: EqFilter,
  region: ConflictRegion,
  victimTier: Tier,
  scope: EqScope,
  scopeNames: string[],
  pairs: PairAnalysis[],
  kind: PairAnalysis["kind"],
): string[] {
  const amount = Math.abs(filter.gainDb).toFixed(1);
  const when =
    scope.type === "section"
      ? `during ${pairs[0]!.scope.name}`
      : scopeNames.length > 0 && scopeNames.length <= 3
        ? `in ${listNames(scopeNames)}`
        : "while they play together";
  const diff = region.levelDifferenceDb;
  const relation = diff >= 0.5 ? `${diff.toFixed(1)} dB above` : diff > -0.5 ? "level with" : `only ${Math.abs(diff).toFixed(1)} dB under`;
  const role = tierPhrase(ctx, victim, victimTier, scope, pairs);
  const outcome =
    kind === "kick-bass"
      ? `A small ${masker.name} reduction should improve their hierarchy.`
      : kind === "lead-support" || victimTier === "focal"
        ? `Reducing ${masker.name}${Math.abs(filter.gainDb) <= 2 ? " slightly" : ""} there should leave more space for ${victim.name}.`
        : "This should improve separation.";
  const lines = [
    `Reduced ${masker.name} by ${amount} dB around ${formatHz(filter.frequencyHz)} because ${masker.name} and ${victim.name} are both strong in ${formatRange(region.lowHz, region.highHz)} ${when}, with ${masker.name} ${relation} ${victim.name} there, while ${victim.name} is ${role}. ${outcome}`,
  ];
  if (kind === "kick-bass") lines.push(`The cut sits at ${victim.name}'s strongest low band, so ${victim.name}'s fundamental keeps its weight.`);
  else lines.push(`A broad ${EQ_FILTER_LABELS[filter.kind].toLowerCase()} (Q ${filter.q.toFixed(1)}) keeps ${masker.name}'s tone outside that range.`);
  return lines;
}

function tierPhrase(ctx: Context, track: Track, tier: Tier, scope: EqScope, pairs: PairAnalysis[]): string {
  const pair = pairs.find((item) => (item.a.track.id === track.id ? item.explicitA : item.explicitB));
  const intent = pair ? ctx.analysis.tiers.get(track.id)?.get(pair.scope.key)?.intentText : null;
  if (tier === "focal") {
    if (intent) return `asked to stand out by the note "${quote(intent)}"`;
    return scope.type === "section" ? `marked Focal in ${pairs[0]!.scope.name}` : "marked Focal";
  }
  if (tier === "primary") {
    const role = roleLabel(track);
    if (track.role === "kick") return "the Primary rhythmic anchor";
    return role.toLowerCase() === track.name.toLowerCase() ? "Primary" : `Primary as the ${role.toLowerCase()}`;
  }
  return tier === "supporting" ? "a Supporting part" : "a background part";
}

function explainPair(ctx: Context, pair: PairAnalysis, result: DirectionResult, outcome: TrackInteraction["outcome"]): string {
  const victim = ctx.model.tracks.get(result.victimId)!.track;
  const masker = ctx.model.tracks.get(result.maskerId)!.track;
  const region = result.regions[0];
  const where = pair.scope.key === "song" ? "" : ` in ${pair.scope.name}`;
  const together = `${pair.a.track.name} and ${pair.b.track.name} play together ${Math.round(Math.min(1, pair.simultaneity) * 100)}% of the time the sparser one plays${where}.`;
  const relation = region ? (region.levelDifferenceDb >= 0.5 ? `${region.levelDifferenceDb.toFixed(1)} dB above` : region.levelDifferenceDb > -0.5 ? "level with" : `${Math.abs(region.levelDifferenceDb).toFixed(1)} dB under`) : "";
  const detail = region ? ` Strongest competition at ${formatRange(region.lowHz, region.highHz)}, where ${masker.name} sits ${relation} ${victim.name}.` : "";
  const scores = ` Plain band overlap ${Math.round(pair.overlap * 100)}%; competition score ${pair.severity.toFixed(2)}.`;
  const verdicts: Record<TrackInteraction["outcome"], string> = {
    recommendation: " An EQ move was planned.",
    review: " An EQ move is offered for review.",
    ambiguous: ` Both are ${pair.tierA === pair.tierB ? capitalize(pair.tierA) : "at the same level of priority"} and neither has a clear priority, so no automatic EQ change was proposed.`,
    "below-threshold": " Not strong enough to act on.",
    layered: " These look like layered parts that are meant to share this range, so they were left alone.",
    "no-benefit": " A filter was considered but would not measurably reduce the overlap.",
    level: " The gap is too large for a conservative EQ cut; level or arrangement is the better fix.",
  };
  return `${together}${detail}${scores}${verdicts[outcome]}`.slice(0, 600);
}

function regionDto(region: ConflictRegion) {
  return {
    centerHz: round1(region.centerHz),
    lowHz: round1(region.lowHz),
    highHz: round1(region.highHz),
    sharedEnergy: round3(clamp(region.sharedEnergy, 0, 1)),
    maskedShare: round3(clamp(region.maskedShare, 0, 1)),
    levelDifferenceDb: round1(region.levelDifferenceDb),
    severity: round3(clamp(region.severity, 0, 1)),
    persistence: round3(clamp(region.persistence, 0, 1)),
  };
}

function evidenceFor(
  model: SpectralModel,
  meanTarget: Float64Array,
  meanReference: Float64Array,
  weights: number[],
  steps: number[],
  focus: ConflictRegion | null = null,
  context: Float64Array | null = null,
  replaces: EqFilter | null = null,
): EqEvidence {
  return {
    focus: focus ? [focus.lowBand, focus.highBand] : null,
    replaces,
    contextDb: context ? Array.from(context, (value) => round1(Math.max(-200, toDb(value)))) : null,
    bandsHz: model.grid.centers.map(round1),
    edgesHz: model.grid.edges.map(round1),
    targetDb: Array.from(meanTarget, (value) => round1(Math.max(-200, toDb(value)))),
    referenceDb: Array.from(meanReference, (value) => round1(Math.max(-200, toDb(value)))),
    weights: weights.map((value) => round3(clamp(value, 0, 1))),
    windows: windowsFor(model, steps),
  };
}

/** Consecutive steps merged into windows; the longest 24 kept, in time order. */
function windowsFor(model: SpectralModel, steps: number[]): Array<[number, number]> {
  const windows: Array<[number, number]> = [];
  for (const step of steps) {
    const start = step * model.stepSeconds;
    const end = Math.min(model.durationSeconds, (step + 1) * model.stepSeconds);
    const last = windows[windows.length - 1];
    if (last && Math.abs(last[1] - start) < 1e-6) last[1] = end;
    else windows.push([start, end]);
  }
  return windows
    .map((window, index) => ({ window, index }))
    .sort((left, right) => right.window[1] - right.window[0] - (left.window[1] - left.window[0]) || left.index - right.index)
    .slice(0, 24)
    .sort((left, right) => left.index - right.index)
    .map(({ window }) => [round3(window[0]), round3(window[1])] as [number, number]);
}

/** The saved, enabled filter on a track that boosts a frequency range the most, when it boosts it by at least 1.5 dB. */
function savedBoostIn(ctx: Context, trackId: string, scope: EqScope, lowHz: number, highHz: number): { node: EqNode; boostDb: number } | null {
  const nodes = scope.type === "global" ? trackEqNodes(ctx.document, trackId) : sectionEqNodes(ctx.document, trackId, scope.sectionId);
  let best: { node: EqNode; boostDb: number } | null = null;
  for (const node of nodes) {
    if (!node.enabled || isPassFilter(node.filter.kind) || node.filter.gainDb <= 0 || ctx.replaced.has(`${trackId}:${node.id}`)) continue;
    const boostDb = 10 * Math.log10(bandPowerGain([node.filter], lowHz, highHz, 7));
    if (boostDb >= 1.5 && (!best || boostDb > best.boostDb)) best = { node, boostDb };
  }
  return best;
}

/** Puts the filter where both tracks really are inside the region, using the finer whole-file spectrum. */
function placeCenter(victim: TrackSpectra, masker: TrackSpectra, region: ConflictRegion, kind: PairAnalysis["kind"]): number {
  if (kind === "kick-bass") {
    const kick = victim.track.role === "kick" ? victim : masker;
    const low = Math.max(30, region.lowHz);
    const high = Math.min(200, region.highHz);
    const peak = kick.fineSpectrum.filter((point) => point.hz >= low && point.hz <= high).sort((left, right) => right.db - left.db || left.hz - right.hz)[0];
    if (peak) return peak.hz;
    return region.centerHz;
  }
  const near = victim.fineSpectrum
    .map((point, index) => ({ hz: point.hz, both: point.db + (masker.fineSpectrum[index]?.db ?? -200) }))
    .filter((point) => Math.abs(Math.log2(point.hz / region.centerHz)) <= 1 / 3 && point.hz >= region.lowHz && point.hz <= region.highHz);
  const best = near.sort((left, right) => right.both - left.both || left.hz - right.hz)[0];
  return best ? Math.sqrt(best.hz * region.centerHz) : region.centerHz;
}

/** "63–84 Hz", "1.5–3.6 kHz", "750 Hz–1.2 kHz": two significant figures, one unit when both ends share it. */
export function formatRange(lowHz: number, highHz: number): string {
  const low = musicalFrequency(lowHz);
  const high = musicalFrequency(highHz);
  if (high < 1_000) return `${low}–${high} Hz`;
  if (low >= 1_000) return `${trimNumber(low / 1_000)}–${trimNumber(high / 1_000)} kHz`;
  return `${low} Hz–${trimNumber(high / 1_000)} kHz`;
}

function trimNumber(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Two significant figures: 82 Hz, 250 Hz, 2.4 kHz, 12 kHz. The plan never claims more precision than broad EQ has. */
export function musicalFrequency(hz: number): number {
  const value = clamp(hz, 20, 20_000);
  const digits = Math.floor(Math.log10(value));
  const step = 10 ** (digits - 1);
  return Math.round(value / step) * step;
}

function tierOf(ctx: Context, trackId: string, scopeKeyValue: string): Tier {
  return ctx.analysis.tiers.get(trackId)?.get(scopeKeyValue)?.tier ?? "unknown";
}

function activeSeconds(model: SpectralModel, spectra: TrackSpectra, window: { start: number; end: number } | null): number {
  const steps = window ? stepsIn(model, window.start, window.end) : rangeSteps(model);
  return steps.filter((step) => spectra.active[step] === 1).length * model.stepSeconds;
}

function rangeSteps(model: SpectralModel): number[] {
  return Array.from({ length: model.steps }, (_, step) => step);
}

function shareBetween(model: SpectralModel, bands: Float64Array, low: number, high: number): number {
  const total = bands.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  let inside = 0;
  model.grid.centers.forEach((hz, band) => {
    if (hz >= low && hz < high) inside += bands[band]!;
  });
  return inside / total;
}

function shares(spectra: TrackSpectra | undefined, model: SpectralModel): number[] {
  if (!spectra) return [];
  const mean = meanBands(
    spectra,
    rangeSteps(model).filter((step) => spectra.active[step] === 1),
  );
  const total = mean.reduce((sum, value) => sum + value, 0);
  return Array.from(mean, (value) => round3(total > 0 ? value / total : 0));
}

function weighted(pairs: PairAnalysis[], value: (pair: PairAnalysis) => number): number {
  const total = pairs.reduce((sum, pair) => sum + pair.coSeconds, 0);
  if (total <= 0) return pairs.length > 0 ? value(pairs[0]!) : 0;
  return pairs.reduce((sum, pair) => sum + value(pair) * pair.coSeconds, 0) / total;
}

function weightedCenterOf(items: Array<{ hz: number; weight: number }>): number {
  const sorted = [...items].sort((left, right) => left.hz - right.hz);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  let covered = 0;
  for (const item of sorted) {
    covered += item.weight;
    if (covered >= total / 2) return item.hz;
  }
  return sorted[sorted.length - 1]?.hz ?? 1_000;
}

function orderedKeys<T>(document: ProjectDocument, groups: Map<string, T>): string[] {
  const order = new Map(document.tracks.map((track, index) => [track.id, index]));
  return [...groups.keys()].sort((left, right) => {
    const [ly, lp] = left.split(">");
    const [ry, rp] = right.split(">");
    return (order.get(ly!) ?? 0) - (order.get(ry!) ?? 0) || (order.get(lp!) ?? 0) - (order.get(rp!) ?? 0);
  });
}

function protectedNames(ctx: Context, move: Move): string {
  if (move.purpose === "presence") return `${trackName(ctx, move.trackId)}'s important energy`;
  return `${listNames(move.protectedIds.map((id) => trackName(ctx, id)))}'s important energy`;
}

function trackName(ctx: Context, trackId: string): string {
  return ctx.document.tracks.find((track) => track.id === trackId)?.name ?? trackId;
}

function listNames(names: string[], joiner = "and"): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${joiner} ${names[names.length - 1]}`;
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function sameTracks(pair: PairAnalysis, left: string, right: string): boolean {
  return (pair.a.track.id === left && pair.b.track.id === right) || (pair.a.track.id === right && pair.b.track.id === left);
}

function sameScope(left: EqScope, right: EqScope): boolean {
  return left.type === right.type && (left.type === "global" || (right.type === "section" && left.sectionId === right.sectionId));
}

function scopeKey(scope: EqScope): string {
  return scope.type === "global" ? "global" : scope.sectionId;
}

function splitKey(key: string): [string, string] {
  const at = key.indexOf(":");
  return [key.slice(0, at), key.slice(at + 1)];
}

function byBenefit(left: Move, right: Move): number {
  return right.benefit - left.benefit || left.filter.frequencyHz - right.filter.frequencyHz || left.trackId.localeCompare(right.trackId);
}

function quote(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 100 ? `${trimmed.slice(0, 97)}…` : trimmed;
}

function lowerFirst(text: string): string {
  return text.length > 0 ? `${text[0]!.toLowerCase()}${text.slice(1)}` : text;
}

function capitalize(text: string): string {
  return text.length > 0 ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

