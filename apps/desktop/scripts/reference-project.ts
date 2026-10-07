/**
 * Acceptance harness for planning toward a reference: the reference planner on a real project's cached analysis,
 * with the mix and the reference measured by `profile_audio`, then the candidate written out to be rendered and
 * measured again (so predicted and measured gaps can be compared).
 *
 *   cargo run --release -p audiosous-audio --example profile_audio -- file REFERENCE ref.json
 *   cargo run --release -p audiosous-audio --example profile_audio -- mix variants.json saved mix.json
 *   npx vite-node apps/desktop/scripts/reference-project.ts -- PROJECT_DIR mix.json ref.json "Name" OUT.json [strength]
 *   cargo run --release -p audiosous-audio --example profile_audio -- mix OUT.json candidate after.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { applyFullMixPlan, compareToReference, describeChange, planReferenceMatch, songProfileSchema, type MixStrength } from "@audiosous/mix-planner";
import { loadScenario } from "../../../packages/mix-planner/scripts/scenario";
import { engineVariant } from "../src/lib/full-mix";

const [projectArg, mixArg, refArg, name, outArg, strengthArg] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!projectArg || !mixArg || !refArg || !name || !outArg) throw new Error("Pass PROJECT_DIR mix.json ref.json NAME OUT.json [strength].");
const projectDir = resolve(projectArg);
const out = resolve(outArg);
mkdirSync(dirname(out), { recursive: true });
const scenarioPath = join(dirname(out), "reference-scenario.json");
writeFileSync(scenarioPath, JSON.stringify({ project: projectDir, out: dirname(out) }));
const { document, measurements, bands, stereo, envelopes } = loadScenario(scenarioPath);
const mixProfile = songProfileSchema.parse(JSON.parse(readFileSync(mixArg, "utf8")));
const referenceProfile = songProfileSchema.parse(JSON.parse(readFileSync(refArg, "utf8")));
const strength = (strengthArg ?? "normal") as MixStrength;
const names = (id: string) => document.tracks.find((track) => track.id === id)?.name.replace(/^Generated From Generated From Notes V\.0\.29 /, "") ?? id;

const comparison = compareToReference(mixProfile, referenceProfile);
console.log(`Your mix against “${name}”:`);
for (const gap of comparison.tonal) console.log(`  ${gap.region.label.padEnd(24)} ${gap.gapDb >= 0 ? "+" : ""}${gap.gapDb.toFixed(2)} dB`);
for (const gap of comparison.width) console.log(`  sides, ${gap.region.label.padEnd(17)} ${gap.gapDb >= 0 ? "+" : ""}${gap.gapDb.toFixed(2)} dB`);
for (const line of comparison.findings) console.log(`  • ${line}`);

const started = performance.now();
const plan = planReferenceMatch({ document, measurements, bands, stereo, envelopes, mixProfile, referenceProfile, referenceName: name, strength, now: "2026-10-07T00:00:00.000Z", trace: process.env.TRACE ? (line) => console.log(`[trace] ${line}`) : undefined });
console.log(`\nPlan (${strength}, ${(performance.now() - started).toFixed(0)} ms): ${plan.summary.headline}`);
for (const change of plan.changes) console.log(`  ${names(change.trackId)}: ${describeChange(change.processing, names, change.evidence.kind === "reference" ? (change.evidence.current ?? undefined) : undefined)}${change.replacesNodeId ? ` (edits saved: ${change.current})` : ""} — ${change.evaluation.summary}`);
for (const problem of plan.problems.filter((item) => item.outcome === "left-alone")) console.log(`  left alone: ${problem.title} ${problem.explanation}`);
for (const regression of plan.evaluation.regressions) console.log(`  side effect: ${regression.description}`);
const predicted = Object.fromEntries((plan.reference?.regions ?? []).map((region) => [region.id, region.gapAfterDb]));
const applied = applyFullMixPlan(document, plan, "all");
if (!applied.ok) throw new Error("The plan did not apply.");
writeFileSync(
  out,
  JSON.stringify({ durationSeconds: document.project.durationSeconds, sources: document.tracks.map((track) => ({ trackId: track.id, path: join(projectDir, track.file.relativePath) })), predicted, variants: { saved: engineVariant("saved", document), candidate: engineVariant("candidate", applied.document) } }, null, 2),
);
console.log(`\nWrote ${out}`);
