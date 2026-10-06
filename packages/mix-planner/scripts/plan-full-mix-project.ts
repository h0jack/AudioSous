/**
 * Acceptance harness: run Full Mix on a real project folder from its cached analysis, and compare it with the four
 * planners run on their own.
 *
 *   cargo run --release -p audiosous-audio --example eq_bands -- "test-assets/Generated 5"
 *   cargo run --release -p audiosous-audio --example stereo_frames -- "test-assets/Generated 5"
 *   cargo run --release -p audiosous-audio --example envelope_frames -- "test-assets/Generated 5"
 *   npx vite-node packages/mix-planner/scripts/plan-full-mix-project.ts -- scenario.json
 *   cargo run --release -p audiosous-audio --example bounce_mix -- OUT_DIR [--wav]
 *
 * The scenario edits the document in memory only (roles, faders, saved EQ and dynamics, sections, prominence,
 * notes); the project file is never written. Output: a readable report, plan.json, reviewed.json, and bounce.json
 * with engine settings for Current, the four planners' Apply all combined, the Full Mix Candidate (loudness-matched
 * as the A/B plays it), and the reviewed plan. checks.json is written empty: Full Mix is checked by the bounces.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { analysisCacheEntrySchema, envelopeFramesCacheSchema, eqBandsCacheSchema, stereoFramesCacheSchema, type EnvelopeFrames, type EqBandFrames, type StereoFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import { applyMixPlan, planBalance } from "@audiosous/balance-planner";
import { applyDynamicsPlan, engineDynamics, planDynamics } from "@audiosous/dynamics-planner";
import { applyEqPlan, planEq } from "@audiosous/eq-planner";
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
import { applySpacePlan, planSpace, spatialAudition } from "@audiosous/spatial-planner";
import {
  applyFullMixPlan,
  describeChange,
  editChange,
  fullMixAudition,
  planFullMix,
  setChangeStatus,
  type ChangePatch,
  type FullMixPlan,
  type MixGoal,
  type MixStrength,
} from "../src/index";

interface Scenario {
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

const scenarioPath = process.argv.slice(2).find((arg) => arg !== "--");
if (!scenarioPath) throw new Error("Pass a scenario JSON path.");
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

const strength = scenario.strength ?? "normal";
const now = "2026-10-05T00:00:00.000Z";
const name = (id: string) => {
  const track = document.tracks.find((item) => item.id === id);
  return (track?.customLabel ?? track?.name ?? id).replace("Sub Operator V4.23 ", "");
};

// The four planners on their own, each on the saved project, as their tabs would run them.
const independentStarted = performance.now();
const balance = planBalance({ document, measurements: Object.fromEntries(document.tracks.map((track) => [track.id, { track: measurements[track.id] ?? null }])), settings: { strength }, now });
const eq = planEq({ document, measurements, bands, settings: { strength }, now });
const space = planSpace({ document, measurements, bands, stereo, settings: { strength }, now });
const dynamics = planDynamics({ document, measurements, envelopes, bands, settings: { strength }, now });
const independentMs = performance.now() - independentStarted;

const started = performance.now();
const plan = planFullMix({ document, measurements, bands, stereo, envelopes, settings: { strength, goal: scenario.goal ?? "balanced" }, now, mixPeakDbfs: scenario.mixPeakDbfs ?? null, trace: process.env.TRACE ? (stage, detail) => console.log(`[${stage}]`, JSON.stringify(detail)) : undefined });
const planMs = performance.now() - started;

console.log(`\n${plan.summary.headline}`);
console.log(`load ${loadMs.toFixed(0)} ms, four planners ${independentMs.toFixed(0)} ms, Full Mix ${planMs.toFixed(0)} ms (${plan.evaluation.surveys} planner runs), confidence ${plan.summary.confidence}`);
for (const line of plan.summary.lines) console.log(`  ${line}`);
for (const note of plan.summary.notes) console.log(`  note: ${note.replaceAll("Sub Operator V4.23 ", "")}`);
console.log("\nIndependent planners:");
for (const row of balance.trackChanges.filter((item) => Math.abs(item.deltaDb) >= 0.05 || Math.abs(item.offsetFromGlobalDb) >= 0.05)) console.log(`  Level  ${name(row.trackId)} ${row.scope.type === "global" ? "global" : row.scope.sectionId} ${row.deltaDb > 0 ? "+" : ""}${row.deltaDb} dB ${row.status}`);
for (const row of eq.changes) console.log(`  EQ     ${name(row.trackId)} ${row.scope.type === "global" ? "global" : row.scope.sectionId} ${describeChange({ type: "eq", filter: row.processing.filter }, name)} ${row.status}`);
for (const row of space.changes) console.log(`  Space  ${name(row.trackId)} ${row.scope.type === "global" ? "global" : row.scope.sectionId} ${describeChange(row.processing, name, row.current)} ${row.status}`);
for (const row of dynamics.changes) console.log(`  Dyn    ${name(row.trackId)} ${row.scope.type === "global" ? "global" : row.scope.sectionId} ${describeChange({ type: "dynamics", processing: row.processing }, name)} ${row.status}`);
for (const problem of plan.problems) {
  console.log(`\n# ${problem.title.replaceAll("Sub Operator V4.23 ", "")} [${problem.type}] severity ${problem.severity} → ${problem.severityAfter}, confidence ${problem.confidence}, ${problem.outcome}`);
  console.log(`  ${problem.explanation.replaceAll("Sub Operator V4.23 ", "")}`);
  for (const evidence of problem.evidence) console.log(`  · ${evidence.source}: ${evidence.detail.replaceAll("Sub Operator V4.23 ", "")}`);
  for (const item of plan.interventions.filter((entry) => entry.problemIds.includes(problem.id))) {
    console.log(`  ${item.outcome === "selected" ? "✔" : "✘"} ${item.label.replaceAll("Sub Operator V4.23 ", "")} (removes ${Math.round(item.expectedReduction * 100)}%, cost ${item.cost}, net ${item.net}) — ${item.reason.replaceAll("Sub Operator V4.23 ", "")}`);
  }
}
console.log("\nSelected changes:");
for (const change of plan.changes) console.log(`  ${name(change.trackId)} · ${change.scope.type === "global" ? "Global" : document.sections.find((section) => section.id === (change.scope as { sectionId: string }).sectionId)?.name} · ${describeChange(change.processing, name, change.evidence.kind === "space" ? change.evidence.current : undefined)} · from ${change.source} · cost ${change.cost} · confidence ${change.confidence} · ${change.status}`);
const metrics = (label: string, value: FullMixPlan["evaluation"]["before"]) =>
  console.log(`  ${label}: problem score ${value.problemScore}, open ${value.openProblems}, est. peak ${value.estimatedPeakDbfs?.toFixed(2)} dBFS, loudness ${value.loudnessDb} dB, correlation ${value.correlation}, mono loss ${value.monoLossDb} dB, max GR ${value.maxReductionDb} dB, cost ${value.processingCost}, changes ${value.changeCount}`);
console.log("\nEvaluation (re-measured):");
metrics("before", plan.evaluation.before);
metrics("after ", plan.evaluation.after);
console.log(`  candidates: ${plan.evaluation.candidates.map((item) => `${item.name} ${item.changeCount} changes, score ${item.score}${item.chosen ? " (kept)" : ""}`).join("; ")}`);
console.log(`  passes: ${plan.evaluation.passes.map((item) => `${item.pass}: ${item.note}`).join(" | ")}`);
console.log(`  stop: ${plan.evaluation.stopReason}`);
for (const regression of plan.evaluation.regressions) console.log(`  regression (${regression.resolution}): ${regression.description.replaceAll("Sub Operator V4.23 ", "")}`);

// Review as the scenario says: accept every change except the rejected stems, then edit.
let reviewed: FullMixPlan = plan;
for (const change of plan.changes) {
  const rejected = (scenario.review?.reject ?? []).some((needle) => name(change.trackId).toLowerCase().includes(needle.toLowerCase()));
  reviewed = setChangeStatus(reviewed, change.id, rejected ? "rejected" : "accepted");
}
for (const edit of scenario.review?.edit ?? []) {
  const target = reviewed.changes.find((change) => name(change.trackId).toLowerCase().includes(edit.track.toLowerCase()) && change.domain === edit.domain);
  if (target) reviewed = editChange(reviewed, target.id, edit.patch);
}

const out = resolve(scenario.out);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "plan.json"), JSON.stringify(plan, null, 2));
writeFileSync(join(out, "reviewed.json"), JSON.stringify(reviewed, null, 2));
writeFileSync(join(out, "checks.json"), JSON.stringify({ project: projectDir, requests: [] }, null, 2));

/** The engine settings a document plays with. */
function engineSettings(doc: ProjectDocument) {
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

// The four planners' Apply all, one after another on the saved project: what "concatenating" them would do.
let combined = applyMixPlan(document, balance, "all");
combined = applyEqPlan(combined, eq, "all");
combined = applySpacePlan(combined, space, "all");
combined = applyDynamicsPlan(combined, dynamics, "all");
const candidate = fullMixAudition(document, plan, { mode: "candidate", loudnessMatch: false }).document;
const matched = fullMixAudition(document, plan, { mode: "candidate", loudnessMatch: true });
const reviewedApplied = applyFullMixPlan(document, reviewed, "accepted");
if (!reviewedApplied.ok) throw new Error(`Reviewed plan could not be applied: ${reviewedApplied.failures.map((item) => item.message).join("; ")}`);
const reviewedMatched = fullMixAudition(document, { ...reviewed, changes: reviewed.changes.map((change) => (change.status === "accepted" ? change : { ...change, status: "rejected" as const })) }, { mode: "candidate", loudnessMatch: true });
console.log(`\nLoudness match in the A/B: candidate ${matched.loudnessMatchDb >= 0 ? "+" : ""}${matched.loudnessMatchDb} dB, reviewed ${reviewedMatched.loudnessMatchDb >= 0 ? "+" : ""}${reviewedMatched.loudnessMatchDb} dB (safety trim ${plan.candidateTrim.gainDb} dB).`);
writeFileSync(
  join(out, "bounce.json"),
  JSON.stringify(
    {
      project: projectDir,
      durationSeconds: document.project.durationSeconds,
      variants: [
        { name: "current", ...engineSettings(document) },
        { name: "independent-combined", ...engineSettings(combined) },
        { name: "full-mix", ...engineSettings(candidate) },
        { name: "full-mix-matched", ...engineSettings(matched.document) },
        { name: "reviewed-matched", ...engineSettings(reviewedMatched.document) },
      ],
    },
    null,
    2,
  ),
);
console.log(`Wrote plan.json, reviewed.json, and bounce.json to ${out}`);
