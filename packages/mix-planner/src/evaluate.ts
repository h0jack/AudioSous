import type { TrackFileMeasurement } from "@audiosous/analysis-contract";
import { formatSignedDb } from "@audiosous/balance-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { clamp, round2, round3 } from "./changes";
import { readContrast } from "./contrast";
import { SPATIAL_RELEASE, effectOn, neededDb, problemWeight } from "./interventions";
import type { CandidateMetrics, MixChange, Regression } from "./model";
import { HEADROOM_PROBLEM_DBFS, detectMixProblems, estimatePeak, gapOf, songImage, widthSeverity, type DetectedProblem, type ProblemMetric } from "./problems";
import { SAFETY, SOLVED_SEVERITY, type FullMixSettings, type MixLimits } from "./settings";
import { PLANNERS, type Surveyor, type Survey } from "./survey";

export interface StemLevel {
  trackId: string;
  peakDbfs: number | null;
  loudnessDb: number | null;
}

export interface EvaluationContext {
  surveyor: Surveyor;
  settings: FullMixSettings;
  limits: MixLimits;
  levels: StemLevel[];
  measurements: Record<string, TrackFileMeasurement | null | undefined>;
  /** The project as saved: the baseline every candidate is compared with. */
  base: ProjectDocument;
  baseline: Survey;
  mixPeakDbfs: number | null;
}

export interface CandidateResult {
  changes: MixChange[];
  survey: Survey;
  /** Severity of every known problem on this candidate. */
  severities: Map<string, number>;
  /** Problems this candidate creates that the baseline did not have. */
  created: DetectedProblem[];
  metrics: CandidateMetrics;
  regressions: Regression[];
  score: number;
}

/**
 * Re-measures a whole candidate: every planner runs again on the candidate mix (see `Surveyor`), each known problem
 * is read again from that survey, new problems are looked for, and the mix-level safety numbers are estimated.
 * The score is the confidence- and priority-weighted problem severity removed, minus processing cost, minus a price
 * for each regression. It ranks candidates of one project; it is not a mix quality measure.
 */
export function evaluateCandidate(ctx: EvaluationContext, changes: MixChange[], known: readonly DetectedProblem[]): CandidateResult {
  const survey = ctx.surveyor.survey(changes, PLANNERS);
  const severities = new Map<string, number>();
  for (const problem of known) severities.set(problem.id, measureProblem(problem, survey, ctx, changes));
  const knownIds = new Set(known.map((problem) => problem.id));
  const changed = new Set(changes.map((change) => change.trackId));
  // A relationship that only crossed a planner's reporting line is not a regression; one whose own measure got worse is.
  const created = detectMixProblems({ survey, settings: ctx.settings, levels: ctx.levels, mixPeakDbfs: ctx.mixPeakDbfs }).filter(
    (problem) =>
      !knownIds.has(problem.id) &&
      problem.severity >= ctx.limits.minSeverity &&
      problem.trackIds.some((id) => changed.has(id)) &&
      measureProblem(problem, ctx.baseline, ctx, []) < problem.severity - 0.08,
  );
  const metrics = metricsOf(ctx, survey, changes, known, severities, created);
  const regressions: Regression[] = [];
  for (const problem of known) {
    const after = severities.get(problem.id) ?? problem.severity;
    if (after > problem.severity + 0.08 && problem.trackIds.some((id) => changed.has(id))) {
      regressions.push({ kind: "problem", trackIds: problem.trackIds, description: `${problem.title} got worse on the candidate (severity ${problem.severity.toFixed(2)} → ${after.toFixed(2)}).`, resolution: "reported" });
    }
  }
  for (const problem of created) regressions.push({ kind: "new-problem", trackIds: problem.trackIds, description: `The candidate creates a new problem: ${problem.title} (severity ${problem.severity.toFixed(2)}).`, resolution: "reported" });
  const before = ctx.baseline.space?.mix.before;
  const after = survey.space?.mix.before;
  if (before && after && (after.monoLossDb > before.monoLossDb + SAFETY.monoLossGrowthDb || after.correlation < before.correlation - SAFETY.correlationDrop)) {
    regressions.push({
      kind: "mono",
      trackIds: changes.filter((change) => change.domain === "space").map((change) => change.trackId),
      description: `Mono compatibility: the mix's fold-down loss ${before.monoLossDb.toFixed(1)} → ${after.monoLossDb.toFixed(1)} dB, correlation ${before.correlation.toFixed(2)} → ${after.correlation.toFixed(2)}.`,
      resolution: "reported",
    });
  }
  for (const [trackId, reduction] of reductionByTrack(changes)) {
    if (reduction > SAFETY.maxStemReductionDb) regressions.push({ kind: "dynamics", trackIds: [trackId], description: `Combined gain reduction on one stem reaches ${reduction.toFixed(1)} dB.`, resolution: "reported" });
  }
  for (const [trackId, shift] of sideShiftByTrack(changes)) {
    if (Math.abs(shift) > SAFETY.maxSideLevelShiftDb) regressions.push({ kind: "level-shift", trackIds: [trackId], description: `Processing moves one stem's average level by ${formatSignedDb(shift)} dB as a side effect.`, resolution: "reported" });
  }
  const steps = transitionSteps(ctx.base, survey.document, ctx.measurements, changes);
  for (const step of steps) {
    if (Math.abs(step.changeDb) > SAFETY.transitionStepDb) regressions.push({ kind: "transition", trackIds: [], description: `The level step into ${step.name} changes by ${formatSignedDb(step.changeDb)} dB.`, resolution: "reported" });
  }
  const removed = known.reduce((sum, problem) => sum + weightOf(ctx, problem) * (problem.severity - (severities.get(problem.id) ?? problem.severity)), 0);
  const createdPrice = created.reduce((sum, problem) => sum + weightOf(ctx, problem) * problem.severity, 0);
  const other = regressions.filter((item) => item.kind !== "problem" && item.kind !== "new-problem").length;
  // Side effects outside each problem (a fader move heard everywhere, a static cut while the protected part rests)
  // count against the candidate as they do against each alternative.
  const collateral = changes.reduce((sum, change) => sum + change.evaluation.collateral, 0);
  const score = round3(removed - createdPrice - metrics.processingCost - collateral - 0.1 * other);
  return { changes, survey, severities, created, metrics, regressions, score };
}

function weightOf(ctx: EvaluationContext, problem: DetectedProblem): number {
  return problemWeight(problem, ctx.settings) * (0.5 + 0.5 * problem.confidence);
}

export function problemScoreOf(ctx: Pick<EvaluationContext, "settings">, problems: readonly DetectedProblem[], severities?: Map<string, number>): number {
  return round3(problems.reduce((sum, problem) => sum + problemWeight(problem, ctx.settings) * (0.5 + 0.5 * problem.confidence) * (severities?.get(problem.id) ?? problem.severity), 0));
}

/**
 * One problem's severity on a candidate, read again with the measure it was detected with. Gaps are read from the
 * planners' interactions on the candidate (EQ evidence for masking, the dynamics planner's hit-by-hit low end for
 * kick/bass); a measure a planner cannot see (a transient shaper, a stated intent) falls back to the change's own
 * evaluation.
 */
export function measureProblem(problem: DetectedProblem, survey: Survey, ctx: Pick<EvaluationContext, "levels" | "base">, changes: readonly MixChange[]): number {
  const now = readMetric(problem, survey, ctx, changes);
  if (!now) {
    let rest = 1;
    for (const change of changes) rest *= 1 - clamp(effectOn(problem, change, { document: survey.document }).share, 0, 1);
    return round3(problem.severity * rest);
  }
  return severityAt(problem, now);
}

/**
 * The problem's measure read again from another survey, or null when no planner can see it there (a transient
 * shaper, a stated intent), in which case the change's own evaluation is used.
 */
export function readMetric(problem: DetectedProblem, survey: Survey, ctx: Pick<EvaluationContext, "levels">, changes: readonly MixChange[]): ProblemMetric | null {
  const metric = problem.metric;
  switch (metric.kind) {
    case "gap": {
      let gap: number | null = null;
      let spatial: number | null = metric.spatial;
      if (problem.type === "low-end-collision") {
        const reading = (survey.dynamics?.interactions ?? []).filter((item) => item.kind === "low-end" && item.trackA === problem.protectedTrackId && item.trackB === problem.yieldingTrackId);
        gap = (reading.find((item) => item.scope.type === "global") ?? reading[0])?.levelGapDb ?? null;
        if (gap === null) {
          const eq = (survey.eq?.interactions ?? []).filter((item) => item.kind === "kick-bass" && samePair(item.trackA, item.trackB, problem));
          gap = (eq.find((item) => item.scope.type === "global") ?? eq[0])?.regions[0]?.levelDifferenceDb ?? null;
        }
      } else {
        const eq = (survey.eq?.interactions ?? []).filter((item) => item.kind !== "kick-bass" && samePair(item.trackA, item.trackB, problem));
        const top = [...eq].sort((left, right) => right.severity - left.severity)[0];
        // The pair dropped out of the EQ planner's report: it competes too little to list.
        gap = top ? gapOf(eq, top, metric.regionHz) : metric.targetDb;
        if (metric.spatial !== null) {
          const space = (survey.space?.interactions ?? []).filter((item) => samePair(item.trackA, item.trackB, problem));
          spatial = space.length > 0 ? Math.max(...space.map((item) => item.severity)) : 0;
        }
      }
      return gap === null ? null : { ...metric, gapDb: round2(gap), spatial: spatial === null ? null : round3(spatial) };
    }
    case "level": {
      const rows = (survey.balance?.trackChanges ?? []).filter((row) => row.trackId === problem.yieldingTrackId && Math.abs(row.deltaDb) >= 0.3);
      const top = [...rows].sort((left, right) => Math.abs(right.deltaDb) - Math.abs(left.deltaDb))[0];
      return { kind: "level", deltaDb: top ? round2(top.deltaDb) : 0 };
    }
    case "spread": {
      const readings = (survey.dynamics?.readings ?? []).filter((reading) => reading.trackId === problem.yieldingTrackId && reading.spreadDb !== null && (metric.scopes.length === 0 || metric.scopes.includes(reading.scope.type === "global" ? "global" : `section:${reading.scope.sectionId}`)));
      return readings.length === 0 ? null : { ...metric, spreadDb: round2(Math.max(...readings.map((reading) => reading.spreadDb!))) };
    }
    case "transient":
    case "rows":
      return null;
    case "conflict": {
      const space = (survey.space?.interactions ?? []).filter((item) => samePair(item.trackA, item.trackB, problem));
      if (space.length === 0 || problem.trackIds.length < 2) return null;
      return { kind: "conflict", value: round3(Math.max(...space.map((item) => item.severity))) };
    }
    case "image": {
      const image = songImage(survey, problem.yieldingTrackId ?? "");
      return image ? { kind: "image", monoLossDb: round2(image.monoLossDb), correlation: round3(image.correlation) } : null;
    }
    case "peak": {
      const estimate = candidatePeak(survey.document, ctx.levels, changes);
      if (estimate === null) return null;
      // The rendered peak moves by as much as the estimate does.
      return { kind: "peak", peakDbfs: round2(metric.peakDbfs + (estimate - metric.estimateDbfs)), estimateDbfs: round2(estimate) };
    }
    case "contrast": {
      const reading = readContrast(survey).find((item) => problem.scope.type === "section" && item.sectionId === problem.scope.sectionId);
      return reading ? { kind: "contrast", reading } : null;
    }
  }
}

/** Severity of a problem whose measure now reads `now`, on the scale it was detected on. */
export function severityAt(problem: DetectedProblem, now: ProblemMetric): number {
  const metric = problem.metric;
  const severity = problem.severity;
  if (metric.kind === "gap" && now.kind === "gap") {
    const closed = (metric.gapDb - now.gapDb) / neededDb(problem);
    if (closed < 0) return round3(clamp(severity * (1 - 0.5 * closed), 0, 1));
    const spatialShare = metric.spatial !== null && now.spatial !== null && metric.spatial > 1e-3 ? SPATIAL_RELEASE * clamp((metric.spatial - now.spatial) / metric.spatial, 0, 1) : 0;
    return round3(clamp(severity * (1 - clamp(closed, 0, 1)) * (1 - spatialShare), 0, 1));
  }
  if (now.kind === "level") return now.deltaDb === 0 ? round3(Math.min(severity, 0.05)) : round3(clamp(Math.abs(now.deltaDb) / 3, 0, 1));
  if (now.kind === "spread") return round3(now.spreadDb <= now.thresholdDb ? Math.min(severity, 0.15) : clamp(0.4 + (now.spreadDb - now.thresholdDb) / 6, 0, 1));
  if (metric.kind === "conflict" && now.kind === "conflict") return round3(clamp(severity * (metric.value > 1e-3 ? now.value / metric.value : 1), 0, 1));
  if (metric.kind === "image" && now.kind === "image") return round3(clamp((severity * widthSeverity(now.monoLossDb, now.correlation)) / Math.max(1e-3, widthSeverity(metric.monoLossDb, metric.correlation)), 0, 1));
  if (now.kind === "peak") return round3(now.peakDbfs > HEADROOM_PROBLEM_DBFS ? clamp(0.4 + (now.peakDbfs - HEADROOM_PROBLEM_DBFS) / 3, 0, 1) : Math.min(severity, 0.1));
  if (now.kind === "contrast") return round3(now.reading.shortfall > 0 ? clamp(0.35 + now.reading.shortfall, 0, 1) : Math.min(severity, 0.1));
  return severity;
}

/**
 * A problem first seen on a candidate, restated against the saved mix: its measure and severity as they were before
 * any change, so what the plan itself caused counts against the plan.
 */
export function rebase(problem: DetectedProblem, baseline: Survey, ctx: Pick<EvaluationContext, "levels">): DetectedProblem {
  const metric = readMetric(problem, baseline, ctx, []);
  if (!metric) return problem;
  return { ...problem, metric, severity: severityAt(problem, metric) };
}

function samePair(a: string, b: string, problem: DetectedProblem): boolean {
  return problem.trackIds.includes(a) && problem.trackIds.includes(b) && a !== b;
}

/** Estimated sum peak of a candidate: faders as written, plus what boosts, widening, and makeup can add. */
export function candidatePeak(document: ProjectDocument, levels: StemLevel[], changes: readonly MixChange[]): number | null {
  const extra = new Map<string, number>();
  for (const change of changes) {
    if (change.processing.type === "gain" || change.processing.type === "trim") continue;
    if (change.evaluation.peakChangeDb > 0) extra.set(change.trackId, (extra.get(change.trackId) ?? 0) + change.evaluation.peakChangeDb);
  }
  return estimatePeak(document, levels, extra);
}

/** Estimated mix loudness: power sum of each stem's loudness at its fader, plus each change's predicted level change. */
export function mixLoudness(document: ProjectDocument, levels: StemLevel[], changes: readonly MixChange[] = []): number | null {
  let total = 0;
  let any = false;
  for (const track of document.tracks) {
    if (track.muted) continue;
    const level = levels.find((item) => item.trackId === track.id)?.loudnessDb;
    if (level === null || level === undefined) continue;
    const processing = changes.filter((change) => change.trackId === track.id && change.scope.type === "global" && change.processing.type !== "gain" && change.processing.type !== "trim").reduce((sum, change) => sum + change.evaluation.levelChangeDb, 0);
    total += 10 ** ((level + track.gainDb + processing) / 10);
    any = true;
  }
  return any ? round2(10 * Math.log10(total)) : null;
}

function reductionByTrack(changes: readonly MixChange[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const change of changes) if (change.processing.type === "dynamics") out.set(change.trackId, (out.get(change.trackId) ?? 0) + change.evaluation.reductionMaxDb);
  return out;
}

function sideShiftByTrack(changes: readonly MixChange[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const change of changes) if (change.processing.type !== "gain" && change.processing.type !== "trim" && change.scope.type === "global") out.set(change.trackId, (out.get(change.trackId) ?? 0) + change.evaluation.levelChangeDb);
  return out;
}

/**
 * Level steps between neighbouring sections, current against candidate: each stem's loudness timeline over the
 * section, at its section gain, plus the candidate's predicted level changes there.
 */
export function transitionSteps(base: ProjectDocument, candidate: ProjectDocument, measurements: EvaluationContext["measurements"], changes: readonly MixChange[]): Array<{ sectionId: string; name: string; changeDb: number }> {
  const sections = [...base.sections].sort((left, right) => left.startTime - right.startTime);
  if (sections.length < 2) return [];
  const level = (document: ProjectDocument, sectionId: string, start: number, end: number, withChanges: boolean) => {
    let total = 0;
    for (const track of document.tracks) {
      if (track.muted) continue;
      const timeline = measurements[track.id]?.loudnessTimeline ?? [];
      const points = timeline.filter((point) => point.timeSeconds >= start && point.timeSeconds < end && point.rmsDbfs !== null);
      if (points.length === 0) continue;
      const mean = points.reduce((sum, point) => sum + 10 ** (point.rmsDbfs! / 10), 0) / points.length;
      const gain = document.sectionTrackSettings.find((row) => row.trackId === track.id && row.sectionId === sectionId)?.overrides.gainDb ?? track.gainDb;
      const processing = withChanges
        ? changes
            .filter((change) => change.trackId === track.id && change.processing.type !== "gain" && change.processing.type !== "trim" && (change.scope.type === "global" || change.scope.sectionId === sectionId))
            .reduce((sum, change) => sum + change.evaluation.levelChangeDb, 0)
        : 0;
      total += mean * 10 ** ((gain + processing) / 10);
    }
    return total > 0 ? 10 * Math.log10(total) : null;
  };
  const out: Array<{ sectionId: string; name: string; changeDb: number }> = [];
  for (let index = 1; index < sections.length; index += 1) {
    const previous = sections[index - 1]!;
    const section = sections[index]!;
    const beforeA = level(base, previous.id, previous.startTime, previous.endTime, false);
    const beforeB = level(base, section.id, section.startTime, section.endTime, false);
    const afterA = level(candidate, previous.id, previous.startTime, previous.endTime, true);
    const afterB = level(candidate, section.id, section.startTime, section.endTime, true);
    if (beforeA === null || beforeB === null || afterA === null || afterB === null) continue;
    out.push({ sectionId: section.id, name: section.name, changeDb: round2(afterB - afterA - (beforeB - beforeA)) });
  }
  return out;
}

export function metricsOf(
  ctx: Pick<EvaluationContext, "levels" | "settings" | "limits">,
  survey: Survey,
  changes: readonly MixChange[],
  known: readonly DetectedProblem[],
  severities: Map<string, number> | null,
  created: readonly DetectedProblem[] = [],
): CandidateMetrics {
  const mix = survey.space?.mix.before ?? null;
  const reductions = [...reductionByTrack(changes).values()];
  const shifts = [...sideShiftByTrack(changes).values()].map(Math.abs);
  return {
    problemScore: round3(problemScoreOf(ctx, known, severities ?? undefined) + problemScoreOf(ctx, created)),
    openProblems: known.filter((problem) => (severities?.get(problem.id) ?? problem.severity) >= Math.max(SOLVED_SEVERITY, ctx.limits.minSeverity)).length + created.length,
    estimatedPeakDbfs: candidatePeak(survey.document, ctx.levels, changes),
    loudnessDb: mixLoudness(survey.document, ctx.levels, changes),
    correlation: mix ? round3(mix.correlation) : null,
    monoLossDb: mix ? round2(mix.monoLossDb) : null,
    centerLoad: mix ? round3(mix.centerLoad) : null,
    maxReductionDb: round2(Math.max(0, ...reductions)),
    maxSideShiftDb: round2(Math.max(0, ...shifts)),
    processingCost: round3(changes.reduce((sum, change) => sum + change.cost, 0)),
    changeCount: changes.length,
  };
}
