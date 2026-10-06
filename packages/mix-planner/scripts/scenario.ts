/**
 * Scenario loading shared by the acceptance harnesses: a real project folder, its cached analysis, EQ band,
 * stereo, and envelope frames, and the scenario's in-memory edits (roles, faders, pan and width, saved processing,
 * sections, prominence, notes). The project file is never written.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { analysisCacheEntrySchema, envelopeFramesCacheSchema, eqBandsCacheSchema, stereoFramesCacheSchema, type EnvelopeFrames, type EqBandFrames, type StereoFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import { deserializeProject, eqChainForSection, sectionEqNodes, setSectionDynamicsNodes, setTrackDynamicsNodes, setTrackEqNodes, setTrackSectionState, type DynamicsNode, type EqFilter, type ProjectDocument, type SectionType, type TrackRole } from "@audiosous/project-model";
import { engineDynamics } from "@audiosous/dynamics-planner";
import { spatialAudition } from "@audiosous/spatial-planner";
import type { ChangePatch, MixGoal, MixStrength } from "../src/index";

export interface Scenario {
  project: string;
  out: string;
  strength?: MixStrength;
  goal?: MixGoal;
  /** The current mix's rendered sample peak, dBFS (from a `bounce_mix` run of Current), for the headroom check. */
  mixPeakDbfs?: number;
  /** Keyed by a case-insensitive substring of the track name. */
  tracks?: Record<string, { role?: TrackRole; gainDb?: number; pan?: number; width?: number; customLabel?: string | null; muted?: boolean; eq?: EqFilter[] }>;
  allGainDb?: number;
  /** Start from the stems as delivered: no saved EQ, pan, width, or dynamics (as the Milestone 3–6 runs did). */
  clearProcessing?: boolean;
  sections?: Array<{ id: string; name: string; type: SectionType; start: number; end: number; intent?: string | null }>;
  trackSection?: Array<{ track: string; section: string; prominence?: "primary" | "focal" | "supporting"; intent?: string }>;
  dynamics?: Array<{ track: string; section?: string; nodes: Array<Record<string, unknown>> }>;
  /** Accept every change except these (track substrings), then edit, as a reviewer would. */
  review?: { reject?: string[]; edit?: Array<{ track: string; domain: string; patch: ChangePatch }> };
}

export interface LoadedScenario {
  scenario: Scenario;
  document: ProjectDocument;
  measurements: Record<string, TrackFileMeasurement | null>;
  bands: Record<string, EqBandFrames | null>;
  stereo: Record<string, StereoFrames | null>;
  envelopes: Record<string, EnvelopeFrames | null>;
  loadMs: number;
  byName: (needle: string) => ProjectDocument["tracks"][number];
}

export function loadScenario(scenarioPath: string): LoadedScenario {
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
const projectDir = resolve(scenario.project);

const loadStarted = performance.now();
let document: ProjectDocument = deserializeProject(readFileSync(join(projectDir, "project.amix"), "utf8"));
const measurements: Record<string, TrackFileMeasurement | null> = {};
const bands: Record<string, EqBandFrames | null> = {};
const stereo: Record<string, StereoFrames | null> = {};
const envelopes: Record<string, EnvelopeFrames | null> = {};
for (const track of document.tracks) {
  const read = (suffix: string) => JSON.parse(readFileSync(join(projectDir, "cache/analysis", `${track.id}${suffix}.json`), "utf8"));
  const attempt = <T>(run: () => T): T | null => {
    try {
      return run();
    } catch {
      return null;
    }
  };
  bands[track.id] = attempt(() => eqBandsCacheSchema.parse(read("__eqbands")).bands);
  stereo[track.id] = attempt(() => stereoFramesCacheSchema.parse(read("__stereo")).stereo);
  envelopes[track.id] = attempt(() => envelopeFramesCacheSchema.parse(read("__envelope")).envelope);
  measurements[track.id] = attempt(() => analysisCacheEntrySchema.parse(read("")).measurement);
}
const loadMs = performance.now() - loadStarted;

const byName = (needle: string) => {
  const hits = document.tracks.filter((track) => track.name.toLowerCase().includes(needle.toLowerCase()) || (track.customLabel ?? "").toLowerCase().includes(needle.toLowerCase()));
  if (hits.length !== 1) throw new Error(`Scenario track "${needle}" matched ${hits.length} tracks.`);
  return hits[0]!;
};
if (scenario.allGainDb !== undefined) document = { ...document, tracks: document.tracks.map((track) => ({ ...track, gainDb: scenario.allGainDb! })) };
if (scenario.clearProcessing) {
  document = {
    ...document,
    tracks: document.tracks.map((track) => ({ ...track, pan: 0, width: 1, processing: { ...track.processing, nodes: [], dynamics: [] } })),
    sectionTrackSettings: document.sectionTrackSettings.map((row) => ({ ...row, overrides: { ...row.overrides, pan: null, width: null }, processing: { ...row.processing, nodes: [], dynamics: [] } })),
  };
}
for (const [needle, patch] of Object.entries(scenario.tracks ?? {})) {
  const target = byName(needle);
  document = {
    ...document,
    tracks: document.tracks.map((track) =>
      track.id === target.id
        ? {
            ...track,
            role: patch.role ?? track.role,
            gainDb: patch.gainDb ?? track.gainDb,
            pan: patch.pan ?? track.pan,
            width: patch.width ?? track.width,
            customLabel: patch.customLabel === undefined ? track.customLabel : patch.customLabel,
            muted: patch.muted ?? track.muted,
          }
        : track,
    ),
  };
  if (patch.eq) {
    const result = setTrackEqNodes(document, target.id, patch.eq.map((filter, index) => ({ id: `scenario-${index}`, type: "eq" as const, enabled: true, filter, origin: "manual" as const, note: "scenario" })));
    if (!result.ok) throw new Error(result.message);
    document = result.document;
  }
}
if (scenario.sections) {
  document = {
    ...document,
    sections: scenario.sections.map((item) => ({ id: item.id, name: item.name, type: item.type, startTime: item.start, endTime: Math.min(item.end, document.project.durationSeconds), userIntent: item.intent ?? null, source: "manual" as const, confidence: null, structuralGroupId: null })),
    sectionTrackSettings: [],
    uiState: { ...document.uiState, selectedSectionId: null, loop: null },
  };
}
for (const item of scenario.trackSection ?? []) {
  const result = setTrackSectionState(document, byName(item.track).id, item.section, { prominence: item.prominence, userIntent: item.intent });
  if (!result.ok) throw new Error(result.message);
  document = result.document;
}
for (const item of scenario.dynamics ?? []) {
  const target = byName(item.track);
  const nodes = item.nodes.map((node, index) => {
    const key = typeof node.keyTrackId === "string" ? byName(node.keyTrackId).id : (node.keyTrackId ?? undefined);
    return { id: `scenario-dyn-${index}`, enabled: true, origin: "manual", note: "scenario", ...node, ...(key !== undefined ? { keyTrackId: key } : {}) } as DynamicsNode;
  });
  const result = item.section ? setSectionDynamicsNodes(document, target.id, item.section, nodes) : setTrackDynamicsNodes(document, target.id, nodes);
  if (!result.ok) throw new Error(result.message);
  document = result.document;
}

return { scenario, document, measurements, bands, stereo, envelopes, loadMs, byName };
}

/** The engine settings a document plays with. */
export function engineSettings(doc: ProjectDocument) {
  const regions = doc.sectionTrackSettings
    .filter((row) => row.overrides.gainDb !== null)
    .map((row) => {
      const section = doc.sections.find((item) => item.id === row.sectionId)!;
      return { trackId: row.trackId, startSeconds: section.startTime, endSeconds: section.endTime, gainDb: row.overrides.gainDb! };
    });
  const spatial = spatialAudition(doc, null, { mode: "current" });
  return {
    tracks: doc.tracks.map((track) => ({ id: track.id, relativePath: track.file.relativePath, gainDb: track.gainDb, muted: track.muted })),
    gainRegions: regions,
    eq: doc.tracks.map((track) => ({
      trackId: track.id,
      filters: eqChainForSection(doc, track.id, null),
      regions: doc.sections
        .map((section) => ({ startSeconds: section.startTime, endSeconds: section.endTime, filters: sectionEqNodes(doc, track.id, section.id).filter((node) => node.enabled).map((node) => node.filter) }))
        .filter((region) => region.filters.length > 0),
    })),
    spatial: spatial.tracks.map((track) => ({ ...track, regions: spatial.regions.filter((region) => region.trackId === track.trackId).map((region) => ({ startSeconds: region.startSeconds, endSeconds: region.endSeconds, pan: region.pan, width: region.width })) })),
    dynamics: engineDynamics(doc),
  };
}

