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
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { applyMixPlan, planBalance } from "@audiosous/balance-planner";
import { applyDynamicsPlan, planDynamics } from "@audiosous/dynamics-planner";
import { applyEqPlan, planEq } from "@audiosous/eq-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { applySpacePlan, planSpace } from "@audiosous/spatial-planner";
import {
  applyFullMixPlan,
  describeChange,
  editChange,
  fullMixAudition,
  planFullMix,
  setChangeStatus,
  type FullMixPlan,
} from "../src/index";
import { engineSettings, loadScenario } from "./scenario";

const scenarioPath = process.argv.slice(2).find((arg) => arg !== "--");
if (!scenarioPath) throw new Error("Pass a scenario JSON path.");
const loaded = loadScenario(scenarioPath);
const { scenario, measurements, bands, stereo, envelopes, loadMs, byName } = loaded;
let document: ProjectDocument = loaded.document;
const projectDir = resolve(scenario.project);

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
