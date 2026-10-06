import {
  CONSTRAINT_DOMAINS,
  CONSTRAINT_PROCESSORS,
  MIX_GOALS,
  MIX_STRENGTHS,
  constraintViolation,
  describeChange,
  emptyConstraints,
  processorKind,
  resetChange,
  scaleChange,
  setChangeStatus,
  type ConstraintDomain,
  type FullMixPlan,
  type MixChange,
  type MixConstraints,
  type MixGoal,
  type MixStrength,
} from "@audiosous/mix-planner";
import { describeFilter } from "@audiosous/eq-planner";
import { describeProcessing } from "@audiosous/dynamics-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { z } from "zod";
import { AGENT_LIMITS, PLAN_TABS, ROUTES, uiFocusSchema, type AgentCard, type AgentSession, type CandidateEntry, type Permission, type Route, type UiFocus } from "./contract";
import type { AgentEnvironment, LoadedInputs } from "./environment";
import { AMOUNTS, type Approval, type ConstraintReading, type DirectEdit } from "./language";
import type { ToolSpec } from "./model";
import type { MixReading } from "./reading";
import { namesOf, resolveSection, resolveTrack, sectionNamesOf, trackName, type ReferenceContext } from "./references";

/* ------------------------------------------------------------------ turn state */

/** Everything one request knows. Built by the orchestrator; tools read and extend it. */
export interface TurnState {
  message: string;
  approval: Approval;
  constraints: ConstraintReading;
  directEdits: DirectEdit[];
  statedFactors: number[];
  refs: ReferenceContext;
  /** False once a newer request or Cancel superseded this one: tools stop before touching session or UI state. */
  isCurrent: () => boolean;
  /** Everything the agent may quote: context, tool results, the person's words. */
  facts: string[];
  cards: AgentCard[];
  focus: UiFocus | null;
  /** WRITE actions that really happened in this turn. */
  writes: Array<{ kind: "apply" | "undo" | "edit"; lines: string[] }>;
  /** What the turn's tools did, for the transcript summary. */
  actions: string[];
  inputs: LoadedInputs | null;
  reading: MixReading | null;
}

export interface ToolContext {
  env: AgentEnvironment;
  session: AgentSession;
  turn: TurnState;
}

export type ToolResult = { ok: true; content: Record<string, unknown> } | { ok: false; error: string; content?: Record<string, unknown> };

export interface AgentTool<A = unknown> {
  name: string;
  permission: Permission;
  /** Said to the model: when to use it and what it does. */
  description: string;
  schema: z.ZodType<A>;
  /** Shown in the panel while it runs ("Checking frequency interaction…"). */
  activity: (args: A, ctx: ToolContext) => string;
  run: (args: A, ctx: ToolContext) => Promise<ToolResult>;
}

export class Superseded extends Error {
  constructor() {
    super("A newer request or Cancel superseded this one.");
    this.name = "Superseded";
  }
}

function check(ctx: ToolContext): void {
  if (!ctx.turn.isCurrent()) throw new Superseded();
}

/* ------------------------------------------------------------------ helpers */

const names = (document: ProjectDocument) => (id: string) => {
  const track = document.tracks.find((item) => item.id === id);
  return track ? trackName(track) : id;
};

function scopeName(document: ProjectDocument, scope: { type: string; sectionId?: string }): string {
  return scope.type === "section" ? (document.sections.find((section) => section.id === scope.sectionId)?.name ?? "a section") : "whole song";
}

type Resolved = { ok: true; ids: string[] } | { ok: false; error: string; content: Record<string, unknown> };

/** Stems from what the model wrote (names, role words, ids, "this"), resolved against the project. Never guessed. */
function tracksFrom(ctx: ToolContext, refs: readonly string[] | undefined): Resolved {
  const document = ctx.env.document();
  const ids: string[] = [];
  for (const ref of refs ?? []) {
    const resolved = resolveTrack(document, ref, ctx.turn.refs);
    if (resolved.kind === "match") ids.push(...resolved.trackIds);
    else if (resolved.kind === "ambiguous") return { ok: false, error: `"${ref}" could mean ${namesOf(document, resolved.trackIds)}. Ask which one.`, content: { ambiguous: ref, options: resolved.trackIds.map(names(document)) } };
    else return { ok: false, error: `No stem matches "${ref}". Stems: ${document.tracks.map(trackName).join(", ")}.`, content: {} };
  }
  return { ok: true, ids: [...new Set(ids)] };
}

function sectionsFrom(ctx: ToolContext, refs: readonly string[] | undefined): Resolved {
  const document = ctx.env.document();
  const ids: string[] = [];
  for (const ref of refs ?? []) {
    const resolved = resolveSection(document, ref, ctx.turn.refs);
    if (resolved.kind === "match") ids.push(...resolved.sectionIds);
    else if (resolved.kind === "ambiguous") return { ok: false, error: `"${ref}" could mean ${sectionNamesOf(document, resolved.sectionIds)}. Ask which one.`, content: {} };
    else return { ok: false, error: `No section matches "${ref}". Sections: ${document.sections.map((section) => section.name).join(", ") || "none marked"}.`, content: {} };
  }
  return { ok: true, ids: [...new Set(ids)] };
}

async function inputsOf(ctx: ToolContext): Promise<LoadedInputs> {
  if (!ctx.turn.inputs) {
    ctx.env.activity("Loading analysis…");
    ctx.turn.inputs = await ctx.env.loadInputs();
    check(ctx);
  }
  return ctx.turn.inputs;
}

async function readingOf(ctx: ToolContext, strength: MixStrength = "normal"): Promise<MixReading> {
  if (ctx.turn.reading && ctx.turn.reading.strength === strength) return ctx.turn.reading;
  const inputs = await inputsOf(ctx);
  ctx.env.activity("Measuring the mix…");
  ctx.turn.reading = await ctx.env.readMix(ctx.env.document(), inputs, strength);
  check(ctx);
  return ctx.turn.reading;
}

function missingNote(document: ProjectDocument, inputs: LoadedInputs | null): string | null {
  if (!inputs || inputs.missing.length === 0) return null;
  const byTrack = new Map<string, string[]>();
  for (const item of inputs.missing) byTrack.set(item.trackId, [...(byTrack.get(item.trackId) ?? []), item.what]);
  return `Not measured, so not judged: ${[...byTrack].map(([id, what]) => `${names(document)(id)} (${what.join(", ")})`).join("; ")}.`;
}

/** One change in words, with what it edits and why. `full` adds its predicted effect and the current setting. */
function changeView(document: ProjectDocument, change: MixChange, detail: "summary" | "full" = "full"): Record<string, unknown> {
  const name = names(document);
  const current = change.evidence.kind === "space" ? change.evidence.current : undefined;
  return {
    id: change.id,
    track: name(change.trackId),
    scope: scopeName(document, change.scope),
    kind: processorKind(change.processing),
    change: describeChange(change.processing, name, current),
    ...(change.edited ? { asPlanned: describeChange(change.planned, name, current), editedByUser: true } : {}),
    status: change.status,
    confidence: change.confidenceLabel,
    problems: change.problemIds,
    why: detail === "full" ? change.reasons[0] : clipText(change.reasons[0] ?? "", 170),
    ...(detail === "full"
      ? {
          current: change.current,
          ...(change.warnings.length > 0 ? { warnings: change.warnings.slice(0, 2) } : {}),
          expectedShareOfProblem: Math.round(change.evaluation.reduction * 100) / 100,
          predictedLevelChangeDb: Math.round(change.evaluation.levelChangeDb * 10) / 10,
        }
      : change.warnings.length > 0
        ? { warning: clipText(change.warnings[0]!, 140) }
        : {}),
  };
}

function clipText(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
}

function includedChanges(plan: FullMixPlan): MixChange[] {
  return plan.changes.filter((change) => change.status !== "rejected" && change.status !== "needs-review");
}

/** A candidate in the compact form the model reads. `full` adds alternatives considered and the passes. */
export function candidateView(document: ProjectDocument, entry: CandidateEntry, plan: FullMixPlan, stale: boolean, detail: "summary" | "full"): Record<string, unknown> {
  const name = names(document);
  const interventions = plan.interventions;
  return {
    candidate: entry.label,
    id: entry.id,
    description: entry.description,
    stale,
    applied: entry.appliedAt !== null,
    settings: plan.settings,
    ...(plan.constraints ? { constraints: describeConstraints(document, plan.constraints) } : {}),
    headline: plan.summary.headline,
    confidence: plan.summary.confidenceLabel,
    processingCost: plan.summary.costLabel,
    changes: plan.changes.map((change) => changeView(document, change, detail)),
    safetyTrimDb: plan.candidateTrim.gainDb,
    problems: plan.problems.map((problem) => {
      const selected = interventions.find((item) => item.id === problem.interventionId);
      const others = interventions.filter((item) => item.problemIds.includes(problem.id) && item.outcome !== "selected");
      return {
        id: problem.id,
        title: problem.title,
        ...(problem.scope.type === "section" ? { scope: scopeName(document, problem.scope) } : {}),
        severity: `${problem.severity} → ${problem.severityAfter ?? problem.severity} re-measured`,
        outcome: problem.outcome,
        solution: selected?.label ?? null,
        ...(detail === "full"
          ? {
              stems: problem.trackIds.map(name),
              explanation: clipText(problem.explanation, 400),
              evidence: problem.evidence.slice(0, 3).map((item) => clipText(`${item.label}: ${item.detail}`, 220)),
              solutionReason: selected ? clipText(selected.reason, 300) : null,
              alternativesConsidered: others.map((item) => ({ alternative: item.label, outcome: item.outcome, expectedShareRemoved: item.expectedReduction, cost: item.cost, reason: clipText(item.reason, 220) })),
            }
          : { ...(selected ? {} : { why: clipText(problem.explanation.split(". ")[0] ?? "", 160) }), alternativesConsidered: others.length }),
      };
    }),
    evaluation: {
      method: "re-measured by the four planners",
      problemScore: { before: plan.evaluation.before.problemScore, after: plan.evaluation.after.problemScore },
      openProblems: { before: plan.evaluation.before.openProblems, after: plan.evaluation.after.openProblems },
      monoLossDb: { before: plan.evaluation.before.monoLossDb, after: plan.evaluation.after.monoLossDb },
      correlation: { before: plan.evaluation.before.correlation, after: plan.evaluation.after.correlation },
      estimatedPeakDbfs: { before: plan.evaluation.before.estimatedPeakDbfs, after: plan.evaluation.after.estimatedPeakDbfs },
      largestGainReductionDb: plan.evaluation.after.maxReductionDb,
      stopReason: plan.evaluation.stopReason,
      fourPlannersOnTheirOwnWouldPropose: plan.evaluation.independent.total,
      ...(detail === "full"
        ? {
            candidatesCompared: plan.evaluation.candidates,
            regressions: plan.evaluation.regressions.map((item) => `${item.description} (${item.resolution})`),
          }
        : {}),
    },
    notes: plan.summary.notes.slice(0, detail === "full" ? 6 : 2).map((note) => clipText(note, detail === "full" ? 400 : 240)),
  };
}

export function describeConstraints(document: ProjectDocument, constraints: MixConstraints): Record<string, unknown> {
  const name = names(document);
  return {
    ...(constraints.protectedTrackIds.length ? { protectedStems: constraints.protectedTrackIds.map(name) } : {}),
    ...(constraints.excludedDomains.length ? { excludedDomains: constraints.excludedDomains } : {}),
    ...(constraints.excludedProcessors.length ? { excludedProcessors: constraints.excludedProcessors } : {}),
    ...(constraints.sectionIds ? { onlySections: sectionNamesOf(document, constraints.sectionIds) } : {}),
    ...(constraints.focusTrackIds.length ? { focusStems: constraints.focusTrackIds.map(name) } : {}),
    ...(constraints.focusSectionIds.length ? { focusSections: sectionNamesOf(document, constraints.focusSectionIds) } : {}),
    ...((constraints.intents ?? []).length ? { intents: (constraints.intents ?? []).map((item) => `${item.note}${item.trackId ? ` (${name(item.trackId)})` : ""}${item.sectionId ? ` in ${sectionNamesOf(document, [item.sectionId])}` : ""}`) } : {}),
  };
}

function currentEntry(ctx: ToolContext): CandidateEntry | null {
  return ctx.session.candidates.find((entry) => entry.id === ctx.session.currentCandidateId) ?? null;
}

/** The live candidate: the panel's copy (with the person's edits), kept in step with the session's entry. */
function liveCandidate(ctx: ToolContext): { entry: CandidateEntry; plan: FullMixPlan } | null {
  const entry = currentEntry(ctx);
  if (!entry) return null;
  const shown = ctx.env.candidate();
  const plan = shown && shown.stateIdentity === entry.plan.stateIdentity && shown.createdAt === entry.plan.createdAt ? shown : entry.plan;
  entry.plan = plan;
  return { entry, plan };
}

function candidateCard(document: ProjectDocument, entry: CandidateEntry, plan: FullMixPlan, stale: boolean): AgentCard {
  const name = names(document);
  return {
    kind: "candidate",
    candidateId: entry.id,
    label: entry.label,
    headline: plan.summary.headline,
    changes: includedChanges(plan).map((change) => `${name(change.trackId)}: ${describeChange(change.processing, name, change.evidence.kind === "space" ? change.evidence.current : undefined)}${change.scope.type === "section" ? ` (${scopeName(document, change.scope)})` : ""}`),
    stale,
  };
}

function pushCard(ctx: ToolContext, card: AgentCard): void {
  const at = ctx.turn.cards.findIndex((item) => item.kind === card.kind && (card.kind !== "candidate" || (item.kind === "candidate" && item.candidateId === card.candidateId)));
  if (at >= 0) ctx.turn.cards[at] = card;
  else ctx.turn.cards.push(card);
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function addCandidate(ctx: ToolContext, plan: FullMixPlan, route: Route, description: string): CandidateEntry {
  const used = ctx.session.candidates.length;
  const entry: CandidateEntry = { id: `cand-${ctx.session.candidates.length + 1}-${plan.stateIdentity.slice(0, 6)}`, label: `Candidate ${LETTERS[used % 26]}${used >= 26 ? Math.floor(used / 26) : ""}`, description, route, plan, createdAt: ctx.env.now(), appliedAt: null };
  ctx.session.candidates = [...ctx.session.candidates, entry].slice(-AGENT_LIMITS.maxCandidates);
  ctx.session.currentCandidateId = entry.id;
  return entry;
}

/* ------------------------------------------------------------------ safety gate */

/**
 * Before a candidate is presented as ready: not stale, nothing outside the constraints, every stem and sidechain
 * key exists, and safety readings inside the planner's limits. A violating change is rejected, never shown as ready.
 */
export function safetyGate(document: ProjectDocument, plan: FullMixPlan, stale: boolean): { plan: FullMixPlan; problems: string[] } {
  const problems: string[] = [];
  if (stale) problems.push("The mix changed while the candidate was built.");
  let next = plan;
  const ids = new Set(document.tracks.map((track) => track.id));
  for (const change of plan.changes) {
    let reason: string | null = null;
    if (!ids.has(change.trackId)) reason = "its stem is missing";
    else if (plan.constraints && constraintViolation(change, plan.constraints) !== null) reason = `it breaks the request's constraints (${constraintViolation(change, plan.constraints)})`;
    else if (change.processing.type === "dynamics") {
      const node = change.processing.processing;
      const key = node.type === "ducking" || node.type === "dynamic-eq" ? node.keyTrackId : null;
      if (key && (!ids.has(key) || key === change.trackId)) reason = "its sidechain key is not a valid stem";
    }
    if (reason) {
      problems.push(`${names(document)(change.trackId)}: ${describeChange(change.processing, names(document)).toLowerCase()} was rejected because ${reason}.`);
      next = setChangeStatus(next, change.id, "rejected");
    }
  }
  const after = next.evaluation.after;
  if (after.maxReductionDb > 8) problems.push(`Combined gain reduction on one stem reaches ${after.maxReductionDb.toFixed(1)} dB.`);
  const before = next.evaluation.before;
  if (before.monoLossDb !== null && after.monoLossDb !== null && after.monoLossDb - before.monoLossDb > 0.5) problems.push(`Mono fold-down loss grows by ${(after.monoLossDb - before.monoLossDb).toFixed(2)} dB.`);
  return { plan: next, problems };
}

/* ------------------------------------------------------------------ constraints */

const ROUTE_EXCLUDES: Record<Route, ConstraintDomain[]> = {
  full: [],
  level: ["eq", "space", "dynamics"],
  eq: ["gain", "space", "dynamics"],
  space: ["gain", "eq", "dynamics"],
  dynamics: ["gain", "eq", "space"],
};

/**
 * The planner constraints for a request: the route's domains, the session's standing constraints, what this
 * message says, and what the model adds. The model can narrow; it cannot widen past what the person said.
 */
export function mergeConstraints(
  document: ProjectDocument,
  ctx: ToolContext,
  route: Route,
  extra: { protect: string[]; excludeDomains: ConstraintDomain[]; excludeProcessors: MixConstraints["excludedProcessors"]; only: string[] | null; focusTracks: string[]; focusSections: string[]; intents: NonNullable<MixConstraints["intents"]> },
): MixConstraints {
  const standing = ctx.session.standing;
  const read = ctx.turn.constraints;
  const only = read.onlySectionIds ?? (extra.only && extra.only.length > 0 ? extra.only : null);
  const excludedSections = [...new Set([...standing.excludedSectionIds, ...read.excludedSectionIds])];
  let sectionIds: string[] | null = only;
  if (excludedSections.length > 0) sectionIds = (sectionIds ?? document.sections.map((section) => section.id)).filter((id) => !excludedSections.includes(id));
  return {
    ...emptyConstraints(),
    protectedTrackIds: [...new Set([...standing.protectedTrackIds, ...read.protectedTrackIds, ...extra.protect])].filter((id) => !read.releasedTrackIds.includes(id)),
    // The person's own narrowing ("only fix the levels") holds whatever route the model chose.
    excludedDomains: [...new Set([...ROUTE_EXCLUDES[route], ...(read.route ? ROUTE_EXCLUDES[read.route] : []), ...standing.excludedDomains, ...read.excludedDomains, ...extra.excludeDomains])].filter((domain) => !read.releasedDomains.includes(domain)),
    excludedProcessors: [...new Set([...standing.excludedProcessors, ...read.excludedProcessors, ...extra.excludeProcessors])],
    sectionIds,
    focusTrackIds: extra.focusTracks,
    focusSectionIds: extra.focusSections.length > 0 ? extra.focusSections : (only ?? []),
    intents: extra.intents.slice(0, 8),
  };
}

/* ------------------------------------------------------------------ tools */

const refs = z.array(z.string().min(1).max(80)).max(8);

const getProject = {
  name: "get_project_overview",
  permission: "read" as const,
  description: "Lists every stem (role, fader, pan, width, mute, saved processing count) and every section (type, times, note). The request context already has a compact version; use this only when you need all stems or section notes.",
  schema: z.object({}).strict(),
  activity: () => "Reading the project…",
  run: async (_args: Record<string, never>, ctx: ToolContext) => {
    const document = ctx.env.document();
    return {
      ok: true as const,
      content: {
        stems: document.tracks.map((track) => ({ name: trackName(track), role: track.role, faderDb: track.gainDb, pan: track.pan, width: track.width, muted: track.muted, eqNodes: track.processing.nodes.length, dynamicsNodes: track.processing.dynamics.length })),
        sections: document.sections.map((section) => ({ name: section.name, type: section.type, start: section.startTime, end: section.endTime, note: section.userIntent?.slice(0, 300) ?? null })),
      },
    };
  },
};

const getTrack = {
  name: "get_track_details",
  permission: "read" as const,
  description:
    "Everything saved on one or more stems: fader, pan, width, mute, every EQ and dynamics node (with which plan wrote it and its note), per-section overrides and processing, prominence, and the stem's measured loudness, peak, crest, and dynamics classification when analysis exists. Use for 'what processing is on the bass?', 'what did AutoBalance do?', 'which tracks are sidechained?'.",
  schema: z.object({ tracks: refs.min(1) }).strict(),
  activity: (args: { tracks: string[] }) => `Reading ${args.tracks.join(", ")}…`,
  run: async (args: { tracks: string[] }, ctx: ToolContext): Promise<ToolResult> => {
    const resolved = tracksFrom(ctx, args.tracks);
    if (!resolved.ok) return resolved;
    const document = ctx.env.document();
    const name = names(document);
    const origin = (value: string) => (value === "eq-plan" ? "written by an EQ or Full Mix plan" : value === "dynamics-plan" ? "written by a Dynamics or Full Mix plan" : value === "manual" ? "set by hand" : value);
    let inputs: LoadedInputs | null = null;
    try {
      inputs = await inputsOf(ctx);
    } catch {
      inputs = null;
    }
    const stems = resolved.ids.map((id) => {
      const track = document.tracks.find((item) => item.id === id)!;
      const measurement = inputs?.measurements[id];
      const reading = ctx.turn.reading?.stems.find((item) => item.trackId === id);
      return {
        name: trackName(track),
        role: track.role,
        faderDb: track.gainDb,
        pan: track.pan,
        width: track.width,
        muted: track.muted,
        eq: track.processing.nodes.map((node) => ({ filter: describeFilter(node.filter), enabled: node.enabled, origin: origin(node.origin), note: node.note })),
        dynamics: track.processing.dynamics.map((node) => ({ processor: node.type, setting: describeProcessing(node, name), enabled: node.enabled, origin: origin(node.origin), note: node.note })),
        sidechainedFrom: track.processing.dynamics.flatMap((node) => ("keyTrackId" in node && node.keyTrackId ? [name(node.keyTrackId)] : [])),
        keysOtherStems: document.tracks.filter((other) => other.processing.dynamics.some((node) => "keyTrackId" in node && node.keyTrackId === id)).map(trackName),
        sections: document.sectionTrackSettings
          .filter((row) => row.trackId === id)
          .map((row) => ({
            section: scopeName(document, { type: "section", sectionId: row.sectionId }),
            prominence: row.prominence,
            note: row.userIntent?.slice(0, 200) ?? null,
            gainOverrideDb: row.overrides.gainDb,
            panOverride: row.overrides.pan,
            widthOverride: row.overrides.width,
            eq: row.processing.nodes.map((node) => describeFilter(node.filter)),
            dynamics: row.processing.dynamics.map((node) => describeProcessing(node, name)),
          })),
        measured: measurement ? { loudnessLufs: round1n(measurement.levels.integratedLufs), peakDbfs: round1n(measurement.levels.peakDbfs), crestDb: measurement.levels.crestFactorDb === null ? null : round1(measurement.levels.crestFactorDb), correlation: measurement.stereo.correlation } : "no analysis for this stem",
        ...(reading ? { dynamicsReading: reading.dynamics } : {}),
      };
    });
    ctx.turn.focus = { ...(ctx.turn.focus ?? {}), trackIds: resolved.ids.slice(0, 4) };
    return { ok: true, content: { stems } };
  },
};

const getSection = {
  name: "get_section_details",
  permission: "read" as const,
  description: "One or more sections: bounds, type, the section's note, every stem's prominence and note there, and the section's own overrides and processing.",
  schema: z.object({ sections: refs.min(1) }).strict(),
  activity: (args: { sections: string[] }) => `Reading ${args.sections.join(", ")}…`,
  run: async (args: { sections: string[] }, ctx: ToolContext): Promise<ToolResult> => {
    const resolved = sectionsFrom(ctx, args.sections);
    if (!resolved.ok) return resolved;
    const document = ctx.env.document();
    const name = names(document);
    return {
      ok: true,
      content: {
        sections: resolved.ids.map((id) => {
          const section = document.sections.find((item) => item.id === id)!;
          return {
            name: section.name,
            type: section.type,
            start: section.startTime,
            end: section.endTime,
            note: section.userIntent,
            stems: document.sectionTrackSettings
              .filter((row) => row.sectionId === id)
              .map((row) => ({ stem: name(row.trackId), prominence: row.prominence, note: row.userIntent, gainOverrideDb: row.overrides.gainDb, panOverride: row.overrides.pan, widthOverride: row.overrides.width, eq: row.processing.nodes.length, dynamics: row.processing.dynamics.length })),
          };
        }),
      },
    };
  },
};

const detectSchema = z
  .object({
    sections: refs.optional(),
    tracks: refs.optional(),
    dimensions: z.array(z.enum(["level", "frequency", "space", "dynamics", "contrast", "headroom"])).max(6).optional(),
  })
  .strict();
type DetectArgs = z.infer<typeof detectSchema>;

const TYPE_DIMENSION: Record<string, string> = {
  headroom: "headroom",
  "level-hierarchy": "level",
  "frequency-conflict": "frequency",
  "event-masking": "frequency",
  "low-end-collision": "dynamics",
  "dynamic-instability": "dynamics",
  "transient-problem": "dynamics",
  "center-congestion": "space",
  "excessive-width": "space",
  "section-contrast": "contrast",
  intent: "contrast",
};

const detectProblems = {
  name: "detect_mix_problems",
  permission: "read" as const,
  description:
    "Measures the current mix with the four planners (level, frequency, space, dynamics) and returns the problems they find, with severity, confidence, and evidence, plus relationships that were measured and are fine. Changes nothing. Use it first for any diagnosis ('what's wrong with the chorus?', 'why does it feel crowded?', 'should the bass be louder?') and to verify a subjective word (muddy, weak, harsh, crowded) before planning. Narrow it with sections, tracks, and dimensions.",
  schema: detectSchema,
  activity: (args: DetectArgs, ctx: ToolContext) => (args.sections?.length ? `Checking ${sectionNamesOf(ctx.env.document(), sectionsFrom(ctx, args.sections).ok ? (sectionsFrom(ctx, args.sections) as { ids: string[] }).ids : []) || args.sections.join(", ")}…` : "Checking the mix…"),
  run: async (args: DetectArgs, ctx: ToolContext): Promise<ToolResult> => {
    const tracks = tracksFrom(ctx, args.tracks);
    if (!tracks.ok) return tracks;
    const sections = sectionsFrom(ctx, args.sections);
    if (!sections.ok) return sections;
    const reading = await readingOf(ctx);
    const document = ctx.env.document();
    const name = names(document);
    const inScope = (trackIds: readonly string[], sectionIds: readonly string[]) =>
      (tracks.ids.length === 0 || trackIds.some((id) => tracks.ids.includes(id))) && (sections.ids.length === 0 || sectionIds.length === 0 || sectionIds.some((id) => sections.ids.includes(id)));
    const dims = args.dimensions ?? [];
    const problems = reading.problems.filter((problem) => inScope(problem.trackIds, problem.sectionIds) && (dims.length === 0 || dims.includes(TYPE_DIMENSION[problem.type] as never)));
    const interactions = reading.interactions.filter((item) => inScope(item.trackIds, item.sectionId ? [item.sectionId] : []) && (dims.length === 0 || dims.includes(item.domain as never)));
    const fine = interactions.filter((item) => ["below-threshold", "already-separated", "solved", "layered", "anchors", "no-priority"].includes(item.outcome));
    const levels = reading.levels.filter((row) => (tracks.ids.length === 0 || tracks.ids.includes(row.trackId)) && (sections.ids.length === 0 || row.sectionId === null || sections.ids.includes(row.sectionId)));
    ctx.turn.focus = { ...(ctx.turn.focus ?? {}), ...(sections.ids.length === 1 ? { sectionId: sections.ids[0]! } : {}), ...(tracks.ids.length > 0 ? { trackIds: tracks.ids.slice(0, 4) } : {}) };
    return {
      ok: true,
      content: {
        measuredAt: "the saved mix, as it plays now",
        scope: { sections: sections.ids.length ? sectionNamesOf(document, sections.ids) : "whole song", stems: tracks.ids.length ? namesOf(document, tracks.ids) : "all" },
        problems: problems
          .sort((left, right) => right.severity - left.severity)
          .slice(0, 10)
          .map((problem) => ({ id: problem.id, title: problem.title, scope: problem.scope, stems: problem.trackIds.map(name), protected: problem.protectedTrackId && name(problem.protectedTrackId), yielding: problem.yieldingTrackId && name(problem.yieldingTrackId), severity: problem.severity, confidence: problem.confidence, evidence: problem.evidence.slice(0, 4).map((item) => `${item.source}: ${item.label} — ${item.detail}`) })),
        healthyRelationships: fine.slice(0, 8).map((item) => ({ stems: item.trackIds.map(name), domain: item.domain, scope: item.scope, outcome: item.outcome, explanation: item.explanation.slice(0, 260) })),
        levelPlannerRows: levels.filter((row) => Math.abs(row.deltaDb) >= 0.5).slice(0, 8).map((row) => ({ stem: name(row.trackId), scope: row.scope, currentGainDb: row.currentGainDb, levelPlannerWouldMoveDb: row.deltaDb, status: row.status, reason: row.reason.slice(0, 240) })),
        mix: reading.mix,
        severityScale: "0–1; problems under about 0.38 are not acted on at Normal strength.",
        ...(missingNote(document, ctx.turn.inputs) ? { missing: missingNote(document, ctx.turn.inputs) } : {}),
      },
    };
  },
};

const interactionsSchema = z.object({ domain: z.enum(["frequency", "space", "dynamics", "level"]), tracks: refs.optional(), sections: refs.optional() }).strict();
type InteractionsArgs = z.infer<typeof interactionsSchema>;

const getInteractions = {
  name: "get_interactions",
  permission: "read" as const,
  description:
    "The pairwise measurements one planner made on the current mix: frequency (masking regions, level differences), space (center competition, stereo overlap), dynamics (kick/bass hits, event masking, the tool it would use), or level (where the level planner would move faders). Use for detailed evidence about one relationship ('why does the guitar get in the way of the vocal?').",
  schema: interactionsSchema,
  activity: (args: InteractionsArgs) => `Checking ${args.domain} interaction…`,
  run: async (args: InteractionsArgs, ctx: ToolContext): Promise<ToolResult> => {
    const tracks = tracksFrom(ctx, args.tracks);
    if (!tracks.ok) return tracks;
    const sections = sectionsFrom(ctx, args.sections);
    if (!sections.ok) return sections;
    const reading = await readingOf(ctx);
    const document = ctx.env.document();
    const name = names(document);
    if (args.domain === "level") {
      return { ok: true, content: { rows: reading.levels.filter((row) => tracks.ids.length === 0 || tracks.ids.includes(row.trackId)).slice(0, 12).map((row) => ({ stem: name(row.trackId), scope: row.scope, currentGainDb: row.currentGainDb, recommendedGainDb: row.recommendedGainDb, deltaDb: row.deltaDb, status: row.status, reason: row.reason })) } };
    }
    const rows = reading.interactions
      .filter((item) => item.domain === args.domain)
      .filter((item) => tracks.ids.length === 0 || tracks.ids.every((id) => item.trackIds.includes(id)) || (tracks.ids.length === 1 && item.trackIds.includes(tracks.ids[0]!)))
      .filter((item) => sections.ids.length === 0 || item.sectionId === null || sections.ids.includes(item.sectionId))
      .sort((left, right) => (right.severity ?? 0) - (left.severity ?? 0))
      .slice(0, 8)
      .map((item) => ({ stems: item.trackIds.map(name), scope: item.scope, severity: item.severity, outcome: item.outcome, measures: Object.fromEntries(Object.entries(item.measures).map(([key, value]) => [key, typeof value === "string" && document.tracks.some((track) => track.id === value) ? name(value) : value])), explanation: item.explanation }));
    if (tracks.ids.length > 0) ctx.turn.focus = { ...(ctx.turn.focus ?? {}), trackIds: tracks.ids.slice(0, 4), tab: "full" };
    return { ok: true, content: { domain: args.domain, interactions: rows, ...(rows.length === 0 ? { note: "No measured interaction between these stems in this domain." } : {}) } };
  },
};

const planSchema = z
  .object({
    route: z.enum(ROUTES),
    strength: z.enum(MIX_STRENGTHS).optional(),
    goal: z.enum(MIX_GOALS).optional(),
    focusTracks: refs.optional(),
    focusSections: refs.optional(),
    onlySections: refs.optional(),
    protectTracks: refs.optional(),
    excludeDomains: z.array(z.enum(CONSTRAINT_DOMAINS)).max(4).optional(),
    excludeProcessors: z.array(z.enum(CONSTRAINT_PROCESSORS)).max(4).optional(),
    intents: z.array(z.object({ note: z.string().min(1).max(120), section: z.string().max(80).optional(), track: z.string().max(80).optional() }).strict()).max(4).optional(),
    intent: z.string().max(160).optional(),
  })
  .strict();
type PlanArgs = z.infer<typeof planSchema>;

const planMix = {
  name: "plan_mix",
  permission: "plan" as const,
  description: [
    "Builds a new candidate with the deterministic planners and puts it in the Full Mix review for preview. Never writes the project. The planners choose every value; you choose the route and the constraints.",
    "route 'full': broad, subjective, or multi-dimension requests (improve the chorus, make it punchier, give the vocal room, less crowded, the drop should hit harder). The Full Mix planner weighs gain, EQ, space, and dynamics together; do not chain the other routes yourself.",
    "route 'level': only faders. 'eq': only static EQ (frequency-focused requests where other domains must stay). 'space': only pan and width (wider, narrower, crowded center when the person wants only stereo moves). 'dynamics': only time-varying processing (compression, ducking, transients, dynamic EQ: tighter, jumps around, kick buried on hits).",
    "focusTracks/focusSections: only problems involving these are planned. onlySections: nothing outside these sections may change. protectTracks: measured but never changed. excludeDomains/excludeProcessors: kinds of processing not allowed. strength: conservative for subtle requests, strong only when asked; goal leans the weighting (punchy, open, intimate, wide, controlled).",
    "intents: what the person wants that the mix does not already show as a problem, in plain words the planners read as section or stem notes ('wider', 'punchier', 'more prominent', 'less muddy', 'warmer', 'sit back'), optionally for one section or stem. The planners check it against measurements and size any move themselves; a note never carries a number, and an intent the mix already satisfies plans nothing. Use it for 'make the drop wider', 'the trumpets should stand out more', 'the vocal sounds muddy'.",
    "The person's own constraints are added automatically and cannot be removed.",
  ].join(" "),
  schema: planSchema,
  activity: (args: PlanArgs) => (args.route === "full" ? "Building Full Mix candidate…" : `Building ${args.route === "level" ? "level" : args.route === "eq" ? "EQ" : args.route === "space" ? "spatial" : "dynamics"} candidate…`),
  run: async (args: PlanArgs, ctx: ToolContext): Promise<ToolResult> => {
    const document = ctx.env.document();
    const focusTracks = tracksFrom(ctx, args.focusTracks);
    if (!focusTracks.ok) return focusTracks;
    const focusSections = sectionsFrom(ctx, args.focusSections);
    if (!focusSections.ok) return focusSections;
    const only = sectionsFrom(ctx, args.onlySections);
    if (!only.ok) return only;
    const protect = tracksFrom(ctx, args.protectTracks);
    if (!protect.ok) return protect;
    if (ctx.turn.constraints.unresolved.length > 0) {
      const item = ctx.turn.constraints.unresolved[0]!;
      return { ok: false, error: `The person's constraint "${item.phrase}" could mean ${namesOf(document, item.options)}. Ask which one before planning.` };
    }
    const intents: NonNullable<MixConstraints["intents"]> = [];
    for (const item of args.intents ?? []) {
      const track = item.track ? tracksFrom(ctx, [item.track]) : null;
      if (track && !track.ok) return track;
      const section = item.section ? sectionsFrom(ctx, [item.section]) : null;
      if (section && !section.ok) return section;
      const trackIds = track?.ok ? track.ids : [null];
      const sectionIds = section?.ok ? section.ids : [null];
      for (const trackId of trackIds) for (const sectionId of sectionIds) intents.push({ trackId, sectionId, note: item.note });
    }
    const constraints = mergeConstraints(document, ctx, args.route, {
      protect: protect.ids,
      excludeDomains: args.excludeDomains ?? [],
      excludeProcessors: args.excludeProcessors ?? [],
      only: only.ids.length > 0 ? only.ids : null,
      focusTracks: focusTracks.ids,
      focusSections: focusSections.ids,
      intents,
    });
    // The person's strength word wins over the model's choice.
    const strength: MixStrength = ctx.turn.constraints.strength ?? args.strength ?? ctx.session.standing.strength ?? "normal";
    const goal: MixGoal = args.goal ?? "balanced";
    const inputs = await inputsOf(ctx);
    ctx.env.activity(args.route === "full" ? "Building Full Mix candidate…" : "Building candidate…");
    const latest = ctx.env.document();
    let plan = await ctx.env.planFullMix({ document: latest, measurements: inputs.measurements, bands: inputs.bands, stereo: inputs.stereo, envelopes: inputs.envelopes, fingerprints: inputs.fingerprints, mixPeakDbfs: inputs.mixPeakDbfs, settings: { strength, goal }, constraints, now: ctx.env.now() });
    check(ctx);
    ctx.env.activity("Evaluating…");
    const gate = safetyGate(ctx.env.document(), plan, ctx.env.candidateStale(plan));
    plan = gate.plan;
    if (ctx.env.candidateStale(plan)) return { ok: false, error: "The mix changed while the candidate was built. Nothing was changed; build it again." };
    const describe = [args.intent, args.route === "full" ? null : `${args.route} only`, strength !== "normal" ? strength : null, goal !== "balanced" ? goal : null, Object.keys(describeConstraints(document, constraints)).length > 0 ? summarizeConstraints(document, constraints) : null].filter(Boolean).join(" · ");
    const entry = addCandidate(ctx, plan, args.route, describe || "whole mix");
    const firstProblem = plan.problems.find((problem) => problem.interventionId) ?? plan.problems[0] ?? null;
    ctx.env.showCandidate(plan, { problemId: firstProblem?.id ?? null });
    pushCard(ctx, candidateCard(document, entry, plan, false));
    ctx.turn.focus = { ...(ctx.turn.focus ?? {}), tab: "full", problemId: firstProblem?.id ?? null, trackIds: firstProblem?.trackIds.slice(0, 4) ?? ctx.turn.focus?.trackIds ?? [] };
    ctx.turn.actions.push(`built ${entry.label} (${describe || "whole mix"}): ${includedChanges(plan).length} changes`);
    ctx.env.log("agent.plan", { route: args.route, strength, goal, changes: plan.changes.length, problems: plan.problems.length, constrained: plan.constraints !== undefined });
    return {
      ok: true,
      content: {
        ...candidateView(document, entry, plan, false, "summary"),
        route: args.route,
        ...(gate.problems.length > 0 ? { safety: gate.problems } : {}),
        ...(missingNote(document, inputs) ? { missing: missingNote(document, inputs) } : {}),
        next: "The candidate is in the Full Mix review and can be previewed. Nothing is applied until the person says so.",
      },
    };
  },
};

function summarizeConstraints(document: ProjectDocument, constraints: MixConstraints): string {
  const parts: string[] = [];
  if (constraints.protectedTrackIds.length) parts.push(`${namesOf(document, constraints.protectedTrackIds)} protected`);
  if (constraints.excludedDomains.length) parts.push(`no ${constraints.excludedDomains.join("/")}`);
  if (constraints.excludedProcessors.length) parts.push(`no ${constraints.excludedProcessors.join("/")}`);
  if (constraints.sectionIds) parts.push(`only ${sectionNamesOf(document, constraints.sectionIds)}`);
  if (constraints.focusTrackIds.length) parts.push(`focus ${namesOf(document, constraints.focusTrackIds)}`);
  return parts.join(", ");
}

const getCandidate = {
  name: "get_candidate",
  permission: "read" as const,
  description:
    "The current candidate as it is now, including the person's edits and accept/reject in the plan UI: changes, problems with re-measured severity, and why. detail 'full' adds each problem's evidence and every alternative considered with why it was rejected (use for 'why EQ instead of panning?', 'why didn't you change the bass?', 'show me the reasoning'). Optionally another candidate by label.",
  schema: z.object({ detail: z.enum(["summary", "full"]).optional(), candidate: z.string().max(40).optional() }).strict(),
  activity: () => "Reading the candidate…",
  run: async (args: { detail?: "summary" | "full"; candidate?: string }, ctx: ToolContext): Promise<ToolResult> => {
    const document = ctx.env.document();
    if (args.candidate) {
      const entry = findCandidate(ctx, args.candidate);
      if (!entry) return { ok: false, error: `No candidate "${args.candidate}". Candidates: ${ctx.session.candidates.map((item) => item.label).join(", ") || "none"}.` };
      if (entry.id !== ctx.session.currentCandidateId) return { ok: true, content: candidateView(document, entry, entry.plan, ctx.env.candidateStale(entry.plan), args.detail ?? "summary") };
    }
    const live = liveCandidate(ctx);
    if (!live) return { ok: false, error: "There is no candidate in this conversation yet." };
    return { ok: true, content: candidateView(document, live.entry, live.plan, ctx.env.candidateStale(live.plan), args.detail ?? "summary") };
  },
};

const explainProblem = {
  name: "explain_problem",
  permission: "read" as const,
  description: "One problem of the current candidate in full: its evidence, the solution chosen and why, every alternative considered and why it lost, and the changes that serve it. Also focuses it in the review.",
  schema: z.object({ problemId: z.string().min(1).max(120) }).strict(),
  activity: () => "Reading the evidence…",
  run: async (args: { problemId: string }, ctx: ToolContext): Promise<ToolResult> => {
    const live = liveCandidate(ctx);
    if (!live) return { ok: false, error: "There is no candidate. Use detect_mix_problems to read problems on the current mix." };
    const document = ctx.env.document();
    const problem = live.plan.problems.find((item) => item.id === args.problemId);
    if (!problem) return { ok: false, error: `No problem "${args.problemId}" in ${live.entry.label}. Problems: ${live.plan.problems.map((item) => item.id).join(", ")}.` };
    const view = candidateView(document, live.entry, live.plan, false, "full") as { problems: Array<{ id: string }> };
    ctx.turn.focus = { ...(ctx.turn.focus ?? {}), problemId: problem.id, trackIds: problem.trackIds.slice(0, 4), tab: "full", ...(problem.scope.type === "section" ? { sectionId: problem.scope.sectionId } : {}) };
    pushCard(ctx, { kind: "problem", problemId: problem.id, title: problem.title, severity: problem.severity, outcome: problem.outcome });
    return { ok: true, content: { problem: view.problems.find((item) => item.id === problem.id), changes: live.plan.changes.filter((change) => change.problemIds.includes(problem.id)).map((change) => changeView(document, change)) } };
  },
};

/* --------------------------------------------------------------- refinement */

const targetSchema = z
  .object({
    changeIds: z.array(z.string().min(1).max(160)).max(12).optional(),
    problemIds: z.array(z.string().min(1).max(160)).max(8).optional(),
    tracks: refs.optional(),
    domains: z.array(z.enum(["gain", "eq", "space", "dynamics"])).max(4).optional(),
    processors: z.array(z.enum(["gain", "eq", "space", "compressor", "ducking", "transient", "dynamicEq"])).max(7).optional(),
    all: z.boolean().optional(),
  })
  .strict();
type Target = z.infer<typeof targetSchema>;

const operationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("scale"), target: targetSchema, amount: z.enum(Object.keys(AMOUNTS) as [keyof typeof AMOUNTS, ...Array<keyof typeof AMOUNTS>]).optional(), statedFactor: z.number().min(0).max(2).optional() }).strict(),
  z.object({ action: z.literal("remove"), target: targetSchema }).strict(),
  z.object({ action: z.literal("restore"), target: targetSchema }).strict(),
  z.object({ action: z.literal("accept"), target: targetSchema }).strict(),
  z.object({ action: z.literal("reset"), target: targetSchema }).strict(),
]);
const refineSchema = z.object({ operations: z.array(operationSchema).min(1).max(6) }).strict();
type RefineArgs = z.infer<typeof refineSchema>;

function selectChanges(ctx: ToolContext, plan: FullMixPlan, target: Target): { ok: true; changes: MixChange[] } | { ok: false; error: string } {
  const tracks = tracksFrom(ctx, target.tracks);
  if (!tracks.ok) return { ok: false, error: tracks.error };
  let changes = plan.changes.filter((change) => change.processing.type !== "trim");
  if (target.all) return { ok: true, changes };
  if (target.changeIds?.length) {
    const unknown = target.changeIds.filter((id) => !changes.some((change) => change.id === id));
    if (unknown.length) return { ok: false, error: `Unknown change ids: ${unknown.join(", ")}.` };
    changes = changes.filter((change) => target.changeIds!.includes(change.id));
  }
  if (target.problemIds?.length) changes = changes.filter((change) => change.problemIds.some((id) => target.problemIds!.includes(id)));
  if (tracks.ids.length) changes = changes.filter((change) => tracks.ids.includes(change.trackId));
  if (target.domains?.length) changes = changes.filter((change) => (target.domains as readonly string[]).includes(change.domain));
  if (target.processors?.length) changes = changes.filter((change) => (target.processors as readonly string[]).includes(processorKind(change.processing)));
  if (!target.changeIds?.length && !target.problemIds?.length && !tracks.ids.length && !target.domains?.length && !target.processors?.length) return { ok: false, error: "Name the changes to refine (ids, problems, stems, domains, processors, or all)." };
  return changes.length > 0 ? { ok: true, changes } : { ok: false, error: "No change in the candidate matches that." };
}

const refineCandidate = {
  name: "refine_candidate",
  permission: "plan" as const,
  description: [
    "Edits the current candidate without re-planning, starting from its current values (including the person's own edits in the plan UI).",
    "scale: weaker or stronger by a named amount (much-less 0.5, less 0.7, slightly-less 0.85, slightly-more 1.15, more 1.3, much-more 1.5) or by statedFactor, which must be a factor the person stated ('25% weaker' → 0.75). The planners' edit bounds apply.",
    "remove: reject changes ('lose the width change', 'try it without the sidechain'). restore: bring rejected ones back. accept: mark as accepted ('keep the EQ'). reset: back to the planned value.",
    "Use it for 'a little less', 'keep the EQ but lose the width change', 'more width, less compression'.",
  ].join(" "),
  schema: refineSchema,
  activity: () => "Updating the candidate…",
  run: async (args: RefineArgs, ctx: ToolContext): Promise<ToolResult> => {
    const live = liveCandidate(ctx);
    if (!live) return { ok: false, error: "There is no candidate to refine. Build one first." };
    if (ctx.env.candidateStale(live.plan)) return { ok: false, error: `${live.entry.label} is out of date: the mix changed since it was built. It has to be rebuilt before it can be refined or applied.` };
    const document = ctx.env.document();
    const name = names(document);
    let plan = live.plan;
    const lines: string[] = [];
    for (const operation of args.operations) {
      const selected = selectChanges(ctx, plan, operation.target);
      if (!selected.ok) return { ok: false, error: selected.error };
      for (const change of selected.changes) {
        const before = describeChange(change.processing, name, change.evidence.kind === "space" ? change.evidence.current : undefined);
        if (operation.action === "scale") {
          let factor: number;
          if (operation.statedFactor !== undefined) {
            if (!ctx.turn.statedFactors.some((value) => Math.abs(value - operation.statedFactor!) < 0.011)) return { ok: false, error: `statedFactor ${operation.statedFactor} is not a factor the person stated in this message (${ctx.turn.statedFactors.join(", ") || "none"}). Use a named amount.` };
            factor = operation.statedFactor;
          } else factor = AMOUNTS[operation.amount ?? "less"];
          const scaled = scaleChange(plan, change.id, factor);
          if (!scaled.scaled) {
            lines.push(`${name(change.trackId)} ${before}: unchanged (${scaled.reason ?? "already at its limit"})`);
            continue;
          }
          plan = scaled.plan;
        } else if (operation.action === "remove") plan = setChangeStatus(plan, change.id, "rejected");
        else if (operation.action === "restore") plan = setChangeStatus(plan, change.id, "proposed");
        else if (operation.action === "accept") plan = setChangeStatus(plan, change.id, "accepted");
        else plan = resetChange(plan, change.id);
        const after = plan.changes.find((item) => item.id === change.id)!;
        const now = describeChange(after.processing, name, after.evidence.kind === "space" ? after.evidence.current : undefined);
        lines.push(`${name(change.trackId)}: ${operation.action === "remove" ? `${before} removed` : operation.action === "restore" ? `${now} restored` : operation.action === "accept" ? `${now} accepted` : `${before} → ${now}`}`);
      }
    }
    check(ctx);
    live.entry.plan = plan;
    ctx.env.showCandidate(plan);
    pushCard(ctx, candidateCard(document, live.entry, plan, false));
    pushCard(ctx, { kind: "edit", lines });
    ctx.turn.actions.push(`refined ${live.entry.label}: ${lines.join("; ")}`);
    ctx.env.log("agent.plan", { refine: args.operations.map((operation) => operation.action), changes: lines.length });
    return { ok: true, content: { candidate: live.entry.label, edits: lines, now: candidateView(document, live.entry, plan, false, "summary").changes, note: "Edits are re-checked with each change's own planner evaluator; the whole mix was not re-measured." } };
  },
};

const simplifyCandidate = {
  name: "simplify_candidate",
  permission: "plan" as const,
  description: "'Too processed', 'fewer changes', 'back it off': takes changes out of the current candidate one at a time, each time the one the re-measured mix misses least, while keeping most of the measured improvement. Makes a new candidate so the person can compare and go back.",
  schema: z.object({ keep: z.number().min(0.5).max(0.95).optional() }).strict(),
  activity: () => "Re-measuring without each change…",
  run: async (args: { keep?: number }, ctx: ToolContext): Promise<ToolResult> => {
    const live = liveCandidate(ctx);
    if (!live) return { ok: false, error: "There is no candidate to simplify. If the last plan was applied, it is part of the saved mix now; undo it first or ask for a more conservative plan." };
    if (ctx.env.candidateStale(live.plan)) return { ok: false, error: `${live.entry.label} is out of date: the mix changed since it was built.` };
    const inputs = await inputsOf(ctx);
    const document = ctx.env.document();
    const result = await ctx.env.simplify({ document, measurements: inputs.measurements, bands: inputs.bands, stereo: inputs.stereo, envelopes: inputs.envelopes, fingerprints: inputs.fingerprints, mixPeakDbfs: inputs.mixPeakDbfs, now: ctx.env.now() }, live.plan, { keep: args.keep ?? 0.8 });
    check(ctx);
    if (result.removed.length === 0) return { ok: true, content: { candidate: live.entry.label, removed: [], note: "Every change earns its place: taking any one out loses too much of the measured improvement or adds a regression." } };
    const entry = addCandidate(ctx, result.plan, live.entry.route, `${live.entry.label} simplified`);
    ctx.env.showCandidate(result.plan);
    pushCard(ctx, candidateCard(document, entry, result.plan, false));
    ctx.turn.actions.push(`simplified ${live.entry.label} into ${entry.label}`);
    return {
      ok: true,
      content: {
        from: live.entry.label,
        candidate: entry.label,
        removed: result.removed.map((item) => ({ change: item.label, reason: item.reason })),
        changesBefore: result.before.changes,
        changesAfter: result.after.changes,
        processingCostBefore: result.before.cost,
        processingCostAfter: result.after.cost,
        shareOfImprovementKept: result.kept,
      },
    };
  },
};

function findCandidate(ctx: ToolContext, reference: string): CandidateEntry | null {
  const text = reference.trim().toLowerCase();
  const list = ctx.session.candidates;
  const exact = list.find((entry) => entry.id === reference || entry.label.toLowerCase() === text || entry.label.toLowerCase() === `candidate ${text}`);
  if (exact) return exact;
  const current = list.findIndex((entry) => entry.id === ctx.session.currentCandidateId);
  if (/^(first|1st|the first( one)?|original)$/.test(text)) return list[0] ?? null;
  if (/^(second|2nd)$/.test(text)) return list[1] ?? null;
  if (/^(previous|last|the previous( one)?|before)$/.test(text)) return current > 0 ? list[current - 1]! : null;
  if (/^(latest|newest|current)$/.test(text)) return list.at(-1) ?? null;
  return null;
}

const selectCandidate = {
  name: "select_candidate",
  permission: "plan" as const,
  description: "Makes an earlier candidate of this conversation the current one again ('go back to the first one', 'try Candidate A again'). Refused when the mix changed since it was built.",
  schema: z.object({ candidate: z.string().min(1).max(40) }).strict(),
  activity: () => "Restoring the candidate…",
  run: async (args: { candidate: string }, ctx: ToolContext): Promise<ToolResult> => {
    const entry = findCandidate(ctx, args.candidate);
    if (!entry) return { ok: false, error: `No candidate "${args.candidate}". Candidates: ${ctx.session.candidates.map((item) => item.label).join(", ") || "none"}.` };
    liveCandidate(ctx);
    if (ctx.env.candidateStale(entry.plan)) return { ok: false, error: `${entry.label} is out of date: the mix changed since it was built${entry.appliedAt ? " (it was applied)" : ""}. It would have to be rebuilt.` };
    check(ctx);
    ctx.session.currentCandidateId = entry.id;
    ctx.env.showCandidate(entry.plan);
    const document = ctx.env.document();
    pushCard(ctx, candidateCard(document, entry, entry.plan, false));
    ctx.turn.actions.push(`switched to ${entry.label}`);
    return { ok: true, content: candidateView(document, entry, entry.plan, false, "summary") };
  },
};

const compareCandidates = {
  name: "compare_candidates",
  permission: "read" as const,
  description: "The actual processing difference between two candidates of this conversation (by label: 'A', 'B', 'previous', 'current').",
  schema: z.object({ a: z.string().min(1).max(40), b: z.string().min(1).max(40) }).strict(),
  activity: () => "Comparing candidates…",
  run: async (args: { a: string; b: string }, ctx: ToolContext): Promise<ToolResult> => {
    liveCandidate(ctx);
    const left = findCandidate(ctx, args.a);
    const right = findCandidate(ctx, args.b);
    if (!left || !right) return { ok: false, error: `Candidates: ${ctx.session.candidates.map((item) => item.label).join(", ") || "none"}.` };
    const document = ctx.env.document();
    const name = names(document);
    const key = (change: MixChange) => `${change.trackId}|${processorKind(change.processing)}|${change.scope.type === "section" ? change.scope.sectionId : "global"}`;
    const words = (change: MixChange) => `${name(change.trackId)}${change.scope.type === "section" ? ` (${scopeName(document, change.scope)})` : ""}: ${describeChange(change.processing, name, change.evidence.kind === "space" ? change.evidence.current : undefined)}`;
    const a = new Map(includedChanges(left.plan).map((change) => [key(change), change]));
    const b = new Map(includedChanges(right.plan).map((change) => [key(change), change]));
    return {
      ok: true,
      content: {
        [`only in ${left.label}`]: [...a].filter(([id]) => !b.has(id)).map(([, change]) => words(change)),
        [`only in ${right.label}`]: [...b].filter(([id]) => !a.has(id)).map(([, change]) => words(change)),
        differentValues: [...a].filter(([id, change]) => b.has(id) && JSON.stringify(b.get(id)!.processing) !== JSON.stringify(change.processing)).map(([id, change]) => ({ [left.label]: words(change), [right.label]: words(b.get(id)!) })),
        same: [...a].filter(([id, change]) => b.has(id) && JSON.stringify(b.get(id)!.processing) === JSON.stringify(change.processing)).map(([, change]) => words(change)),
        // Problem scores are not compared: each is measured over its own plan's problems (strength and focus differ).
        summary: { [left.label]: `${left.description}: ${left.plan.summary.headline}`, [right.label]: `${right.description}: ${right.plan.summary.headline}` },
        changeCount: { [left.label]: includedChanges(left.plan).length, [right.label]: includedChanges(right.plan).length },
        processingCost: { [left.label]: Math.round(includedChanges(left.plan).reduce((sum, change) => sum + change.cost, 0) * 1000) / 1000, [right.label]: Math.round(includedChanges(right.plan).reduce((sum, change) => sum + change.cost, 0) * 1000) / 1000 },
      },
    };
  },
};

const discardCandidate = {
  name: "discard_candidate",
  permission: "plan" as const,
  description: "Closes the current candidate without applying it ('forget it', 'undo what you just did' when nothing was applied). The saved mix is untouched.",
  schema: z.object({}).strict(),
  activity: () => "Closing the candidate…",
  run: async (_args: Record<string, never>, ctx: ToolContext): Promise<ToolResult> => {
    const entry = currentEntry(ctx);
    if (!entry) return { ok: false, error: "There is no open candidate." };
    check(ctx);
    ctx.session.currentCandidateId = null;
    ctx.env.showCandidate(null);
    ctx.turn.actions.push(`discarded ${entry.label}`);
    return { ok: true, content: { discarded: entry.label, savedMixChanged: false } };
  },
};

const previewSchema = z.object({ what: z.enum(["candidate", "current", "problem", "change"]), id: z.string().max(160).optional(), side: z.enum(["only", "without"]).optional() }).strict();
type PreviewArgs = z.infer<typeof previewSchema>;

const preview = {
  name: "preview",
  permission: "preview" as const,
  description: "Switches what plays: the current candidate, the saved mix ('current'), one problem's solution or one change on its own ('only') or the candidate without it ('without'). Loudness-matched by default. Changes what is heard, never what is saved. 'Let's hear it' means this, not apply.",
  schema: previewSchema,
  activity: () => "Switching the A/B…",
  run: async (args: PreviewArgs, ctx: ToolContext): Promise<ToolResult> => {
    const live = liveCandidate(ctx);
    if (!live && args.what !== "current") return { ok: false, error: "There is no candidate to preview." };
    if (live && args.what !== "current" && ctx.env.candidateStale(live.plan)) return { ok: false, error: `${live.entry.label} is out of date: the mix changed since it was built.` };
    if ((args.what === "problem" || args.what === "change") && !args.id) return { ok: false, error: "Give the problem or change id." };
    check(ctx);
    // The review may hold another plan (the Full Mix button was used since); play the conversation's candidate.
    if (live && args.what !== "current" && ctx.env.candidate() !== live.plan) ctx.env.showCandidate(live.plan);
    const result = ctx.env.preview(args.what === "candidate" || args.what === "current" ? { kind: args.what } : { kind: args.what, ...(args.what === "problem" ? { problemId: args.id! } : { changeId: args.id! }), side: args.side ?? "only" } as never);
    if (!result.ok) return { ok: false, error: result.message };
    ctx.env.log("agent.preview", { what: args.what, side: args.side ?? null });
    ctx.turn.actions.push(`preview: ${result.hearing}`);
    return { ok: true, content: { hearing: result.hearing, note: "Playback position and transport are unchanged; press play (Space) if it is stopped." } };
  },
};

/* ------------------------------------------------------------------ writes */

/**
 * Applies the current candidate through the existing Full Mix apply. Shared by the tool (with the person's
 * approval in this message) and by the panel's Apply button.
 */
export function applyCurrent(ctx: ToolContext, mode: "all" | "accepted"): ToolResult {
  const live = liveCandidate(ctx);
  if (!live) return { ok: false, error: "There is no candidate to apply." };
  const document = ctx.env.document();
  if (ctx.env.candidateStale(live.plan)) return { ok: false, error: `${live.entry.label} is out of date: the mix changed since it was built. Nothing was applied; it has to be rebuilt first.` };
  const gate = safetyGate(document, live.plan, false);
  const plan = gate.plan;
  const included = plan.changes.filter((change) => (mode === "accepted" ? change.status === "accepted" : change.status === "proposed" || change.status === "accepted"));
  if (included.length === 0) return { ok: false, error: mode === "accepted" ? "No change is accepted yet. Nothing was applied." : "Every change is rejected. Nothing was applied." };
  const name = names(document);
  const lines = included.map((change) => `${name(change.trackId)}: ${describeChange(change.processing, name, change.evidence.kind === "space" ? change.evidence.current : undefined)}${change.scope.type === "section" ? ` in ${scopeName(document, change.scope)}` : ""}`);
  if (Math.abs(plan.candidateTrim.gainDb) >= 0.05) lines.push(`Safety trim ${plan.candidateTrim.gainDb.toFixed(1)} dB on every stem`);
  const result = ctx.env.apply(plan, mode);
  if (!result.ok) return { ok: false, error: `Nothing was applied. ${result.message}` };
  live.entry.appliedAt = ctx.env.now();
  live.entry.plan = plan;
  ctx.session.currentCandidateId = null;
  ctx.session.lastApply = { candidateId: live.entry.id, documentRef: result.document, lines, at: ctx.env.now() };
  ctx.turn.writes.push({ kind: "apply", lines });
  ctx.turn.cards = ctx.turn.cards.filter((card) => card.kind !== "candidate");
  ctx.turn.cards.push({ kind: "applied", lines });
  ctx.turn.actions.push(`applied ${live.entry.label} (${included.length} changes)`);
  ctx.env.log("agent.apply", { changes: included.length, mode });
  return { ok: true, content: { applied: lines, count: included.length, undo: "One undo step (Ctrl+Z or 'undo that') restores the previous mix." } };
}

const applyCandidate = {
  name: "apply_candidate",
  permission: "write" as const,
  description: "Writes the current candidate to the project through the normal Full Mix apply, as one undo step. Only runs when the person's message explicitly approves applying (the system checks; you cannot approve for them). mode 'all' applies proposed and accepted changes (the candidate as shown); 'accepted' only the accepted ones.",
  schema: z.object({ mode: z.enum(["all", "accepted"]).optional() }).strict(),
  activity: () => "Applying…",
  run: async (args: { mode?: "all" | "accepted" }, ctx: ToolContext): Promise<ToolResult> => {
    const live = liveCandidate(ctx);
    if (live && ctx.env.candidateStale(live.plan)) return { ok: false, error: `Not applied: ${live.entry.label} is out of date because the mix changed since it was built. It has to be rebuilt before it can be applied.` };
    if (!ctx.turn.approval.apply) return { ok: false, error: `Not applied: the person has not approved applying in this message${ctx.turn.approval.note ? ` (${ctx.turn.approval.note})` : ""}. Say the candidate is ready and that they can apply it.` };
    check(ctx);
    return applyCurrent(ctx, args.mode ?? ctx.turn.approval.applyMode);
  },
};

const undoApply = {
  name: "undo_last_apply",
  permission: "write" as const,
  description: "Undoes the last apply this conversation made, through the normal undo history. Only when the person asks to undo, and only while nothing else changed since that apply; otherwise explain that Ctrl+Z steps back through their own edits first. If the last candidate was never applied, use discard_candidate instead.",
  schema: z.object({}).strict(),
  activity: () => "Undoing…",
  run: async (_args: Record<string, never>, ctx: ToolContext): Promise<ToolResult> => {
    const last = ctx.session.lastApply;
    if (!last) return { ok: false, error: "This conversation has not applied anything, so there is nothing of mine to undo." };
    if (!ctx.turn.approval.undo) return { ok: false, error: "Not undone: the person has not asked to undo in this message." };
    if (ctx.env.document() !== last.documentRef) return { ok: false, error: "The project changed after that apply (another edit came after it). Undoing now would undo that edit first, so it was not undone. Ctrl+Z steps back one edit at a time." };
    check(ctx);
    const result = ctx.env.undo();
    if (!result.ok) return { ok: false, error: "The undo history had nothing to undo." };
    const entry = ctx.session.candidates.find((item) => item.id === last.candidateId);
    if (entry) entry.appliedAt = null;
    ctx.session.lastApply = null;
    ctx.turn.writes.push({ kind: "undo", lines: last.lines });
    ctx.turn.actions.push("undid the last apply");
    ctx.env.log("agent.apply", { undo: true });
    return { ok: true, content: { undone: last.lines, note: "The mix is back to what it was before that apply." } };
  },
};

const directEditSchema = z
  .object({
    track: z.string().min(1).max(80),
    control: z.enum(["gain", "pan", "width"]),
    mode: z.enum(["delta", "set"]),
    value: z.number().finite(),
    section: z.string().max(80).optional(),
  })
  .strict();
type DirectEditArgs = z.infer<typeof directEditSchema>;

const setTrackControl = {
  name: "set_track_control",
  permission: "write" as const,
  description:
    "Carries out an explicit numeric instruction the person gave in this message ('make the bass 1 dB quieter', 'pan the guitar 20% left', 'set the pad width to 80%') as one undo step. gain in dB, pan −100 (left) … 100 (right), width in percent. The value must be exactly what the person said; any other value is refused. Never use it to choose a value yourself — that is what plan_mix is for.",
  schema: directEditSchema,
  activity: (args: DirectEditArgs) => `Setting ${args.track} ${args.control}…`,
  run: async (args: DirectEditArgs, ctx: ToolContext): Promise<ToolResult> => {
    const resolved = tracksFrom(ctx, [args.track]);
    if (!resolved.ok) return resolved;
    if (resolved.ids.length !== 1) return { ok: false, error: `"${args.track}" is more than one stem. Ask which one.` };
    const trackId = resolved.ids[0]!;
    const stated = ctx.turn.directEdits.find((edit) => edit.trackIds.length === 1 && edit.trackIds[0] === trackId && edit.control === args.control && edit.mode === args.mode && Math.abs(edit.value - args.value) < 0.01);
    if (!stated) return { ok: false, error: "Refused: that value was not stated by the person in this message. Mix values come from the planners (plan_mix) unless the person gives them." };
    const sections = sectionsFrom(ctx, args.section ? [args.section] : stated.sectionIds ?? []);
    if (!sections.ok) return sections;
    const document = ctx.env.document();
    const track = document.tracks.find((item) => item.id === trackId)!;
    const sectionId = sections.ids[0] ?? null;
    const row = sectionId ? document.sectionTrackSettings.find((item) => item.trackId === trackId && item.sectionId === sectionId) : null;
    let value: number;
    if (args.control === "gain") {
      const now = row?.overrides.gainDb ?? track.gainDb;
      value = args.mode === "delta" ? now + args.value : args.value;
      if (value < -24 || value > 12) return { ok: false, error: `That would put ${trackName(track)} at ${value.toFixed(1)} dB, outside the −24 to +12 dB range.` };
    } else if (args.control === "pan") {
      const now = (row?.overrides.pan ?? track.pan) * 100;
      value = (args.mode === "delta" ? now + args.value : args.value) / 100;
      if (value < -1 || value > 1) return { ok: false, error: "Pan runs from 100% left to 100% right." };
    } else {
      const now = (row?.overrides.width ?? track.width) * 100;
      value = (args.mode === "delta" ? now + args.value : args.value) / 100;
      if (value < 0 || value > 2) return { ok: false, error: "Width runs from 0% (mono) to 200%." };
      if (track.metadata.channelCount < 2) return { ok: false, error: `${trackName(track)} is mono; width does nothing on it.` };
    }
    check(ctx);
    const result = ctx.env.directEdit({ trackId, control: args.control, value: Math.round(value * 1000) / 1000, sectionId });
    if (!result.ok) return { ok: false, error: result.message };
    const shown = args.control === "gain" ? `${value >= 0 ? "+" : ""}${value.toFixed(1)} dB` : args.control === "pan" ? (Math.abs(value) < 0.005 ? "center" : `${Math.round(Math.abs(value) * 100)}% ${value < 0 ? "left" : "right"}`) : `${Math.round(value * 100)}%`;
    const line = `${trackName(track)} ${args.control === "gain" ? "fader" : args.control} → ${shown}${sectionId ? ` in ${scopeName(document, { type: "section", sectionId })}` : ""}`;
    ctx.session.lastApply = { candidateId: null, documentRef: result.document, lines: [line], at: ctx.env.now() };
    ctx.turn.writes.push({ kind: "edit", lines: [line] });
    ctx.turn.cards.push({ kind: "applied", lines: [line] });
    ctx.turn.focus = { ...(ctx.turn.focus ?? {}), trackIds: [trackId], ...(sectionId ? { sectionId } : {}) };
    ctx.turn.actions.push(`set ${line}`);
    ctx.env.log("agent.apply", { direct: args.control });
    return { ok: true, content: { done: line, undo: "One undo step restores it." } };
  },
};

/* ------------------------------------------------------------------ final */

export const respondSchema = z
  .object({
    message: z.string().min(1).max(2400),
    focus: uiFocusSchema.optional(),
    confidence: z.enum(["high", "moderate", "low"]).optional(),
  })
  .strict();

const respond = {
  name: "respond",
  permission: "final" as const,
  description: "Ends the turn with your reply to the person. Call it alone, after any tools. focus selects stems, a section, a problem, or a change in the UI so they can see what you mean.",
  schema: respondSchema,
  activity: () => "",
  run: async () => ({ ok: true as const, content: {} }),
};

export const clarifySchema = z.object({ question: z.string().min(1).max(400), options: z.array(z.string().min(1).max(80)).max(6) }).strict();

const clarify = {
  name: "ask_clarification",
  permission: "final" as const,
  description: "Ends the turn with one short question, only when a reference is genuinely ambiguous and the answer would change the mix (two trumpets, six synths). options are the choices.",
  schema: clarifySchema,
  activity: () => "",
  run: async () => ({ ok: true as const, content: {} }),
};

/** The allowlist. The agent can call these and nothing else: no file system, shell, network, or code. */
export const TOOLS: Array<AgentTool<never>> = [
  getProject,
  getTrack,
  getSection,
  detectProblems,
  getInteractions,
  getCandidate,
  explainProblem,
  compareCandidates,
  planMix,
  refineCandidate,
  simplifyCandidate,
  selectCandidate,
  discardCandidate,
  preview,
  applyCandidate,
  undoApply,
  setTrackControl,
  respond,
  clarify,
] as unknown as Array<AgentTool<never>>;

export const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

/** Neutral tool specs for a provider. */
export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((tool) => {
    const schema = z.toJSONSchema(tool.schema as z.ZodType, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: tool.name, description: `[${tool.permission.toUpperCase()}] ${tool.description}`, parameters: schema };
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round1n(value: number | null): number | null {
  return value === null ? null : round1(value);
}

export { PLAN_TABS };
