/**
 * Acceptance harness: run the dynamics planner on a real project folder from its cached analysis.
 *
 *   cargo run --release -p audiosous-audio --example eq_bands -- "test-assets/Generated 5"
 *   cargo run --release -p audiosous-audio --example envelope_frames -- "test-assets/Generated 5"
 *   npx vite-node packages/dynamics-planner/scripts/plan-dynamics-project.ts -- scenario.json
 *   cargo run --release -p audiosous-audio --example bounce_mix -- OUT_DIR [--wav]
 *
 * The scenario edits the document in memory only. The project file is never written.
 * Output: a readable report on stdout, and plan.json, checks.json (proxy-check requests), and bounce.json
 * (engine settings for Current, Dynamics Candidate, level-matched candidate, and the reviewed plan) in `out`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { analysisCacheEntrySchema, envelopeFramesCacheSchema, eqBandsCacheSchema, type EnvelopeFrames, type EqBandFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import {
  deserializeProject,
  eqChainForSection,
  sectionEqNodes,
  setSectionDynamicsNodes,
  setTrackDynamicsNodes,
  setTrackEqNodes,
  setTrackSectionState,
  type DynamicsNode,
  type EqFilter,
  type ProjectDocument,
  type SectionType,
  type TrackRole,
} from "@audiosous/project-model";
import { spatialAudition } from "@audiosous/spatial-planner";
import {
  applyDynamicsPlan,
  describeProcessing,
  dynamicsAudition,
  dynamicsCheckRequest,
  editDynamicsRecommendation,
  engineDynamics,
  planDynamics,
  setDynamicsRecommendationStatus,
  type DynamicsPatch,
  type DynamicsPlan,
  type DynamicsStrength,
} from "../src/index";

interface Scenario {
  project: string;
  out: string;
  strength?: DynamicsStrength;
  /** Keyed by a case-insensitive substring of the track name. */
  tracks?: Record<string, { role?: TrackRole; gainDb?: number; customLabel?: string | null; muted?: boolean; eq?: EqFilter[] }>;
  allGainDb?: number;
  sections?: Array<{ id: string; name: string; type: SectionType; start: number; end: number; intent?: string | null }>;
  trackSection?: Array<{ track: string; section: string; prominence?: "primary" | "focal" | "supporting"; intent?: string }>;
  /** Saved dynamics on the project before planning. Key tracks are name substrings too. */
  dynamics?: Array<{ track: string; section?: string; nodes: Array<Record<string, unknown>> }>;
  /** Accept every row except these (track substrings), then edit, as a reviewer would. */
  review?: { reject?: string[]; edit?: Array<{ track: string; type: string; patch: DynamicsPatch }> };
}

const scenarioPath = process.argv.slice(2).find((arg) => arg !== "--");
if (!scenarioPath) throw new Error("Pass a scenario JSON path.");
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
const projectDir = resolve(scenario.project);

const loadStarted = performance.now();
let document: ProjectDocument = deserializeProject(readFileSync(join(projectDir, "project.amix"), "utf8"));
const measurements: Record<string, TrackFileMeasurement | null> = {};
const bands: Record<string, EqBandFrames | null> = {};
const envelopes: Record<string, EnvelopeFrames | null> = {};
for (const track of document.tracks) {
  const read = (suffix: string) => JSON.parse(readFileSync(join(projectDir, "cache/analysis", `${track.id}${suffix}.json`), "utf8"));
  try {
    bands[track.id] = eqBandsCacheSchema.parse(read("__eqbands")).bands;
  } catch {
    bands[track.id] = null;
  }
  try {
    envelopes[track.id] = envelopeFramesCacheSchema.parse(read("__envelope")).envelope;
  } catch {
    envelopes[track.id] = null;
  }
  try {
    measurements[track.id] = analysisCacheEntrySchema.parse(read("")).measurement;
  } catch {
    measurements[track.id] = null;
  }
}
const loadMs = performance.now() - loadStarted;

const byName = (needle: string) => {
  const hits = document.tracks.filter((track) => track.name.toLowerCase().includes(needle.toLowerCase()));
  if (hits.length !== 1) throw new Error(`Scenario track "${needle}" matched ${hits.length} tracks.`);
  return hits[0]!;
};

if (scenario.allGainDb !== undefined) document = { ...document, tracks: document.tracks.map((track) => ({ ...track, gainDb: scenario.allGainDb! })) };
for (const [needle, patch] of Object.entries(scenario.tracks ?? {})) {
  const target = byName(needle);
  document = {
    ...document,
    tracks: document.tracks.map((track) =>
      track.id === target.id
        ? { ...track, role: patch.role ?? track.role, gainDb: patch.gainDb ?? track.gainDb, customLabel: patch.customLabel === undefined ? track.customLabel : patch.customLabel, muted: patch.muted ?? track.muted }
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
    sections: scenario.sections.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      startTime: item.start,
      endTime: Math.min(item.end, document.project.durationSeconds),
      userIntent: item.intent ?? null,
      source: "manual" as const,
      confidence: null,
      structuralGroupId: null,
    })),
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

const started = performance.now();
const plan = planDynamics({ document, measurements, envelopes, bands, settings: { strength: scenario.strength ?? "normal" }, trace: process.env.DYN_TRACE === "1" ? (stage, detail) => console.log(`[${stage}]`, JSON.stringify(detail)) : undefined });
const planMs = performance.now() - started;
const name = (id: string) => document.tracks.find((track) => track.id === id)?.name.replace("Sub Operator V4.23 ", "") ?? id;

console.log(`\n${plan.summary.headline}`);
console.log(`load ${loadMs.toFixed(0)} ms, plan ${planMs.toFixed(0)} ms, ${plan.summary.tracksAnalyzed} stems, ${plan.summary.pairsAnalyzed} relationships. ${plan.summary.analysisSource}`);
for (const note of plan.summary.notes) console.log(`  note: ${note}`);
for (const change of plan.changes) {
  const scope = change.scope.type === "global" ? "Global" : (document.sections.find((section) => section.id === (change.scope as { sectionId: string }).sectionId)?.name ?? "section");
  const evaluation = change.evaluation!;
  console.log(`\n- ${name(change.trackId)} · ${scope} · ${change.processing.type} · ${describeProcessing(change.processing, name)} · confidence ${change.confidence} · ${change.status}${change.replacesNodeId ? " · edits saved node" : ""}`);
  console.log(
    `  predicted: reduction p50 ${evaluation.reductionP50Db} / p95 ${evaluation.reductionP95Db} / max ${evaluation.reductionMaxDb} dB, level ${evaluation.levelChangeDb} dB` +
      (evaluation.spreadBeforeDb !== null ? `, spread ${evaluation.spreadBeforeDb} → ${evaluation.spreadAfterDb} dB, crest ${evaluation.crestBeforeDb} → ${evaluation.crestAfterDb} dB` : "") +
      (evaluation.conflictBeforeDb !== null ? `, conflict ${evaluation.conflictBeforeDb} → ${evaluation.conflictAfterDb} dB, collision ${evaluation.collisionBefore} → ${evaluation.collisionAfter}` : "") +
      (evaluation.recovery !== null ? `, recovery ${evaluation.recovery}` : "") +
      (evaluation.outsideChangeDb !== null ? `, outside ${evaluation.outsideChangeDb} dB` : "") +
      (evaluation.transientBeforeDb !== null ? `, transient ${evaluation.transientBeforeDb} → ${evaluation.transientAfterDb} dB` : ""),
  );
  for (const reason of change.reasons) console.log(`  · ${reason.replaceAll("Sub Operator V4.23 ", "")}`);
  for (const warning of change.warnings) console.log(`  ! ${warning}`);
}
console.log("\nReadings that were not steady:");
for (const reading of plan.readings.filter((item) => item.classification !== "steady")) console.log(`  ${name(reading.trackId)} (${reading.scopeName}): ${reading.classification}. ${reading.explanation}`);
console.log("\nRelationships:");
for (const item of plan.interactions.slice(0, 20)) console.log(`  ${name(item.trackA)} → ${name(item.trackB)} (${item.scopeName}, ${item.kind}): ${item.outcome}. ${item.explanation.replaceAll("Sub Operator V4.23 ", "")}`);

// Review as the scenario says: accept everything except the rejected stems, then edit.
let reviewed: DynamicsPlan = plan;
for (const change of plan.changes) {
  const rejected = (scenario.review?.reject ?? []).some((needle) => name(change.trackId).toLowerCase().includes(needle.toLowerCase()));
  reviewed = setDynamicsRecommendationStatus(reviewed, change.id, rejected ? "rejected" : "accepted");
}
for (const edit of scenario.review?.edit ?? []) {
  const target = reviewed.changes.find((change) => name(change.trackId).toLowerCase().includes(edit.track.toLowerCase()) && change.processing.type === edit.type);
  if (target) reviewed = editDynamicsRecommendation(reviewed, target.id, edit.patch);
}

const out = resolve(scenario.out);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "plan.json"), JSON.stringify(plan, null, 2));
writeFileSync(join(out, "reviewed.json"), JSON.stringify(reviewed, null, 2));
writeFileSync(join(out, "checks.json"), JSON.stringify({ project: projectDir, requests: plan.changes.map((change) => ({ ...dynamicsCheckRequest(document, change), predicted: change.evaluation })) }, null, 2));

/** The engine settings a document plays with, plus audition-only level offsets. */
function engineSettings(doc: ProjectDocument, compensation: Array<{ trackId: string; sectionId: string | null; startSeconds: number; endSeconds: number; gainDb: number }> = []) {
  const whole = new Map<string, number>();
  for (const item of compensation) if (item.sectionId === null) whole.set(item.trackId, (whole.get(item.trackId) ?? 0) + item.gainDb);
  const regions = new Map<string, { trackId: string; startSeconds: number; endSeconds: number; gainDb: number }>();
  for (const row of doc.sectionTrackSettings) {
    if (row.overrides.gainDb === null) continue;
    const section = doc.sections.find((item) => item.id === row.sectionId)!;
    regions.set(`${row.trackId}:${row.sectionId}`, { trackId: row.trackId, startSeconds: section.startTime, endSeconds: section.endTime, gainDb: row.overrides.gainDb + (whole.get(row.trackId) ?? 0) });
  }
  for (const item of compensation) {
    if (item.sectionId === null) continue;
    const key = `${item.trackId}:${item.sectionId}`;
    const base = regions.get(key)?.gainDb ?? (doc.tracks.find((track) => track.id === item.trackId)!.gainDb + (whole.get(item.trackId) ?? 0));
    regions.set(key, { trackId: item.trackId, startSeconds: item.startSeconds, endSeconds: item.endSeconds, gainDb: base + item.gainDb });
  }
  const spatial = spatialAudition(doc, null, { mode: "current" });
  return {
    tracks: doc.tracks.map((track) => ({ id: track.id, relativePath: track.file.relativePath, gainDb: track.gainDb + (whole.get(track.id) ?? 0), muted: track.muted })),
    gainRegions: [...regions.values()],
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

const candidate = applyDynamicsPlan(document, plan, "all");
const reviewedDocument = applyDynamicsPlan(document, reviewed, "accepted");
writeFileSync(
  join(out, "bounce.json"),
  JSON.stringify(
    {
      project: projectDir,
      durationSeconds: document.project.durationSeconds,
      variants: [
        { name: "current", ...engineSettings(document) },
        { name: "candidate", ...engineSettings(candidate) },
        { name: "candidate-matched", ...engineSettings(candidate, dynamicsAudition(document, plan, { mode: "candidate", levelMatch: true }).compensation) },
        { name: "reviewed-matched", ...engineSettings(reviewedDocument, dynamicsAudition(document, reviewed, { mode: "candidate", levelMatch: true }).compensation) },
      ],
    },
    null,
    2,
  ),
);
console.log(`\nWrote plan.json, reviewed.json, checks.json, and bounce.json to ${out}`);
