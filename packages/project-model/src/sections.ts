import { SECTION_TYPES, emptyProcessingGraph, type ProjectDocument, type SectionType, type SongSection, type TrackSectionState } from "./schema";

export type SectionEditResult = { ok: true; document: ProjectDocument } | { ok: false; message: string };

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
  const keep = next.userIntent !== null || next.prominence !== null || next.overrides.gainDb !== null || next.overrides.pan !== null;
  return { ok: true, document: { ...document, sectionTrackSettings: keep ? [...rest, next] : rest } };
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
