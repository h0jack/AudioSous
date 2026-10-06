import { emptyProcessingGraph, type ProjectDocument } from "@audiosous/project-model";
import { z } from "zod";
import { clampGain, round3 } from "./changes";
import { changeCost, type CostContext } from "./cost";
import type { MixChange } from "./model";

/** Domains a person can rule out. The safety trim is never ruled out: it keeps the balance and only protects headroom. */
export const CONSTRAINT_DOMAINS = ["gain", "eq", "space", "dynamics"] as const;
export type ConstraintDomain = (typeof CONSTRAINT_DOMAINS)[number];

/** Dynamics processors a person can rule out one by one ("no compression", "without the sidechain"). */
export const CONSTRAINT_PROCESSORS = ["compressor", "ducking", "transient", "dynamic-eq"] as const;
export type ConstraintProcessor = (typeof CONSTRAINT_PROCESSORS)[number];

/** Most sections a global change is moved into when only some sections may change. */
export const MAX_RESCOPED_SECTIONS = 4;

/**
 * What a plan may touch and what it should work on. Every field narrows; an empty value narrows nothing.
 *
 * - `protectedTrackIds`: stems that may be measured and may key a duck, but never get a change.
 * - `excludedDomains` / `excludedProcessors`: processing that may not be added or edited.
 * - `sectionIds`: only these sections may change. A song-wide change is moved into them (Track × Section gain, EQ,
 *   pan and width, or dynamics), so nothing outside them moves.
 * - `focusTrackIds` / `focusSectionIds`: only problems that involve these stems or were measured in these sections
 *   are planned. Others are still measured, so a change that makes one of them worse still counts against it.
 */
export const mixConstraintsSchema = z.object({
  protectedTrackIds: z.array(z.string().min(1)).max(64),
  excludedDomains: z.array(z.enum(CONSTRAINT_DOMAINS)).max(4),
  excludedProcessors: z.array(z.enum(CONSTRAINT_PROCESSORS)).max(4),
  sectionIds: z.array(z.string().min(1)).max(32).nullable(),
  focusTrackIds: z.array(z.string().min(1)).max(64),
  focusSectionIds: z.array(z.string().min(1)).max(32),
  /**
   * What the request wants, as notes the planners already read (section and Track × Section intent): "wider",
   * "punchier", "Trumpets more prominent", "less muddy". They are added to the planning view only, never written to
   * the project, and the planners verify and size them as they do any note. A null section means every section.
   */
  intents: z.array(z.object({ sectionId: z.string().min(1).nullable(), trackId: z.string().min(1).nullable(), note: z.string().min(1).max(160) })).max(8).optional(),
});
export type MixConstraints = z.infer<typeof mixConstraintsSchema>;

export function emptyConstraints(): MixConstraints {
  return { protectedTrackIds: [], excludedDomains: [], excludedProcessors: [], sectionIds: null, focusTrackIds: [], focusSectionIds: [], intents: [] };
}

export function constraintsAreEmpty(constraints: MixConstraints | null | undefined): boolean {
  if (!constraints) return true;
  return (
    constraints.protectedTrackIds.length === 0 &&
    constraints.excludedDomains.length === 0 &&
    constraints.excludedProcessors.length === 0 &&
    constraints.sectionIds === null &&
    constraints.focusTrackIds.length === 0 &&
    constraints.focusSectionIds.length === 0 &&
    (constraints.intents ?? []).length === 0
  );
}

/** Sorted and de-duplicated, so the same constraints always give the same plan identity. */
export function normalizeConstraints(constraints: MixConstraints): MixConstraints {
  const sorted = <T extends string>(values: readonly T[]) => [...new Set(values)].sort();
  return {
    protectedTrackIds: sorted(constraints.protectedTrackIds),
    excludedDomains: sorted(constraints.excludedDomains),
    excludedProcessors: sorted(constraints.excludedProcessors),
    sectionIds: constraints.sectionIds === null ? null : sorted(constraints.sectionIds),
    focusTrackIds: sorted(constraints.focusTrackIds),
    focusSectionIds: sorted(constraints.focusSectionIds),
    // Fixed key order: the identity hashes this JSON, and a plan stores it in schema order.
    intents: (constraints.intents ?? [])
      .map((item) => ({ sectionId: item.sectionId, trackId: item.trackId, note: cleanNote(item.note) }))
      .filter((item) => item.note)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

/** A request note as the planners read it: words only (no number reaches a planner this way), on one line. */
export function cleanNote(note: string): string {
  return note
    .replace(/[0-9]+([.,][0-9]+)?/g, " ")
    .replace(/[^\p{L}\s,.!?'’-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * The project as the planners see it for one request: the request's intents appended to the section and
 * Track × Section notes. For planning only; the plan's identity and every write use the real project.
 */
export function withIntents(document: ProjectDocument, constraints: MixConstraints): ProjectDocument {
  let next = document;
  for (const intent of constraints.intents ?? []) {
    const note = cleanNote(intent.note);
    if (!note) continue;
    const sectionIds = intent.sectionId ? [intent.sectionId] : next.sections.map((section) => section.id);
    for (const sectionId of sectionIds) {
      if (!next.sections.some((section) => section.id === sectionId)) continue;
      if (intent.trackId) {
        const trackId = intent.trackId;
        if (!next.tracks.some((track) => track.id === trackId)) continue;
        const existing = next.sectionTrackSettings.find((row) => row.trackId === trackId && row.sectionId === sectionId);
        const row = existing ?? { trackId, sectionId, userIntent: null, prominence: null, overrides: { gainDb: null, pan: null, width: null }, processing: emptyProcessingGraph() };
        const userIntent = row.userIntent ? `${row.userIntent}. ${note}` : note;
        next = { ...next, sectionTrackSettings: [...next.sectionTrackSettings.filter((item) => item !== existing), { ...row, userIntent }] };
      } else {
        next = { ...next, sections: next.sections.map((section) => (section.id === sectionId ? { ...section, userIntent: section.userIntent ? `${section.userIntent}. ${note}` : note } : section)) };
      }
    }
  }
  return next;
}

/** Whether a problem is one the plan should work on. */
export function problemInFocus(problem: { trackIds: string[]; sectionIds: string[]; scope: { type: string; sectionId?: string } }, constraints: MixConstraints): boolean {
  if (constraints.focusTrackIds.length > 0 && !problem.trackIds.some((id) => constraints.focusTrackIds.includes(id))) return false;
  if (constraints.focusSectionIds.length > 0) {
    const sections = problem.scope.type === "section" && problem.scope.sectionId ? [problem.scope.sectionId] : problem.sectionIds;
    // A whole-song reading with no section list applies everywhere, so it applies in the focused section too.
    if (sections.length > 0 && !sections.some((id) => constraints.focusSectionIds.includes(id))) return false;
  }
  return true;
}

/** Why a change is not allowed, or null when it is. */
export function constraintViolation(change: Pick<MixChange, "trackId" | "domain" | "scope" | "processing">, constraints: MixConstraints): string | null {
  if (change.domain === "trim") return null;
  if (constraints.protectedTrackIds.includes(change.trackId)) return "protected stem";
  if ((constraints.excludedDomains as readonly string[]).includes(change.domain)) return `${change.domain} is ruled out`;
  if (change.processing.type === "dynamics" && (constraints.excludedProcessors as readonly string[]).includes(change.processing.processing.type)) return `${change.processing.processing.type} is ruled out`;
  if (constraints.sectionIds !== null && (change.scope.type === "global" || !constraints.sectionIds.includes(change.scope.sectionId))) return "outside the allowed sections";
  return null;
}

/**
 * The form of a change the constraints allow: the change itself, the same change moved into the allowed sections
 * (a song-wide change when only some sections may change), or nothing.
 */
export function constrainChange(ctx: CostContext, change: MixChange, constraints: MixConstraints, problemSectionIds: readonly string[]): MixChange[] {
  if (change.domain === "trim") return [change];
  const direct = constraintViolation(change, constraints);
  if (direct === null) return [change];
  if (direct !== "outside the allowed sections" || change.scope.type !== "global" || constraints.sectionIds === null) return [];
  const allowed = constraints.sectionIds;
  const wanted = problemSectionIds.filter((id) => allowed.includes(id));
  const targets = (wanted.length > 0 ? wanted : problemSectionIds.length === 0 ? allowed : []).slice(0, MAX_RESCOPED_SECTIONS);
  return targets.map((sectionId) => rescoped(ctx, change, sectionId));
}

function rescoped(ctx: CostContext, change: MixChange, sectionId: string): MixChange {
  const scope = { type: "section" as const, sectionId };
  let processing = change.processing;
  if (processing.type === "gain") processing = { type: "gain", gainDb: sectionGain(ctx.document, change.trackId, sectionId, processing.deltaDb), deltaDb: processing.deltaDb };
  const moved: MixChange = {
    ...change,
    id: `${change.id}@${sectionId}`,
    scope,
    processing,
    planned: processing,
    // A song-wide node cannot be edited from a section; the section gets its own.
    replacesNodeId: null,
    reasons: change.reasons.map((reason, index) => (index === 0 ? `${reason} (in this section only)`.slice(0, 600) : reason)),
  };
  const current = change.evidence.kind === "space" ? change.evidence.current : undefined;
  return { ...moved, cost: round3(changeCost(ctx, moved, current)) };
}

/** The absolute Track × Section gain that moves a stem by `deltaDb` inside one section. */
function sectionGain(document: ProjectDocument, trackId: string, sectionId: string, deltaDb: number): number {
  const track = document.tracks.find((item) => item.id === trackId);
  const row = document.sectionTrackSettings.find((item) => item.trackId === trackId && item.sectionId === sectionId);
  return clampGain((row?.overrides.gainDb ?? track?.gainDb ?? 0) + deltaDb);
}
