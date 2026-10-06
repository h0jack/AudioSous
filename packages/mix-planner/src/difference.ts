import type { EnvelopeFrames } from "@audiosous/analysis-contract";
import { decodeEnvelopeSeries } from "@audiosous/analysis-contract";
import { applyMixPlan, type MixPlan } from "@audiosous/balance-planner";
import { applyDynamicsPlan, type DynamicsEvaluation, type DynamicsPlan } from "@audiosous/dynamics-planner";
import { applyEqPlan, eqRecommendationIncluded, responseCurve, type EqEvaluation, type EqPlan } from "@audiosous/eq-planner";
import {
  eqChainForSection,
  sectionDynamicsNodes,
  sectionEqNodes,
  spatialForSection,
  trackDynamicsNodes,
  type DynamicsNode,
  type EqFilter,
  type ProjectDocument,
} from "@audiosous/project-model";
import { applySpacePlan, type SpatialEvaluation, type SpatialPlan } from "@audiosous/spatial-planner";
import type { FullMixPlan, MixProblem, MixScope } from "./model";
import { applyFullMixPlan, changeIncluded } from "./plan";

/**
 * What a candidate changes, by how much, where, and when: one normalized model for every plan (Gain, EQ, Space,
 * Dynamics, Full Mix, Auto Mix). It diffs the saved project against the candidate project the plan's own apply
 * would write, so a change that edits a saved node reads as before / after / net, never as the new node alone;
 * evidence the planners measured (dynamics reduction over time, interaction before and after) is attached from
 * the plan's rows. Every number is diagnostic, for one relationship or one stem. None of it is a quality score.
 */

export type DifferenceDomain = "gain" | "eq" | "space" | "dynamics";

export interface DifferenceScope {
  sectionId: string | null;
  /** "Song" or the section name. */
  label: string;
  startSeconds: number;
  endSeconds: number;
}

export interface GainDifference {
  trackId: string;
  name: string;
  scope: DifferenceScope;
  currentDb: number;
  candidateDb: number;
  deltaDb: number;
}

export interface CurvePoint {
  hz: number;
  db: number;
}

export interface EqDifference {
  trackId: string;
  name: string;
  scope: DifferenceScope;
  currentFilters: EqFilter[];
  candidateFilters: EqFilter[];
  current: CurvePoint[];
  candidate: CurvePoint[];
  /** Candidate minus current at each frequency: the net change, whatever nodes were added or replaced. */
  difference: CurvePoint[];
  /** Largest net change and where. */
  peakDeltaDb: number;
  peakHz: number;
  /** A saved filter in this scope was changed or removed, so the candidate filters alone would mislead. */
  replacesSaved: boolean;
  /** Interactions the plan row behind this change works on. */
  interactionIds: string[];
}

export interface SpaceDifference {
  trackId: string;
  name: string;
  scope: DifferenceScope;
  current: { pan: number; width: number };
  candidate: { pan: number; width: number };
  /** "moved right, narrower" */
  words: string;
}

export interface DynamicsDifference {
  id: string;
  trackId: string;
  name: string;
  scope: DifferenceScope;
  kind: DynamicsNode["type"];
  change: "added" | "edited" | "removed";
  /** The node in words, before and after. */
  before: string | null;
  after: string | null;
  keyTrackId: string | null;
  keyName: string | null;
  /** Gain reduction (dB ≥ 0; for a transient shaper |gain|) over time, from the planner's envelope simulation. */
  timeline: { startSeconds: number; hopSeconds: number; values: number[] } | null;
  reductionP95Db: number | null;
  reductionMaxDb: number | null;
  /** Share of the scope where it acts by more than 0.1 dB. */
  activeShare: number | null;
  /** The key stem's hits inside the timeline (seconds), for ducking and keyed dynamic EQ. */
  keyEvents: number[] | null;
  /** Dynamic EQ: the band and its deepest curve. */
  dynamicEq: { frequencyHz: number; q: number; rangeDb: number; maxCurve: CurvePoint[] } | null;
  metrics: MetricDifference[];
}

export interface InteractionDifference {
  id: string;
  /** "Lead ↔ Pad" */
  label: string;
  kind: string;
  trackIds: string[];
  before: number;
  after: number;
  /** Share of the interaction removed (0–1); negative when it grew. */
  reduction: number;
  /** What the number is: "interaction score", "competed share", "conflict". */
  measure: string;
}

export interface MetricDifference {
  label: string;
  before: number;
  after: number;
  unit: string;
  /** Which way is the improvement, if there is one: lower, higher, or neither (context). */
  better: "lower" | "higher" | "neither";
}

export interface SectionMarker {
  sectionId: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
  domains: DifferenceDomain[];
  count: number;
}

export interface MixDifference {
  gain: GainDifference[];
  /** A uniform safety trim on every fader, shown once instead of as a move on every stem. Null when none. */
  trimDb: number | null;
  /** Estimated level of each stem in the mix, current and candidate (dB), loudest first. Null without loudness. */
  hierarchy: Array<{ trackId: string; name: string; currentDb: number; candidateDb: number }> | null;
  eq: EqDifference[];
  /** The difference view's vertical range (±dB), zoomed to the largest net change and labelled as such. */
  eqDifferenceScaleDb: number;
  space: SpaceDifference[];
  dynamics: DynamicsDifference[];
  interactions: InteractionDifference[];
  metrics: MetricDifference[];
  /** Sections with section-only changes, and what kind. */
  sections: SectionMarker[];
  /** Domains changed song-wide. */
  songWide: DifferenceDomain[];
  counts: Record<DifferenceDomain, number>;
  /** True when every change is small enough to be hard to hear in isolation. */
  subtle: boolean;
}

/** What the planners measured about the changes that made the candidate, matched to the rows by stem and scope. */
export interface DifferenceEvidence {
  trackId: string;
  sectionId: string | null;
  domain: DifferenceDomain;
  dynamicsKind?: DynamicsNode["type"];
  dynamics?: DynamicsEvaluation | null;
  eq?: EqEvaluation | null;
  space?: SpatialEvaluation | null;
  /** Interactions this change works on (ids in `interactions`). */
  interactionIds?: string[];
}

export interface DifferenceInput {
  current: ProjectDocument;
  candidate: ProjectDocument;
  evidence?: DifferenceEvidence[];
  interactions?: InteractionDifference[];
  metrics?: MetricDifference[];
  /** Each stem's measured loudness at 0 dB fader (integrated LUFS or RMS), for the level hierarchy. */
  loudness?: Record<string, number | null>;
  /** Each stem's 10 ms envelope, for the key's hits under a duck. */
  envelopes?: Record<string, EnvelopeFrames | null | undefined>;
  /** A safety trim the candidate puts on every fader; a stem whose only move is the trim is not listed. */
  trimDb?: number | null;
}

const EPSILON_DB = 0.05;
const CURVE_POINTS = 96;

export function mixDifference(input: DifferenceInput): MixDifference {
  const { current, candidate } = input;
  const name = (id: string) => trackName(current, id);
  const song: DifferenceScope = { sectionId: null, label: "Song", startSeconds: 0, endSeconds: current.project.durationSeconds };
  const scopes: DifferenceScope[] = [
    song,
    ...[...current.sections]
      .sort((left, right) => left.startTime - right.startTime)
      .map((section) => ({ sectionId: section.id, label: section.name, startSeconds: section.startTime, endSeconds: section.endTime })),
  ];
  const evidence = input.evidence ?? [];
  const gain: GainDifference[] = [];
  const eq: EqDifference[] = [];
  const space: SpaceDifference[] = [];
  const dynamics: DynamicsDifference[] = [];

  for (const track of current.tracks) {
    const next = candidate.tracks.find((item) => item.id === track.id);
    if (!next) continue;
    // Gain: the fader song-wide, and a section's absolute override (it replaces the fader there).
    const trimOnly = input.trimDb ? Math.abs(next.gainDb - track.gainDb - input.trimDb) < EPSILON_DB : false;
    if (Math.abs(next.gainDb - track.gainDb) >= EPSILON_DB && !trimOnly) {
      gain.push({ trackId: track.id, name: name(track.id), scope: song, currentDb: round2(track.gainDb), candidateDb: round2(next.gainDb), deltaDb: round2(next.gainDb - track.gainDb) });
    }
    for (const scope of scopes.slice(1)) {
      const before = sectionGain(current, track.id, scope.sectionId!);
      const after = sectionGain(candidate, track.id, scope.sectionId!);
      if (before === null && after === null) continue;
      const beforeDb = before ?? track.gainDb;
      const afterDb = after ?? next.gainDb;
      const songDelta = next.gainDb - track.gainDb;
      // Only what differs from the song-wide move counts as a section change.
      if (Math.abs(afterDb - beforeDb - songDelta) < EPSILON_DB) continue;
      gain.push({ trackId: track.id, name: name(track.id), scope, currentDb: round2(beforeDb), candidateDb: round2(afterDb), deltaDb: round2(afterDb - beforeDb) });
    }

    // EQ: the chain that plays in each scope, before and after, and their difference.
    for (const scope of scopes) {
      if (scope.sectionId && JSON.stringify(sectionEqNodes(current, track.id, scope.sectionId)) === JSON.stringify(sectionEqNodes(candidate, track.id, scope.sectionId))) continue;
      const beforeFilters = eqChainForSection(current, track.id, scope.sectionId);
      const afterFilters = eqChainForSection(candidate, track.id, scope.sectionId);
      if (JSON.stringify(beforeFilters) === JSON.stringify(afterFilters)) continue;
      const before = responseCurve(beforeFilters, CURVE_POINTS);
      const after = responseCurve(afterFilters, CURVE_POINTS);
      const difference = after.map((point, index) => ({ hz: point.hz, db: round2(point.db - (before[index]?.db ?? 0)) }));
      const peak = difference.reduce((best, point) => (Math.abs(point.db) > Math.abs(best.db) ? point : best), { hz: 1_000, db: 0 });
      if (Math.abs(peak.db) < EPSILON_DB) continue;
      const savedBefore = scope.sectionId ? sectionEqNodes(current, track.id, scope.sectionId) : current.tracks.find((item) => item.id === track.id)!.processing.nodes;
      const savedAfter = scope.sectionId ? sectionEqNodes(candidate, track.id, scope.sectionId) : next.processing.nodes;
      const replacesSaved = savedBefore.some((node) => !savedAfter.some((other) => JSON.stringify(other) === JSON.stringify(node)));
      const linked = evidence.filter((item) => item.domain === "eq" && item.trackId === track.id && item.sectionId === scope.sectionId).flatMap((item) => item.interactionIds ?? []);
      eq.push({ trackId: track.id, name: name(track.id), scope, currentFilters: beforeFilters, candidateFilters: afterFilters, current: before.map(roundPoint), candidate: after.map(roundPoint), difference, peakDeltaDb: peak.db, peakHz: Math.round(peak.hz), replacesSaved, interactionIds: [...new Set(linked)] });
    }

    // Space: pan and width in each scope.
    for (const scope of scopes) {
      const before = spatialForSection(current, track.id, scope.sectionId);
      const after = spatialForSection(candidate, track.id, scope.sectionId);
      if (Math.abs(before.pan - after.pan) < 0.005 && Math.abs(before.width - after.width) < 0.005) continue;
      if (scope.sectionId) {
        const songBefore = spatialForSection(current, track.id, null);
        const songAfter = spatialForSection(candidate, track.id, null);
        // A section that only follows the song-wide move is not a section change.
        if (Math.abs(after.pan - before.pan - (songAfter.pan - songBefore.pan)) < 0.005 && Math.abs(after.width - before.width - (songAfter.width - songBefore.width)) < 0.005) continue;
      }
      space.push({ trackId: track.id, name: name(track.id), scope, current: { pan: round3(before.pan), width: round3(before.width) }, candidate: { pan: round3(after.pan), width: round3(after.width) }, words: spaceWords(before, after) });
    }

    // Dynamics: nodes added, edited, or removed in each scope.
    for (const scope of scopes) {
      const beforeNodes = scope.sectionId ? sectionDynamicsNodes(current, track.id, scope.sectionId) : trackDynamicsNodes(current, track.id);
      const afterNodes = scope.sectionId ? sectionDynamicsNodes(candidate, track.id, scope.sectionId) : trackDynamicsNodes(candidate, track.id);
      const pairs = pairNodes(beforeNodes, afterNodes);
      for (const [before, after] of pairs) {
        if (before && after && JSON.stringify({ ...before, note: "" }) === JSON.stringify({ ...after, note: "" })) continue;
        const node = (after ?? before)!;
        const proof = evidence.find((item) => item.domain === "dynamics" && item.trackId === track.id && item.sectionId === scope.sectionId && item.dynamicsKind === node.type)?.dynamics ?? null;
        dynamics.push(dynamicsRow(current, track.id, scope, before, after, proof, input.envelopes));
      }
    }
  }

  const counts: Record<DifferenceDomain, number> = { gain: gain.length, eq: eq.length, space: space.length, dynamics: dynamics.length };
  const sections: SectionMarker[] = scopes
    .slice(1)
    .map((scope) => {
      const domains: DifferenceDomain[] = [];
      const rows = [gain, eq, space, dynamics] as const;
      const keys: DifferenceDomain[] = ["gain", "eq", "space", "dynamics"];
      let count = 0;
      rows.forEach((list, index) => {
        const here = (list as Array<{ scope: DifferenceScope }>).filter((row) => row.scope.sectionId === scope.sectionId).length;
        if (here > 0) domains.push(keys[index]!);
        count += here;
      });
      return { sectionId: scope.sectionId!, name: scope.label, startSeconds: scope.startSeconds, endSeconds: scope.endSeconds, domains, count };
    })
    .filter((marker) => marker.count > 0);
  const songWide = (["gain", "eq", "space", "dynamics"] as const).filter((domain) => ({ gain, eq, space, dynamics })[domain].some((row: { scope: DifferenceScope }) => row.scope.sectionId === null) || (domain === "gain" && Boolean(input.trimDb)));
  const largestEq = eq.reduce((largest, row) => Math.max(largest, ...row.difference.map((point) => Math.abs(point.db))), 0);
  const subtle =
    gain.every((row) => Math.abs(row.deltaDb) < 1.5) &&
    eq.every((row) => Math.abs(row.peakDeltaDb) < 2) &&
    space.every((row) => Math.abs(row.candidate.pan - row.current.pan) < 0.15 && Math.abs(row.candidate.width - row.current.width) < 0.2) &&
    dynamics.every((row) => (row.reductionP95Db ?? 0) < 2);
  return {
    gain,
    trimDb: input.trimDb && Math.abs(input.trimDb) >= EPSILON_DB ? round2(input.trimDb) : null,
    hierarchy: hierarchyOf(current, candidate, input.loudness, dynamics, eq),
    eq,
    eqDifferenceScaleDb: differenceScale(largestEq),
    space,
    dynamics,
    interactions: input.interactions ?? [],
    metrics: input.metrics ?? [],
    sections,
    songWide,
    counts,
    subtle,
  };
}

/** The difference view's vertical range: the smallest of ±1, ±2, ±3, ±6, ±12 dB that holds the largest change. */
export function differenceScale(largestDb: number): number {
  for (const scale of [1, 2, 3, 6, 12]) if (largestDb <= scale * 0.92) return scale;
  return 24;
}

function sectionGain(document: ProjectDocument, trackId: string, sectionId: string): number | null {
  return document.sectionTrackSettings.find((row) => row.trackId === trackId && row.sectionId === sectionId)?.overrides.gainDb ?? null;
}

function trackName(document: ProjectDocument, id: string): string {
  const track = document.tracks.find((item) => item.id === id);
  return track?.customLabel ?? track?.name ?? id;
}

function spaceWords(before: { pan: number; width: number }, after: { pan: number; width: number }): string {
  const parts: string[] = [];
  const pan = after.pan - before.pan;
  if (Math.abs(pan) >= 0.005) parts.push(pan > 0 ? "moved right" : "moved left");
  const width = after.width - before.width;
  if (Math.abs(width) >= 0.005) parts.push(after.width === 0 ? "mono" : width > 0 ? "wider" : "narrower");
  return parts.join(", ");
}

/** Pairs saved nodes with the candidate's: by id, then by type (a planner edit keeps the type). */
function pairNodes(before: DynamicsNode[], after: DynamicsNode[]): Array<[DynamicsNode | null, DynamicsNode | null]> {
  const out: Array<[DynamicsNode | null, DynamicsNode | null]> = [];
  const left = [...after];
  for (const node of before) {
    let at = left.findIndex((other) => other.id === node.id);
    if (at === -1) at = left.findIndex((other) => other.type === node.type && keyOfNode(other) === keyOfNode(node));
    if (at === -1) out.push([node, null]);
    else out.push([node, left.splice(at, 1)[0]!]);
  }
  for (const node of left) out.push([null, node]);
  return out;
}

function keyOfNode(node: DynamicsNode): string | null {
  return node.type === "ducking" || node.type === "dynamic-eq" ? (node.keyTrackId ?? null) : null;
}

function describeNode(node: DynamicsNode | null, name: (id: string) => string): string | null {
  if (!node) return null;
  switch (node.type) {
    case "compressor":
      return `Compressor ${node.ratio.toFixed(1)}:1 at ${node.thresholdDb.toFixed(1)} dB, attack ${node.attackMs.toFixed(0)} ms, release ${node.releaseMs.toFixed(0)} ms`;
    case "ducking":
      return `Duck up to ${node.rangeDb.toFixed(1)} dB from ${name(node.keyTrackId)}, release ${node.releaseMs.toFixed(0)} ms`;
    case "transient":
      return `Attack ${signedPercent(node.attack)}, sustain ${signedPercent(node.sustain)}`;
    case "dynamic-eq":
      return `Dynamic EQ ${formatHz(node.filter.frequencyHz)}, 0 to ${node.rangeDb.toFixed(1)} dB${node.keyTrackId ? ` when ${name(node.keyTrackId)} plays` : ""}`;
  }
}

function dynamicsRow(document: ProjectDocument, trackId: string, scope: DifferenceScope, before: DynamicsNode | null, after: DynamicsNode | null, proof: DynamicsEvaluation | null, envelopes: DifferenceInput["envelopes"]): DynamicsDifference {
  const node = (after ?? before)!;
  const name = (id: string) => trackName(document, id);
  const keyTrackId = keyOfNode(node);
  const timeline = proof?.timeline && proof.timeline.values.length > 0 ? { startSeconds: proof.timeline.startSeconds, hopSeconds: proof.timeline.hopSeconds, values: proof.timeline.values.map(round2) } : null;
  const activeShare = timeline ? round3(timeline.values.filter((value) => Math.abs(value) > 0.1).length / timeline.values.length) : null;
  const keyEvents = keyTrackId && timeline ? keyHits(envelopes?.[keyTrackId] ?? null, timeline.startSeconds, timeline.startSeconds + timeline.hopSeconds * timeline.values.length) : null;
  const metrics: MetricDifference[] = [];
  if (proof) {
    const add = (label: string, a: number | null, b: number | null, unit: string, better: MetricDifference["better"]) => {
      if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b)) metrics.push({ label, before: round2(a), after: round2(b), unit, better });
    };
    add(`${name(trackId)} sustained-level variation`, proof.spreadBeforeDb, proof.spreadAfterDb, "dB", "lower");
    add(`${name(trackId)} crest`, proof.crestBeforeDb, proof.crestAfterDb, "dB", "neither");
    if (keyTrackId) add(`${name(trackId)} over ${name(keyTrackId)} where they meet`, proof.conflictBeforeDb, proof.conflictAfterDb, "dB", "lower");
    if (keyTrackId) add(`${name(keyTrackId)}/${name(trackId)} hit collision`, proof.collisionBefore, proof.collisionAfter, "", "lower");
    add(`${name(trackId)} attack over body`, proof.transientBeforeDb, proof.transientAfterDb, "dB", "neither");
  }
  const dynamicEq =
    after?.type === "dynamic-eq"
      ? { frequencyHz: after.filter.frequencyHz, q: after.filter.q, rangeDb: after.rangeDb, maxCurve: responseCurve([{ kind: "bell", frequencyHz: after.filter.frequencyHz, gainDb: after.rangeDb, q: after.filter.q }], CURVE_POINTS).map(roundPoint) }
      : null;
  return {
    id: `${trackId}:${scope.sectionId ?? "song"}:${node.type}:${node.id}`,
    trackId,
    name: name(trackId),
    scope,
    kind: node.type,
    change: before && after ? "edited" : after ? "added" : "removed",
    before: describeNode(before, name),
    after: describeNode(after, name),
    keyTrackId,
    keyName: keyTrackId ? name(keyTrackId) : null,
    timeline,
    reductionP95Db: proof ? round2(proof.reductionP95Db) : null,
    reductionMaxDb: proof ? round2(proof.reductionMaxDb) : null,
    activeShare,
    keyEvents,
    dynamicEq,
    metrics,
  };
}

/** The key's hits between `from` and `to`: a 10 ms peak rising 6 dB over the previous 50 ms, at least 80 ms apart. */
export function keyHits(envelope: EnvelopeFrames | null, from: number, to: number, limit = 400): number[] | null {
  if (!envelope) return null;
  const peak = decodeEnvelopeSeries(envelope.peak);
  const hop = envelope.hopSeconds;
  const out: number[] = [];
  const start = Math.max(5, Math.floor(from / hop));
  const end = Math.min(peak.length, Math.ceil(to / hop));
  let last = -Infinity;
  for (let frame = start; frame < end && out.length < limit; frame += 1) {
    let floor = Infinity;
    for (let back = 1; back <= 5; back += 1) floor = Math.min(floor, peak[frame - back]!);
    const time = frame * hop;
    if (peak[frame]! > -60 && peak[frame]! - floor >= 6 && time - last >= 0.08) {
      out.push(round3(time));
      last = time;
    }
  }
  return out;
}

function hierarchyOf(current: ProjectDocument, candidate: ProjectDocument, loudness: DifferenceInput["loudness"], dynamics: DynamicsDifference[], eq: EqDifference[]): MixDifference["hierarchy"] {
  if (!loudness) return null;
  const rows = current.tracks
    .filter((track) => !track.muted && loudness[track.id] !== null && loudness[track.id] !== undefined)
    .map((track) => {
      const next = candidate.tracks.find((item) => item.id === track.id) ?? track;
      // EQ and dynamics change the level a little too; a static cut is read as its average dip, a compressor as nothing here.
      const eqShift = eq.filter((row) => row.trackId === track.id && row.scope.sectionId === null).reduce((sum, row) => sum + average(row.difference.map((point) => point.db)) * 0.3, 0);
      void dynamics;
      return { trackId: track.id, name: trackName(current, track.id), currentDb: round2(loudness[track.id]! + track.gainDb), candidateDb: round2(loudness[track.id]! + next.gainDb + eqShift) };
    });
  return rows.sort((left, right) => right.currentDb - left.currentDb);
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(Math.round(value * 100))}%`;
}

function formatHz(hz: number): string {
  return hz >= 1_000 ? `${(hz / 1_000).toFixed(hz >= 10_000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`;
}

function roundPoint(point: CurvePoint): CurvePoint {
  return { hz: Math.round(point.hz * 10) / 10, db: round2(point.db) };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The relationship an EQ change was planned for: an interaction its plan row names, a pair before a single stem;
 * otherwise any pair the stem is in.
 */
export function interactionFor(diff: Pick<MixDifference, "interactions">, row: Pick<EqDifference, "trackId" | "interactionIds">): InteractionDifference | null {
  const linked = diff.interactions.filter((item) => row.interactionIds.includes(item.id));
  const pairs = (list: InteractionDifference[]) => list.filter((item) => item.trackIds.length > 1);
  return pairs(linked)[0] ?? linked[0] ?? pairs(diff.interactions.filter((item) => item.trackIds.includes(row.trackId)))[0] ?? null;
}

/* ------------------------------------------------------------------ explanation */

/** A plain-language line for one change: what moved, by how much, where, and what it measurably did. */
export function explainEq(row: EqDifference, interaction: InteractionDifference | null): string {
  const size = Math.abs(row.peakDeltaDb);
  const verb = row.peakDeltaDb < 0 ? "reduced" : "raised";
  const where = row.scope.sectionId ? ` in ${row.scope.label}` : "";
  const lead = size < 2 ? "This is a subtle change. " : "";
  const hear = size < 2 ? ", so the effect may be difficult to hear in isolation" : "";
  const result = interaction ? ` ${interaction.label} ${interaction.measure} went from ${interaction.before.toFixed(2)} to ${interaction.after.toFixed(2)}.` : "";
  return `${lead}${row.name} is ${size < 2 ? "only " : ""}${verb} ${size.toFixed(1)} dB around ${formatHz(row.peakHz)}${where}${hear}. The difference curve shows the affected range.${result}`;
}

export function explainGain(row: GainDifference): string {
  const size = Math.abs(row.deltaDb);
  const where = row.scope.sectionId ? ` in ${row.scope.label} only` : "";
  const subtle = size < 1.5 ? "This is a subtle change: " : "";
  return `${subtle}${row.name} ${row.deltaDb > 0 ? "up" : "down"} ${size.toFixed(1)} dB${where} (${row.currentDb.toFixed(1)} → ${row.candidateDb.toFixed(1)} dB).`;
}

export function explainSpace(row: SpaceDifference): string {
  const parts: string[] = [];
  if (Math.abs(row.candidate.pan - row.current.pan) >= 0.005) parts.push(`pan ${panLabel(row.current.pan)} → ${panLabel(row.candidate.pan)}`);
  if (Math.abs(row.candidate.width - row.current.width) >= 0.005) parts.push(`width ${Math.round(row.current.width * 100)}% → ${Math.round(row.candidate.width * 100)}%`);
  return `${row.name}${row.scope.sectionId ? ` in ${row.scope.label}` : ""}: ${row.words} (${parts.join(", ")}).`;
}

export function explainDynamics(row: DynamicsDifference): string {
  const amount = row.reductionMaxDb !== null ? ` up to ${row.reductionMaxDb.toFixed(1)} dB` : "";
  const when = row.activeShare !== null ? `, acting ${Math.round(row.activeShare * 100)}% of the time${row.scope.sectionId ? ` in ${row.scope.label}` : ""}` : "";
  const key = row.keyName ? ` when ${row.keyName} plays` : "";
  const what = row.kind === "compressor" ? "Compression" : row.kind === "ducking" ? "Ducking" : row.kind === "dynamic-eq" ? `Dynamic EQ${row.dynamicEq ? ` at ${formatHz(row.dynamicEq.frequencyHz)}` : ""}` : "Transient shaping";
  const subtle = row.reductionP95Db !== null && row.reductionP95Db < 2 && row.kind !== "transient" ? " This is subtle; the timeline shows where it acts." : "";
  return `${what} on ${row.name}${amount}${key}${when}.${subtle}`;
}

export function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.005) return "C";
  return `${pan < 0 ? "L" : "R"}${Math.round(Math.abs(pan) * 100)}`;
}

/* ------------------------------------------------------------------ adapters */

function interactionLabel(document: ProjectDocument, ids: string[]): string {
  return ids.map((id) => trackName(document, id)).join(" ↔ ");
}

const INTERACTION_TYPES = new Set<MixProblem["type"]>(["frequency-conflict", "low-end-collision", "event-masking", "center-congestion", "excessive-width", "level-hierarchy", "dynamic-instability", "transient-problem"]);

/** The Full Mix (or Auto Mix) candidate: what Apply would write, with each problem's severity before and after. */
export function fullMixDifference(document: ProjectDocument, plan: FullMixPlan, options: { mode?: "all" | "accepted"; loudness?: DifferenceInput["loudness"]; envelopes?: DifferenceInput["envelopes"] } = {}): MixDifference | null {
  const applied = applyFullMixPlan(document, plan, options.mode ?? "all");
  if (!applied.ok) return null;
  const included = plan.changes.filter((change) => changeIncluded(change, options.mode ?? "all"));
  const evidence: DifferenceEvidence[] = included.map((change) => ({
    trackId: change.trackId,
    sectionId: change.scope.type === "section" ? change.scope.sectionId : null,
    domain: change.domain === "trim" ? "gain" : change.domain,
    dynamicsKind: change.processing.type === "dynamics" ? change.processing.processing.type : undefined,
    dynamics: change.evaluation.dynamics,
    eq: change.evaluation.eq,
    space: change.evaluation.space,
    interactionIds: change.problemIds,
  }));
  const touched = new Set(included.flatMap((change) => change.problemIds));
  const interactions: InteractionDifference[] = plan.problems
    .filter((problem) => touched.has(problem.id) && INTERACTION_TYPES.has(problem.type) && problem.severityAfter !== null)
    .map((problem) => ({
      id: problem.id,
      label: problem.trackIds.length > 1 ? interactionLabel(document, problem.trackIds) : trackName(document, problem.trackIds[0] ?? ""),
      kind: problem.type,
      trackIds: problem.trackIds,
      before: round2(problem.severity),
      after: round2(problem.severityAfter!),
      reduction: problem.severity > 0 ? round3((problem.severity - problem.severityAfter!) / problem.severity) : 0,
      measure: problem.trackIds.length > 1 ? "interaction" : "problem severity",
    }));
  const { before, after } = plan.evaluation;
  const metrics: MetricDifference[] = [];
  const add = (label: string, a: number | null, b: number | null, unit: string, better: MetricDifference["better"]) => {
    if (a !== null && b !== null && (Math.abs(a - b) >= 0.005 || label === "Open problems")) metrics.push({ label, before: round2(a), after: round2(b), unit, better });
  };
  add("Open problems", before.openProblems, after.openProblems, "", "lower");
  add("Center congestion", before.centerLoad, after.centerLoad, "", "lower");
  add("Mono compatibility (correlation)", before.correlation, after.correlation, "", "higher");
  add("Mono fold-down loss", before.monoLossDb, after.monoLossDb, "dB", "lower");
  add("Estimated peak", before.estimatedPeakDbfs, after.estimatedPeakDbfs, "dBFS", "neither");
  add("Largest gain reduction on one stem", before.maxReductionDb, after.maxReductionDb, "dB", "neither");
  for (const change of included) {
    const dyn = change.evaluation.dynamics;
    if (!dyn) continue;
    const name = trackName(document, change.trackId);
    if (dyn.spreadBeforeDb !== null && dyn.spreadAfterDb !== null) add(`${name} active-level variation`, dyn.spreadBeforeDb, dyn.spreadAfterDb, "dB", "lower");
    if (dyn.collisionBefore !== null && dyn.collisionAfter !== null) add(`${name} onset conflict`, dyn.collisionBefore, dyn.collisionAfter, "", "lower");
  }
  const loudness = options.loudness ?? Object.fromEntries(plan.levels.map((level) => [level.trackId, level.loudnessDb === null ? null : level.loudnessDb]));
  const trim = included.some((change) => change.processing.type === "trim") ? plan.candidateTrim.gainDb : null;
  return mixDifference({ current: document, candidate: applied.document, evidence, interactions, metrics, loudness, envelopes: options.envelopes, trimDb: trim });
}

/** The Gain (AutoBalance) candidate. */
export function gainPlanDifference(document: ProjectDocument, plan: MixPlan): MixDifference {
  return mixDifference({ current: document, candidate: applyMixPlan(document, plan, "all") });
}

/** The EQ candidate, with each row's competed share before and after. */
export function eqPlanDifference(document: ProjectDocument, plan: EqPlan): MixDifference {
  const rows = plan.changes.filter((change) => eqRecommendationIncluded(change, "all"));
  const interactions: InteractionDifference[] = rows
    .filter((row) => row.evaluation && row.protectedTrackIds.length > 0)
    .map((row) => ({
      id: row.id,
      label: interactionLabel(document, [row.protectedTrackIds[0]!, row.trackId]),
      kind: "frequency-conflict",
      trackIds: [row.protectedTrackIds[0]!, row.trackId],
      before: round2(row.evaluation!.before),
      after: round2(row.evaluation!.after),
      reduction: row.evaluation!.before > 0 ? round3((row.evaluation!.before - row.evaluation!.after) / row.evaluation!.before) : 0,
      measure: "competed share",
    }));
  const evidence: DifferenceEvidence[] = rows.map((row) => ({ trackId: row.trackId, sectionId: scopeSection(row.scope), domain: "eq", eq: row.evaluation, interactionIds: [row.id] }));
  return mixDifference({ current: document, candidate: applyEqPlan(document, plan, "all"), evidence, interactions });
}

/** The Space candidate, with each row's conflict and the mix's center load, correlation, and mono loss. */
export function spacePlanDifference(document: ProjectDocument, plan: SpatialPlan): MixDifference {
  const rows = plan.changes.filter((change) => change.status !== "rejected" && change.status !== "needs-review");
  const interactions: InteractionDifference[] = rows
    .filter((row) => row.evaluation && row.evaluation.conflictBefore > 0)
    .map((row) => ({
      id: row.id,
      label: interactionLabel(document, [row.trackId, ...row.relatedTrackIds.slice(0, 1)]),
      kind: "center-congestion",
      trackIds: [row.trackId, ...row.relatedTrackIds],
      before: round2(row.evaluation!.conflictBefore),
      after: round2(row.evaluation!.conflictAfter),
      reduction: round3((row.evaluation!.conflictBefore - row.evaluation!.conflictAfter) / row.evaluation!.conflictBefore),
      measure: "stereo conflict",
    }));
  const metrics: MetricDifference[] = [];
  const first = rows.find((row) => row.evaluation)?.evaluation;
  const last = [...rows].reverse().find((row) => row.evaluation)?.evaluation;
  if (first && last) {
    const mixBefore = first.mixBefore as Record<string, number | null>;
    const mixAfter = last.mixAfter as Record<string, number | null>;
    for (const [key, label, unit, better] of [
      ["centerLoad", "Center congestion", "", "lower"],
      ["correlation", "Mono compatibility (correlation)", "", "higher"],
      ["monoLossDb", "Mono fold-down loss", "dB", "lower"],
    ] as const) {
      const a = mixBefore[key];
      const b = mixAfter[key];
      if (typeof a === "number" && typeof b === "number") metrics.push({ label, before: round2(a), after: round2(b), unit, better });
    }
  }
  const evidence: DifferenceEvidence[] = rows.map((row) => ({ trackId: row.trackId, sectionId: scopeSection(row.scope), domain: "space", space: row.evaluation, interactionIds: [row.id] }));
  return mixDifference({ current: document, candidate: applySpacePlan(document, plan, "all"), evidence, interactions, metrics });
}

/** The Dynamics candidate, with each row's reduction over time and its before/after readings. */
export function dynamicsPlanDifference(document: ProjectDocument, plan: DynamicsPlan, envelopes?: DifferenceInput["envelopes"]): MixDifference {
  const rows = plan.changes.filter((change) => change.status !== "rejected" && change.status !== "needs-review");
  const evidence: DifferenceEvidence[] = rows.map((row) => ({ trackId: row.trackId, sectionId: scopeSection(row.scope), domain: "dynamics", dynamicsKind: row.processing.type, dynamics: row.evaluation }));
  return mixDifference({ current: document, candidate: applyDynamicsPlan(document, plan, "all"), evidence, envelopes });
}

function scopeSection(scope: MixScope | { type: string; sectionId?: string }): string | null {
  return scope.type === "section" && "sectionId" in scope && scope.sectionId ? scope.sectionId : null;
}
