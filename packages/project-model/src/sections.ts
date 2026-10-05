import { SECTION_TYPES, emptyProcessingGraph, type ProjectDocument, type SectionType, type SongSection, type TrackSectionState } from "./schema";

export type SectionEditResult = { ok: true; document: ProjectDocument; time?: number } | { ok: false; message: string };

export interface NewSectionInput {
  name?: string;
  type?: SectionType | null;
  startTime: number;
  endTime: number;
}

export function addManualSection(document: ProjectDocument, input: NewSectionInput): SectionEditResult {
  const bounds = boundsFor(document, input.startTime, input.endTime);
  if (!bounds.ok) return bounds;
  const overlap = overlapping(document.sections, bounds.start, bounds.end);
  if (overlap) return { ok: false, message: `That range overlaps ${overlap.name}.` };

  const section: SongSection = {
    id: randomId(),
    name: freshName(document.sections, input.name),
    type: input.type ?? null,
    startTime: bounds.start,
    endTime: bounds.end,
    userIntent: null,
    source: "manual",
    confidence: null,
    structuralGroupId: null,
  };
  return {
    ok: true,
    document: {
      ...document,
      sections: insertByStart(document.sections, section),
      uiState: { ...document.uiState, selectedSectionId: section.id },
    },
  };
}

export function updateSection(
  document: ProjectDocument,
  sectionId: string,
  patch: Partial<Pick<SongSection, "name" | "type" | "startTime" | "endTime" | "userIntent">>,
): SectionEditResult {
  const current = document.sections.find((section) => section.id === sectionId);
  if (!current) return { ok: false, message: "That section is no longer in the project." };

  const name = patch.name === undefined ? current.name : patch.name.trim();
  if (!name) return { ok: false, message: "A section needs a name." };
  if (name.length > 120) return { ok: false, message: "Section names can be at most 120 characters." };
  const intent = patch.userIntent === undefined ? current.userIntent : normalizeIntent(patch.userIntent);
  if (typeof intent === "object" && intent && "ok" in intent) return intent;

  const bounds = boundsFor(document, patch.startTime ?? current.startTime, patch.endTime ?? current.endTime);
  if (!bounds.ok) return bounds;
  const overlap = overlapping(document.sections, bounds.start, bounds.end, sectionId);
  if (overlap) return { ok: false, message: `That range overlaps ${overlap.name}.` };

  const edited =
    patch.name !== undefined ||
    patch.type !== undefined ||
    patch.startTime !== undefined ||
    patch.endTime !== undefined ||
    patch.userIntent !== undefined;
  const next: SongSection = {
    ...current,
    name,
    type: patch.type === undefined ? current.type : patch.type,
    startTime: bounds.start,
    endTime: bounds.end,
    userIntent: intent,
    source: current.source === "automatic" && edited ? "automatic-edited" : current.source,
  };
  const rest = document.sections.filter((section) => section.id !== sectionId);
  const loop = document.uiState.loop;
  const uiState =
    loop?.sectionId === sectionId ? { ...document.uiState, loop: { ...loop, start: bounds.start, end: bounds.end } } : document.uiState;
  return { ok: true, document: { ...document, sections: insertByStart(rest, next), uiState } };
}

export function setTrackSectionState(
  document: ProjectDocument,
  trackId: string,
  sectionId: string,
  patch: { userIntent?: string | null; prominence?: TrackSectionState["prominence"] },
): SectionEditResult {
  if (!document.tracks.some((track) => track.id === trackId)) return { ok: false, message: "That track is no longer in the project." };
  if (!document.sections.some((section) => section.id === sectionId)) {
    return { ok: false, message: "That section is no longer in the project." };
  }
  const existing = document.sectionTrackSettings.find((setting) => setting.trackId === trackId && setting.sectionId === sectionId);
  const intent = patch.userIntent === undefined ? (existing?.userIntent ?? null) : normalizeIntent(patch.userIntent);
  if (typeof intent === "object" && intent && "ok" in intent) return intent;
  const prominence = patch.prominence === undefined ? (existing?.prominence ?? null) : patch.prominence;
  const next: TrackSectionState = {
    trackId,
    sectionId,
    userIntent: intent,
    prominence,
    overrides: existing?.overrides ?? { gainDb: null, pan: null },
    processing: existing?.processing ?? emptyProcessingGraph(),
  };
  const rest = document.sectionTrackSettings.filter((setting) => setting.trackId !== trackId || setting.sectionId !== sectionId);
  const keep = sectionSettingInUse(next);
  return { ok: true, document: { ...document, sectionTrackSettings: keep ? [...rest, next] : rest } };
}

/** A Track × Section row is stored only while it carries something. */
export function sectionSettingInUse(setting: TrackSectionState): boolean {
  return (
    setting.userIntent !== null ||
    setting.prominence !== null ||
    setting.overrides.gainDb !== null ||
    setting.overrides.pan !== null ||
    setting.processing.nodes.length > 0
  );
}

export interface SuggestedSection {
  startTime: number;
  endTime: number;
  suggestedName: string;
  suggestedType: string;
  confidence: number;
  structuralGroupId: string | null;
}

export function applyAutomaticSections(document: ProjectDocument, suggestions: SuggestedSection[]): SectionEditResult {
  if (suggestions.length === 0) return { ok: false, message: "The waveforms don't show a clear section change." };
  let sections = document.sections;
  let added = 0;
  for (const suggestion of suggestions) {
    const bounds = boundsFor(document, suggestion.startTime, suggestion.endTime);
    if (!bounds.ok) continue;
    if (overlapping(sections, bounds.start, bounds.end)) continue;
    const type = sectionType(suggestion.suggestedType);
    const section: SongSection = {
      id: randomId(),
      name: suggestion.suggestedName.trim().slice(0, 120) || "Section",
      type,
      startTime: bounds.start,
      endTime: bounds.end,
      userIntent: null,
      source: "automatic",
      confidence: Math.min(1, Math.max(0, suggestion.confidence)),
      structuralGroupId: suggestion.structuralGroupId,
    };
    sections = insertByStart(sections, section);
    added += 1;
  }
  if (added === 0) return { ok: false, message: "Suggestions overlap sections that are already marked." };
  return { ok: true, document: { ...document, sections } };
}

export function clearSuggestedSections(document: ProjectDocument): ProjectDocument {
  const removed = new Set(document.sections.filter((section) => section.source === "automatic").map((section) => section.id));
  if (removed.size === 0) return document;
  const loop = document.uiState.loop;
  return {
    ...document,
    sections: document.sections.filter((section) => !removed.has(section.id)),
    sectionTrackSettings: document.sectionTrackSettings.filter((setting) => !removed.has(setting.sectionId)),
    uiState: {
      ...document.uiState,
      selectedSectionId: document.uiState.selectedSectionId && removed.has(document.uiState.selectedSectionId) ? null : document.uiState.selectedSectionId,
      loop: loop?.sectionId && removed.has(loop.sectionId) ? { ...loop, sectionId: null } : loop,
    },
  };
}

export function splitSection(document: ProjectDocument, sectionId: string, time: number): SectionEditResult {
  const current = document.sections.find((section) => section.id === sectionId);
  if (!current) return { ok: false, message: "That section is no longer in the project." };
  const at = roundSeconds(time);
  if (at < current.startTime + MIN_SECTION_SECONDS || at > current.endTime - MIN_SECTION_SECONDS) {
    return { ok: false, message: "Split inside the section, leaving at least a quarter second on each side." };
  }
  const left: SongSection = {
    ...current,
    endTime: at,
    source: current.source === "automatic" ? "automatic-edited" : current.source,
  };
  const right: SongSection = {
    id: randomId(),
    name: splitName(document.sections, current.name),
    type: current.type,
    startTime: at,
    endTime: current.endTime,
    userIntent: null,
    source: "manual",
    confidence: null,
    structuralGroupId: null,
  };
  const rest = document.sections.filter((section) => section.id !== sectionId);
  const loop = document.uiState.loop;
  const uiState = loop?.sectionId === sectionId ? { ...document.uiState, loop: { ...loop, start: left.startTime, end: left.endTime } } : document.uiState;
  return { ok: true, document: { ...document, sections: insertByStart(insertByStart(rest, left), right), uiState } };
}

/**
 * One action for "mark a section here". Inside a section it splits that section at the time.
 * Otherwise it adds a section from the end of the previous section, or the song start, up to the time.
 */
export function sectionAtTime(document: ProjectDocument, time: number): SectionEditResult {
  const at = roundSeconds(time);
  const inside = document.sections.find((section) => at > section.startTime && at < section.endTime);
  if (inside) {
    const split = splitSection(document, inside.id, at);
    if (!split.ok) return split;
    const right = split.document.sections.find((section) => Math.abs(section.startTime - at) < 0.0005);
    return { ok: true, document: { ...split.document, uiState: { ...split.document.uiState, selectedSectionId: right?.id ?? inside.id } } };
  }
  const start = document.sections.reduce((latest, section) => (section.endTime <= at + 0.0005 ? Math.max(latest, section.endTime) : latest), 0);
  if (at - start < MIN_SECTION_SECONDS) {
    return { ok: false, message: "Move the playhead at least a quarter second past the start of the song or the previous section." };
  }
  return addManualSection(document, { startTime: start, endTime: at });
}

export function mergeSectionWithNext(document: ProjectDocument, sectionId: string): SectionEditResult {
  const ordered = [...document.sections].sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
  const index = ordered.findIndex((section) => section.id === sectionId);
  const current = ordered[index];
  const following = index >= 0 ? ordered[index + 1] : undefined;
  if (!current) return { ok: false, message: "That section is no longer in the project." };
  if (!following) return { ok: false, message: "There is no following section to merge." };
  if (Math.abs(following.startTime - current.endTime) > 0.001) {
    return { ok: false, message: "The next section has to start where this one ends." };
  }
  const merged: SongSection = {
    ...current,
    endTime: following.endTime,
    type: current.type ?? following.type,
    userIntent: current.userIntent ?? following.userIntent,
    source: current.source === "automatic" ? "automatic-edited" : current.source,
  };
  const keptTracks = new Set(
    document.sectionTrackSettings.filter((setting) => setting.sectionId === current.id).map((setting) => setting.trackId),
  );
  const carried = document.sectionTrackSettings
    .filter((setting) => setting.sectionId === following.id && !keptTracks.has(setting.trackId))
    .map((setting) => ({ ...setting, sectionId: current.id }));
  const loop = document.uiState.loop;
  const loopFollows = loop?.sectionId === current.id || loop?.sectionId === following.id;
  return {
    ok: true,
    document: {
      ...document,
      sections: ordered.filter((section) => section.id !== following.id).map((section) => (section.id === current.id ? merged : section)),
      sectionTrackSettings: [
        ...document.sectionTrackSettings.filter((setting) => setting.sectionId !== following.id),
        ...carried,
      ],
      uiState: {
        ...document.uiState,
        selectedSectionId: document.uiState.selectedSectionId === following.id ? current.id : document.uiState.selectedSectionId,
        loop: loopFollows && loop ? { ...loop, sectionId: current.id, start: merged.startTime, end: merged.endTime } : loop,
      },
    },
  };
}

const MIN_SECTION_SECONDS = 0.25;

export function moveSectionBoundary(document: ProjectDocument, fromTime: number, toTime: number): SectionEditResult {
  const times = boundaryTimes(document.sections);
  const index = times.findIndex((time) => Math.abs(time - fromTime) < 0.0005);
  if (index < 0) return { ok: false, message: "That guide is no longer on the timeline." };
  const from = times[index]!;
  let lower = 0;
  let upper = document.project.durationSeconds;
  for (const section of document.sections) {
    if (Math.abs(section.endTime - from) < 0.0005) lower = Math.max(lower, section.startTime + MIN_SECTION_SECONDS);
    if (Math.abs(section.startTime - from) < 0.0005) upper = Math.min(upper, section.endTime - MIN_SECTION_SECONDS);
  }
  if (index > 0) lower = Math.max(lower, times[index - 1]!);
  if (index < times.length - 1) upper = Math.min(upper, times[index + 1]!);
  if (lower > upper) return { ok: true, document, time: from };
  const next = roundSeconds(Math.min(upper, Math.max(lower, toTime)));
  if (Math.abs(next - from) < 0.0005) return { ok: true, document, time: from };

  const sections = document.sections.map((section) => {
    const startTime = Math.abs(section.startTime - from) < 0.0005 ? next : section.startTime;
    const endTime = Math.abs(section.endTime - from) < 0.0005 ? next : section.endTime;
    const moved = startTime !== section.startTime || endTime !== section.endTime;
    return {
      ...section,
      startTime,
      endTime,
      source: section.source === "automatic" && moved ? ("automatic-edited" as const) : section.source,
    };
  });
  sections.sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
  const loop = document.uiState.loop;
  const looped = loop?.sectionId ? sections.find((section) => section.id === loop.sectionId) : undefined;
  return {
    ok: true,
    time: next,
    document: {
      ...document,
      sections,
      uiState: looped ? { ...document.uiState, loop: { ...loop!, start: looped.startTime, end: looped.endTime } } : document.uiState,
    },
  };
}

function boundaryTimes(sections: SongSection[]): number[] {
  const times = new Set<number>();
  for (const section of sections) {
    times.add(section.startTime);
    times.add(section.endTime);
  }
  return [...times].sort((left, right) => left - right);
}

export function removeSection(document: ProjectDocument, sectionId: string): ProjectDocument {
  const loop = document.uiState.loop;
  return {
    ...document,
    sections: document.sections.filter((section) => section.id !== sectionId),
    sectionTrackSettings: document.sectionTrackSettings.filter((setting) => setting.sectionId !== sectionId),
    uiState: {
      ...document.uiState,
      selectedSectionId: document.uiState.selectedSectionId === sectionId ? null : document.uiState.selectedSectionId,
      loop: loop?.sectionId === sectionId ? { ...loop, sectionId: null } : loop,
    },
  };
}

function boundsFor(
  document: ProjectDocument,
  startTime: number,
  endTime: number,
): { ok: true; start: number; end: number } | { ok: false; message: string } {
  const duration = document.project.durationSeconds;
  const start = roundSeconds(Math.min(duration, Math.max(0, startTime)));
  const end = roundSeconds(Math.min(duration, Math.max(0, endTime)));
  if (!(end > start)) return { ok: false, message: "A section needs a duration." };
  return { ok: true, start, end };
}

function overlapping(sections: SongSection[], start: number, end: number, ignoreId?: string): SongSection | undefined {
  return sections.find((section) => section.id !== ignoreId && start < section.endTime && end > section.startTime);
}

function insertByStart(sections: SongSection[], section: SongSection): SongSection[] {
  const next = [...sections, section];
  next.sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
  return next;
}

function splitName(sections: SongSection[], name: string): string {
  const base = name.trim().slice(0, 110) || "Section";
  const candidate = `${base} 2`;
  if (!sections.some((section) => section.name === candidate)) return candidate.slice(0, 120);
  return freshName(sections);
}

function freshName(sections: SongSection[], requested?: string): string {
  const trimmed = requested?.trim();
  if (trimmed) return trimmed.slice(0, 120);
  const used = new Set(sections.map((section) => section.name));
  if (!used.has("Section")) return "Section";
  for (let index = 2; index < 1000; index += 1) {
    const name = `Section ${index}`;
    if (!used.has(name)) return name;
  }
  return "Section";
}

function normalizeIntent(value: string | null): string | null | { ok: false; message: string } {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 8_000) return { ok: false, message: "Intent can be at most 8000 characters." };
  return trimmed;
}

function sectionType(value: string): SectionType | null {
  return SECTION_TYPES.find((type) => type === value) ?? null;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function randomId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!cryptoApi?.randomUUID) {
    throw new Error("crypto.randomUUID is unavailable.");
  }
  return cryptoApi.randomUUID();
}
