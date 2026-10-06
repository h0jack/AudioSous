import { formatSignedDb } from "@audiosous/balance-planner";
import { bandGrid, evaluateFilter, formatHz, musicalFrequency, type EqEvidence } from "@audiosous/eq-planner";
import { normalizeEqFilter, type ProjectDocument } from "@audiosous/project-model";
import { clamp, describeChange, round2, round3, sameScope } from "./changes";
import { EXTRA_PROCESSOR_COST, isAnchor } from "./cost";
import type { MixChange, MixProblemType } from "./model";
import { HEADROOM_PROBLEM_DBFS, widthSeverity, type DetectedProblem } from "./problems";
import { eqChange, fromBalanceRow, fromDynamicsRow, fromEqRow, fromSpaceRow, gainChange, lowBandChangeDb, scaled, type RowContext } from "./rows";
import { MIN_PROBLEM_CONFIDENCE, type FullMixSettings, type MixLimits } from "./settings";
import type { MixInputs, Survey } from "./survey";
import { translatedNotes } from "./contrast";

export interface InterventionContext extends RowContext {
  document: ProjectDocument;
  /** Surveys a view of the candidate whose notes are rewritten (section contrast in each planner's vocabulary). */
  translated?: (document: ProjectDocument) => Survey;
  inputs: MixInputs;
  settings: FullMixSettings;
  limits: MixLimits;
  /** Every open problem of this pass, for crediting a change that helps several. */
  problems: readonly DetectedProblem[];
}

/** One way to solve one problem: a single processor, or two at reduced depth. */
export interface Alternative {
  id: string;
  problemId: string;
  label: string;
  kind: "single" | "combined";
  changes: MixChange[];
  /** Share of the problem removed with this alternative and the changes already chosen, minus what those already removed. */
  reduction: number;
  /** Total share removed, counting changes already chosen. */
  total: number;
  cost: number;
  collateral: number;
  /** Benefit to other open problems (half weight): what makes one change that serves two preferred. */
  secondary: number;
  benefit: number;
  net: number;
  confidence: number;
  notes: string[];
}

/** How much a problem matters, before severity and confidence. A goal leans the weights; it never adds work. */
export function problemWeight(problem: DetectedProblem, settings: FullMixSettings): number {
  const base: Record<MixProblemType, number> = {
    headroom: 1,
    "level-hierarchy": 1,
    "frequency-conflict": 1,
    "low-end-collision": 1,
    "event-masking": 1,
    "dynamic-instability": 0.9,
    "transient-problem": 0.85,
    "center-congestion": 0.8,
    "excessive-width": 0.95,
    "section-contrast": 0.8,
    intent: 0.75,
  };
  let weight = base[problem.type];
  const goal = settings.goal;
  if (goal === "punchy" && (problem.type === "transient-problem" || problem.type === "low-end-collision")) weight *= 1.2;
  if (goal === "controlled" && problem.type === "dynamic-instability") weight *= 1.25;
  if ((goal === "open" || goal === "wide") && problem.type === "center-congestion") weight *= 1.2;
  if (goal === "intimate" && problem.type === "center-congestion") weight *= 0.8;
  if (problem.intended) weight *= 1.15;
  return weight;
}

/* ------------------------------------------------------------------ effect of a change on a problem */

interface Effect {
  /** dB of a gap closed (gap problems). */
  db: number;
  /** Share removed directly (other metrics, and space on a masking gap). */
  share: number;
}

const NONE: Effect = { db: 0, share: 0 };
/** Share of a frequency conflict a stereo separation releases (a supporting part moved from a centred lead). */
export const SPATIAL_RELEASE = 0.35;

/** What one change does to one problem, from the change's own evaluation. Also used to credit changes chosen for other problems. */
export function effectOn(problem: DetectedProblem, change: MixChange, ctx: Pick<InterventionContext, "document">): Effect {
  // A trim moves every stem together: it changes headroom and nothing else.
  if (change.processing.type === "trim") return problem.metric.kind === "peak" ? { db: 0, share: clamp(-change.processing.gainDb / Math.max(0.5, problem.metric.peakDbfs - HEADROOM_PROBLEM_DBFS + 0.3), 0, 1) } : NONE;
  if (!problem.trackIds.includes(change.trackId) && problem.type !== "section-contrast") return NONE;
  if (problem.type === "section-contrast" && !(change.scope.type === "section" && problem.scope.type === "section" && change.scope.sectionId === problem.scope.sectionId)) return NONE;
  const coverage = scopeCoverage(problem, change);
  if (coverage <= 0) return NONE;
  const metric = problem.metric;
  const processing = change.processing;
  const evaluation = change.evaluation;
  const yielding = change.trackId === problem.yieldingTrackId;
  switch (metric.kind) {
    case "gap": {
      if (processing.type === "gain") return { db: coverage * (yielding ? Math.max(0, -processing.deltaDb) : 0.8 * Math.max(0, processing.deltaDb)), share: 0 };
      if (processing.type === "eq") {
        const region = metric.regionHz;
        const hz = processing.filter.frequencyHz;
        if (region && (hz < region[0] / 1.5 || hz > region[1] * 1.5)) return NONE;
        // Judged on the pair's own band levels, the same numbers every other spectral alternative is judged on.
        if (yielding && problem.eqEvidence && !change.replacesNodeId) return { db: coverage * Math.max(0, evaluateFilter(problem.eqEvidence, processing.filter, "separation").gapReductionDb), share: 0 };
        return { db: coverage * Math.max(0, evaluation.eq?.gapReductionDb ?? 0), share: 0 };
      }
      if (processing.type === "dynamics") {
        const node = processing.processing;
        const keyed = (node.type === "ducking" || node.type === "dynamic-eq") && node.keyTrackId === problem.protectedTrackId;
        const dynamics = evaluation.dynamics;
        if (keyed && yielding && problem.type !== "low-end-collision" && problem.eqEvidence && dynamics) {
          // While the protected stem plays (which is when they compete) the node sits at its typical depth.
          const depth = -Math.abs(dynamics.reductionP50Db);
          if (node.type === "dynamic-eq") {
            const bell = normalizeEqFilter({ kind: "bell", frequencyHz: node.filter.frequencyHz, q: node.filter.q, gainDb: Math.min(0, Math.max(-12, depth)) });
            return { db: coverage * Math.max(0, evaluateFilter(problem.eqEvidence, bell, "separation").gapReductionDb), share: 0 };
          }
          return { db: coverage * Math.abs(depth), share: 0 };
        }
        if (keyed && yielding && dynamics?.conflictBeforeDb != null && dynamics.conflictAfterDb != null) return { db: coverage * Math.max(0, dynamics.conflictBeforeDb - dynamics.conflictAfterDb), share: 0 };
        if (node.type === "compressor" && yielding) return { db: coverage * 0.5 * Math.max(0, -evaluation.levelChangeDb), share: 0 };
        return NONE;
      }
      if (processing.type === "spatial" && evaluation.space && pairedWith(change, problem)) {
        const before = evaluation.space.conflictBefore;
        // Moving a part away in the field releases only part of a frequency conflict with a centred lead.
        return { db: 0, share: coverage * SPATIAL_RELEASE * clamp(before > 1e-3 ? (before - evaluation.space.conflictAfter) / before : 0, 0, 1) };
      }
      return NONE;
    }
    case "level": {
      const wanted = metric.deltaDb;
      const moved = processing.type === "gain" ? processing.deltaDb : 0.9 * evaluation.levelChangeDb;
      if (Math.sign(moved) !== Math.sign(wanted)) return NONE;
      return { db: 0, share: coverage * clamp(moved / wanted, 0, 1) };
    }
    case "spread": {
      const dynamics = evaluation.dynamics;
      if (processing.type !== "dynamics" || processing.processing.type !== "compressor" || dynamics?.spreadBeforeDb == null || dynamics.spreadAfterDb == null) return NONE;
      const room = Math.max(1, dynamics.spreadBeforeDb - (metric.thresholdDb - 1));
      return { db: 0, share: coverage * clamp((dynamics.spreadBeforeDb - dynamics.spreadAfterDb) / room, 0, 1) };
    }
    case "transient": {
      const dynamics = evaluation.dynamics;
      if (processing.type !== "dynamics" || processing.processing.type !== "transient" || dynamics?.transientBeforeDb == null || dynamics.transientAfterDb == null) return NONE;
      const moved = dynamics.transientAfterDb - dynamics.transientBeforeDb;
      if ((metric.excess && moved >= 0) || (!metric.excess && moved <= 0)) return NONE;
      return { db: 0, share: coverage * clamp(Math.abs(moved) / 2, 0, 1) };
    }
    case "conflict": {
      if (processing.type === "spatial" && evaluation.space && pairedWith(change, problem)) {
        const before = evaluation.space.conflictBefore;
        return { db: 0, share: coverage * clamp(before > 1e-3 ? (before - evaluation.space.conflictAfter) / before : 0, 0, 1) };
      }
      if (processing.type === "eq" && yielding) return { db: 0, share: coverage * 0.3 * clamp((evaluation.eq?.gapReductionDb ?? 0) / 4, 0, 1) };
      return NONE;
    }
    case "image": {
      const space = evaluation.space;
      if (processing.type !== "spatial" || !space) return NONE;
      const before = Math.max(1e-3, widthSeverity(metric.monoLossDb, metric.correlation));
      return { db: 0, share: coverage * clamp(1 - widthSeverity(space.monoLossAfterDb + (metric.monoLossDb - space.monoLossBeforeDb), space.correlationAfter) / before, 0, 1) };
    }
    case "peak":
      return processing.type === "gain" && processing.deltaDb < 0 ? { db: 0, share: 0.1 * clamp(-processing.deltaDb / 3, 0, 1) } : NONE;
    case "contrast": {
      const asked = metric.reading.asked;
      const role = ctx.document.tracks.find((track) => track.id === change.trackId)?.role ?? "other";
      if (processing.type === "spatial" && processing.width !== null && change.evidence.kind === "space" && processing.width > change.evidence.current.width + 0.02 && asked.includes("width")) return { db: 0, share: 0.6 };
      if (processing.type === "dynamics" && processing.processing.type === "transient" && processing.processing.attack > 0 && asked.includes("punch")) return { db: 0, share: 0.6 };
      if (processing.type === "gain" && processing.deltaDb > 0 && asked.includes("foreground") && (role === "lead" || role === "vocal")) return { db: 0, share: 0.6 };
      return NONE;
    }
    case "rows": {
      const rows = change.domain === "space" ? problem.rows.space : change.domain === "eq" ? problem.rows.eq : [];
      return rows.some((row) => row.trackId === change.trackId && sameScope(row.scope, change.scope)) ? { db: 0, share: 0.8 } : NONE;
    }
  }
}

/** Share of a problem a set of changes removes. Gaps add in dB; space and other measures combine as independent shares. */
export function reductionOf(problem: DetectedProblem, changes: readonly MixChange[], ctx: Pick<InterventionContext, "document">): number {
  let db = 0;
  let rest = 1;
  for (const change of changes) {
    const effect = effectOn(problem, change, ctx);
    db += effect.db;
    rest *= 1 - clamp(effect.share, 0, 1);
  }
  const metric = problem.metric;
  if (metric.kind === "gap") {
    const needed = neededDb(problem);
    return round3(clamp(1 - (1 - clamp(db / needed, 0, 1)) * rest, 0, 1));
  }
  return round3(clamp(1 - rest, 0, 1));
}

export function neededDb(problem: DetectedProblem): number {
  if (problem.metric.kind !== "gap") return 1;
  return clamp(problem.metric.gapDb - problem.metric.targetDb, 1, problem.metric.capDb);
}

/** A section change on a whole-song problem only covers part of it. */
function scopeCoverage(problem: DetectedProblem, change: MixChange): number {
  if (change.scope.type === "global") return 1;
  if (problem.scope.type === "section") return problem.scope.sectionId === change.scope.sectionId ? 1 : 0;
  const sections = problem.sectionIds.length;
  if (sections === 0) return 0.4;
  return problem.sectionIds.includes(change.scope.sectionId) ? 1 / sections : 0.2;
}

function pairedWith(change: MixChange, problem: DetectedProblem): boolean {
  if (change.evidence.kind !== "space") return false;
  const other = problem.trackIds.find((id) => id !== change.trackId);
  if (!other) return true;
  return change.evidence.evidence.scopes.some((scope) => scope.pairs.some((pair) => pair.trackId === other));
}

/** Price a change pays outside the problem it solves, in the benefit unit. */
export function collateralOf(problem: DetectedProblem, change: MixChange): number {
  const processing = change.processing;
  const evaluation = change.evaluation;
  let price = 0;
  if (processing.type === "gain" && problem.metric.kind === "gap") {
    // A fader move is heard everywhere, not just where the two meet.
    // A fader move is heard everywhere, not just where the two meet, and moves the stem away from the current balance.
    price += 0.2 * clamp(Math.abs(processing.deltaDb) / 2, 0, 1) * (1 - clamp(problem.coactive ?? 0.5, 0, 1) * 0.5) * (problem.type === "low-end-collision" ? 1.4 : 1);
  }
  if (processing.type === "eq" && problem.metric.kind === "gap") {
    const region = Math.abs(evaluation.eq?.regionChangeDb ?? 0);
    if (problem.type === "event-masking") price += 0.25 * clamp(problem.freeShare ?? 0.4, 0, 1) * clamp(region / 2.5, 0, 1);
    else if (problem.type === "low-end-collision") price += 0.12 * clamp(region / 2, 0, 1);
    else price += 0.04 * clamp(region / 3, 0, 1);
  }
  if (processing.type === "dynamics") {
    const node = processing.processing;
    const outside = Math.abs(evaluation.outsideChangeDb ?? 0);
    if (node.type === "ducking") price += 0.1 * clamp(outside / 1.5, 0, 1) + ((evaluation.dynamics?.recovery ?? 1) < 0.6 ? 0.05 : 0);
    if (node.type === "dynamic-eq") price += 0.1 * clamp(outside / 1, 0, 1);
    if (node.type === "compressor") {
      const crestLoss = (evaluation.dynamics?.crestBeforeDb ?? 0) - (evaluation.dynamics?.crestAfterDb ?? 0);
      price += 0.04 * Math.max(0, crestLoss - 1);
    }
  }
  if (processing.type === "spatial" && evaluation.space) {
    price += evaluation.space.collateral + 0.1 * Math.max(0, evaluation.space.mixAfter.monoLossDb - evaluation.space.mixBefore.monoLossDb);
  }
  if (processing.type !== "gain" && processing.type !== "trim" && Math.abs(evaluation.levelChangeDb) > 1 && problem.type !== "level-hierarchy") price += 0.05 * (Math.abs(evaluation.levelChangeDb) - 1);
  return round3(price);
}

/* ------------------------------------------------------------------ alternatives */

/**
 * Up to four ways to solve a problem, each judged on the problem's own evidence: every row the four planners
 * offered for it, a plain gain move where one could do the job, a small static cut where the EQ planner left a
 * low-end overlap undecided, and two of those at reduced depth when no single one is enough. "No change" is
 * always the fifth option, with net 0; an alternative has to beat it.
 */
export function generateAlternatives(ctx: InterventionContext, problem: DetectedProblem): { alternatives: Alternative[]; already: number; note: string | null } {
  const already = reductionOf(problem, ctx.chosen, ctx);
  if (problem.confidence < MIN_PROBLEM_CONFIDENCE) return { alternatives: [], already, note: `Confidence ${Math.round(problem.confidence * 100)}% is too low to change anything for this.` };
  if (already >= 0.7) return { alternatives: [], already, note: `Changes chosen for other problems already remove about ${Math.round(already * 100)}% of it.` };
  const singles: MixChange[] = [];
  const push = (change: MixChange | null) => {
    if (!change) return;
    if (singles.some((item) => item.id === change.id)) return;
    const chosen = ctx.chosen.find((item) => item.id === change.id);
    // A different setting for a change another problem already chose would contradict it.
    if (chosen && JSON.stringify(chosen.processing) !== JSON.stringify(change.processing)) return;
    singles.push(change);
  };
  for (const row of problem.rows.dynamics) push(fromDynamicsRow(ctx, row, problem.id));
  for (const row of problem.rows.eq) push(fromEqRow(ctx, row, problem.id));
  for (const row of problem.rows.space) push(fromSpaceRow(ctx, row, problem.id));
  if (problem.type === "level-hierarchy" || problem.type === "section-contrast") {
    for (const row of problem.rows.balance) push(fromBalanceRow(ctx, row, problem.id));
  } else if (problem.metric.kind === "gap" && (problem.type === "low-end-collision" || problem.levelProblem || problem.metric.gapDb - problem.metric.targetDb > problem.metric.capDb + 2)) {
    // A fader move is offered for a conflict only when it is a level problem; otherwise it is EQ's or space's to solve.
    push(gapGain(ctx, problem));
  }
  if (problem.type === "low-end-collision" && !singles.some((change) => change.domain === "eq")) push(lowEndCut(ctx, problem));
  if (problem.type === "headroom") push(trimChange(ctx, problem));
  if (problem.type === "section-contrast" && problem.metric.kind === "contrast" && ctx.translated) {
    // The note in each planner's own words, for the dimensions that fall short; the planners size the moves.
    const survey = ctx.translated(translatedNotes(ctx.document, problem.metric.reading));
    const sectionId = problem.metric.reading.sectionId;
    const inSection = (row: { scope: { type: string; sectionId?: string } }) => row.scope.type === "section" && row.scope.sectionId === sectionId;
    for (const row of (survey.space?.changes ?? []).filter((item) => inSection(item) && (item.purpose === "intent" || item.purpose === "widen"))) push(fromSpaceRow(ctx, row, problem.id));
    for (const row of (survey.dynamics?.changes ?? []).filter((item) => inSection(item) && item.problem === "transient-weakness")) push(fromDynamicsRow(ctx, row, problem.id));
    for (const row of (survey.balance?.trackChanges ?? []).filter((item) => inSection(item) && item.deltaDb > 0 && item.deltaDb <= 2)) push(fromBalanceRow(ctx, row, problem.id));
  }

  const lowConfidence = problem.confidence < ctx.limits.lowConfidence;
  // A change another problem already chose is credited in `already`, not offered again as an alternative.
  const usable = singles.filter((change) => !ctx.chosen.some((item) => item.id === change.id) && (effectOn(problem, change, ctx).db > 0.05 || effectOn(problem, change, ctx).share > 0.02));
  let options: Alternative[] = usable.map((change) => score(ctx, problem, [lowConfidence ? scaled(ctx, change, 0.7) : change], already, "single"));
  if (lowConfidence) options = options.filter((option) => option.cost <= 0.1);
  options.sort(byNet);
  const best = options[0];
  if (!lowConfidence && ctx.limits.maxChangesPerProblem >= 2 && best && best.total < 0.8) {
    const top = options.slice(0, 3);
    const combos: Alternative[] = [];
    for (let left = 0; left < top.length; left += 1) {
      for (let right = left + 1; right < top.length; right += 1) {
        const a = top[left]!.changes[0]!;
        const b = top[right]!.changes[0]!;
        if (a.domain === b.domain || a.trackId === b.trackId && a.domain === "gain") continue;
        const depth = ctx.limits.comboDepth;
        combos.push(score(ctx, problem, [scaled(ctx, a, depth), scaled(ctx, b, depth)], already, "combined"));
      }
    }
    combos.sort(byNet);
    if (combos[0]) options.push(combos[0]);
  }
  options.sort(byNet);
  return { alternatives: options.slice(0, 4), already, note: null };
}

function byNet(left: Alternative, right: Alternative): number {
  return right.net - left.net || left.cost - right.cost || left.id.localeCompare(right.id);
}

function score(ctx: InterventionContext, problem: DetectedProblem, changes: MixChange[], already: number, kind: "single" | "combined"): Alternative {
  const withChosen = [...ctx.chosen.filter((item) => !changes.some((change) => change.id === item.id)), ...changes];
  const total = reductionOf(problem, withChosen, ctx);
  const reduction = round3(Math.max(0, total - already));
  const fresh = changes.filter((change) => !ctx.chosen.some((item) => item.id === change.id));
  const cost = round3(fresh.reduce((sum, change) => sum + change.cost, 0) + (kind === "combined" ? EXTRA_PROCESSOR_COST : 0));
  const collateral = round3(fresh.reduce((sum, change) => sum + collateralOf(problem, change), 0));
  const weight = problemWeight(problem, ctx.settings);
  const benefit = weight * problem.severity * (0.5 + 0.5 * problem.confidence) * reduction;
  let secondary = 0;
  for (const other of ctx.problems) {
    if (other.id === problem.id) continue;
    const before = reductionOf(other, ctx.chosen, ctx);
    const after = reductionOf(other, withChosen, ctx);
    if (after > before) secondary += 0.5 * problemWeight(other, ctx.settings) * other.severity * (0.5 + 0.5 * other.confidence) * (after - before);
    // A change that makes another problem worse pays for it here.
    if (after < before) secondary -= problemWeight(other, ctx.settings) * other.severity * (before - after);
  }
  const confidence = round3(0.5 * problem.confidence + 0.5 * Math.min(...changes.map((change) => change.confidence)));
  const net = round3(benefit + secondary - cost - collateral);
  const label = changes.map((change) => changeLabel(ctx, change)).join(" + ");
  return {
    id: `${problem.id}::${changes.map((change) => change.id).join("+")}${kind === "combined" ? "::combined" : ""}`,
    problemId: problem.id,
    label,
    kind,
    changes: changes.map((change) => ({ ...change, problemIds: [problem.id], evaluation: { ...change.evaluation, reduction: reductionOf(problem, [change], ctx), collateral: collateralOf(problem, change) } })),
    reduction,
    total,
    cost,
    collateral,
    secondary: round3(secondary),
    benefit: round3(benefit),
    net,
    confidence,
    notes: [],
  };
}

/** A fader move on the yielding stem, sized to close part of the gap the way AutoBalance would (≤ 2 dB on Normal). */
function gapGain(ctx: InterventionContext, problem: DetectedProblem): MixChange | null {
  const yielding = problem.yieldingTrackId;
  if (!yielding) return null;
  const track = ctx.document.tracks.find((item) => item.id === yielding);
  if (!track) return null;
  const balance = problem.rows.balance.find((row) => row.trackId === yielding && row.deltaDb < 0 && sameScope(row.scope, problem.scope));
  if (balance) return fromBalanceRow(ctx, balance, problem.id);
  const cap = { conservative: 1, normal: 2, strong: 3 }[ctx.settings.strength];
  const delta = -Math.min(cap, Math.max(0.5, Math.round(neededDb(problem) * 0.5 * 2) / 2));
  const current = problem.scope.type === "section" ? (ctx.document.sectionTrackSettings.find((row) => row.trackId === yielding && row.sectionId === (problem.scope as { sectionId: string }).sectionId)?.overrides.gainDb ?? track.gainDb) : track.gainDb;
  return gainChange(ctx, {
    trackId: yielding,
    scope: problem.scope,
    currentGainDb: current,
    deltaDb: delta,
    problemId: problem.id,
    confidence: problem.confidence,
    reason: `Lowering ${ctx.names(yielding)} ${formatSignedDb(delta)} dB would close part of the gap everywhere it plays, not only where the conflict is.`,
  });
}

/** A small static low cut on the bass where the kick's fundamental sits, re-checkable on the band frames. */
function lowEndCut(ctx: InterventionContext, problem: DetectedProblem): MixChange | null {
  const bassId = problem.yieldingTrackId;
  const kickId = problem.protectedTrackId;
  if (!bassId || !kickId) return null;
  const bass = meanBands(ctx.inputs, bassId);
  const kick = meanBands(ctx.inputs, kickId);
  if (!bass || !kick) return null;
  const grid = bandGrid();
  // Where the kick's own low end peaks, 45–120 Hz.
  let peakBand = -1;
  for (let band = 0; band < grid.centers.length; band += 1) {
    const hz = grid.centers[band]!;
    if (hz < 45 || hz > 120) continue;
    if (peakBand < 0 || kick[band]! > kick[peakBand]!) peakBand = band;
  }
  if (peakBand < 0) return null;
  const depth = { conservative: 1, normal: 1.5, strong: 2.5 }[ctx.settings.strength];
  const filter = normalizeEqFilter({ kind: "bell", frequencyHz: musicalFrequency(grid.centers[peakBand]!), gainDb: -depth, q: 1.2 });
  const focusLow = grid.centers.findIndex((hz) => hz >= 40);
  let focusHigh = focusLow;
  grid.centers.forEach((hz, band) => {
    if (hz <= 150) focusHigh = Math.max(focusHigh, band);
  });
  const evidence: EqEvidence = {
    bandsHz: grid.centers.map((hz) => round2(hz)),
    edgesHz: grid.edges.map((hz) => round2(hz)),
    targetDb: bass.map((db) => round2(db)),
    referenceDb: kick.map((db) => round2(db)),
    replaces: null,
    contextDb: null,
    weights: grid.centers.map((hz) => (hz < 250 ? 1 : 0.2)),
    focus: [focusLow, focusHigh],
    windows: [],
  };
  const change = eqChange(ctx, {
    trackId: bassId,
    scope: { type: "global" },
    filter,
    evidence,
    problemId: problem.id,
    confidence: Math.min(0.75, problem.confidence),
    reason: `A small ${ctx.names(bassId)} cut at ${formatHz(filter.frequencyHz)}, where ${ctx.names(kickId)}'s fundamental sits, lowers ${ctx.names(bassId)}'s low end by ${(-lowBandChangeDb(bass, grid.edges, filter)).toFixed(1)} dB on every hit and between them.`,
  });
  return change;
}

function trimChange(ctx: InterventionContext, problem: DetectedProblem): MixChange | null {
  if (problem.metric.kind !== "peak") return null;
  const trim = -Math.min(6, Math.ceil((problem.metric.peakDbfs - HEADROOM_PROBLEM_DBFS + 0.2) * 2) / 2);
  const change = gainChange(ctx, { trackId: ctx.document.tracks[0]!.id, scope: { type: "global" }, currentGainDb: 0, deltaDb: trim, problemId: problem.id, confidence: problem.confidence, reason: "trim" });
  return {
    ...change,
    id: "trim:mix",
    domain: "trim",
    source: "full-mix",
    processing: { type: "trim", gainDb: trim },
    planned: { type: "trim", gainDb: trim },
    current: "every fader as it is",
    cost: 0.03,
    evaluation: { ...change.evaluation, levelChangeDb: trim, peakChangeDb: trim, summary: `${formatSignedDb(trim)} dB on every stem; the balance does not change.` },
    reasons: [`The current mix peaks at ${formatSignedDb(problem.metric.peakDbfs)} dBFS when rendered. A ${formatSignedDb(trim)} dB trim on every fader keeps the balance and brings it under ${formatSignedDb(HEADROOM_PROBLEM_DBFS)} dBFS. It is a safety trim, not a loudness target, and no limiter is used.`],
  };
}

/** A stem's mean grid-band levels where it plays, from the proxy band frames. */
function meanBands(inputs: MixInputs, trackId: string): number[] | null {
  const frames = inputs.bands?.[trackId];
  if (!frames || frames.frames.length === 0) return null;
  const bands = frames.frames[0]!.length;
  const sums = new Array<number>(bands).fill(0);
  let count = 0;
  for (const frame of frames.frames) {
    const total = frame.reduce((sum, db) => sum + 10 ** (db / 10), 0);
    if (total <= 1e-9) continue;
    frame.forEach((db, band) => (sums[band] = sums[band]! + 10 ** (db / 10)));
    count += 1;
  }
  if (count === 0) return null;
  return sums.map((sum) => 10 * Math.log10(Math.max(sum / count, 1e-20)));
}

/** "Bass duck from Kick, up to −1.4 dB, 5 / 140 ms", "Lead gain +1.0 dB in Drop". */
export function changeLabel(ctx: Pick<InterventionContext, "names" | "document">, change: MixChange): string {
  if (change.processing.type === "trim") return describeChange(change.processing, ctx.names);
  const where = change.scope.type === "section" ? ` in ${ctx.document.sections.find((section) => section.id === (change.scope as { sectionId: string }).sectionId)?.name ?? "a section"}` : "";
  return `${ctx.names(change.trackId)} ${lowerFirst(describeChange(change.processing, ctx.names, change.evidence.kind === "space" ? change.evidence.current : undefined))}${where}`;
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}

export { isAnchor };
