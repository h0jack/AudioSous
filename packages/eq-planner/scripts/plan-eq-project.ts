/**
 * Acceptance harness: run the EQ planner on a real project folder from its cached analysis.
 *
 *   npx vite-node packages/eq-planner/scripts/plan-eq-project.ts -- scenario.json
 *
 * The scenario edits the document in memory only. The project file is never written.
 * Output: a readable report on stdout, and plan.json + audition.json in `out` for render-eq-audition.py.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { analysisCacheEntrySchema, eqBandsCacheSchema, type EqBandFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import {
  deserializeProject,
  setTrackEqNodes,
  setTrackSectionState,
  type EqFilter,
  type ProjectDocument,
  type SectionType,
  type TrackRole,
} from "@audiosous/project-model";
import { eqAudition, formatHz, planEq, type EqStrength } from "../src/index";

interface Scenario {
  project: string;
  out: string;
  strength?: EqStrength;
  /** Keyed by a case-insensitive substring of the track name. */
  tracks?: Record<string, { role?: TrackRole; gainDb?: number; customLabel?: string | null; muted?: boolean; eq?: EqFilter[] }>;
  sections?: Array<{ id: string; name: string; type: SectionType; start: number; end: number; intent?: string | null }>;
  trackSection?: Array<{ track: string; section: string; prominence?: "primary" | "focal" | "supporting"; intent?: string }>;
  /** Accept every row except these (track substrings), then edit, as a reviewer would. */
  review?: { reject?: string[]; edit?: Array<{ track: string; gainDb?: number; frequencyHz?: number; q?: number }> };
}

const scenarioPath = process.argv.slice(2).find((arg) => arg !== "--");
if (!scenarioPath) throw new Error("Pass a scenario JSON path.");
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
const projectDir = resolve(scenario.project);

const loadStarted = performance.now();
let document: ProjectDocument = deserializeProject(readFileSync(join(projectDir, "project.amix"), "utf8"));
const measurements: Record<string, TrackFileMeasurement | null> = {};
const bands: Record<string, EqBandFrames | null> = {};
for (const track of document.tracks) {
  try {
    bands[track.id] = process.env.EQ_NO_BANDS === "1" ? null : eqBandsCacheSchema.parse(JSON.parse(readFileSync(join(projectDir, "cache/analysis", `${track.id}__eqbands.json`), "utf8"))).bands;
  } catch {
    bands[track.id] = null;
  }
  try {
    const entry = analysisCacheEntrySchema.parse(JSON.parse(readFileSync(join(projectDir, "cache/analysis", `${track.id}.json`), "utf8")));
    measurements[track.id] = entry.measurement;
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
  const result = setTrackSectionState(document, byName(row.track).id, row.section, { prominence: row.prominence, userIntent: row.intent });
  if (!result.ok) throw new Error(`Could not set ${row.track} in ${row.section}.`);
  document = result.document;
}

const planStarted = performance.now();
const tracing = process.env.EQ_TRACE === "1";
const plan = planEq({
  document,
  measurements,
  bands,
  settings: { strength: scenario.strength ?? "normal" },
  now: "2026-10-04T00:00:00.000Z",
  trace: tracing
    ? (stage, detail) => {
        process.stdout.write(`[trace] ${stage}\n`);
        for (const item of detail as Array<{ track: string; scope: unknown; filter: { kind: string; frequencyHz: number; gainDb: number; q: number }; purpose: string; evaluation: unknown; benefit: number }>) {
          const label = document.tracks.find((track) => track.id === item.track)?.name.replace(/^Sub Operator V[\d.]+ /, "") ?? item.track;
          process.stdout.write(`   ${label} ${JSON.stringify(item.scope)} ${item.filter.kind} ${item.filter.frequencyHz} ${item.filter.gainDb} q${item.filter.q} ${item.purpose} ${JSON.stringify(item.evaluation)} b=${item.benefit.toFixed(2)}\n`);
        }
      }
    : undefined,
});
const planMs = performance.now() - planStarted;

const name = (id: string) => document.tracks.find((track) => track.id === id)?.name.replace(/^Sub Operator V[\d.]+ /, "") ?? id;
const sectionName = (id: string) => document.sections.find((item) => item.id === id)?.name ?? id;

const current = eqAudition(document, plan, { mode: "current" });
const candidate = eqAudition(document, plan, { mode: "candidate" });
let reviewed = plan;
if (scenario.review) {
  const { setEqRecommendationStatus, editEqRecommendation } = await import("../src/index");
  for (const change of plan.changes) {
    const reject = scenario.review.reject?.some((needle) => name(change.trackId).toLowerCase().includes(needle.toLowerCase()));
    reviewed = setEqRecommendationStatus(reviewed, change.id, reject ? "rejected" : "accepted");
  }
  for (const edit of scenario.review.edit ?? []) {
    const change = reviewed.changes.find((item) => name(item.trackId).toLowerCase().includes(edit.track.toLowerCase()) && item.status === "accepted");
    if (change) reviewed = editEqRecommendation(reviewed, change.id, { gainDb: edit.gainDb, frequencyHz: edit.frequencyHz, q: edit.q });
  }
}
const accepted = eqAudition(document, reviewed, { mode: "candidate" });

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
        pan: track.pan,
        sectionGains: document.sectionTrackSettings
          .filter((row) => row.trackId === track.id && row.overrides.gainDb !== null)
          .map((row) => {
            const section = document.sections.find((item) => item.id === row.sectionId)!;
            return { startSeconds: section.startTime, endSeconds: section.endTime, gainDb: row.overrides.gainDb };
          }),
      })),
      current,
      candidate,
      accepted,
      checks: plan.changes.map((change) => ({
        id: change.id,
        trackId: change.trackId,
        protectedTrackIds: change.protectedTrackIds,
        windows: change.evidence.windows,
        focus: change.evidence.focus ? [change.evidence.edgesHz[change.evidence.focus[0]], change.evidence.edgesHz[change.evidence.focus[1] + 1]] : null,
      })),
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
for (const note of plan.summary.notes) log(`  note: ${note}`);
log("");
log("Top interactions:");
for (const item of plan.interactions.slice(0, 12)) {
  const region = item.regions[0];
  log(
    `  ${item.scopeName.padEnd(12)} ${`${name(item.trackA)} ↔ ${name(item.trackB)}`.padEnd(38)} ${item.kind.padEnd(12)} sev ${item.severity.toFixed(2)} overlap ${Math.round(item.overlap * 100)}% together ${Math.round(item.simultaneousActivity * 100)}% ${region ? `${formatHz(region.lowHz)}–${formatHz(region.highHz)} Δ${region.levelDifferenceDb}` : ""} → ${item.outcome}`,
  );
}
log("");
log(`Recommendations: ${plan.changes.length} (global ${plan.changes.filter((item) => item.scope.type === "global").length}, section ${plan.changes.filter((item) => item.scope.type === "section").length}, review ${plan.summary.reviewCount})`);
for (const item of plan.changes) {
  const where = item.scope.type === "global" ? "Global" : sectionName(item.scope.sectionId);
  const filter = item.processing.filter;
  log(
    `  ${name(item.trackId).padEnd(22)} ${where.padEnd(8)} ${filter.kind.padEnd(10)} ${formatHz(filter.frequencyHz).padStart(9)} ${filter.kind.endsWith("pass") ? "    —" : `${filter.gainDb > 0 ? "+" : ""}${filter.gainDb.toFixed(1)}`.padStart(5)} Q ${filter.q.toFixed(2)}  conf ${item.confidence.toFixed(2)} ${item.status}  gap −${item.evaluation?.gapReductionDb ?? 0} dB, own ${item.evaluation?.identityChangeDb ?? 0} dB`,
  );
  for (const reason of item.reasons) log(`      - ${reason}`);
}
