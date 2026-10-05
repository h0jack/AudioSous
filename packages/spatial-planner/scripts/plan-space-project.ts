/**
 * Acceptance harness: run the spatial planner on a real project folder from its cached analysis.
 *
 *   cargo run --release -p audiosous-audio --example eq_bands -- "test-assets/Generated 5"
 *   cargo run --release -p audiosous-audio --example stereo_frames -- "test-assets/Generated 5"
 *   npx vite-node packages/spatial-planner/scripts/plan-space-project.ts -- scenario.json
 *
 * The scenario edits the document in memory only. The project file is never written.
 * Output: a readable report on stdout, and plan.json + audition.json in `out` for render-space-audition.py.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { analysisCacheEntrySchema, eqBandsCacheSchema, stereoFramesCacheSchema, type EqBandFrames, type StereoFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import {
  deserializeProject,
  eqChainForSection,
  setSectionSpatial,
  setTrackEqNodes,
  setTrackSectionState,
  type EqFilter,
  type ProjectDocument,
  type SectionType,
  type TrackRole,
} from "@audiosous/project-model";
import {
  describePan,
  describeWidth,
  editSpatialRecommendation,
  planSpace,
  setSpatialRecommendationStatus,
  spatialAudition,
  type SpatialStrength,
} from "../src/index";

interface Scenario {
  project: string;
  out: string;
  strength?: SpatialStrength;
  /** Keyed by a case-insensitive substring of the track name. */
  tracks?: Record<string, { role?: TrackRole; gainDb?: number; pan?: number; width?: number; customLabel?: string | null; muted?: boolean; eq?: EqFilter[] }>;
  /** Every fader to this value first (the producer's balance is the stems at 0 dB). */
  allGainDb?: number;
  sections?: Array<{ id: string; name: string; type: SectionType; start: number; end: number; intent?: string | null }>;
  trackSection?: Array<{ track: string; section: string; prominence?: "primary" | "focal" | "supporting"; intent?: string; pan?: number; width?: number }>;
  /** Accept every row except these (track substrings), then edit, as a reviewer would. */
  review?: { reject?: string[]; edit?: Array<{ track: string; pan?: number; width?: number }> };
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
for (const track of document.tracks) {
  const read = (suffix: string) => JSON.parse(readFileSync(join(projectDir, "cache/analysis", `${track.id}${suffix}.json`), "utf8"));
  try {
    bands[track.id] = eqBandsCacheSchema.parse(read("__eqbands")).bands;
  } catch {
    bands[track.id] = null;
  }
  try {
    stereo[track.id] = process.env.SPACE_NO_STEREO === "1" ? null : stereoFramesCacheSchema.parse(read("__stereo")).stereo;
  } catch {
    stereo[track.id] = null;
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
    const result = setTrackEqNodes(
      document,
      target.id,
      patch.eq.map((filter, index) => ({ id: `scenario-${index}`, type: "eq" as const, enabled: true, filter, origin: "manual" as const, note: "scenario" })),
    );
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
      endTime: item.end,
      userIntent: item.intent ?? null,
      source: "manual" as const,
      confidence: null,
      structuralGroupId: null,
    })),
    sectionTrackSettings: [],
  };
}
for (const row of scenario.trackSection ?? []) {
  const track = byName(row.track);
  const result = setTrackSectionState(document, track.id, row.section, { prominence: row.prominence, userIntent: row.intent });
  if (!result.ok) throw new Error(`Could not set ${row.track} in ${row.section}.`);
  document = result.document;
  if (row.pan !== undefined || row.width !== undefined) {
    const spatial = setSectionSpatial(document, track.id, row.section, { pan: row.pan, width: row.width });
    if (!spatial.ok) throw new Error(spatial.message);
    document = spatial.document;
  }
}

const planStarted = performance.now();
const plan = planSpace({
  document,
  measurements,
  bands,
  stereo,
  settings: { strength: scenario.strength ?? "normal" },
  now: "2026-10-04T00:00:00.000Z",
  trace: process.env.SPACE_TRACE === "1" ? (stage, detail) => process.stdout.write(`[trace] ${stage} ${JSON.stringify(detail)}\n`) : undefined,
});
const planMs = performance.now() - planStarted;

const name = (id: string) => document.tracks.find((track) => track.id === id)?.name.replace(/^Sub Operator V[\d.]+ /, "") ?? id;
const sectionName = (id: string) => document.sections.find((item) => item.id === id)?.name ?? id;

let reviewed = plan;
if (scenario.review) {
  for (const change of plan.changes) {
    const reject = scenario.review.reject?.some((needle) => name(change.trackId).toLowerCase().includes(needle.toLowerCase()));
    reviewed = setSpatialRecommendationStatus(reviewed, change.id, reject ? "rejected" : "accepted");
  }
  for (const edit of scenario.review.edit ?? []) {
    const change = reviewed.changes.find((item) => name(item.trackId).toLowerCase().includes(edit.track.toLowerCase()) && item.status === "accepted");
    if (change) reviewed = setSpatialRecommendationStatus(editSpatialRecommendation(reviewed, change.id, { pan: edit.pan, width: edit.width }), change.id, "accepted");
  }
}

const out = resolve(scenario.out);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "plan.json"), JSON.stringify(plan, null, 2));
writeFileSync(
  join(out, "audition.json"),
  JSON.stringify(
    {
      projectDir,
      tracks: document.tracks.map((track) => ({
        id: track.id,
        name: name(track.id),
        muted: track.muted,
        gainDb: track.gainDb,
        eq: eqChainForSection(document, track.id, null),
        sectionGains: document.sectionTrackSettings
          .filter((row) => row.trackId === track.id && row.overrides.gainDb !== null)
          .map((row) => {
            const section = document.sections.find((item) => item.id === row.sectionId)!;
            return { startSeconds: section.startTime, endSeconds: section.endTime, gainDb: row.overrides.gainDb };
          }),
      })),
      current: spatialAudition(document, plan, { mode: "current" }),
      candidate: spatialAudition(document, plan, { mode: "candidate" }),
      reviewed: spatialAudition(document, reviewed, { mode: "candidate" }),
      checks: plan.changes.map((change) => {
        const before = change.scope.type === "section" ? (change.evidence.scopes[0]?.baseline ?? change.current) : change.current;
        return {
        id: change.id,
        trackId: change.trackId,
        windows: change.evidence.windows,
        before,
        after: { pan: change.processing.pan ?? before.pan, width: change.processing.width ?? before.width },
        predicted: change.evaluation
          ? { correlationBefore: change.evaluation.correlationBefore, correlationAfter: change.evaluation.correlationAfter, monoLossBeforeDb: change.evaluation.monoLossBeforeDb, monoLossAfterDb: change.evaluation.monoLossAfterDb }
          : null,
        };
      }),
    },
    null,
    2,
  ),
);

const log = (line = "") => process.stdout.write(`${line}\n`);
log(`Project: ${document.project.name}  (${document.tracks.length} tracks, ${document.sections.length} sections, strength ${plan.settings.strength})`);
log(`Cache load: ${loadMs.toFixed(1)} ms   Planner: ${planMs.toFixed(1)} ms   Pairs analyzed: ${plan.summary.pairsAnalyzed}`);
log(`Source: ${plan.summary.analysisSource}`);
log(`Headline: ${plan.summary.headline}`);
log(`Confidence: ${plan.summary.confidence}   Candidate trim: ${plan.candidateTrim.gainDb} dB`);
log(`Mix: center load ${plan.mix.before.centerLoad} → ${plan.mix.after.centerLoad}, lean ${plan.mix.before.balance} → ${plan.mix.after.balance}, correlation ${plan.mix.before.correlation} → ${plan.mix.after.correlation}, mono loss ${plan.mix.before.monoLossDb} → ${plan.mix.after.monoLossDb} dB`);
for (const note of plan.summary.notes) log(`  note: ${note}`);
log("");
log("Where each stem sits (whole song):");
for (const item of plan.fields.find((field) => field.key === "song")?.tracks ?? []) {
  log(`  ${name(item.trackId).padEnd(22)} ${describePan(item.image.position).padEnd(10)} spread ${item.image.spread.toFixed(2)} corr ${item.image.correlation.toFixed(2)} mono loss ${item.image.monoLossDb.toFixed(1)} dB  level ${item.levelDb.toFixed(1)} dB  ${item.tier}`);
}
log("");
log("Top spatial interactions:");
for (const item of plan.interactions.slice(0, 14)) {
  log(
    `  ${item.scopeName.padEnd(12)} ${`${name(item.trackA)} ↔ ${name(item.trackB)}`.padEnd(38)} sev ${item.severity.toFixed(2)} freq ${item.frequencyOverlap.toFixed(2)} field ${item.stereoOverlap.toFixed(2)} center ${item.centerCompetition.toFixed(2)} together ${Math.round(item.simultaneousActivity * 100)}% → ${item.outcome}`,
  );
}
log("");
log(`Recommendations: ${plan.changes.length} (global ${plan.changes.filter((item) => item.scope.type === "global").length}, section ${plan.changes.filter((item) => item.scope.type === "section").length}, review ${plan.summary.reviewCount})`);
for (const item of plan.changes) {
  const where = item.scope.type === "global" ? "Global" : sectionName(item.scope.sectionId);
  const pan = item.processing.pan === null ? "pan —" : `pan ${describePan(item.current.pan)} → ${describePan(item.processing.pan)}`;
  const width = item.processing.width === null ? "width —" : `width ${describeWidth(item.current.width)} → ${describeWidth(item.processing.width)}`;
  log(`  ${name(item.trackId).padEnd(22)} ${where.padEnd(8)} ${pan.padEnd(28)} ${width.padEnd(22)} ${item.purpose.padEnd(11)} conf ${item.confidence.toFixed(2)} ${item.status}`);
  for (const reason of item.reasons) log(`      - ${reason}`);
  for (const warning of item.warnings) log(`      ! ${warning}`);
}
if (scenario.review) {
  log("");
  log("Reviewed:");
  for (const item of reviewed.changes) {
    log(`  ${name(item.trackId).padEnd(22)} ${item.status.padEnd(9)} pan ${item.processing.pan ?? "—"} width ${item.processing.width ?? "—"}${item.edited ? " (edited)" : ""}`);
  }
  log(`  Reviewed trim: ${reviewed.candidateTrim.gainDb} dB`);
}
