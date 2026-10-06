import { confidenceLabel, formatSignedDb, type GainRecommendation } from "@audiosous/balance-planner";
import { dynamicsWarnings, evaluateDynamics, type DynamicsRecommendation } from "@audiosous/dynamics-planner";
import { bandPowerGain, evaluateFilter, needsReview as eqNeedsReview, type EqEvidence, type EqRecommendation } from "@audiosous/eq-planner";
import { normalizeEqFilter, normalizePan, normalizeWidth, type EqFilter, type ProjectDocument } from "@audiosous/project-model";
import { evaluateSpatial, safetyWarnings, type SpatialRecommendation } from "@audiosous/spatial-planner";
import { clamp, describeChange, domainOf, fnv1a, nodeIdFor, panWords, round2, round3, scopeKey } from "./changes";
import { changeCost, type CostContext } from "./cost";
import type { ChangeEvaluation, ChangeProcessing, MixChange, MixScope, MixSource } from "./model";

/**
 * Turns the four planners' rows into full-mix changes, and re-checks any change (a scaled alternative, an edit)
 * from the evidence stored with it, using the subsystem's own evaluator. No planner runs and no audio is read.
 */
export interface RowContext extends CostContext {
  names: (trackId: string) => string;
  /** Changes already chosen, so a row that edits one of their nodes becomes that change again, not another one. */
  chosen: readonly MixChange[];
}

const REVIEW_CONFIDENCE = 0.55;

export function fromBalanceRow(ctx: RowContext, row: GainRecommendation, problemId: string): MixChange {
  const processing: ChangeProcessing = { type: "gain", gainDb: round2(row.recommendedGainDb), deltaDb: round2(row.deltaDb) };
  const id = `gain:${row.trackId}:${scopeKey(row.scope)}`;
  return finish(ctx, {
    id,
    problemIds: [problemId],
    trackId: row.trackId,
    scope: row.scope,
    source: "level",
    processing,
    replacesNodeId: null,
    current: `${formatSignedDb(row.currentGainDb)} dB`,
    confidence: row.confidence,
    status: row.status === "needs-review" ? "needs-review" : "proposed",
    reasons: row.reasons,
    evidence: { kind: "level", currentGainDb: row.currentGainDb },
  });
}

/** A gain move the four planners did not propose: the full-mix planner's own level alternative. */
export function gainChange(ctx: RowContext, input: { trackId: string; scope: MixScope; currentGainDb: number; deltaDb: number; problemId: string; reason: string; confidence: number }): MixChange {
  const delta = round2(input.deltaDb);
  return finish(ctx, {
    id: `gain:${input.trackId}:${scopeKey(input.scope)}`,
    problemIds: [input.problemId],
    trackId: input.trackId,
    scope: input.scope,
    source: "full-mix",
    processing: { type: "gain", gainDb: round2(input.currentGainDb + delta), deltaDb: delta },
    replacesNodeId: null,
    current: `${formatSignedDb(input.currentGainDb)} dB`,
    confidence: input.confidence,
    status: "proposed",
    reasons: [input.reason],
    evidence: { kind: "level", currentGainDb: input.currentGainDb },
  });
}

export function fromEqRow(ctx: RowContext, row: EqRecommendation, problemId: string): MixChange {
  const edits = ctx.chosen.find((change) => change.domain === "eq" && row.replacesNodeId !== null && nodeIdFor(change) === row.replacesNodeId);
  const id = edits?.id ?? `eq:${row.trackId}:${scopeKey(row.scope)}:${Math.round(4 * Math.log2(row.processing.filter.frequencyHz / 20))}`;
  return finish(ctx, {
    id,
    problemIds: [problemId],
    trackId: row.trackId,
    scope: row.scope,
    source: "eq",
    processing: { type: "eq", filter: row.processing.filter },
    replacesNodeId: edits ? edits.replacesNodeId : row.replacesNodeId,
    current: row.evidence.replaces ? `saved ${describeChange({ type: "eq", filter: row.evidence.replaces }, ctx.names)}` : "no filter here",
    confidence: row.confidence,
    status: row.status === "needs-review" ? "needs-review" : "proposed",
    reasons: row.reasons,
    evidence: { kind: "eq", purpose: row.purpose, evidence: edits?.evidence.kind === "eq" ? edits.evidence.evidence : row.evidence },
  });
}

/** A static cut the EQ planner left to review or ambiguity (kick/bass): built on band frames the change can be re-checked on. */
export function eqChange(ctx: RowContext, input: { trackId: string; scope: MixScope; filter: EqFilter; evidence: EqEvidence; problemId: string; reason: string; confidence: number }): MixChange {
  return finish(ctx, {
    id: `eq:${input.trackId}:${scopeKey(input.scope)}:${Math.round(4 * Math.log2(input.filter.frequencyHz / 20))}`,
    problemIds: [input.problemId],
    trackId: input.trackId,
    scope: input.scope,
    source: "full-mix",
    processing: { type: "eq", filter: normalizeEqFilter(input.filter) },
    replacesNodeId: null,
    current: "no filter here",
    confidence: input.confidence,
    status: "proposed",
    reasons: [input.reason],
    evidence: { kind: "eq", purpose: "low-end", evidence: input.evidence },
  });
}

export function fromSpaceRow(ctx: RowContext, row: SpatialRecommendation, problemId: string): MixChange {
  return finish(ctx, {
    id: `space:${row.trackId}:${scopeKey(row.scope)}`,
    problemIds: [problemId],
    trackId: row.trackId,
    scope: row.scope,
    source: "space",
    processing: row.processing,
    replacesNodeId: null,
    current: `${panWords(row.current.pan)}, width ${Math.round(row.current.width * 100)}%`,
    confidence: row.confidence,
    status: row.status === "needs-review" ? "needs-review" : "proposed",
    reasons: row.reasons,
    evidence: { kind: "space", current: row.current, evidence: row.evidence },
  });
}

export function fromDynamicsRow(ctx: RowContext, row: DynamicsRecommendation, problemId: string): MixChange {
  const processing = row.processing;
  const key = processing.type === "ducking" || processing.type === "dynamic-eq" ? processing.keyTrackId : null;
  const edits = ctx.chosen.find((change) => change.domain === "dynamics" && row.replacesNodeId !== null && nodeIdFor(change) === row.replacesNodeId);
  return finish(ctx, {
    id: edits?.id ?? `dyn:${row.trackId}:${scopeKey(row.scope)}:${processing.type}:${key ?? ""}`,
    problemIds: [problemId],
    trackId: row.trackId,
    scope: row.scope,
    source: "dynamics",
    processing: { type: "dynamics", processing },
    replacesNodeId: edits ? edits.replacesNodeId : row.replacesNodeId,
    current: row.replacesNodeId ? "a saved node of this kind (edited, not stacked)" : `no ${processing.type === "dynamic-eq" ? "dynamic EQ" : processing.type === "ducking" ? "duck" : processing.type} here`,
    confidence: row.confidence,
    status: row.status === "needs-review" ? "needs-review" : "proposed",
    reasons: row.reasons,
    evidence: { kind: "dynamics", problem: row.problem, targetReductionDb: row.targetReductionDb, evidence: edits?.evidence.kind === "dynamics" ? edits.evidence.evidence : row.evidence },
  });
}

type Draft = Omit<MixChange, "planned" | "domain" | "cost" | "confidenceLabel" | "edited" | "warnings" | "evaluation">;

function finish(ctx: RowContext, draft: Draft): MixChange {
  const base: MixChange = {
    ...draft,
    confidence: round3(clamp(draft.confidence, 0, 1)),
    confidenceLabel: confidenceLabel(draft.confidence),
    domain: domainOf(draft.processing),
    planned: draft.processing,
    cost: 0,
    edited: false,
    warnings: [],
    reasons: draft.reasons.slice(0, 6).map((reason) => reason.slice(0, 600)),
    evaluation: emptyEvaluation(),
  };
  return reevaluate(ctx, base);
}

export function emptyEvaluation(): ChangeEvaluation {
  return { summary: "", reduction: 0, levelChangeDb: 0, peakChangeDb: 0, reductionMaxDb: 0, outsideChangeDb: null, collateral: 0, eq: null, space: null, dynamics: null };
}

/**
 * Re-reads a change's effect from its evidence with its own subsystem's evaluator, then its cost, warnings, and
 * whether it waits for review. Keeps `reduction` (set by the planner per problem) as it was.
 */
export function reevaluate(ctx: CostContext & { names: (trackId: string) => string }, change: MixChange): MixChange {
  const evidence = change.evidence;
  const processing = change.processing;
  let evaluation: ChangeEvaluation = { ...emptyEvaluation(), reduction: change.evaluation.reduction, collateral: change.evaluation.collateral };
  let warnings: string[] = [];
  let review = change.confidence < REVIEW_CONFIDENCE;
  let reductionP95: number | undefined;
  if (processing.type === "gain") {
    evaluation = { ...evaluation, levelChangeDb: processing.deltaDb, peakChangeDb: Math.max(0, processing.deltaDb), summary: `${formatSignedDb(processing.deltaDb)} dB on the fader${change.scope.type === "section" ? " in this section" : ""}.` };
    if (Math.abs(processing.deltaDb) > 6) {
      warnings.push(`A ${formatSignedDb(processing.deltaDb)} dB move is larger than Audiosous makes on its own.`);
      review = true;
    }
  } else if (processing.type === "trim") {
    evaluation = { ...evaluation, levelChangeDb: processing.gainDb, peakChangeDb: processing.gainDb, summary: `${formatSignedDb(processing.gainDb)} dB on every stem, so the estimated peak stays under the ceiling. The balance does not change.` };
  } else if (processing.type === "eq" && evidence.kind === "eq") {
    const result = evaluateFilter(evidence.evidence, processing.filter, evidence.purpose);
    const boost = processing.filter.kind !== "high-pass" && processing.filter.kind !== "low-pass" && processing.filter.gainDb > 0 ? processing.filter.gainDb : 0;
    evaluation = {
      ...evaluation,
      eq: { ...result, passes: 1, proxy: null },
      levelChangeDb: result.identityChangeDb,
      peakChangeDb: round2(boost * 0.5),
      outsideChangeDb: result.regionChangeDb,
      summary: `${result.regionChangeDb.toFixed(1)} dB on this stem in its range, pulling it ${result.gapReductionDb.toFixed(1)} dB further under the part it protects.`,
    };
    review = review || eqNeedsReview(processing.filter, change.confidence, evidence.evidence.replaces);
  } else if (processing.type === "spatial" && evidence.kind === "space") {
    const pan = processing.pan === null ? null : normalizePan(processing.pan);
    const width = processing.width === null ? null : normalizeWidth(processing.width);
    const result = evaluateSpatial(evidence.evidence, { pan, width }, change.scope.type === "global");
    warnings = safetyWarnings({ current: evidence.current, scope: change.scope }, { pan, width }, result);
    evaluation = {
      ...evaluation,
      space: { ...result, passes: 1, proxy: null },
      levelChangeDb: result.levelChangeDb,
      peakChangeDb: Math.max(0, result.levelChangeDb),
      summary: `Conflict ${result.conflictBefore.toFixed(2)} → ${result.conflictAfter.toFixed(2)}; this stem's mono fold-down ${result.monoLossBeforeDb.toFixed(1)} → ${result.monoLossAfterDb.toFixed(1)} dB.`,
    };
    review = review || warnings.length > 0;
  } else if (processing.type === "dynamics" && evidence.kind === "dynamics") {
    const result = evaluateDynamics(evidence.evidence, processing.processing, change.scope);
    warnings = dynamicsWarnings({ targetReductionDb: evidence.targetReductionDb }, processing.processing, result);
    reductionP95 = result.reductionP95Db;
    const peak = processing.processing.type === "compressor" ? Math.max(0, result.peakChangeDb ?? 0) : processing.processing.type === "transient" && processing.processing.attack > 0 ? result.reductionMaxDb : 0;
    evaluation = {
      ...evaluation,
      dynamics: { ...result, passes: 1, proxy: null },
      levelChangeDb: result.levelChangeDb,
      peakChangeDb: round2(peak),
      reductionMaxDb: processing.processing.type === "transient" ? 0 : result.reductionMaxDb,
      outsideChangeDb: result.outsideChangeDb,
      summary: dynamicsSummary(result, processing.processing.type),
    };
    review = review || warnings.length > 0;
  }
  const current = change.evidence.kind === "space" ? change.evidence.current : undefined;
  const cost = changeCost(ctx, { trackId: change.trackId, scope: change.scope, processing, replacesNodeId: change.replacesNodeId, reductionP95Db: reductionP95 }, current);
  const status = change.status === "accepted" || change.status === "rejected" ? change.status : review ? "needs-review" : change.status === "needs-review" && !change.edited ? "needs-review" : "proposed";
  return { ...change, evaluation, warnings: warnings.slice(0, 6), cost, status };
}

function dynamicsSummary(result: ReturnType<typeof evaluateDynamics>, type: string): string {
  if (type === "compressor") return `Reduction ${result.reductionP50Db.toFixed(1)}/${result.reductionP95Db.toFixed(1)} dB (p50/p95); sustained spread ${result.spreadBeforeDb?.toFixed(1)} → ${result.spreadAfterDb?.toFixed(1)} dB; level ${formatSignedDb(result.levelChangeDb)} dB.`;
  if (type === "transient") return `Attack over body ${result.transientBeforeDb?.toFixed(1)} → ${result.transientAfterDb?.toFixed(1)} dB; level ${formatSignedDb(result.levelChangeDb)} dB.`;
  return `Up to ${result.reductionMaxDb.toFixed(1)} dB while the key plays; the conflict ${result.conflictBeforeDb?.toFixed(1)} → ${result.conflictAfterDb?.toFixed(1)} dB; ${formatSignedDb(result.outsideChangeDb ?? 0)} dB where it does not.`;
}

/** The same change at `share` of its depth (a gain move, a cut, a duck, a dip, a pan or width move). */
export function scaled(ctx: CostContext & { names: (trackId: string) => string }, change: MixChange, share: number): MixChange {
  const processing = change.processing;
  let next: ChangeProcessing = processing;
  if (processing.type === "gain") {
    const delta = round2(processing.deltaDb * share);
    next = { type: "gain", gainDb: round2(processing.gainDb - processing.deltaDb + delta), deltaDb: delta };
  } else if (processing.type === "eq" && processing.filter.kind !== "high-pass" && processing.filter.kind !== "low-pass") {
    const replaced = change.evidence.kind === "eq" ? (change.evidence.evidence.replaces?.gainDb ?? 0) : 0;
    next = { type: "eq", filter: normalizeEqFilter({ ...processing.filter, gainDb: replaced + (processing.filter.gainDb - replaced) * share }) };
  } else if (processing.type === "spatial" && change.evidence.kind === "space") {
    const current = change.evidence.current;
    next = {
      type: "spatial",
      pan: processing.pan === null ? null : normalizePan(current.pan + (processing.pan - current.pan) * share),
      width: processing.width === null ? null : normalizeWidth(current.width + (processing.width - current.width) * share),
    };
  } else if (processing.type === "dynamics") {
    const node = processing.processing;
    if (node.type === "ducking" || node.type === "dynamic-eq") next = { type: "dynamics", processing: { ...node, rangeDb: Math.min(-0.5, round1(node.rangeDb * share)) } };
    else if (node.type === "transient") next = { type: "dynamics", processing: { ...node, attack: round2(node.attack * share), sustain: round2(node.sustain * share) } };
    else return change;
  }
  return reevaluate(ctx, { ...change, id: `${change.id}`, processing: next, planned: next });
}

/** Low band (40–150 Hz) change of a stem's spectrum through a filter, dB. */
export function lowBandChangeDb(bandsDb: number[], edgesHz: number[], filter: EqFilter): number {
  let before = 0;
  let after = 0;
  for (let band = 0; band < bandsDb.length; band += 1) {
    const low = edgesHz[band]!;
    const high = edgesHz[band + 1]!;
    if (high <= 40 || low >= 150) continue;
    const power = 10 ** (bandsDb[band]! / 10);
    before += power;
    after += power * bandPowerGain([filter], Math.max(40, low), Math.min(150, high));
  }
  return before > 0 && after > 0 ? round2(10 * Math.log10(after / before)) : 0;
}

export function changeKey(change: MixChange): string {
  return fnv1a(JSON.stringify([change.id, change.processing]));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export type { MixSource, ProjectDocument };
