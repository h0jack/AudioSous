import {
  DYNAMICS_LIMITS,
  DYNAMICS_NODE_LABELS,
  DYNAMICS_NODE_TYPES,
  MAX_SECTION_DYNAMICS,
  MAX_TRACK_DYNAMICS,
  emptyProcessingGraph,
  keyCycle,
  type DynamicsNode,
  type DynamicsNodeType,
  type ProjectDocument,
  type SongSection,
  type Track,
  type TrackSectionState,
} from "./schema";
import { roundFrequency } from "./processing";
import { sectionSettingInUse, type SectionEditResult } from "./sections";

/**
 * The per-track processing order. It is fixed by stage, never by where a node sits in a list:
 *
 *   source → static EQ (track, then section) → dynamic EQ → compressor → transient → ducking
 *          → width → pan / balance → gain → mix
 *
 * Inside one stage, the track's own nodes run first, then the nodes of the section under the playhead. A section
 * node is added; it never replaces or bypasses a track node.
 *
 * - Dynamic EQ comes first so a band that only dips while a lead plays is taken out before the compressor reacts
 *   to it.
 * - The compressor sees the stem after its EQ, as you would set one by ear.
 * - Ducking is last, so a compressor never "undoes" a duck by recovering gain underneath it.
 * - Every sidechain key is the key track's own source (mono, before its EQ, dynamics, fader, mute, and solo),
 *   read for the same frame before any track is processed. No result depends on track order, and a fader or
 *   EQ move on the key track never changes when the target ducks.
 */
export const DYNAMICS_STAGE_ORDER: readonly DynamicsNodeType[] = DYNAMICS_NODE_TYPES;

export function trackDynamicsNodes(document: ProjectDocument, trackId: string): DynamicsNode[] {
  return document.tracks.find((track) => track.id === trackId)?.processing.dynamics ?? [];
}

export function sectionDynamicsNodes(document: ProjectDocument, trackId: string, sectionId: string): DynamicsNode[] {
  return document.sectionTrackSettings.find((row) => row.trackId === trackId && row.sectionId === sectionId)?.processing.dynamics ?? [];
}

/** Enabled nodes in processing order. Track nodes come before section nodes inside each stage. */
export function orderDynamics(track: readonly DynamicsNode[], section: readonly DynamicsNode[] = []): DynamicsNode[] {
  const out: DynamicsNode[] = [];
  for (const stage of DYNAMICS_STAGE_ORDER) {
    for (const node of track) if (node.enabled && node.type === stage) out.push(node);
    for (const node of section) if (node.enabled && node.type === stage) out.push(node);
  }
  return out;
}

/** The dynamics that run on a track for the whole of one section (or outside every section, for null). */
export function dynamicsChainForSection(document: ProjectDocument, trackId: string, sectionId: string | null): DynamicsNode[] {
  return orderDynamics(trackDynamicsNodes(document, trackId), sectionId ? sectionDynamicsNodes(document, trackId, sectionId) : []);
}

export function dynamicsChainAt(document: ProjectDocument, trackId: string, seconds: number): DynamicsNode[] {
  return dynamicsChainForSection(document, trackId, sectionAt(document.sections, seconds)?.id ?? null);
}

export function hasSavedDynamics(document: ProjectDocument, trackId: string): boolean {
  return (
    trackDynamicsNodes(document, trackId).some((node) => node.enabled) ||
    document.sectionTrackSettings.some((row) => row.trackId === trackId && row.processing.dynamics.some((node) => node.enabled))
  );
}

/** Clamped to the stored bounds and rounded to what the editor shows. */
export function normalizeDynamicsNode<T extends DynamicsNode>(node: T): T {
  const L = DYNAMICS_LIMITS;
  const threshold = (value: number) => round(clamp(finiteOr(value, -20), L.minThresholdDb, L.maxThresholdDb), 10);
  const attack = (value: number) => roundMs(clamp(finiteOr(value, 10), L.minAttackMs, L.maxAttackMs));
  const release = (value: number) => roundMs(clamp(finiteOr(value, 120), L.minReleaseMs, L.maxReleaseMs));
  const range = (value: number) => round(clamp(finiteOr(value, -2), L.minRangeDb, L.maxRangeDb), 10);
  switch (node.type) {
    case "compressor":
      return {
        ...node,
        thresholdDb: threshold(node.thresholdDb),
        ratio: round(clamp(finiteOr(node.ratio, 2), L.minRatio, L.maxRatio), 10),
        attackMs: attack(node.attackMs),
        releaseMs: release(node.releaseMs),
        kneeDb: round(clamp(finiteOr(node.kneeDb, 6), L.minKneeDb, L.maxKneeDb), 10),
        makeupDb: round(clamp(finiteOr(node.makeupDb, 0), L.minMakeupDb, L.maxMakeupDb), 10),
      };
    case "ducking":
      return { ...node, thresholdDb: threshold(node.thresholdDb), rangeDb: range(node.rangeDb), attackMs: attack(node.attackMs), releaseMs: release(node.releaseMs) };
    case "transient":
      return {
        ...node,
        attack: round(clamp(finiteOr(node.attack, 0), -L.maxTransientAttack, L.maxTransientAttack), 100),
        sustain: round(clamp(finiteOr(node.sustain, 0), -L.maxTransientSustain, L.maxTransientSustain), 100),
      };
    case "dynamic-eq":
      return {
        ...node,
        filter: {
          kind: "bell",
          frequencyHz: roundFrequency(clamp(finiteOr(node.filter.frequencyHz, 1_000), L.minHz, L.maxHz)),
          q: round(clamp(finiteOr(node.filter.q, 1), L.minQ, L.maxQ), 100),
        },
        thresholdDb: threshold(node.thresholdDb),
        rangeDb: range(node.rangeDb),
        attackMs: attack(node.attackMs),
        releaseMs: release(node.releaseMs),
      };
  }
}

export function setTrackDynamicsNodes(document: ProjectDocument, trackId: string, nodes: DynamicsNode[]): SectionEditResult {
  const track = document.tracks.find((item) => item.id === trackId);
  if (!track) return { ok: false, message: "That track is no longer in the project." };
  const checked = checkNodes(document, trackId, nodes, MAX_TRACK_DYNAMICS, track.processing.nodes.map((node) => node.id));
  if (!checked.ok) return checked;
  const next = { ...document, tracks: document.tracks.map((item) => (item.id === trackId ? { ...item, processing: { ...item.processing, dynamics: checked.nodes } } : item)) };
  return routingOk(next);
}

export function setSectionDynamicsNodes(document: ProjectDocument, trackId: string, sectionId: string, nodes: DynamicsNode[]): SectionEditResult {
  if (!document.tracks.some((track) => track.id === trackId)) return { ok: false, message: "That track is no longer in the project." };
  if (!document.sections.some((section) => section.id === sectionId)) return { ok: false, message: "That section is no longer in the project." };
  const existing = document.sectionTrackSettings.find((row) => row.trackId === trackId && row.sectionId === sectionId);
  const checked = checkNodes(document, trackId, nodes, MAX_SECTION_DYNAMICS, existing?.processing.nodes.map((node) => node.id) ?? []);
  if (!checked.ok) return checked;
  const next: TrackSectionState = {
    trackId,
    sectionId,
    userIntent: existing?.userIntent ?? null,
    prominence: existing?.prominence ?? null,
    overrides: existing?.overrides ?? { gainDb: null, pan: null, width: null },
    processing: { ...(existing?.processing ?? emptyProcessingGraph()), dynamics: checked.nodes },
  };
  const rest = document.sectionTrackSettings.filter((row) => row.trackId !== trackId || row.sectionId !== sectionId);
  return routingOk({ ...document, sectionTrackSettings: sectionSettingInUse(next) ? [...rest, next] : rest });
}

export interface KeyRoutingIssue {
  trackId: string;
  sectionId: string | null;
  nodeId: string;
  problem: "self" | "missing" | "cycle";
}

/**
 * Sidechain routes that cannot run. A missing key track leaves its node inert (it is skipped, not guessed);
 * self-keys and loops are rejected by the schema and by the setters, so they only appear in hand-edited files.
 */
export function keyRoutingIssues(document: ProjectDocument): KeyRoutingIssue[] {
  const ids = new Set(document.tracks.map((track) => track.id));
  const out: KeyRoutingIssue[] = [];
  const scan = (trackId: string, sectionId: string | null, nodes: DynamicsNode[]) => {
    for (const node of nodes) {
      const key = keyOf(node);
      if (!key) continue;
      if (key === trackId) out.push({ trackId, sectionId, nodeId: node.id, problem: "self" });
      else if (!ids.has(key)) out.push({ trackId, sectionId, nodeId: node.id, problem: "missing" });
    }
  };
  for (const track of document.tracks) scan(track.id, null, track.processing.dynamics);
  for (const row of document.sectionTrackSettings) scan(row.trackId, row.sectionId, row.processing.dynamics);
  if (keyCycle(keyEdges(document))) {
    for (const track of document.tracks) for (const node of track.processing.dynamics) if (keyOf(node)) out.push({ trackId: track.id, sectionId: null, nodeId: node.id, problem: "cycle" });
  }
  return out;
}

/** A node the engine can run: enabled, and its key (if any) is another track in the project. */
export function dynamicsNodeRunnable(document: ProjectDocument, trackId: string, node: DynamicsNode): boolean {
  if (!node.enabled) return false;
  const key = keyOf(node);
  return key === null || (key !== trackId && document.tracks.some((track) => track.id === key));
}

export function keyOf(node: DynamicsNode): string | null {
  return node.type === "ducking" || node.type === "dynamic-eq" ? node.keyTrackId : null;
}

/** Everything about saved dynamics that changes what a planner would hear, in a stable order. */
export function dynamicsIdentity(document: ProjectDocument): unknown {
  const node = (item: DynamicsNode) =>
    Object.entries(item)
      .filter(([key]) => key !== "note" && key !== "origin")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, typeof value === "object" && value !== null ? JSON.stringify(value) : value]);
  return {
    tracks: document.tracks.map((track) => [track.id, track.processing.dynamics.map(node)]),
    sections: [...document.sectionTrackSettings]
      .filter((row) => row.processing.dynamics.length > 0)
      .sort((left, right) => `${left.trackId}:${left.sectionId}`.localeCompare(`${right.trackId}:${right.sectionId}`))
      .map((row) => [row.trackId, row.sectionId, row.processing.dynamics.map(node)]),
  };
}

/** "Compressor 2.2:1 at −18 dB", "Duck from Kick, up to −2.0 dB", "Dynamic EQ 2.4 kHz, up to −1.8 dB". */
export function describeDynamicsNode(node: DynamicsNode, tracks: readonly Track[] = []): string {
  const name = (id: string | null) => (id ? (tracks.find((track) => track.id === id)?.name ?? id) : "its own signal");
  switch (node.type) {
    case "compressor":
      return `Compressor ${node.ratio.toFixed(1)}:1 at ${signed(node.thresholdDb)} dB, ${trimMs(node.attackMs)}/${trimMs(node.releaseMs)} ms`;
    case "ducking":
      return `Duck from ${name(node.keyTrackId)}, up to ${signed(node.rangeDb)} dB`;
    case "transient":
      return `Transient attack ${percent(node.attack)}, sustain ${percent(node.sustain)}`;
    case "dynamic-eq":
      return `Dynamic EQ ${hz(node.filter.frequencyHz)}, up to ${signed(node.rangeDb)} dB, keyed from ${name(node.keyTrackId)}`;
  }
}

export function dynamicsNodeLabel(type: DynamicsNodeType): string {
  return DYNAMICS_NODE_LABELS[type];
}

function checkNodes(
  document: ProjectDocument,
  trackId: string,
  nodes: DynamicsNode[],
  limits: Record<DynamicsNodeType, number>,
  eqIds: string[],
): { ok: true; nodes: DynamicsNode[] } | { ok: false; message: string } {
  for (const type of DYNAMICS_NODE_TYPES) {
    if (nodes.filter((node) => node.type === type).length > limits[type]) {
      return { ok: false, message: `This graph holds up to ${limits[type]} ${DYNAMICS_NODE_LABELS[type]} ${limits[type] === 1 ? "node" : "nodes"}.` };
    }
  }
  const ids = new Set(eqIds);
  for (const node of nodes) {
    if (ids.has(node.id)) return { ok: false, message: "Two processing nodes share an id." };
    ids.add(node.id);
    const key = keyOf(node);
    if (key === trackId) return { ok: false, message: "A sidechain key cannot be the track itself." };
    if (key && !document.tracks.some((track) => track.id === key)) return { ok: false, message: "The sidechain key track is not in the project." };
  }
  return { ok: true, nodes: nodes.map((node) => normalizeDynamicsNode(node)) };
}

function routingOk(document: ProjectDocument): SectionEditResult {
  if (keyCycle(keyEdges(document))) return { ok: false, message: "That sidechain would make two tracks key each other." };
  return { ok: true, document };
}

function keyEdges(document: ProjectDocument): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  const add = (from: string, node: DynamicsNode) => {
    const key = keyOf(node);
    if (!key || key === from) return;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(key);
  };
  for (const track of document.tracks) for (const node of track.processing.dynamics) add(track.id, node);
  for (const row of document.sectionTrackSettings) for (const node of row.processing.dynamics) add(row.trackId, node);
  return edges;
}

function sectionAt(sections: readonly SongSection[], seconds: number): SongSection | null {
  return sections.find((section) => seconds >= section.startTime && seconds < section.endTime) ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function round(value: number, steps: number): number {
  return Math.round(value * steps) / steps || 0;
}

/** 0.1 ms under 10 ms, whole milliseconds above. */
function roundMs(ms: number): number {
  return ms < 10 ? round(ms, 10) : Math.round(ms);
}

function signed(db: number): string {
  const value = db.toFixed(1);
  return db > 0 ? `+${value}` : value.replace("-", "−");
}

function percent(value: number): string {
  const rounded = Math.round(value * 100);
  return rounded > 0 ? `+${rounded}%` : rounded < 0 ? `−${Math.abs(rounded)}%` : "0%";
}

function trimMs(ms: number): string {
  return ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
}

function hz(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} kHz` : `${Math.round(value)} Hz`;
}
