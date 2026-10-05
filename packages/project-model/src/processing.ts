import {
  EQ_LIMITS,
  MAX_SECTION_EQ_NODES,
  MAX_TRACK_EQ_NODES,
  emptyProcessingGraph,
  type EqFilter,
  type EqNode,
  type ProjectDocument,
  type SongSection,
  type TrackSectionState,
} from "./schema";
import { sectionSettingInUse, type SectionEditResult } from "./sections";

/**
 * Processing inheritance, for EQ:
 *
 *   track graph (whole song)  →  Track × Section graph (inside that section only)  →  gain  →  pan
 *
 * A Track × Section node is added after the track's own nodes. It never replaces or edits them.
 * There is no section-wide graph shared by every track, and no mix-bus graph yet.
 */

export function isPassFilter(kind: EqFilter["kind"]): boolean {
  return kind === "high-pass" || kind === "low-pass";
}

/** Clamp to the stored bounds and round to the precision the UI shows. Pass filters store 0 dB. */
export function normalizeEqFilter(filter: EqFilter): EqFilter {
  const frequencyHz = clamp(Number.isFinite(filter.frequencyHz) ? filter.frequencyHz : 1_000, EQ_LIMITS.minHz, EQ_LIMITS.maxHz);
  const gainDb = isPassFilter(filter.kind) ? 0 : clamp(Number.isFinite(filter.gainDb) ? filter.gainDb : 0, EQ_LIMITS.minGainDb, EQ_LIMITS.maxGainDb);
  const q = clamp(Number.isFinite(filter.q) ? filter.q : 0.707, EQ_LIMITS.minQ, EQ_LIMITS.maxQ);
  return {
    kind: filter.kind,
    frequencyHz: roundFrequency(frequencyHz),
    gainDb: Math.round(gainDb * 10) / 10,
    q: Math.round(q * 100) / 100,
  };
}

/** Three significant figures below 10 kHz, 100 Hz steps above. 82 Hz, 2.43 kHz, 12.4 kHz. */
export function roundFrequency(hz: number): number {
  if (hz >= 10_000) return Math.round(hz / 100) * 100;
  if (hz >= 1_000) return Math.round(hz / 10) * 10;
  if (hz >= 100) return Math.round(hz);
  return Math.round(hz * 10) / 10;
}

export function enabledFilters(nodes: readonly EqNode[]): EqFilter[] {
  return nodes.filter((node) => node.enabled).map((node) => node.filter);
}

export function trackEqNodes(document: ProjectDocument, trackId: string): EqNode[] {
  return document.tracks.find((track) => track.id === trackId)?.processing.nodes ?? [];
}

export function sectionEqNodes(document: ProjectDocument, trackId: string, sectionId: string): EqNode[] {
  return document.sectionTrackSettings.find((row) => row.trackId === trackId && row.sectionId === sectionId)?.processing.nodes ?? [];
}

/** The filters that run on a track at `seconds`: track nodes, then the nodes of the section under the playhead. */
export function eqChainAt(document: ProjectDocument, trackId: string, seconds: number): EqFilter[] {
  const section = sectionAt(document.sections, seconds);
  const own = enabledFilters(trackEqNodes(document, trackId));
  if (!section) return own;
  return [...own, ...enabledFilters(sectionEqNodes(document, trackId, section.id))];
}

/** The filters that run on a track for the whole of one section. */
export function eqChainForSection(document: ProjectDocument, trackId: string, sectionId: string | null): EqFilter[] {
  const own = enabledFilters(trackEqNodes(document, trackId));
  if (!sectionId) return own;
  return [...own, ...enabledFilters(sectionEqNodes(document, trackId, sectionId))];
}

export function setTrackEqNodes(document: ProjectDocument, trackId: string, nodes: EqNode[]): SectionEditResult {
  if (!document.tracks.some((track) => track.id === trackId)) return { ok: false, message: "That track is no longer in the project." };
  if (nodes.length > MAX_TRACK_EQ_NODES) return { ok: false, message: `A track holds up to ${MAX_TRACK_EQ_NODES} filters.` };
  const checked = checkNodes(nodes);
  if (!checked.ok) return checked;
  return {
    ok: true,
    document: {
      ...document,
      tracks: document.tracks.map((track) =>
        track.id === trackId ? { ...track, processing: { schemaVersion: 1, nodes: checked.nodes } } : track,
      ),
    },
  };
}

export function setSectionEqNodes(document: ProjectDocument, trackId: string, sectionId: string, nodes: EqNode[]): SectionEditResult {
  if (!document.tracks.some((track) => track.id === trackId)) return { ok: false, message: "That track is no longer in the project." };
  if (!document.sections.some((section) => section.id === sectionId)) return { ok: false, message: "That section is no longer in the project." };
  if (nodes.length > MAX_SECTION_EQ_NODES) return { ok: false, message: `A track holds up to ${MAX_SECTION_EQ_NODES} extra filters in one section.` };
  const checked = checkNodes(nodes);
  if (!checked.ok) return checked;
  const existing = document.sectionTrackSettings.find((row) => row.trackId === trackId && row.sectionId === sectionId);
  const next: TrackSectionState = {
    trackId,
    sectionId,
    userIntent: existing?.userIntent ?? null,
    prominence: existing?.prominence ?? null,
    overrides: existing?.overrides ?? { gainDb: null, pan: null, width: null },
    processing: { ...(existing?.processing ?? emptyProcessingGraph()), nodes: checked.nodes },
  };
  const rest = document.sectionTrackSettings.filter((row) => row.trackId !== trackId || row.sectionId !== sectionId);
  return { ok: true, document: { ...document, sectionTrackSettings: sectionSettingInUse(next) ? [...rest, next] : rest } };
}

/** Everything about saved processing that changes what a planner would hear, in a stable order. */
export function processingIdentity(document: ProjectDocument): unknown {
  const node = (item: EqNode) => [item.id, item.enabled, item.filter.kind, item.filter.frequencyHz, item.filter.gainDb, item.filter.q];
  return {
    tracks: document.tracks.map((track) => [track.id, track.processing.nodes.map(node)]),
    sections: [...document.sectionTrackSettings]
      .filter((row) => row.processing.nodes.length > 0)
      .sort((left, right) => `${left.trackId}:${left.sectionId}`.localeCompare(`${right.trackId}:${right.sectionId}`))
      .map((row) => [row.trackId, row.sectionId, row.processing.nodes.map(node)]),
  };
}

function checkNodes(nodes: EqNode[]): { ok: true; nodes: EqNode[] } | { ok: false; message: string } {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) return { ok: false, message: "Two filters share an id." };
    ids.add(node.id);
  }
  return { ok: true, nodes: nodes.map((node) => ({ ...node, filter: normalizeEqFilter(node.filter) })) };
}

function sectionAt(sections: readonly SongSection[], seconds: number): SongSection | null {
  return sections.find((section) => seconds >= section.startTime && seconds < section.endTime) ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
