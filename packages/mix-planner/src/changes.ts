import { describeFilter, formatHz } from "@audiosous/eq-planner";
import { describeProcessing } from "@audiosous/dynamics-planner";
import { formatSignedDb } from "@audiosous/balance-planner";
import {
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  MAX_SECTION_EQ_NODES,
  MAX_TRACK_EQ_NODES,
  emptyProcessingGraph,
  normalizeEqFilter,
  sectionDynamicsNodes,
  sectionEqNodes,
  sectionSettingInUse,
  setSectionDynamicsNodes,
  setSectionEqNodes,
  setSectionSpatial,
  setTrackDynamicsNodes,
  setTrackEqNodes,
  setTrackSpatial,
  trackDynamicsNodes,
  trackEqNodes,
  type DynamicsNode,
  type EqNode,
  type ProjectDocument,
  type TrackSectionState,
} from "@audiosous/project-model";
import type { ChangeProcessing, MixChange, MixDomain, MixScope } from "./model";

/** The parts of a change that decide what it does to a project. */
export type ChangeCore = Pick<MixChange, "id" | "trackId" | "scope" | "processing" | "replacesNodeId" | "reasons">;

export interface ApplyResult {
  document: ProjectDocument;
  failures: Array<{ changeId: string; message: string }>;
}

/** The node id a change writes. Stable, so a later pass that edits the node can be traced back to the change. */
export function nodeIdFor(change: Pick<MixChange, "id">): string {
  return `fm-${fnv1a(change.id)}`;
}

/**
 * Writes changes into a project as the existing representations: faders and Track × Section gain, static EQ
 * nodes, pan and width, and dynamics nodes. Gains are absolute and applied after everything else, then the trim.
 * A change that cannot be stored is reported, never dropped silently.
 */
export function applyChanges(document: ProjectDocument, changes: readonly ChangeCore[]): ApplyResult {
  let next = document;
  const failures: ApplyResult["failures"] = [];
  const used = usedNodeIds(document);
  const idFor = (change: ChangeCore) => {
    let id = nodeIdFor(change);
    for (let attempt = 1; used.has(id); attempt += 1) id = `fm-${fnv1a(`${change.id}#${attempt}`)}`;
    used.add(id);
    return id;
  };
  const ordered = [...changes].sort((left, right) => order(left) - order(right));
  for (const change of ordered) {
    const note = change.reasons[0]!.slice(0, 400);
    const processing = change.processing;
    let result: { ok: true; document: ProjectDocument } | { ok: false; message: string };
    switch (processing.type) {
      case "gain":
        result = { ok: true, document: setGain(next, change.trackId, change.scope, processing.gainDb) };
        break;
      case "trim":
        result = { ok: true, document: addTrim(next, processing.gainDb) };
        break;
      case "eq": {
        const node: EqNode = { id: idFor(change), type: "eq", enabled: true, filter: normalizeEqFilter(processing.filter), origin: "eq-plan", note };
        if (change.scope.type === "global") {
          const nodes = replaceNode(trackEqNodes(next, change.trackId), node, change.replacesNodeId);
          result = nodes.length > MAX_TRACK_EQ_NODES ? { ok: false, message: `${MAX_TRACK_EQ_NODES} filters are already on this track.` } : setTrackEqNodes(next, change.trackId, nodes);
        } else {
          const nodes = replaceNode(sectionEqNodes(next, change.trackId, change.scope.sectionId), node, change.replacesNodeId);
          result = nodes.length > MAX_SECTION_EQ_NODES ? { ok: false, message: `${MAX_SECTION_EQ_NODES} filters are already on this track in this section.` } : setSectionEqNodes(next, change.trackId, change.scope.sectionId, nodes);
        }
        break;
      }
      case "spatial": {
        const patch: { pan?: number; width?: number } = {};
        if (processing.pan !== null) patch.pan = processing.pan;
        if (processing.width !== null) patch.width = processing.width;
        result = change.scope.type === "global" ? setTrackSpatial(next, change.trackId, patch) : setSectionSpatial(next, change.trackId, change.scope.sectionId, patch);
        break;
      }
      case "dynamics": {
        const node = { ...processing.processing, id: idFor(change), enabled: true, origin: "dynamics-plan", note } as DynamicsNode;
        result =
          change.scope.type === "global"
            ? setTrackDynamicsNodes(next, change.trackId, replaceNode(trackDynamicsNodes(next, change.trackId), node, change.replacesNodeId))
            : setSectionDynamicsNodes(next, change.trackId, change.scope.sectionId, replaceNode(sectionDynamicsNodes(next, change.trackId, change.scope.sectionId), node, change.replacesNodeId));
        break;
      }
    }
    if (result.ok) next = result.document;
    else failures.push({ changeId: change.id, message: result.message });
  }
  return { document: next, failures };
}

/** Gain changes go last (they are absolute), the trim after them (it is relative to every fader). */
function order(change: ChangeCore): number {
  if (change.processing.type === "trim") return 3;
  if (change.processing.type === "gain") return change.scope.type === "global" ? 1 : 2;
  return 0;
}

function replaceNode<T extends { id: string }>(nodes: T[], node: T, replaces: string | null): T[] {
  const at = replaces ? nodes.findIndex((item) => item.id === replaces) : -1;
  return at < 0 ? [...nodes, node] : nodes.map((item, index) => (index === at ? node : item));
}

function usedNodeIds(document: ProjectDocument): Set<string> {
  const used = new Set<string>();
  for (const track of document.tracks) for (const node of [...track.processing.nodes, ...track.processing.dynamics]) used.add(node.id);
  for (const row of document.sectionTrackSettings) for (const node of [...row.processing.nodes, ...row.processing.dynamics]) used.add(node.id);
  return used;
}

export function setGain(document: ProjectDocument, trackId: string, scope: MixScope, gainDb: number): ProjectDocument {
  const value = clampGain(gainDb);
  if (scope.type === "global") return { ...document, tracks: document.tracks.map((track) => (track.id === trackId ? { ...track, gainDb: value } : track)) };
  const existing = document.sectionTrackSettings.find((row) => row.trackId === trackId && row.sectionId === scope.sectionId);
  const track = document.tracks.find((item) => item.id === trackId);
  const next: TrackSectionState = {
    trackId,
    sectionId: scope.sectionId,
    userIntent: existing?.userIntent ?? null,
    prominence: existing?.prominence ?? null,
    overrides: { gainDb: track && Math.abs(value - track.gainDb) < 0.05 ? null : value, pan: existing?.overrides.pan ?? null, width: existing?.overrides.width ?? null },
    processing: existing?.processing ?? emptyProcessingGraph(),
  };
  const rest = document.sectionTrackSettings.filter((row) => row.trackId !== trackId || row.sectionId !== scope.sectionId);
  return { ...document, sectionTrackSettings: sectionSettingInUse(next) ? [...rest, next] : rest };
}

/** Adds `deltaDb` to a stem in one scope: the fader (and its section gains, which replace the fader there) or one section. */
export function addGain(document: ProjectDocument, trackId: string, scope: MixScope, deltaDb: number): ProjectDocument {
  if (Math.abs(deltaDb) < 0.005) return document;
  const track = document.tracks.find((item) => item.id === trackId);
  if (!track) return document;
  if (scope.type === "section") {
    const existing = document.sectionTrackSettings.find((row) => row.trackId === trackId && row.sectionId === scope.sectionId);
    return setGain(document, trackId, scope, (existing?.overrides.gainDb ?? track.gainDb) + deltaDb);
  }
  return {
    ...document,
    tracks: document.tracks.map((item) => (item.id === trackId ? { ...item, gainDb: clampGain(item.gainDb + deltaDb) } : item)),
    sectionTrackSettings: document.sectionTrackSettings.map((row) =>
      row.trackId === trackId && row.overrides.gainDb !== null ? { ...row, overrides: { ...row.overrides, gainDb: clampGain(row.overrides.gainDb + deltaDb) } } : row,
    ),
  };
}

export function addTrim(document: ProjectDocument, trimDb: number): ProjectDocument {
  if (Math.abs(trimDb) < 0.005) return document;
  return {
    ...document,
    tracks: document.tracks.map((track) => ({ ...track, gainDb: clampGain(track.gainDb + trimDb) })),
    sectionTrackSettings: document.sectionTrackSettings.map((row) => (row.overrides.gainDb === null ? row : { ...row, overrides: { ...row.overrides, gainDb: clampGain(row.overrides.gainDb + trimDb) } })),
  };
}

/* ------------------------------------------------------------------ words */

export function domainOf(processing: ChangeProcessing): MixDomain {
  switch (processing.type) {
    case "gain":
      return "gain";
    case "trim":
      return "trim";
    case "eq":
      return "eq";
    case "spatial":
      return "space";
    case "dynamics":
      return "dynamics";
  }
}

/** "Gain −1.0 dB", "Bell −1.2 dB at 2.4 kHz, Q 1.0", "Width 130% → 112%", "Duck from Kick, up to −1.4 dB". */
export function describeChange(processing: ChangeProcessing, trackName: (id: string) => string, current?: { pan: number; width: number }): string {
  switch (processing.type) {
    case "gain":
      return `Gain ${formatSignedDb(processing.deltaDb)} dB (to ${formatSignedDb(processing.gainDb)} dB)`;
    case "trim":
      return `Safety trim ${formatSignedDb(processing.gainDb)} dB on every stem`;
    case "eq":
      return describeFilter(processing.filter);
    case "spatial": {
      const parts: string[] = [];
      if (processing.width !== null) parts.push(`Width ${current ? `${Math.round(current.width * 100)}% → ` : ""}${Math.round(processing.width * 100)}%`);
      if (processing.pan !== null) parts.push(`${panWords(processing.pan)}${current && Math.abs(current.pan - processing.pan) >= 0.005 ? ` (was ${panWords(current.pan)})` : ""}`);
      return parts.join(", ") || "Pan and width unchanged";
    }
    case "dynamics": {
      const label = processing.processing.type === "compressor" ? "Compressor" : processing.processing.type === "ducking" ? "Duck" : processing.processing.type === "transient" ? "Transient" : "Dynamic EQ";
      return `${label} ${describeProcessing(processing.processing, trackName)}`;
    }
  }
}

/** The short processor name for summaries and counts. */
export function processorKind(processing: ChangeProcessing): "gain" | "eq" | "space" | "compressor" | "ducking" | "transient" | "dynamicEq" | "trim" {
  if (processing.type === "dynamics") {
    const type = processing.processing.type;
    return type === "dynamic-eq" ? "dynamicEq" : type;
  }
  if (processing.type === "spatial") return "space";
  return processing.type;
}

export function panWords(pan: number): string {
  if (Math.abs(pan) < 0.005) return "center";
  return `${Math.round(Math.abs(pan) * 100)}% ${pan < 0 ? "left" : "right"}`;
}

export { formatHz };

export function scopeKey(scope: MixScope): string {
  return scope.type === "global" ? "global" : `section:${scope.sectionId}`;
}

export function sameScope(left: MixScope, right: MixScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

export function clampGain(value: number): number {
  return Math.round(Math.min(GAIN_DB_MAX, Math.max(GAIN_DB_MIN, value)) * 100) / 100;
}

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Pan and width a spatial change starts from: from the Space planner's evidence or a reference plan's. */
export function currentSpatialOf(change: Pick<MixChange, "evidence">): { pan: number; width: number } | undefined {
  if (change.evidence.kind === "space") return change.evidence.current;
  if (change.evidence.kind === "reference") return change.evidence.current ?? undefined;
  return undefined;
}
