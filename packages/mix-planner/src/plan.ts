import { ANALYSIS_ENGINE_VERSION, ENVELOPE_FRAMES_VERSION, EQ_BANDS_VERSION, STEREO_FRAMES_VERSION } from "@audiosous/analysis-contract";
import { PLANNER_VERSION, confidenceLabel, formatSignedDb, headroomTrimDb, type SourceFingerprint } from "@audiosous/balance-planner";
import { DYNAMICS_PLANNER_VERSION, normalizeProcessing, type DynamicsPatch } from "@audiosous/dynamics-planner";
import { EDIT_LIMITS, EQ_PLANNER_VERSION } from "@audiosous/eq-planner";
import { dynamicsIdentity, normalizeEqFilter, normalizePan, normalizeWidth, processingIdentity, spatialIdentity, withUpdatedAt, type EqFilter, type ProjectDocument } from "@audiosous/project-model";
import { SPATIAL_PLANNER_VERSION } from "@audiosous/spatial-planner";
import { addTrim, applyChanges, clamp, clampGain, fnv1a, round2 } from "./changes";
import { candidatePeak, mixLoudness, type StemLevel } from "./evaluate";
import type { ChangeProcessing, ChangeStatus, FullMixPlan, MixChange } from "./model";
import { reevaluate } from "./rows";
import { FULL_MIX_PLANNER_VERSION, MAX_LOUDNESS_MATCH_DB, SAFETY, type FullMixSettings } from "./settings";

/* ------------------------------------------------------------------ identity */

/**
 * Everything a full-mix plan depends on: every stem's identity, role, fader, pan, width, mute, and file; sections
 * and their intent; Track × Section prominence, notes, and overrides; every saved EQ, spatial, and dynamics node;
 * the analysis versions of all four measurements; every planner's version; and the settings. Selection, playhead,
 * loop, and zoom are not in it.
 */
export function fullMixStateIdentity(document: ProjectDocument, settings: FullMixSettings, fingerprints: SourceFingerprint[] = []): string {
  const files = new Map(fingerprints.map((file) => [file.trackId, file]));
  const payload = {
    projectId: document.project.id,
    analysis: [ANALYSIS_ENGINE_VERSION, EQ_BANDS_VERSION, STEREO_FRAMES_VERSION, ENVELOPE_FRAMES_VERSION],
    planners: [PLANNER_VERSION, EQ_PLANNER_VERSION, SPATIAL_PLANNER_VERSION, DYNAMICS_PLANNER_VERSION, FULL_MIX_PLANNER_VERSION],
    settings,
    tracks: document.tracks.map((track) => {
      const file = files.get(track.id);
      return [track.id, track.name, track.customLabel, track.role, track.gainDb, track.pan, track.width, track.muted, track.metadata.durationSeconds, file?.fileSizeBytes ?? track.metadata.fileSizeBytes, file?.modifiedAtNs ?? ""];
    }),
    sections: document.sections.map((section) => [section.id, section.startTime, section.endTime, section.type, section.userIntent]),
    rows: [...document.sectionTrackSettings]
      .sort((left, right) => `${left.trackId}:${left.sectionId}`.localeCompare(`${right.trackId}:${right.sectionId}`))
      .map((row) => [row.trackId, row.sectionId, row.prominence, row.userIntent, row.overrides.gainDb, row.overrides.pan, row.overrides.width]),
    eq: processingIdentity(document),
    spatial: spatialIdentity(document),
    dynamics: dynamicsIdentity(document),
  };
  return fnv1a(JSON.stringify(payload));
}

export function fullMixPlanIsStale(plan: FullMixPlan, document: ProjectDocument, fingerprints: SourceFingerprint[] = [], settings: FullMixSettings = plan.settings): boolean {
  return plan.projectId !== document.project.id || plan.stateIdentity !== fullMixStateIdentity(document, settings, fingerprints);
}

/* ------------------------------------------------------------------ status */

export type FullMixApplyMode = "all" | "accepted";

/** Same rule as the other plans: rejected never, needs-review only once accepted, Apply accepted takes accepted only. */
export function changeIncluded(change: Pick<MixChange, "status">, mode: FullMixApplyMode | "preview"): boolean {
  if (change.status === "rejected") return false;
  if (mode === "accepted") return change.status === "accepted";
  if (change.status === "needs-review") return false;
  return change.status === "proposed" || change.status === "accepted";
}

export function setChangeStatus(plan: FullMixPlan, id: string, status: ChangeStatus): FullMixPlan {
  return refreshFullMix({ ...plan, changes: plan.changes.map((change) => (change.id === id ? { ...change, status } : change)) });
}

/** The changes that make up one problem's selected solution. */
export function solutionChanges(plan: FullMixPlan, problemId: string): MixChange[] {
  const problem = plan.problems.find((item) => item.id === problemId);
  const intervention = problem?.interventionId ? plan.interventions.find((item) => item.id === problem.interventionId) : null;
  const ids = new Set(intervention?.changeIds ?? []);
  return plan.changes.filter((change) => ids.has(change.id) || (ids.size === 0 && change.problemIds.includes(problemId)));
}

/** Accept or reject a whole solution: every change selected for that problem. */
export function setProblemStatus(plan: FullMixPlan, problemId: string, status: "accepted" | "rejected"): FullMixPlan {
  const ids = new Set(solutionChanges(plan, problemId).map((change) => change.id));
  return refreshFullMix({ ...plan, changes: plan.changes.map((change) => (ids.has(change.id) ? { ...change, status } : change)) });
}

/* ------------------------------------------------------------------ edits */

/** One edit, in the shape of the change it edits. */
export type ChangePatch = { gainDb?: number } & Partial<Pick<EqFilter, "frequencyHz" | "gainDb" | "q">> & { pan?: number | null; width?: number | null } & DynamicsPatch;

/**
 * Edits one change with the same bounds as its own planner's editor and re-checks it from its stored evidence with
 * that planner's evaluator, then re-checks the plan's safety (headroom trim, mono, gain reduction) from the changes'
 * evaluations. The planner does not run again.
 */
export function editChange(plan: FullMixPlan, id: string, patch: ChangePatch): FullMixPlan {
  const names = (trackId: string) => trackId;
  const changes = plan.changes.map((change) => {
    if (change.id !== id) return change;
    const processing = patched(change, patch);
    const edited = JSON.stringify(processing) !== JSON.stringify(change.planned);
    const next = reevaluate({ document: emptyDocument(plan), goal: plan.settings.goal, names }, { ...change, processing, edited });
    return { ...next, cost: change.cost, status: change.status === "proposed" && next.status === "needs-review" ? ("needs-review" as const) : change.status };
  });
  return refreshFullMix({ ...plan, changes });
}

export function resetChange(plan: FullMixPlan, id: string): FullMixPlan {
  const change = plan.changes.find((item) => item.id === id);
  if (!change) return plan;
  const changes = plan.changes.map((item) => (item.id === id ? reevaluate({ document: emptyDocument(plan), goal: plan.settings.goal, names: (trackId) => trackId }, { ...item, processing: item.planned, edited: false }) : item));
  return refreshFullMix({ ...plan, changes: changes.map((item) => (item.id === id ? { ...item, cost: change.cost, status: change.status } : item)) });
}

function patched(change: MixChange, patch: ChangePatch): ChangeProcessing {
  const processing = change.processing;
  switch (processing.type) {
    case "gain": {
      if (patch.gainDb === undefined) return processing;
      const current = change.evidence.kind === "level" ? change.evidence.currentGainDb : processing.gainDb - processing.deltaDb;
      const gainDb = clampGain(patch.gainDb);
      return { type: "gain", gainDb, deltaDb: round2(gainDb - current) };
    }
    case "trim":
      return patch.gainDb === undefined ? processing : { type: "trim", gainDb: round2(clamp(patch.gainDb, -SAFETY.maxTrimDb, 0)) };
    case "eq": {
      const merged = { ...processing.filter, ...pick(patch, ["frequencyHz", "gainDb", "q"]) };
      return {
        type: "eq",
        filter: normalizeEqFilter({
          kind: merged.kind,
          frequencyHz: clamp(merged.frequencyHz, EDIT_LIMITS.minHz, EDIT_LIMITS.maxHz),
          gainDb: clamp(merged.gainDb, EDIT_LIMITS.minGainDb, EDIT_LIMITS.maxGainDb),
          q: clamp(merged.q, EDIT_LIMITS.minQ, EDIT_LIMITS.maxQ),
        }),
      };
    }
    case "spatial":
      return {
        type: "spatial",
        pan: patch.pan === undefined ? processing.pan : patch.pan === null ? null : normalizePan(patch.pan),
        width: patch.width === undefined ? processing.width : patch.width === null ? null : normalizeWidth(patch.width),
      };
    case "dynamics": {
      const node = processing.processing;
      const merged = { ...node, ...patch } as Record<string, unknown>;
      if (node.type === "dynamic-eq") {
        merged.filter = { frequencyHz: patch.frequencyHz ?? node.filter.frequencyHz, q: patch.q ?? node.filter.q };
        delete merged.frequencyHz;
        delete merged.q;
      }
      if (node.type === "ducking" && (patch.keyTrackId === null || patch.keyTrackId === undefined)) merged.keyTrackId = node.keyTrackId;
      merged.type = node.type;
      return { type: "dynamics", processing: normalizeProcessing(merged as never) };
    }
  }
}

function pick<T extends object, K extends keyof T>(value: T, keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) if (value[key] !== undefined) out[key] = value[key];
  return out;
}

/** The cost model only needs the stems' roles and prominence; an edit never changes them. */
function emptyDocument(plan: FullMixPlan): ProjectDocument {
  return { tracks: [], sectionTrackSettings: [], project: { id: plan.projectId } } as unknown as ProjectDocument;
}

/**
 * After a status change or an edit: counts, and the safety checks that can be read from the changes' own
 * evaluations without measuring again (estimated peak and trim, combined gain reduction per stem, mono fold-down
 * of spatial changes).
 */
export function refreshFullMix(plan: FullMixPlan): FullMixPlan {
  const included = plan.changes.filter((change) => changeIncluded(change, "preview"));
  const reviewCount = plan.changes.filter((change) => change.status === "needs-review").length;
  const estimated = trimFor(plan, included);
  const trim = plan.candidateTrim.renderedDb !== null ? Math.min(estimated, plan.candidateTrim.renderedDb) : estimated;
  const reason = Math.abs(trim) >= 0.05 ? `Headroom trim: ${formatSignedDb(trim)} dB on every stem, because the included changes could push the estimated peak past the current mix or ${SAFETY.ceilingDbfs} dBFS. A safety trim, not a mix decision.` : null;
  const notes = plan.summary.notes.filter((note) => !note.startsWith("Headroom trim:") && !note.startsWith("After review:"));
  if (reason) notes.push(reason);
  const concerns = safetyConcerns(included);
  if (concerns.length > 0) notes.push(`After review: ${concerns.join(" ")}`);
  const confidence = plan.summary.confidence;
  return {
    ...plan,
    candidateTrim: { gainDb: trim, reason, renderedDb: plan.candidateTrim.renderedDb },
    summary: { ...plan.summary, reviewCount, notes: notes.slice(-12), confidenceLabel: confidenceLabel(confidence) },
  };
}

function safetyConcerns(included: MixChange[]): string[] {
  const out: string[] = [];
  const reduction = new Map<string, number>();
  for (const change of included) if (change.processing.type === "dynamics") reduction.set(change.trackId, (reduction.get(change.trackId) ?? 0) + change.evaluation.reductionMaxDb);
  for (const [, value] of reduction) if (value > SAFETY.maxStemReductionDb) out.push(`One stem's combined gain reduction reaches ${value.toFixed(1)} dB.`);
  for (const change of included) {
    const space = change.evaluation.space;
    if (space && space.mixAfter.monoLossDb > space.mixBefore.monoLossDb + SAFETY.monoLossGrowthDb) out.push(`An edited spatial change raises the mix's mono fold-down loss to ${space.mixAfter.monoLossDb.toFixed(1)} dB.`);
  }
  for (const change of included) if (change.warnings.length > 0 && change.edited) out.push(change.warnings[0]!);
  return [...new Set(out)].slice(0, 4);
}

function trimFor(plan: FullMixPlan, included: MixChange[]): number {
  const levels: StemLevel[] = plan.levels.map((level) => ({ trackId: level.trackId, peakDbfs: level.peakDbfs, loudnessDb: level.loudnessDb }));
  const document = levelsDocument(plan);
  const before = candidatePeak(document, levels, []);
  const after = candidatePeak(applyChanges(document, included.filter((change) => change.processing.type === "gain" || change.processing.type === "trim")).document, levels, included);
  if (before === null || after === null) return 0;
  return round2(clamp(headroomTrimDb(before, after), -SAFETY.maxTrimDb, 0));
}

/** Enough of a project for the peak and loudness estimates: the stems at their faders when the plan was made. */
function levelsDocument(plan: FullMixPlan): ProjectDocument {
  return {
    project: { id: plan.projectId },
    tracks: plan.levels.map((level) => ({ id: level.trackId, gainDb: level.gainDb, muted: level.muted, processing: { schemaVersion: 2, nodes: [], dynamics: [] } })),
    sectionTrackSettings: [],
    sections: [],
  } as unknown as ProjectDocument;
}

/* ------------------------------------------------------------------ audition */

export interface FullMixAuditionOptions {
  mode: "current" | "candidate";
  /** Hear one change ("change") or one problem's solution ("problem") on its own, or the candidate without it. */
  focus?: { kind: "change" | "problem"; id: string; side: "only" | "without" } | null;
  /** Play the candidate at the current mix's estimated loudness (default on). */
  loudnessMatch?: boolean;
}

export interface FullMixAudition {
  /** The project as the engine should play it: the saved project with the auditioned changes written in. */
  document: ProjectDocument;
  /** Uniform offset on every fader, in the audition only: safety trim plus loudness match. */
  offsetDb: number;
  trimDb: number;
  loudnessMatchDb: number;
  /** Which changes are playing. */
  changeIds: string[];
  note: string;
}

/**
 * What to play. Whole-mix A/B: Current is the saved project; Full Mix Candidate writes the included changes into
 * a copy (gain, EQ, space, and dynamics together, through the existing engine representations), adds the safety
 * trim, and by default plays it at the current mix's estimated loudness so it does not win by being louder.
 * Focus: one change on the saved mix (or the candidate without it), one problem's solution on the saved mix (or
 * the candidate without it). Nothing is written to the saved project and no proxy is rebuilt.
 */
export function fullMixAudition(document: ProjectDocument, plan: FullMixPlan | null, options: FullMixAuditionOptions): FullMixAudition {
  if (!plan) return { document, offsetDb: 0, trimDb: 0, loudnessMatchDb: 0, changeIds: [], note: "Current plays the saved mix." };
  const focus = options.focus ?? null;
  const included = plan.changes.filter((change) => changeIncluded(change, "preview"));
  const focusIds = new Set(focus ? (focus.kind === "change" ? [focus.id] : solutionChanges(plan, focus.id).map((change) => change.id)) : []);
  let chosen: MixChange[];
  if (focus && focus.side === "only") chosen = plan.changes.filter((change) => focusIds.has(change.id) && change.status !== "rejected");
  else if (focus) chosen = included.filter((change) => !focusIds.has(change.id));
  else chosen = options.mode === "candidate" ? included : [];
  if (options.mode === "current" && !focus) return { document, offsetDb: 0, trimDb: 0, loudnessMatchDb: 0, changeIds: [], note: "Current plays the saved mix." };
  const written = applyChanges(document, chosen).document;
  const wholeCandidate = !focus && options.mode === "candidate";
  const trimDb = wholeCandidate ? plan.candidateTrim.gainDb : 0;
  let loudnessMatchDb = 0;
  if (options.loudnessMatch !== false) {
    const levels: StemLevel[] = plan.levels.map((level) => ({ trackId: level.trackId, peakDbfs: level.peakDbfs, loudnessDb: level.loudnessDb }));
    const before = mixLoudness(document, levels, []);
    const after = mixLoudness(written, levels, chosen);
    if (before !== null && after !== null) loudnessMatchDb = round2(clamp(before - (after + trimDb), -MAX_LOUDNESS_MATCH_DB, MAX_LOUDNESS_MATCH_DB));
    if (Math.abs(loudnessMatchDb) < 0.05) loudnessMatchDb = 0;
  }
  const offsetDb = round2(trimDb + loudnessMatchDb);
  return { document: offsetDb !== 0 ? addTrim(written, offsetDb) : written, offsetDb, trimDb, loudnessMatchDb, changeIds: chosen.map((change) => change.id), note: auditionNote(options, loudnessMatchDb, trimDb) };
}

function auditionNote(options: FullMixAuditionOptions, matchDb: number, trimDb: number): string {
  const fairness =
    options.loudnessMatch === false
      ? " Loudness matching is off."
      : matchDb !== 0
        ? ` Played ${formatSignedDb(matchDb)} dB on every stem so its estimated loudness equals Current's (power sum of each stem's integrated loudness at its fader, with each change's predicted level change). The balance between stems is unchanged.`
        : " Its estimated loudness already matches Current.";
  const trim = trimDb !== 0 ? ` Includes the ${formatSignedDb(trimDb)} dB safety trim.` : "";
  const focus = options.focus;
  if (focus?.kind === "change") return focus.side === "only" ? `The saved mix with only this change.${fairness}` : `The Full Mix Candidate without this change.${fairness}`;
  if (focus?.kind === "problem") return focus.side === "only" ? `The saved mix with only this problem's solution.${fairness}` : `The Full Mix Candidate without this problem's solution.${fairness}`;
  return `Full Mix Candidate: the saved mix with every included change, gain, EQ, space, and dynamics together.${trim}${fairness}`;
}

/* ------------------------------------------------------------------ apply */

export type ApplyFullMixResult = { ok: true; document: ProjectDocument; applied: number } | { ok: false; failures: Array<{ changeId: string; message: string }> };

/**
 * Writes the chosen changes into the project in one update: faders and Track × Section gain, static EQ nodes, pan
 * and width, and dynamics nodes, then the safety trim. If any change cannot be stored, nothing is written and the
 * failures are returned. One call is one undo step for the caller.
 */
export function applyFullMixPlan(document: ProjectDocument, plan: FullMixPlan, mode: FullMixApplyMode): ApplyFullMixResult {
  const chosen = plan.changes.filter((change) => (mode === "accepted" ? change.status === "accepted" : changeIncluded(change, "all")));
  const result = applyChanges(document, chosen);
  if (result.failures.length > 0) return { ok: false, failures: result.failures };
  const estimated = trimFor(plan, chosen);
  const trim = plan.candidateTrim.renderedDb !== null ? Math.min(estimated, plan.candidateTrim.renderedDb) : estimated;
  const next = Math.abs(trim) >= 0.05 ? addTrim(result.document, trim) : result.document;
  return { ok: true, document: withUpdatedAt(next), applied: chosen.length };
}

/* ------------------------------------------------------------------ render check */

/** What rendering Current and the candidate through the native DSP measured. */
export interface RenderedCheck {
  seconds: number;
  current: { peakDbfs: number; rmsDb: number; monoLossDb: number; correlation: number };
  /** The candidate as Apply would write it: included changes and the safety trim, no loudness match. */
  candidate: { peakDbfs: number; rmsDb: number; monoLossDb: number; correlation: number };
  /** Change of each section boundary's level step, candidate against current, dB. */
  steps: Array<{ sectionId: string; name: string; changeDb: number }>;
}

/**
 * Folds the rendered whole-mix check into the plan: a candidate whose rendered peak passes the current mix's (or
 * the ceiling, whichever is higher) gets the extra safety trim, and mono, level, and section-step findings are
 * stated. It never adds or removes a change.
 */
export function withRenderedCheck(plan: FullMixPlan, check: RenderedCheck): FullMixPlan {
  const notes = plan.summary.notes.filter((note) => !note.startsWith("Render check:"));
  const findings: string[] = [];
  const allowed = Math.max(check.current.peakDbfs, SAFETY.ceilingDbfs);
  let trim = plan.candidateTrim.gainDb;
  let reason = plan.candidateTrim.reason;
  if (check.candidate.peakDbfs > allowed + 0.1) {
    const extra = round2(-(check.candidate.peakDbfs - allowed));
    trim = round2(clamp(trim + extra, -SAFETY.maxTrimDb, 0));
    reason = `Headroom trim: ${formatSignedDb(trim)} dB on every stem, because the rendered candidate peaked at ${formatSignedDb(check.candidate.peakDbfs)} dBFS against ${formatSignedDb(check.current.peakDbfs)} dBFS now. A safety trim, not a mix decision.`;
    findings.push(`the rendered peak rose to ${formatSignedDb(check.candidate.peakDbfs)} dBFS, so the safety trim is ${formatSignedDb(trim)} dB`);
  } else {
    findings.push(`peak ${formatSignedDb(check.current.peakDbfs)} → ${formatSignedDb(check.candidate.peakDbfs)} dBFS`);
  }
  findings.push(`level ${formatSignedDb(round2(check.candidate.rmsDb - check.current.rmsDb))} dB before the A/B's loudness match`);
  const monoGrowth = check.candidate.monoLossDb - check.current.monoLossDb;
  findings.push(monoGrowth > SAFETY.monoLossGrowthDb ? `mono fold-down loses ${monoGrowth.toFixed(1)} dB more than now; listen in mono` : `mono fold-down ${check.current.monoLossDb.toFixed(2)} → ${check.candidate.monoLossDb.toFixed(2)} dB`);
  const jumps = check.steps.filter((step) => Math.abs(step.changeDb) > SAFETY.transitionStepDb);
  if (jumps.length > 0) findings.push(`the step into ${jumps.map((step) => `${step.name} (${formatSignedDb(step.changeDb)} dB)`).join(", ")} changes noticeably`);
  notes.push(`Render check: ${Math.round(check.seconds)} s of Current and the candidate rendered through the native DSP from the playback proxies; ${findings.join("; ")}.`);
  const filtered = reason ? notes.filter((note) => !note.startsWith("Headroom trim:")).concat(reason) : notes;
  return { ...plan, candidateTrim: { gainDb: trim, reason, renderedDb: trim < plan.candidateTrim.gainDb ? trim : plan.candidateTrim.renderedDb }, summary: { ...plan.summary, notes: filtered.slice(-12) } };
}
