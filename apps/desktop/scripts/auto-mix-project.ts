/**
 * Acceptance harness for Auto Mix: the desktop's own orchestrator (`runAutoMix`, the store, the Full Mix apply and
 * undo) on a real project folder's cached analysis, compared with the four planners on their own and with Full Mix
 * run directly. Writes export.json for the export harness:
 *
 *   npx vite-node apps/desktop/scripts/auto-mix-project.ts -- target/acceptance/m7-good.json
 *   cargo run --release -p audiosous-audio --example export_mix -- OUT_DIR
 *
 * Only analysis loading is replaced (the scenario loader reads the project's cache, as the desktop would); the
 * render check needs the desktop shell and is skipped. The project file is never written.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { applyMixPlan, planBalance } from "@audiosous/balance-planner";
import { planDynamics } from "@audiosous/dynamics-planner";
import { planEq } from "@audiosous/eq-planner";
import { changeIncluded, explainDynamics, explainEq, explainGain, explainSpace, fullMixDifference, interactionFor, planFullMix, type FullMixPlan } from "@audiosous/mix-planner";
import { planSpace } from "@audiosous/spatial-planner";
import { loadScenario } from "../../../packages/mix-planner/scripts/scenario";
import { applyAutoMix, autoMixSummaryLines, runAutoMix, type AutoMixDeps } from "../src/lib/auto-mix";
import { engineVariant } from "../src/lib/full-mix";
import { useAppStore } from "../src/state/app-store";

const scenarioPath = process.argv.slice(2).find((arg) => arg !== "--");
if (!scenarioPath) throw new Error("Pass a scenario JSON path.");
const loaded = loadScenario(scenarioPath);
const { scenario, measurements, bands, stereo, envelopes, document } = loaded;
const projectDir = resolve(scenario.project);
const out = resolve(scenario.out.replace(/\/?$/, "-automix"));
mkdirSync(out, { recursive: true });
const strength = scenario.strength ?? "normal";
const lines: string[] = [];
const say = (line = "") => {
  lines.push(line);
  console.log(line);
};
const name = (id: string) => document.tracks.find((track) => track.id === id)?.name.replace("Sub Operator V4.23 ", "") ?? id;

useAppStore.getState().openDocument(document, join(projectDir, "project.amix"), []);
useAppStore.getState().setFullMix({ settings: { strength, goal: scenario.goal ?? "balanced" } });

let loads = 0;
const deps: AutoMixDeps = {
  waitForAudio: async () => ({ ok: true }),
  loadInputs: async (_document, options) => {
    loads += 1;
    for (const stage of ["levels", "frequency", "space", "dynamics", "peak"] as const) {
      options.stage?.(stage, "running");
      options.stage?.(stage, "done");
    }
    return { measurements, bands, stereo, envelopes, fingerprints: [], mixPeakDbfs: scenario.mixPeakDbfs ?? null };
  },
  plan: async (input) => planFullMix(input),
  check: async () => null,
  now: () => performance.now(),
};

say(`Auto Mix acceptance: ${scenario.project} (${scenarioPath}), strength ${strength}`);
const first = performance.now();
await runAutoMix({ strength }, deps);
const firstMs = performance.now() - first;
const state = useAppStore.getState();
if (state.autoMix.phase !== "ready" || !state.fullMix.plan) throw new Error(`Auto Mix did not finish: ${state.autoMix.error ?? state.autoMix.phase}`);
const plan: FullMixPlan = state.fullMix.plan;
const summary = state.autoMix.summary!;
const text = autoMixSummaryLines(summary);
say();
say("RECOMMENDED MIX");
say(`Analyzed: ${text.analyzed.join(", ")}`);
say(`Detected: ${text.detected.join(", ")}`);
say(`Final coordinated plan: ${text.kept.join(", ")}`);
if (text.omitted) say(text.omitted);
say(`Stages: ${state.autoMix.stages.map((stage) => `${stage.label} ${stage.status}`).join(" · ")}`);
say(`Auto Mix ${firstMs.toFixed(0)} ms (planning in Node, no render check)`);

// The same project through the four planners on their own, and Full Mix run directly.
const now = plan.createdAt;
const independent = {
  gain: planBalance({ document, measurements: Object.fromEntries(document.tracks.map((track) => [track.id, { track: measurements[track.id] ?? null }])), settings: { strength }, now }),
  eq: planEq({ document, measurements, bands, settings: { strength }, now }),
  space: planSpace({ document, measurements, bands, stereo, settings: { strength }, now }),
  dynamics: planDynamics({ document, measurements, envelopes, bands, settings: { strength }, now }),
};
const counts = plan.evaluation.independent;
void applyMixPlan;
void independent;
const direct = planFullMix({ document, measurements, bands, stereo, envelopes, settings: { strength, goal: scenario.goal ?? "balanced" }, fingerprints: [], mixPeakDbfs: scenario.mixPeakDbfs ?? null, now });
const same = JSON.stringify({ ...direct, createdAt: "" }) === JSON.stringify({ ...plan, createdAt: "" });
say();
say(`Individual planners on their own: gain ${counts.level}, EQ ${counts.eq}, space ${counts.space}, dynamics ${counts.dynamics} (total ${counts.total})`);
say(`Full Mix run directly on the same project: ${direct.changes.filter((change) => changeIncluded(change, "preview")).length} changes; Auto Mix plan identical: ${same ? "yes" : "NO"}`);

// Visual difference: what an inexperienced listener would see.
const diff = fullMixDifference(document, plan, { envelopes })!;
say();
say(`WHAT CHANGES (difference scale ±${diff.eqDifferenceScaleDb} dB${diff.subtle ? ", all subtle" : ""})`);
if (diff.trimDb) say(`  Every stem ${diff.trimDb.toFixed(1)} dB (safety trim)`);
for (const row of diff.gain) say(`  ${explainGain(row)}`);
for (const row of diff.eq) say(`  ${explainEq(row, interactionFor(diff, row))}`);
for (const row of diff.space) say(`  ${explainSpace(row)}`);
for (const row of diff.dynamics) say(`  ${explainDynamics(row)}${row.keyEvents ? ` [${row.keyEvents.length} ${row.keyName} hits drawn]` : ""}${row.timeline ? ` [${row.timeline.values.length}-point reduction timeline]` : ""}`);
for (const item of diff.interactions) say(`  ${item.label}: ${item.measure} ${item.before.toFixed(2)} → ${item.after.toFixed(2)}`);
for (const metric of diff.metrics) say(`  ${metric.label}: ${metric.before.toFixed(2)} → ${metric.after.toFixed(2)} ${metric.unit}`);
say(`  Sections marked: ${diff.sections.map((marker) => `${marker.name} [${marker.domains.join(",")}]`).join(" ") || "none (song-wide changes only)"}`);

// Cache reuse: the second click does not measure or plan again.
const second = performance.now();
await runAutoMix({ strength }, deps);
const secondMs = performance.now() - second;
say();
say(`Second Auto Mix on the unchanged project: ${secondMs.toFixed(1)} ms, inputs loaded ${loads} time(s) in all, stages ${useAppStore.getState().autoMix.stages.every((stage) => stage.status === "reused") ? "all reused" : "recomputed"}`);

// Apply is one undo step.
const before = JSON.stringify(useAppStore.getState().document!.tracks);
const applied = applyAutoMix();
const appliedDocument = useAppStore.getState().document!;
say(`Apply: ${applied ? "ok" : "refused"}, history ${useAppStore.getState().history.past.length} step(s)`);
useAppStore.getState().undo();
say(`Undo restores the mix: ${JSON.stringify(useAppStore.getState().document!.tracks) === before ? "yes" : "NO"}`);

// For the export harness: the applied Recommended Mix and the current mix, as the engine plays them.
const sources = document.tracks.map((track) => ({ trackId: track.id, path: join(projectDir, track.file.relativePath) }));
writeFileSync(join(out, "export.json"), JSON.stringify({ project: projectDir, durationSeconds: document.project.durationSeconds, projectRate: document.project.sampleRate, sources, variants: { current: engineVariant("current", document), recommended: engineVariant("recommended", appliedDocument) } }, null, 2));
writeFileSync(join(out, "report.txt"), `${lines.join("\n")}\n`);
writeFileSync(join(out, "plan.json"), JSON.stringify(plan, null, 2));
console.log(`\nWrote ${out}/report.txt, plan.json, export.json`);
console.log(`Stems: ${document.tracks.map((track) => name(track.id)).join(", ")}`);
