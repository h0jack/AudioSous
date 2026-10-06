import { ANALYSIS_ENGINE_VERSION } from "@audiosous/analysis-contract";
import { confidenceLabel, formatSignedDb, headroomTrimDb, type SourceFingerprint } from "@audiosous/balance-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { clamp, describeChange, fnv1a, processorKind, round2, round3 } from "./changes";
import { costLabel } from "./cost";
import { evaluateCandidate, metricsOf, rebase, type CandidateResult, type EvaluationContext, type StemLevel } from "./evaluate";
import { changeLabel, generateAlternatives, reductionOf, type Alternative, type InterventionContext } from "./interventions";
import { PROBLEM_LABELS, fullMixPlanSchema, type FullMixPlan, type MixChange, type MixIntervention, type MixProblem, type Regression } from "./model";
import { fullMixStateIdentity } from "./plan";
import { detectMixProblems, type DetectedProblem } from "./problems";
import { scaled } from "./rows";
import {
  DEFAULT_FULL_MIX_SETTINGS,
  FULL_MIX_PLAN_VERSION,
  FULL_MIX_PLANNER_VERSION,
  MIX_LIMITS_BY_STRENGTH,
  SAFETY,
  SOLVED_SEVERITY,
  type FullMixSettings,
  type MixLimits,
} from "./settings";
import { PLANNERS, Surveyor, type MixInputs, type Survey } from "./survey";

export interface PlanFullMixInput extends MixInputs {
  document: ProjectDocument;
  settings?: Partial<FullMixSettings>;
  fingerprints?: SourceFingerprint[];
  now?: string;
  /** The current mix's sample peak rendered from the proxies, when known; raises a headroom problem when it clips. */
  mixPeakDbfs?: number | null;
  /** Receives each stage's decisions. For acceptance scripts and debugging; the plan does not depend on it. */
  trace?: (stage: string, detail: unknown) => void;
}

type Policy = "minimal" | "balanced" | "assertive";
const POLICIES: Policy[] = ["balanced", "minimal", "assertive"];

interface Decision {
  problem: DetectedProblem;
  pass: number;
  /** Share of the problem changes chosen for other problems already remove. */
  already?: number;
  alternatives: Alternative[];
  selected: Alternative | null;
  note: string;
  outcome: "selected" | "left-alone" | "redundant" | "regression" | "budget";
  /** Changes this decision added, after merging with other decisions. */
  changeIds: string[];
}

interface Built {
  policy: Policy;
  changes: MixChange[];
  decisions: Decision[];
  result: CandidateResult;
}

/**
 * Full Mix: the smallest coherent set of changes across gain, static EQ, space, and dynamics that improves the
 * current mix.
 *
 *   survey (the four planners as measurement) → problems → alternatives per problem (≤ 4, plus "no change")
 *     → whole-mix candidates (minimal / balanced / assertive) → re-measure each → keep the best
 *     → prune what is redundant → revise what regresses → next pass on the candidate (≤ 2–4 passes)
 *
 * Deterministic: the same project, analysis, and settings give the same plan. No model is called.
 */
export function planFullMix(input: PlanFullMixInput): FullMixPlan {
  const settings: FullMixSettings = { ...DEFAULT_FULL_MIX_SETTINGS, ...input.settings };
  const limits = MIX_LIMITS_BY_STRENGTH[settings.strength];
  const document = input.document;
  const now = input.now ?? new Date().toISOString();
  const trace = input.trace ?? (() => {});
  const inputs: MixInputs = { measurements: input.measurements, sectionMeasurements: input.sectionMeasurements, bands: input.bands, stereo: input.stereo, envelopes: input.envelopes };
  const surveyor = new Surveyor(document, inputs, settings.strength, now);
  const levels: StemLevel[] = document.tracks.map((track) => {
    const measurement = input.measurements[track.id];
    return { trackId: track.id, peakDbfs: measurement?.levels.peakDbfs ?? null, loudnessDb: measurement?.levels.integratedLufs ?? measurement?.levels.rmsDbfs ?? null };
  });
  const names = (id: string) => {
    const track = document.tracks.find((item) => item.id === id);
    return track?.customLabel ?? track?.name ?? id;
  };
  const baseline = surveyor.survey([], PLANNERS);
  const mixPeakDbfs = input.mixPeakDbfs ?? null;
  const evalCtx: EvaluationContext = { surveyor, settings, limits, levels, measurements: input.measurements, base: document, baseline, mixPeakDbfs };
  const independent = {
    level: baseline.balance?.trackChanges.filter((row) => Math.abs(row.deltaDb) >= 0.05 || Math.abs(row.offsetFromGlobalDb) >= 0.05).length ?? 0,
    eq: baseline.eq?.changes.length ?? 0,
    space: baseline.space?.changes.length ?? 0,
    dynamics: baseline.dynamics?.changes.length ?? 0,
    total: 0,
  };
  independent.total = independent.level + independent.eq + independent.space + independent.dynamics;

  const known = new Map<string, DetectedProblem>();
  const firstPass = new Map<string, number>();
  const decisions = new Map<string, Decision>();
  const passes: FullMixPlan["evaluation"]["passes"] = [];
  const resolved: Regression[] = [];
  let candidates: FullMixPlan["evaluation"]["candidates"] = [];
  let chosen: MixChange[] = [];
  let current: CandidateResult | null = null;
  let stopReason = `Stopped after ${limits.maxIterations} passes, the most this strength allows.`;

  const detected0 = detectMixProblems({ survey: baseline, settings, levels, mixPeakDbfs });
  for (const problem of detected0) if (problem.severity >= limits.minSeverity) register(problem, 1);
  const baseResult = evaluateCandidate(evalCtx, [], [...known.values()]);
  current = baseResult;

  // One pass may be spent on severe level problems alone, so nothing is judged around a stem far off its level.
  let gate = true;
  for (let pass = 1; pass <= limits.maxIterations; pass += 1) {
    const survey: Survey = pass === 1 ? baseline : current!.survey;
    const detected = pass === 1 ? detected0 : detectMixProblems({ survey, settings, levels, mixPeakDbfs });
    const open = detected.filter((problem) => problem.severity >= limits.minSeverity);
    const before = known.size;
    for (const problem of open) register(problem, pass);
    // Scores of one pass are comparable only against the same list of problems.
    if (known.size !== before) current = evaluateCandidate(evalCtx, chosen, [...known.values()]);
    // Problems already chosen for (in an earlier pass) are not re-planned; their remaining severity is reported.
    const fresh = open.filter((problem) => !(decisions.get(problem.id)?.selected));
    if (fresh.length === 0) {
      stopReason = pass === 1 ? "No problem past the threshold: the mix needs no high-confidence change." : "No remaining problem past the threshold.";
      passes.push({ pass, problems: open.length, selected: 0, scoreBefore: current!.score, scoreAfter: current!.score, kept: false, note: stopReason });
      break;
    }
    // A stem far off its level is fixed before anything is judged around it, when there is an automatic fix for it.
    const severeLevel = fresh.some((problem) => problem.type === "level-hierarchy" && problem.severity >= 0.75 && problem.confidence >= limits.lowConfidence && problem.rows.balance.some((row) => row.status !== "needs-review"));
    const gated = gate && severeLevel && pass < limits.maxIterations;
    gate = false;
    const working = gated ? fresh.filter((problem) => problem.group === 1) : fresh;
    const known1 = [...known.values()];
    const builds = POLICIES.map((policy) => build(policy, working, survey, pass, known1));
    const ranked = [...builds].sort((left, right) => right.result.score - left.result.score || left.changes.length - right.changes.length || POLICIES.indexOf(left.policy) - POLICIES.indexOf(right.policy));
    let best = ranked[0]!;
    if (pass === 1) {
      candidates = builds.map((item) => ({
        name: item.policy,
        changeCount: item.changes.length,
        cost: round3(item.changes.reduce((sum, change) => sum + change.cost, 0)),
        problemScore: item.result.metrics.problemScore,
        regressions: item.result.regressions.length,
        score: item.result.score,
        chosen: item === best,
      }));
    }
    trace(`pass${pass}:candidates`, builds.map((item) => ({ policy: item.policy, score: item.result.score, changes: item.changes.map((change) => change.id) })));
    trace(
      `pass${pass}:decisions`,
      builds[0]!.decisions.map((decision) => ({ problem: decision.problem.id, sev: decision.problem.severity, outcome: decision.outcome, note: decision.note, alternatives: decision.alternatives.map((item) => ({ label: item.label, r: item.reduction, cost: item.cost, col: item.collateral, sec: item.secondary, net: item.net })) })),
    );
    best = prune(best, known1);
    best = revise(best, known1);
    const gain = best.result.score - current!.score;
    const added = best.changes.filter((change) => !chosen.some((item) => item.id === change.id)).length;
    trace(`pass${pass}:best`, { policy: best.policy, score: best.result.score, gain, changes: best.changes.map((change) => change.id), regressions: best.result.regressions });
    if (gated && (added === 0 || gain < limits.minPassGain)) {
      // The level pass found nothing worth doing; the next pass looks at everything.
      for (const decision of best.decisions) if (!decisions.has(decision.problem.id)) decisions.set(decision.problem.id, { ...decision, selected: null, changeIds: [], outcome: decision.outcome === "selected" ? "left-alone" : decision.outcome, note: decision.selected ? "Not worth its cost when the whole mix was re-measured." : decision.note });
      passes.push({ pass, problems: open.length, selected: 0, scoreBefore: current!.score, scoreAfter: best.result.score, kept: false, note: "Level-first pass: nothing worth keeping; the next pass looks at every problem." });
      continue;
    }
    if (added === 0 || gain < limits.minPassGain) {
      stopReason =
        added === 0
          ? pass === 1
            ? "No change was worth its cost: every alternative removed too little of its problem for the processing it adds."
            : "No further change was worth its cost."
          : `The next changes would improve the candidate by too little (${gain.toFixed(3)}) to be worth their cost.`;
      for (const decision of best.decisions) if (!decisions.has(decision.problem.id)) decisions.set(decision.problem.id, { ...decision, outcome: decision.selected ? "left-alone" : decision.outcome, note: decision.selected ? stopReason : decision.note, selected: null, changeIds: decision.selected ? [] : decision.changeIds });
      passes.push({ pass, problems: open.length, selected: 0, scoreBefore: current!.score, scoreAfter: best.result.score, kept: false, note: stopReason });
      break;
    }
    passes.push({ pass, problems: open.length, selected: added, scoreBefore: current!.score, scoreAfter: best.result.score, kept: true, note: `${best.policy} candidate kept: ${added} new ${added === 1 ? "change" : "changes"}.` });
    for (const decision of best.decisions) {
      const previous = decisions.get(decision.problem.id);
      if (previous?.selected) continue;
      if (previous && previous.changeIds.length > 0 && !decision.selected) continue;
      decisions.set(decision.problem.id, decision);
    }
    chosen = best.changes;
    current = best.result;
    if (pass === limits.maxIterations) stopReason = `Stopped after ${limits.maxIterations} passes, the most this strength allows.`;
  }

  // Problems seen in a pass but never decided: either no planner offered a move for them on the candidate any more,
  // or the passes ran out.
  for (const problem of known.values()) {
    if (decisions.has(problem.id)) continue;
    const after = current!.severities.get(problem.id) ?? problem.severity;
    const note =
      after < limits.minSeverity
        ? "Below the threshold once the other changes were in; nothing more was needed."
        : (firstPass.get(problem.id) ?? 1) < passes.length
          ? "Re-measured on the candidate, no planner offers a move for it any more; it is reported, not acted on."
          : `Not reached: ${stopReason}`;
    decisions.set(problem.id, { problem, pass: firstPass.get(problem.id) ?? 1, alternatives: [], selected: null, note, outcome: note.startsWith("Not reached") ? "budget" : "left-alone", changeIds: [] });
  }

  // Headroom: the candidate's estimated peak may not pass the current mix's or the ceiling, whichever is higher.
  const final = current!;
  const beforePeak = baseResult.metrics.estimatedPeakDbfs;
  const afterPeak = final.metrics.estimatedPeakDbfs;
  const trim = beforePeak !== null && afterPeak !== null ? clamp(headroomTrimDb(beforePeak, afterPeak), -SAFETY.maxTrimDb, 0) : 0;
  const trimReason = Math.abs(trim) >= 0.05 ? `Headroom trim: ${formatSignedDb(trim)} dB on every stem, because the candidate's boosts, widening, or gain moves could push the estimated peak past the current mix or ${SAFETY.ceilingDbfs} dBFS. A safety trim, not a mix decision; the balance does not change.` : null;
  if (trimReason) resolved.push({ kind: "headroom", trackIds: [], description: trimReason, resolution: "trimmed" });

  const plan = assemble();
  trace("plan", { surveys: surveyor.runs });
  return fullMixPlanSchema.parse(plan);

  /* ---------------------------------------------------------------- steps */

  /** Every problem is kept as the saved mix had it, so what the plan causes counts against the plan. */
  function register(problem: DetectedProblem, pass: number): void {
    if (!known.has(problem.id)) {
      known.set(problem.id, pass === 1 ? problem : rebase(problem, baseline, evalCtx));
      firstPass.set(problem.id, pass);
    }
  }

  function build(policy: Policy, problems: DetectedProblem[], survey: Survey, pass: number, known1: DetectedProblem[]): Built {
    const picks: MixChange[] = [...chosen];
    const made: Decision[] = [];
    const order = [...problems].sort((left, right) => left.group - right.group || right.severity * right.confidence - left.severity * left.confidence || left.id.localeCompare(right.id));
    for (const problem of order) {
      const ctx: InterventionContext = {
        document: survey.document,
        goal: settings.goal,
        names,
        chosen: picks,
        inputs,
        settings,
        limits,
        problems,
        translated: (view) => surveyor.surveyView(`${survey.key}:${fnv1a(JSON.stringify(view.sections.map((section) => section.userIntent)))}`, view, ["level", "space", "dynamics"]),
      };
      const { alternatives, already, note } = generateAlternatives(ctx, problem);
      if (note) {
        made.push({ problem, pass, already, alternatives, selected: null, note, outcome: "left-alone", changeIds: [] });
        continue;
      }
      const pick = choose(policy, problem, alternatives, limits);
      if (!pick) {
        made.push({ problem, pass, already, alternatives, selected: null, note: leftAloneReason(problem, alternatives, limits, policy, already), outcome: "left-alone", changeIds: [] });
        continue;
      }
      const budget = picks.reduce((sum, change) => sum + change.cost, 0) + pick.cost;
      if (budget > limits.maxTotalCost) {
        made.push({ problem, pass, alternatives, selected: null, note: `The plan's processing budget for this strength is spent; this problem waits.`, outcome: "budget", changeIds: [] });
        continue;
      }
      const ids: string[] = [];
      for (const change of pick.changes) {
        const at = picks.findIndex((item) => item.id === change.id);
        if (at >= 0) picks[at] = { ...picks[at]!, problemIds: [...new Set([...picks[at]!.problemIds, problem.id])].slice(0, 8) };
        else picks.push(change);
        ids.push(change.id);
      }
      made.push({ problem, pass, already, alternatives, selected: pick, note: "", outcome: "selected", changeIds: ids });
    }
    // Credit every change to every problem it measurably helps, so the plan shows one change serving several.
    const evidenceCtx = { document: survey.document };
    const credited = picks.map((change) => {
      const served = problems.filter((problem) => reductionOf(problem, [change], evidenceCtx) >= 0.1).map((problem) => problem.id);
      return { ...change, problemIds: [...new Set([...change.problemIds, ...served])].slice(0, 8) };
    });
    for (const decision of made) {
      if (decision.selected) continue;
      const serving = credited.filter((change) => change.problemIds.includes(decision.problem.id));
      if (serving.length > 0 && reductionOf(decision.problem, serving, evidenceCtx) >= 0.2) {
        decision.note = `Served by changes chosen for other problems (${serving.map((change) => changeLabel({ names, document: survey.document }, change)).join("; ")}): about ${Math.round(reductionOf(decision.problem, serving, evidenceCtx) * 100)}% of it, so nothing more was added.`;
        decision.changeIds = serving.map((change) => change.id);
      }
    }
    const result = evaluateCandidate(evalCtx, credited, known1);
    return { policy, changes: credited, decisions: made, result };
  }

  /** Leave-one-out: an intervention the re-measured mix does not miss is redundant and goes. */
  function prune(best: Built, known1: DetectedProblem[]): Built {
    let current1 = best;
    // Redundancy needs company: only an intervention that shares a stem with another selected change can be made
    // unnecessary by it. A lone change on its own stem was already judged against "no change".
    const stemsOf = (decision: Decision) => new Set(current1.changes.filter((change) => decision.changeIds.includes(change.id)).map((change) => change.trackId));
    const selected = current1.decisions
      .filter((decision) => decision.selected)
      .filter((decision) => {
        const own = stemsOf(decision);
        return current1.changes.some((change) => !decision.changeIds.includes(change.id) && (own.has(change.trackId) || decision.problem.trackIds.includes(change.trackId)));
      })
      .sort((left, right) => right.selected!.cost - left.selected!.cost || left.problem.id.localeCompare(right.problem.id))
      .slice(0, 6);
    for (const decision of selected) {
      const others = new Set(current1.decisions.filter((item) => item !== decision && item.selected).flatMap((item) => item.changeIds));
      const own = decision.changeIds.filter((id) => !others.has(id) && !chosen.some((change) => change.id === id));
      if (own.length === 0) continue;
      const without = current1.changes.filter((change) => !own.includes(change.id));
      const result = evaluateCandidate(evalCtx, without, known1);
      if (result.score >= current1.result.score - 0.002) {
        trace("prune", { problem: decision.problem.id, removed: own, with: current1.result.score, without: result.score });
        // What the whole mix had with it that it does not have without: the reason it goes.
        const only = current1.result.regressions.filter((item) => !result.regressions.some((other) => other.description === item.description));
        const worse = [...known1]
          .filter((problem) => problem.id !== decision.problem.id && (current1.result.severities.get(problem.id) ?? 0) > (result.severities.get(problem.id) ?? 0) + 0.05)
          .map((problem) => problem.title);
        const why =
          only.length > 0
            ? `with it, the re-measured mix regressed: ${only[0]!.description}`
            : worse.length > 0
              ? `with it, re-measured, ${worse[0]} got worse`
              : "the rest of the plan already covers what it would do";
        const decisions1 = current1.decisions.map((item) =>
          item === decision ? { ...item, outcome: "redundant" as const, selected: null, changeIds: [], note: `${decision.selected!.label} was left out: ${why} (candidate score ${current1.result.score.toFixed(2)} with it, ${result.score.toFixed(2)} without).` } : item,
        );
        // Keep the alternative visible as the one that was considered.
        decisions1.find((item) => item.problem.id === decision.problem.id)!.alternatives = decision.alternatives;
        current1 = { ...current1, changes: without, decisions: decisions1, result };
      }
    }
    return current1;
  }

  /** A change that makes another problem, mono, gain reduction, a stem's level, or a transition worse is halved, then removed. */
  function revise(best: Built, known1: DetectedProblem[]): Built {
    let current1 = best;
    for (let round = 0; round < 3; round += 1) {
      // Any change on the stems involved may be the cause, including one an earlier pass chose.
      const offending = current1.result.regressions.find((item) => item.trackIds.some((id) => current1.changes.some((change) => change.trackId === id)));
      if (!offending) break;
      const suspects = current1.changes.filter((change) => offending.trackIds.includes(change.trackId)).sort((left, right) => right.cost - left.cost);
      const suspect = suspects[0];
      if (!suspect) break;
      const ctx = { document, goal: settings.goal, names };
      const halved = current1.changes.map((change) => (change.id === suspect.id ? scaled(ctx, change, 0.5) : change));
      const halvedResult = evaluateCandidate(evalCtx, halved, known1);
      const stillThere = halvedResult.regressions.some((item) => item.kind === offending.kind && item.description === offending.description);
      if (!stillThere && halvedResult.score >= current1.result.score - 0.02) {
        resolved.push({ ...offending, resolution: "reduced", description: `${offending.description} ${names(suspect.trackId)}'s ${describeChange(suspect.processing, names).toLowerCase()} was halved.` });
        current1 = { ...current1, changes: halved, result: halvedResult };
        continue;
      }
      const removed = current1.changes.filter((change) => change.id !== suspect.id);
      const removedResult = evaluateCandidate(evalCtx, removed, known1);
      resolved.push({ ...offending, resolution: "removed", description: `${offending.description} ${names(suspect.trackId)}'s ${describeChange(suspect.processing, names).toLowerCase()} was removed.` });
      const decisions1 = current1.decisions.map((item) =>
        item.changeIds.includes(suspect.id)
          ? { ...item, changeIds: item.changeIds.filter((id) => id !== suspect.id), outcome: item.changeIds.length <= 1 ? ("regression" as const) : item.outcome, selected: item.changeIds.length <= 1 ? null : item.selected, note: item.changeIds.length <= 1 ? `It made the whole mix worse when re-measured: ${offending.description}` : item.note }
          : item,
      );
      current1 = { ...current1, changes: removed, decisions: decisions1, result: removedResult };
    }
    return current1;
  }

  function assemble(): FullMixPlan {
    const severities = final.severities;
    const shown = [...known.values()].filter((problem) => problem.severity >= limits.minSeverity);
    const interventions: MixIntervention[] = [];
    const problems: MixProblem[] = shown.map((problem) => {
      const decision = decisions.get(problem.id);
      const after = severities.get(problem.id) ?? problem.severity;
      const selected = decision?.selected ?? null;
      const outcome: MixProblem["outcome"] = selected
        ? after <= SOLVED_SEVERITY
          ? "solved"
          : after < problem.severity * 0.85
            ? "improved"
            : "unchanged"
        : after <= SOLVED_SEVERITY && after < problem.severity - 0.1
          ? "solved"
          : decision && decision.changeIds.length > 0 && after < problem.severity * 0.85
            ? "improved"
            : decision
            ? decision.outcome === "budget"
              ? "deferred"
              : "left-alone"
            : "deferred";
      if (decision) {
        if (selected) {
          interventions.push({
            id: selected.id,
            problemIds: [problem.id],
            label: selected.label,
            kind: selected.kind,
            items: selected.changes.map((change) => ({ trackId: change.trackId, domain: change.domain, description: describeChange(change.processing, names, change.evidence.kind === "space" ? change.evidence.current : undefined) })),
            changeIds: decision.changeIds.filter((id) => final.changes.some((change) => change.id === id)),
            cost: selected.cost,
            confidence: selected.confidence,
            expectedReduction: clamp(selected.reduction, 0, 1),
            net: selected.net,
            outcome: "selected",
            reason: selectedReason(problem, selected, decision.alternatives),
          });
        }
        for (const alternative of decision.alternatives.filter((item) => item !== selected).slice(0, 3)) {
          interventions.push({
            id: alternative.id,
            problemIds: [problem.id],
            label: alternative.label,
            kind: alternative.kind,
            items: alternative.changes.map((change) => ({ trackId: change.trackId, domain: change.domain, description: describeChange(change.processing, names, change.evidence.kind === "space" ? change.evidence.current : undefined) })),
            changeIds: [],
            cost: alternative.cost,
            confidence: alternative.confidence,
            expectedReduction: clamp(alternative.reduction, 0, 1),
            net: alternative.net,
            outcome: decision.outcome === "redundant" ? "redundant" : decision.outcome === "regression" ? "regression" : selected ? "rejected" : "not-needed",
            reason: rejectedReason(problem, alternative, selected, decision),
          });
        }
      }
      return {
        id: problem.id,
        type: problem.type,
        title: problem.title,
        scope: problem.scope,
        sectionIds: problem.sectionIds,
        trackIds: problem.trackIds,
        protectedTrackId: problem.protectedTrackId,
        yieldingTrackId: problem.yieldingTrackId,
        severity: problem.severity,
        confidence: problem.confidence,
        group: problem.group,
        references: problem.references,
        evidence: problem.evidence,
        severityAfter: round3(after),
        outcome,
        interventionId: selected?.id ?? null,
        explanation: explain(problem, decision, after, outcome),
        pass: firstPass.get(problem.id) ?? 1,
      };
    });
    const changes = final.changes.map((change) => ({ ...change, problemIds: change.problemIds.filter((id) => shown.some((problem) => problem.id === id)).length > 0 ? change.problemIds.filter((id) => shown.some((problem) => problem.id === id)) : change.problemIds }));
    const counts = { gain: 0, eq: 0, space: 0, compressor: 0, ducking: 0, transient: 0, dynamicEq: 0, trim: 0 };
    for (const change of changes) counts[processorKind(change.processing)] += 1;
    const before = metricsOf(evalCtx, baseline, [], [...known.values()], null);
    const after = final.metrics;
    const regressions = [...resolved, ...final.regressions].slice(0, 24);
    const rejected = interventions.filter((item) => item.outcome !== "selected").length;
    const reviewCount = changes.filter((change) => change.status === "needs-review").length;
    const confidence = planConfidence(problems, changes);
    const totalCost = changes.reduce((sum, change) => sum + change.cost, 0);
    const lines = summaryLines(problems, changes, counts, independent, totalCost, before, after, trim);
    const headline =
      problems.length === 0
        ? "Full Mix found no significant problems. No change is recommended."
        : changes.length === 0
          ? `Full Mix found ${problems.length} ${problems.length === 1 ? "issue" : "issues"} but no change worth its cost.`
          : `Full Mix found ${problems.length} significant ${problems.length === 1 ? "issue" : "issues"} and proposes ${changes.length} ${changes.length === 1 ? "change" : "changes"}.`;
    const notes = [stopReason, ...(trimReason ? [trimReason] : []), ...subsystemNotes()].slice(0, 12);
    return {
      planVersion: FULL_MIX_PLAN_VERSION,
      plannerVersion: FULL_MIX_PLANNER_VERSION,
      kind: "full-mix",
      createdAt: now,
      projectId: document.project.id,
      sourceAnalysisVersion: ANALYSIS_ENGINE_VERSION,
      settings,
      stateIdentity: fullMixStateIdentity(document, settings, input.fingerprints ?? []),
      summary: {
        headline,
        lines,
        notes,
        confidence,
        confidenceLabel: confidenceLabel(confidence),
        problemCount: problems.length,
        changeCount: changes.length,
        rejectedCount: rejected,
        reviewCount,
        processing: counts,
        costLabel: costLabel(totalCost),
      },
      problems,
      interventions: interventions.slice(0, 256),
      changes,
      evaluation: {
        method: "re-measured",
        before,
        after,
        candidates,
        passes,
        stopReason,
        regressions,
        independent,
        surveys: surveyor.runs,
      },
      candidateTrim: { gainDb: round2(trim), reason: trimReason, renderedDb: null },
      levels: document.tracks.map((track) => {
        const level = levels.find((item) => item.trackId === track.id);
        return { trackId: track.id, loudnessDb: level?.loudnessDb ?? null, peakDbfs: level?.peakDbfs ?? null, gainDb: track.gainDb, muted: track.muted };
      }),
    };
  }

  function subsystemNotes(): string[] {
    const notes: string[] = [];
    for (const note of [...(baseline.eq?.summary.notes ?? []), ...(baseline.dynamics?.summary.notes ?? []), ...(baseline.space?.summary.notes ?? []), ...(baseline.balance?.summary.notes ?? [])]) {
      if (/could mean|Name the stem|no envelope|no band frames|less certain/i.test(note)) notes.push(note);
    }
    if (!baseline.dynamics) notes.push("No stem has envelope frames, so dynamics were not read. Open the project in the desktop app to measure them.");
    return [...new Set(notes)].slice(0, 4);
  }
}

/* ------------------------------------------------------------------ choice */

/** True when a planner marked part of the alternative for a person's review: it is shown, never chosen automatically. */
function needsPerson(alternative: Alternative): boolean {
  return alternative.changes.some((change) => change.status === "needs-review");
}

function choose(policy: Policy, problem: DetectedProblem, alternatives: Alternative[], limits: MixLimits): Alternative | null {
  const automatic = alternatives.filter((item) => !needsPerson(item));
  const eligible = automatic.filter((item) => item.net > limits.minNet && item.reduction >= limits.minReduction);
  if (policy === "minimal") {
    if (problem.severity < limits.minSeverity + 0.1 || problem.confidence < limits.lowConfidence) return null;
    const singles = eligible.filter((item) => item.kind === "single");
    return [...singles].sort((left, right) => left.cost - right.cost || right.net - left.net)[0] ?? null;
  }
  if (policy === "balanced") return [...eligible].sort((left, right) => right.net - left.net || left.cost - right.cost)[0] ?? null;
  const loose = automatic.filter((item) => item.net > limits.minNet / 2 && item.reduction >= limits.minReduction * 0.75);
  return [...loose].sort((left, right) => right.total - left.total || left.cost - right.cost)[0] ?? null;
}

function leftAloneReason(problem: DetectedProblem, alternatives: Alternative[], limits: MixLimits, policy: Policy, already: number): string {
  if (alternatives.length === 0) return already > 0 ? `Changes chosen for other problems already remove about ${Math.round(already * 100)}% of it; nothing else was offered.` : "None of the planners offered a move that acts on it within Audiosous's limits.";
  const automatic = alternatives.filter((item) => !needsPerson(item));
  if (automatic.length === 0) {
    const flagged = alternatives[0]!.changes.find((change) => change.status === "needs-review")!;
    return `The only alternatives need a person's review (${alternatives[0]!.label}): ${flagged.warnings[0] ?? flagged.reasons[flagged.reasons.length - 1] ?? "its planner marked it for review"}`.slice(0, 600);
  }
  const best = automatic[0]!;
  if (policy === "minimal" && (problem.severity < limits.minSeverity + 0.1 || problem.confidence < limits.lowConfidence)) return "Not clear-cut enough for the minimal candidate.";
  if (best.reduction < limits.minReduction) return `The best alternative (${best.label}) would remove only about ${Math.round(best.reduction * 100)}% of it.`;
  return `The best alternative (${best.label}) is not worth its processing: benefit ${best.benefit.toFixed(2)} against cost ${best.cost.toFixed(2)}${best.collateral > 0.005 ? ` and ${best.collateral.toFixed(2)} of side effects` : ""}.`;
}

function selectedReason(problem: DetectedProblem, selected: Alternative, alternatives: Alternative[]): string {
  const share = Math.round(selected.reduction * 100);
  const others = alternatives.filter((item) => item !== selected);
  const cheaper = others.filter((item) => item.cost < selected.cost - 0.005);
  const parts = [`Expected to remove about ${share}% of the problem for processing cost ${selected.cost.toFixed(2)}.`];
  if (selected.secondary > 0.01) parts.push("It also helps another problem in the plan.");
  if (cheaper.length > 0) parts.push(`Cheaper options remove less (${cheaper.map((item) => `${item.label}: ${Math.round(item.reduction * 100)}%`).join("; ")}).`);
  if (selected.kind === "combined") parts.push("No single processor was enough, so two run at reduced depth.");
  void problem;
  return parts.join(" ").slice(0, 600);
}

function rejectedReason(problem: DetectedProblem, alternative: Alternative, selected: Alternative | null, decision: Decision): string {
  if (decision.outcome === "redundant" || decision.outcome === "regression") return decision.note.slice(0, 600);
  if (needsPerson(alternative)) return `Needs a person: its planner marked it for review, so Full Mix does not choose it automatically. ${alternative.changes.find((change) => change.status === "needs-review")?.warnings[0] ?? ""}`.trim().slice(0, 600);
  if (!selected) return `Not needed: ${decision.note}`.slice(0, 600);
  const reasons: string[] = [];
  if (alternative.reduction + 0.05 < selected.reduction) reasons.push(`removes less of the problem (${Math.round(alternative.reduction * 100)}% against ${Math.round(selected.reduction * 100)}%)`);
  if (alternative.collateral > selected.collateral + 0.02) {
    const change = alternative.changes[0]!;
    reasons.push(
      change.processing.type === "gain"
        ? "would change the stem everywhere it plays, not only where the conflict is"
        : change.processing.type === "eq" && problem.type === "event-masking"
          ? `would cut the stem also while ${problem.protectedTrackId ? "the protected part" : "the other part"} rests (${Math.round((problem.freeShare ?? 0) * 100)}% of the time)`
          : "costs more outside the conflict",
    );
  }
  if (alternative.cost > selected.cost + 0.01 && Math.abs(alternative.reduction - selected.reduction) <= 0.1) reasons.push("a comparable result for more processing");
  if (alternative.kind === "combined" && selected.kind === "single") reasons.push("one processor already does enough; a second adds little");
  if (reasons.length === 0) reasons.push(`a lower net benefit (${alternative.net.toFixed(2)} against ${selected.net.toFixed(2)})`);
  return `Rejected: ${reasons.join("; ")}.`.slice(0, 600);
}

function explain(problem: DetectedProblem, decision: Decision | undefined, after: number, outcome: MixProblem["outcome"]): string {
  const label = PROBLEM_LABELS[problem.type];
  const measured = `${label}, severity ${problem.severity.toFixed(2)} → ${after.toFixed(2)} re-measured on the candidate.`;
  if (!decision) return `${measured} It appeared in the last pass and was not planned.`;
  const shared = (decision.already ?? 0) >= 0.05 ? ` Changes chosen for other problems already remove about ${Math.round((decision.already ?? 0) * 100)}% of it.` : "";
  if (decision.selected) {
    const verdict = outcome === "solved" ? "Resolved" : outcome === "improved" ? "Improved" : "Not measurably changed";
    return `${verdict}: ${decision.selected.label}.${shared} ${measured}`.slice(0, 800);
  }
  return `${decision.note} ${measured}`.slice(0, 800);
}

function planConfidence(problems: MixProblem[], changes: MixChange[]): number {
  if (problems.length === 0) return 0.9;
  const agreement = problems.filter((problem) => problem.interventionId !== null);
  // Agreement between what each change was expected to do locally and what the re-measured candidate shows.
  const gaps = agreement.map((problem) => Math.abs((problem.severity - (problem.severityAfter ?? problem.severity)) / Math.max(problem.severity, 1e-3) - (changes.filter((change) => change.problemIds.includes(problem.id)).reduce((best, change) => Math.max(best, change.evaluation.reduction), 0))));
  const agree = gaps.length > 0 ? 1 - clamp(gaps.reduce((sum, value) => sum + value, 0) / gaps.length, 0, 1) : 0.8;
  const problemConfidence = problems.reduce((sum, problem) => sum + problem.confidence, 0) / problems.length;
  const lowShare = changes.length > 0 ? changes.filter((change) => change.confidence < 0.6).length / changes.length : 0;
  return round3(clamp(0.45 * problemConfidence + 0.35 * agree + 0.2 * (1 - lowShare), 0.2, 0.95));
}

function summaryLines(problems: MixProblem[], changes: MixChange[], counts: FullMixPlan["summary"]["processing"], independent: FullMixPlan["evaluation"]["independent"], totalCost: number, before: FullMixPlan["evaluation"]["before"], after: FullMixPlan["evaluation"]["after"], trim: number): string[] {
  const lines: string[] = [];
  const parts: string[] = [];
  const add = (count: number, one: string, many: string) => {
    if (count > 0) parts.push(`${count} ${count === 1 ? one : many}`);
  };
  add(counts.gain, "gain change", "gain changes");
  add(counts.eq, "EQ change", "EQ changes");
  add(counts.space, "spatial adjustment", "spatial adjustments");
  add(counts.compressor, "compressor", "compressors");
  add(counts.ducking, "ducking relationship", "ducking relationships");
  add(counts.dynamicEq, "dynamic EQ", "dynamic EQs");
  add(counts.transient, "transient shaper", "transient shapers");
  add(counts.trim, "safety trim", "safety trims");
  lines.push(changes.length > 0 ? `Selected: ${parts.join(", ")}.` : "Selected: nothing.");
  lines.push(`The four planners on their own propose ${independent.total} (Level ${independent.level}, EQ ${independent.eq}, Space ${independent.space}, Dynamics ${independent.dynamics}); Full Mix keeps ${changes.length}.`);
  const solved = problems.filter((problem) => problem.outcome === "solved" || problem.outcome === "improved").length;
  if (problems.length > 0) lines.push(`${solved} of ${problems.length} ${problems.length === 1 ? "issue" : "issues"} resolved or improved when the candidate was re-measured.`);
  lines.push(`Estimated processing cost: ${costLabel(totalCost)}.`);
  const concerns: string[] = [];
  if (before.estimatedPeakDbfs !== null && after.estimatedPeakDbfs !== null && after.estimatedPeakDbfs + trim > before.estimatedPeakDbfs + 0.05 && after.estimatedPeakDbfs + trim > SAFETY.ceilingDbfs) concerns.push("the candidate's estimated peak is hotter than the current mix's");
  if (before.monoLossDb !== null && after.monoLossDb !== null && after.monoLossDb > before.monoLossDb + SAFETY.monoLossGrowthDb) concerns.push("mono fold-down loses more than before");
  if (after.maxReductionDb > SAFETY.maxStemReductionDb) concerns.push("heavy gain reduction on one stem");
  lines.push(concerns.length === 0 ? "No clipping, mono-compatibility, or gain-reduction concerns detected." : `Check: ${concerns.join("; ")}.`);
  return lines;
}
