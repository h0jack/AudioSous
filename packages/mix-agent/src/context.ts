import { describeChange, processorKind } from "@audiosous/mix-planner";
import type { ProjectDocument, Track } from "@audiosous/project-model";
import { AGENT_LIMITS, type AgentSession, type TranscriptEntry } from "./contract";
import type { ConstraintReading, DirectEdit } from "./language";
import { namesOf, sectionAt, sectionNamesOf, trackName, type Mention, type SectionResolution, type TrackResolution } from "./references";

/**
 * The deterministic context builder: the slice of the project one request needs, as compact JSON. It never
 * contains audio, file paths, analysis frames, or secrets; stems are named, not located. Detail beyond this
 * (measurements, interactions, evidence) is fetched by tools, so a 64-stem project costs about what a 6-stem one does.
 */

export interface ContextInput {
  document: ProjectDocument;
  session: AgentSession;
  message: string;
  mentions: { tracks: Array<Mention<TrackResolution>>; sections: Array<Mention<SectionResolution>> };
  constraints: ConstraintReading;
  approval: { apply: boolean; undo: boolean; preview: boolean };
  directEdits: DirectEdit[];
  statedFactors: number[];
  candidateStale: boolean | null;
  /** The live candidate, if any (with the person's edits). */
  candidate: import("@audiosous/mix-planner").FullMixPlan | null;
}

function round(value: number, digits = 1): number {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

function processingSummary(document: ProjectDocument, track: Track): string {
  const parts: string[] = [];
  if (track.processing.nodes.length) parts.push(`EQ×${track.processing.nodes.length}`);
  for (const node of track.processing.dynamics) {
    if (node.type === "ducking") parts.push(`duck←${namesOf(document, [node.keyTrackId])}`);
    else if (node.type === "dynamic-eq") parts.push(`dynEQ${node.keyTrackId ? `←${namesOf(document, [node.keyTrackId])}` : ""}`);
    else parts.push(node.type);
  }
  const sections = document.sectionTrackSettings.filter((row) => row.trackId === track.id && (row.processing.nodes.length + row.processing.dynamics.length > 0 || row.overrides.gainDb !== null || row.overrides.pan !== null || row.overrides.width !== null));
  if (sections.length) parts.push(`section settings in ${sections.length}`);
  return parts.join(", ");
}

function stemLine(document: ProjectDocument, track: Track, detailed: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = { name: trackName(track), role: track.role };
  if (!detailed) return base;
  const prominence = document.sectionTrackSettings.filter((row) => row.trackId === track.id && row.prominence).map((row) => `${row.prominence} in ${sectionNamesOf(document, [row.sectionId])}`);
  return {
    ...base,
    faderDb: round(track.gainDb),
    ...(Math.abs(track.pan) >= 0.005 ? { pan: round(track.pan, 2) } : {}),
    ...(track.metadata.channelCount >= 2 && Math.abs(track.width - 1) >= 0.005 ? { width: round(track.width, 2) } : {}),
    ...(track.metadata.channelCount < 2 ? { mono: true } : {}),
    ...(track.muted ? { muted: true } : {}),
    ...(processingSummary(document, track) ? { processing: processingSummary(document, track) } : {}),
    ...(prominence.length ? { prominence } : {}),
    ...(track.customLabel && track.customLabel !== track.name ? { file: track.name } : {}),
  };
}

function entryText(entry: TranscriptEntry): string {
  const text = entry.text.length > AGENT_LIMITS.entryChars ? `${entry.text.slice(0, AGENT_LIMITS.entryChars)}…` : entry.text;
  const cards = (entry.cards ?? [])
    .map((card) => (card.kind === "candidate" ? `[${card.label} shown: ${card.changes.join("; ")}]` : card.kind === "applied" ? `[applied: ${card.lines.join("; ")}]` : card.kind === "edit" ? `[edited: ${card.lines.join("; ")}]` : ""))
    .filter(Boolean)
    .join(" ");
  return `${entry.role === "user" ? "Person" : "Audiosous"}: ${text}${cards ? ` ${cards}` : ""}`;
}

/** The request's user message to the model: context JSON, recent conversation, and the message itself. */
export function buildContext(input: ContextInput): { text: string; json: string } {
  const { document, session } = input;
  const mentioned = new Set<string>();
  for (const mention of input.mentions.tracks) if (mention.resolution.kind !== "none") for (const id of mention.resolution.trackIds) mentioned.add(id);
  for (const id of session.focus.trackIds) mentioned.add(id);
  if (document.uiState.selectedTrackId) mentioned.add(document.uiState.selectedTrackId);
  // Detail for every stem on ordinary projects; on large ones only for stems this request is about.
  const detailedAll = document.tracks.length <= 24;
  const playheadSection = sectionAt(document, document.uiState.playheadSeconds);
  const candidate = input.candidate;
  const current = session.candidates.find((entry) => entry.id === session.currentCandidateId) ?? null;
  const name = (id: string) => namesOf(document, [id]) || id;

  const context: Record<string, unknown> = {
    project: {
      name: document.project.name,
      durationSeconds: round(document.project.durationSeconds, 0),
      stems: document.tracks.map((track) => stemLine(document, track, detailedAll || mentioned.has(track.id))),
      sections: [...document.sections]
        .sort((left, right) => left.startTime - right.startTime)
        .map((section) => ({ name: section.name, type: section.type, start: round(section.startTime, 0), end: round(section.endTime, 0), ...(section.userIntent ? { note: section.userIntent.slice(0, 160) } : {}) })),
    },
    selection: {
      stem: document.uiState.selectedTrackId ? name(document.uiState.selectedTrackId) : null,
      section: document.uiState.selectedSectionId ? sectionNamesOf(document, [document.uiState.selectedSectionId]) : null,
      playhead: { seconds: round(document.uiState.playheadSeconds, 0), section: playheadSection?.name ?? null },
    },
    request: {
      stemsMentioned: input.mentions.tracks.map((mention) =>
        mention.resolution.kind === "ambiguous"
          ? { phrase: mention.phrase, ambiguous: mention.resolution.trackIds.map(name) }
          : { phrase: mention.phrase, stems: mention.resolution.kind === "match" ? mention.resolution.trackIds.map(name) : [], via: mention.resolution.kind === "match" ? mention.resolution.via : null },
      ),
      sectionsMentioned: input.mentions.sections.map((mention) => ({ phrase: mention.phrase, sections: mention.resolution.kind === "none" ? [] : sectionNamesOf(document, mention.resolution.sectionIds).split(/, | and /) })),
      constraintsStated: {
        ...(input.constraints.protectedTrackIds.length ? { protect: input.constraints.protectedTrackIds.map(name) } : {}),
        ...(input.constraints.releasedTrackIds.length ? { release: input.constraints.releasedTrackIds.map(name) } : {}),
        ...(input.constraints.excludedDomains.length ? { excludeDomains: input.constraints.excludedDomains } : {}),
        ...(input.constraints.excludedProcessors.length ? { excludeProcessors: input.constraints.excludedProcessors } : {}),
        ...(input.constraints.onlySectionIds ? { onlySections: sectionNamesOf(document, input.constraints.onlySectionIds) } : {}),
        ...(input.constraints.excludedSectionIds.length ? { notSections: sectionNamesOf(document, input.constraints.excludedSectionIds) } : {}),
        ...(input.constraints.strength ? { strength: input.constraints.strength } : {}),
        ...(input.constraints.route ? { narrowTo: input.constraints.route } : {}),
        ...(input.constraints.unresolved.length ? { ambiguous: input.constraints.unresolved.map((item) => ({ phrase: item.phrase, options: item.options.map(name) })) } : {}),
      },
      approvesApply: input.approval.apply,
      asksUndo: input.approval.undo,
      asksToHear: input.approval.preview,
      ...(input.directEdits.length ? { explicitValues: input.directEdits.map((edit) => ({ stem: namesOf(document, edit.trackIds), control: edit.control, mode: edit.mode, value: edit.value, ...(edit.sectionIds ? { sections: sectionNamesOf(document, edit.sectionIds) } : {}) })) } : {}),
      ...(input.statedFactors.length ? { statedFactors: input.statedFactors } : {}),
    },
    standingConstraints: {
      ...(session.standing.protectedTrackIds.length ? { protect: session.standing.protectedTrackIds.map(name) } : {}),
      ...(session.standing.excludedDomains.length ? { excludeDomains: session.standing.excludedDomains } : {}),
      ...(session.standing.excludedProcessors.length ? { excludeProcessors: session.standing.excludedProcessors } : {}),
      ...(session.standing.strength ? { strength: session.standing.strength } : {}),
    },
    candidate:
      current && candidate
        ? {
            label: current.label,
            description: current.description,
            stale: input.candidateStale,
            headline: candidate.summary.headline,
            changes: candidate.changes
              .filter((change) => change.processing.type !== "trim")
              .map((change) => ({
                id: change.id,
                stem: name(change.trackId),
                scope: change.scope.type === "section" ? sectionNamesOf(document, [change.scope.sectionId]) : "whole song",
                kind: processorKind(change.processing),
                change: describeChange(change.processing, name, change.evidence.kind === "space" ? change.evidence.current : undefined),
                status: change.status,
                ...(change.edited ? { editedByPerson: true, asPlanned: describeChange(change.planned, name, change.evidence.kind === "space" ? change.evidence.current : undefined) } : {}),
                problems: change.problemIds,
              })),
            problems: candidate.problems.map((problem) => ({ id: problem.id, title: problem.title, outcome: problem.outcome, severity: problem.severity, after: problem.severityAfter })),
          }
        : null,
    otherCandidates: session.candidates.filter((entry) => entry.id !== session.currentCandidateId).map((entry) => ({ label: entry.label, description: entry.description, applied: entry.appliedAt !== null })),
    lastApply: session.lastApply ? { lines: session.lastApply.lines, undoableFromConversation: session.lastApply.documentRef === document } : null,
    conversationFocus: {
      stems: session.focus.trackIds.map(name),
      section: session.focus.sectionId ? sectionNamesOf(document, [session.focus.sectionId]) : null,
      problem: session.focus.problemId,
      change: session.focus.changeId,
    },
    ...(session.pendingQuestion ? { youAsked: session.pendingQuestion } : {}),
  };

  let json = JSON.stringify(context);
  // Budget: drop the least useful detail first.
  if (json.length > AGENT_LIMITS.contextChars) {
    const project = context.project as { stems: Array<Record<string, unknown>>; sections: Array<Record<string, unknown>> };
    project.sections = project.sections.map(({ note: _note, ...rest }) => rest);
    json = JSON.stringify(context);
  }
  if (json.length > AGENT_LIMITS.contextChars) {
    const project = context.project as { stems: Array<Record<string, unknown>> };
    project.stems = document.tracks.map((track) => stemLine(document, track, mentioned.has(track.id)));
    json = JSON.stringify(context);
  }
  if (json.length > AGENT_LIMITS.contextChars && context.candidate) {
    const view = context.candidate as { problems?: unknown };
    delete view.problems;
    json = JSON.stringify(context);
  }

  const recent = session.transcript.slice(-AGENT_LIMITS.recentEntries).map(entryText);
  const text = [
    "Context (structured project state for this request; JSON):",
    json,
    ...(session.summary.length ? ["", "Earlier in this conversation:", ...session.summary.slice(-8).map((line) => `- ${line}`)] : []),
    ...(recent.length ? ["", "Recent conversation:", ...recent] : []),
    "",
    `Person: ${input.message}`,
  ].join("\n");
  return { text, json };
}
