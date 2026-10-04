/**
 * Acceptance harness: run AutoBalance on a real project folder from the cached analysis.
 *
 *   npx vite-node packages/balance-planner/scripts/plan-project.ts -- scenario.json
 *
 * The scenario edits the document in memory only. The project file is never written.
 * Output: a readable report on stdout, and plan.json + audition.json in `out` for the renderer.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { analysisCacheEntrySchema } from "@audiosous/analysis-contract";
import { deserializeProject, setTrackSectionState, type SectionType, type TrackRole } from "@audiosous/project-model";
import { auditionMix, planBalance, type BalanceStrength, type TrackMeasurements } from "../src/index";

interface Scenario {
  project: string;
  out: string;
  strength?: BalanceStrength;
  /** Keyed by a case-insensitive substring of the track name. */
  tracks?: Record<string, { role?: TrackRole; gainDb?: number; customLabel?: string | null }>;
  sections?: Array<{ id: string; name: string; type: SectionType; start: number; end: number; intent?: string | null }>;
  trackSection?: Array<{ track: string; section: string; prominence?: "primary" | "focal" | "supporting"; intent?: string }>;
}

const scenarioPath = process.argv.slice(2).find((arg) => arg !== "--");
if (!scenarioPath) throw new Error("Pass a scenario JSON path.");
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
const projectDir = resolve(scenario.project);

const loadStarted = performance.now();
let document = deserializeProject(readFileSync(join(projectDir, "project.amix"), "utf8"));
const measurements: Record<string, TrackMeasurements> = {};
for (const track of document.tracks) {
  try {
    const entry = analysisCacheEntrySchema.parse(JSON.parse(readFileSync(join(projectDir, "cache/analysis", `${track.id}.json`), "utf8")));
    measurements[track.id] = { track: entry.measurement };
  } catch {
    measurements[track.id] = { track: null };
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
        ? { ...track, role: patch.role ?? track.role, gainDb: patch.gainDb ?? track.gainDb, customLabel: patch.customLabel ?? track.customLabel }
        : track,
    ),
  };
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
const plan = planBalance({ document, measurements, settings: { strength: scenario.strength ?? "normal" }, now: "2026-10-04T00:00:00.000Z" });
const planMs = performance.now() - planStarted;
const candidate = auditionMix(document, plan, { mode: "candidate" });

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
        name: track.name,
        path: track.file.relativePath,
        muted: track.muted,
        currentGainDb: track.gainDb,
        currentRegions: document.sectionTrackSettings
          .filter((row) => row.trackId === track.id && row.overrides.gainDb !== null)
          .map((row) => {
            const section = document.sections.find((item) => item.id === row.sectionId)!;
            return { startSeconds: section.startTime, endSeconds: section.endTime, gainDb: row.overrides.gainDb };
          }),
      })),
      candidate,
    },
    null,
    2,
  ),
);

const name = (id: string) => document.tracks.find((track) => track.id === id)?.name ?? id;
const sectionName = (id: string) => document.sections.find((item) => item.id === id)?.name ?? id;
const largest = plan.trackChanges.reduce((max, item) => Math.max(max, Math.abs(item.deltaDb)), 0);
console.log(`Project: ${document.project.name}  (${document.tracks.length} tracks, ${document.sections.length} sections, strength ${plan.settings.strength})`);
console.log(`Cache load: ${loadMs.toFixed(1)} ms   Planner: ${planMs.toFixed(2)} ms`);
console.log(`Anchor: ${plan.anchor.label} — ${plan.anchor.reason}`);
console.log(`Confidence: ${plan.summary.confidence}   Headline: ${plan.summary.headline}`);
for (const note of plan.summary.notes) console.log(`  note: ${note}`);
console.log(
  `Recommendations: ${plan.trackChanges.length} (global ${plan.trackChanges.filter((item) => item.scope.type === "global").length}, section ${plan.trackChanges.filter((item) => item.scope.type === "section").length}, needs-review ${plan.summary.reviewCount})   Largest move: ${largest.toFixed(1)} dB   Candidate trim: ${plan.candidateTrim.gainDb} dB`,
);
for (const item of plan.trackChanges) {
  const where = item.scope.type === "global" ? "global" : sectionName(item.scope.sectionId);
  console.log(
    `  ${name(item.trackId).padEnd(38)} ${where.padEnd(10)} ${item.currentGainDb.toFixed(1).padStart(5)} → ${item.recommendedGainDb.toFixed(1).padStart(5)} (${item.deltaDb > 0 ? "+" : ""}${item.deltaDb.toFixed(1)})  conf ${item.confidence} ${item.status}`,
  );
  for (const reason of item.reasons) console.log(`      - ${reason}`);
}
