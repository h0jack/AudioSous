import type { ProjectDocument, SectionType, SongSection } from "./schema";

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
  patch: Partial<Pick<SongSection, "name" | "type" | "startTime" | "endTime">>,
): SectionEditResult {
  const current = document.sections.find((section) => section.id === sectionId);
  if (!current) return { ok: false, message: "That section is no longer in the project." };

  const name = patch.name === undefined ? current.name : patch.name.trim();
  if (!name) return { ok: false, message: "A section needs a name." };
  if (name.length > 120) return { ok: false, message: "Section names can be at most 120 characters." };

  const bounds = boundsFor(document, patch.startTime ?? current.startTime, patch.endTime ?? current.endTime);
  if (!bounds.ok) return bounds;
  const overlap = overlapping(document.sections, bounds.start, bounds.end, sectionId);
  if (overlap) return { ok: false, message: `That range overlaps ${overlap.name}.` };

  const edited = patch.name !== undefined || patch.type !== undefined || patch.startTime !== undefined || patch.endTime !== undefined;
  const next: SongSection = {
    ...current,
    name,
    type: patch.type === undefined ? current.type : patch.type,
    startTime: bounds.start,
    endTime: bounds.end,
    source: current.source === "automatic" && edited ? "automatic-edited" : current.source,
  };
  const rest = document.sections.filter((section) => section.id !== sectionId);
  return { ok: true, document: { ...document, sections: insertByStart(rest, next) } };
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
