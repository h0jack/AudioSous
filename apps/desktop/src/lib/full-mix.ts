import type { TrackFileMeasurement } from "@audiosous/analysis-contract";
import { runJob } from "./planning-jobs";
import {
  applyFullMixPlan,
  changeIncluded,
  editChange,
  fullMixPlanIsStale,
  resetChange,
  setChangeStatus,
  setProblemStatus,
  solutionChanges,
  withRenderedCheck,
  type ChangePatch,
  type FullMixApplyMode,
  type FullMixPlan,
  type MixInputs,
  type MixStrength,
  type PlanFullMixInput,
} from "@audiosous/mix-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { getPlatform } from "../platform";
import type { DesktopPlatform, MixCheckResult, MixCheckVariant } from "../platform/types";
import { idleBalance, idleDynamics, idleEq, idleSpace, useAppStore, type FullMixCheck, type FullMixFocus, type FullMixSession } from "../state/app-store";
import { loadEnvelopeFrames } from "./dynamics";
import { loadBandFrames } from "./eq";
import { logEvent } from "./log";
import { monitorState } from "./monitor";
import { loadStereoFrames } from "./space";
import { loadTrackAnalysis } from "./track-analysis";

/** What Full Mix looks at. The timeline selection never narrows it. */
export function fullMixScope(document: ProjectDocument): string {
  const sections = document.sections.length;
  const parts = sections === 0 ? "the whole song" : `the whole song and each of the ${sections} ${sections === 1 ? "section" : "sections"}`;
  return `Reads level, frequency, stereo, and time-domain interactions over ${parts}, as the mix is now (every saved fader, EQ, pan, width, and dynamics node), and plans the fewest changes that improve it. The selection does not limit it.`;
}

export function fullMixPlanFresh(document: ProjectDocument, full: FullMixSession): boolean {
  return Boolean(full.plan && full.phase === "ready" && !fullMixPlanIsStale(full.plan, document, full.fingerprints, full.settings));
}

export async function runFullMixPlan(): Promise<void> {
  const store = useAppStore.getState();
  const document = store.document;
  const projectFile = store.projectFilePath;
  if (!document || !projectFile) return;
  const generation = store.fullMix.generation + 1;
  const projectId = document.project.id;
  store.setPlanTab("full");
  store.setFullMix({ open: true, generation, phase: "analyzing", progress: "Analyzing…", error: null, plan: null, preview: false, focus: null, selectedProblemId: null, selectedChangeId: null, check: null });
  const platform = getPlatform();
  await logEvent(platform, "info", "fullmix.start", "Started Full Mix planning.", { projectId, tracks: document.tracks.length, strength: store.fullMix.settings.strength, goal: store.fullMix.settings.goal });
  const current = () => useAppStore.getState().fullMix.generation === generation && useAppStore.getState().document?.project.id === projectId;
  try {
    const analysisStarted = performance.now();
    const loaded = await loadMixInputs(platform, projectFile, document, { current, progress: (label) => useAppStore.getState().setFullMix({ progress: label }) });
    if (!loaded) return;
    const { measurements, bands, stereo, envelopes, fingerprints, mixPeakDbfs } = loaded;
    const analysisMs = Math.round(performance.now() - analysisStarted);
    if (!current()) return;
    const latest = useAppStore.getState().document;
    if (!latest || latest.project.id !== projectId) return;
    useAppStore.getState().setFullMix({ phase: "planning", progress: "Planning: detecting problems, weighing alternatives, re-measuring candidates…", mixPeakDbfs });
    const started = performance.now();
    let plan = await planOffThread({ document: latest, measurements, bands, stereo, envelopes, fingerprints, settings: useAppStore.getState().fullMix.settings, mixPeakDbfs });
    const durationMs = Math.round(performance.now() - started);
    if (!current()) return;
    if (refuseStale(plan, fingerprints, "Discarded a Full Mix plan because the project changed while it was planned.")) return;
    useAppStore.getState().setFullMix({ phase: "checking", progress: "Rendering Current and the candidate through the native DSP…" });
    const checkStarted = performance.now();
    const check = await finalCheck(platform, projectFile, latest, plan);
    if (check) plan = withRenderedCheck(plan, check);
    const checkMs = Math.round(performance.now() - checkStarted);
    if (!current()) return;
    if (refuseStale(plan, fingerprints, "Discarded a Full Mix plan because the project changed while it was checked.")) return;
    const firstProblem = plan.problems.find((problem) => problem.interventionId) ?? plan.problems[0] ?? null;
    useAppStore.getState().setFullMix({ phase: "ready", progress: null, plan, fingerprints, error: null, check: check ? { ...check, notes: [] } : null, selectedProblemId: firstProblem?.id ?? null });
    await logEvent(platform, "info", "fullmix.complete", "Finished a Full Mix plan.", {
      projectId,
      problems: plan.problems.length,
      changes: plan.changes.length,
      independent: plan.evaluation.independent.total,
      review: plan.summary.reviewCount,
      confidence: plan.summary.confidence,
      plannerRuns: plan.evaluation.surveys,
      analysisMs,
      durationMs,
      checkMs,
    });
  } catch (caught) {
    if (!current()) return;
    const message = caught instanceof Error && caught.message ? caught.message : "Full Mix planning could not finish.";
    useAppStore.getState().setFullMix({ phase: "failed", progress: null, error: message, plan: null });
  }

  function refuseStale(plan: FullMixPlan, fingerprints: FullMixSession["fingerprints"], message: string): boolean {
    const after = useAppStore.getState().document;
    if (after && !fullMixPlanIsStale(plan, after, fingerprints, useAppStore.getState().fullMix.settings)) return false;
    void logEvent(platform, "info", "fullmix.stale", message, { projectId });
    useAppStore.getState().setFullMix({ phase: "failed", progress: null, error: "The project changed while Full Mix was planning. Run it again." });
    return true;
  }
}

export interface LoadedMixInputs {
  measurements: Record<string, TrackFileMeasurement | null>;
  bands: Awaited<ReturnType<typeof loadBandFrames>>;
  stereo: Awaited<ReturnType<typeof loadStereoFrames>>;
  envelopes: Awaited<ReturnType<typeof loadEnvelopeFrames>>;
  fingerprints: FullMixSession["fingerprints"];
  mixPeakDbfs: number | null;
}

/** The evidence stages Full Mix and Auto Mix measure, in order. */
export type MixInputStage = "levels" | "frequency" | "space" | "dynamics" | "peak";
export type MixInputStageState = "running" | "done" | "reused";

export interface LoadMixInputsOptions {
  current: () => boolean;
  progress: (label: string) => void;
  /** Called as each stage starts and ends; "reused" when its results were already current. */
  stage?: (stage: MixInputStage, state: MixInputStageState) => void;
}

/**
 * Measurements and frames per set of source files (ids, paths, size, modification time, mute), and the rendered
 * peak per mix state. Full Mix, Auto Mix, and the assistant all read through these, so a second request on an
 * unchanged project measures nothing again. The disk caches stay the source of truth; this saves the reading.
 */
let sourcesCache: { key: string; measurements: LoadedMixInputs["measurements"]; fingerprints: LoadedMixInputs["fingerprints"]; bands: LoadedMixInputs["bands"]; stereo: LoadedMixInputs["stereo"]; envelopes: LoadedMixInputs["envelopes"] } | null = null;
let peakCache: { key: string; mixPeakDbfs: number | null } | null = null;

/** The envelopes already loaded for this project, if any: for drawing a key's hits under a duck. */
export function cachedEnvelopes(projectId: string): LoadedMixInputs["envelopes"] | null {
  return sourcesCache && sourcesCache.key.startsWith(`${projectId}|`) ? sourcesCache.envelopes : null;
}

export function clearMixInputsCache(): void {
  sourcesCache = null;
  peakCache = null;
}

function sourcesKey(document: ProjectDocument, fingerprints: LoadedMixInputs["fingerprints"]): string {
  const stamp = new Map(fingerprints.map((item) => [item.trackId, `${item.fileSizeBytes}:${item.modifiedAtNs}`]));
  return `${document.project.id}|${document.tracks.map((track) => `${track.id}:${track.file.relativePath}:${stamp.get(track.id) ?? "?"}:${track.muted}`).join(",")}`;
}

/**
 * Everything Full Mix measures from: each stem's analysis, band, stereo, and envelope frames from the proxies, and
 * the current mix's rendered peak. Shared by Full Mix, Auto Mix, and the assistant. Null when `current` went false.
 */
export async function loadMixInputs(platform: DesktopPlatform, projectFile: string, document: ProjectDocument, options: LoadMixInputsOptions): Promise<LoadedMixInputs | null> {
  if (platform.kind !== "tauri") throw new Error("Full Mix reads the desktop analysis cache and the playback proxies. Open this project in the desktop app.");
  const { current, progress } = options;
  const stage = options.stage ?? (() => undefined);
  const statuses = await platform.projectMediaStatus(projectFile, document.tracks.map((track) => track.file.relativePath));
  if (!current()) return null;
  const fingerprints: LoadedMixInputs["fingerprints"] = [];
  for (const track of document.tracks) {
    const status = statuses.find((item) => item.relativePath === track.file.relativePath);
    if (status) fingerprints.push({ trackId: track.id, fileSizeBytes: status.fileSizeBytes, modifiedAtNs: status.modifiedAtNs });
  }
  const key = sourcesKey(document, fingerprints);
  let sources = sourcesCache?.key === key ? sourcesCache : null;
  if (sources) {
    for (const reused of ["levels", "frequency", "space", "dynamics"] as const) stage(reused, "reused");
  } else {
    stage("levels", "running");
    const measurements: LoadedMixInputs["measurements"] = {};
    for (const [index, track] of document.tracks.entries()) {
      if (!current()) return null;
      progress(`Analyzing ${index + 1} of ${document.tracks.length}: ${track.name}`);
      const loaded = await loadTrackAnalysis(platform, projectFile, { id: track.id, filename: track.file.filename, relativePath: track.file.relativePath }, undefined, 15);
      if (!current()) return null;
      measurements[track.id] = loaded.measurement;
    }
    stage("levels", "done");
    stage("frequency", "running");
    progress("Measuring frequency bands on the playback audio…");
    const bands = await loadBandFrames(platform, projectFile, document);
    if (!current()) return null;
    stage("frequency", "done");
    stage("space", "running");
    progress("Measuring the stereo field on the playback audio…");
    const stereo = await loadStereoFrames(platform, projectFile, document);
    if (!current()) return null;
    stage("space", "done");
    stage("dynamics", "running");
    progress("Measuring level envelopes on the playback audio…");
    const envelopes = await loadEnvelopeFrames(platform, projectFile, document);
    if (!current()) return null;
    stage("dynamics", "done");
    sources = { key, measurements, fingerprints, bands, stereo, envelopes };
    // A stem whose analysis failed is measured again next time rather than remembered as missing.
    if (document.tracks.every((track) => measurements[track.id])) sourcesCache = sources;
  }
  const mixKey = `${key}|${JSON.stringify(engineVariant("current", document))}`;
  let mixPeakDbfs: number | null;
  if (peakCache?.key === mixKey) {
    stage("peak", "reused");
    mixPeakDbfs = peakCache.mixPeakDbfs;
  } else {
    stage("peak", "running");
    progress("Rendering the current mix for its peak…");
    const before = await renderCheck(platform, projectFile, document, null, songWindows(document));
    if (!current()) return null;
    mixPeakDbfs = before?.[0]?.peakDbfs ?? null;
    if (mixPeakDbfs !== null) peakCache = { key: mixKey, mixPeakDbfs };
    stage("peak", "done");
  }
  return { measurements: sources.measurements, bands: sources.bands, stereo: sources.stereo, envelopes: sources.envelopes, fingerprints: sources.fingerprints, mixPeakDbfs };
}

/** Work the planning worker can do: Full Mix, the agent's mix reading, and simplification. */
export type WorkerJob =
  | { kind: "plan"; input: PlanFullMixInput }
  | { kind: "read"; document: ProjectDocument; inputs: MixInputs & { mixPeakDbfs: number | null }; strength: MixStrength; now: string }
  | { kind: "simplify"; input: PlanFullMixInput; plan: FullMixPlan; keep: number };

/** Runs a planning job in a Web Worker in the desktop app; directly where there is no worker (tests). */
export function runOffThread<T>(job: WorkerJob): Promise<T> {
  if (typeof Worker === "undefined") return Promise.resolve(runJob(job) as T);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./full-mix-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ ok: true; result: T } | { ok: false; message: string }>) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Planning failed."));
    };
    worker.postMessage(job);
  });
}

/** Plans in a Web Worker in the desktop app; directly where there is no worker (tests). */
export function planOffThread(input: PlanFullMixInput): Promise<FullMixPlan> {
  return runOffThread<FullMixPlan>({ kind: "plan", input });
}

/* ------------------------------------------------------------------ render check */

/** Representative windows of the song: a stretch of every section and every boundary between sections. */
export function songWindows(document: ProjectDocument): Array<[number, number]> {
  const duration = document.project.durationSeconds;
  if (document.sections.length === 0) return [[0, Math.min(duration, 30)]];
  const out: Array<[number, number]> = [];
  const ordered = [...document.sections].sort((left, right) => left.startTime - right.startTime);
  for (const section of ordered) {
    const middle = (section.startTime + section.endTime) / 2;
    out.push([Math.max(section.startTime, middle - 3), Math.min(section.endTime, middle + 3)]);
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const boundary = ordered[index]!.startTime;
    out.push([Math.max(0, boundary - 2), Math.min(duration, boundary + 2)]);
  }
  return out;
}

/** Windows where the plan's changes act: each change's own evidence windows, a few per change. */
export function problemWindows(plan: FullMixPlan): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const change of plan.changes.filter((item) => changeIncluded(item, "preview"))) {
    const windows = change.evidence.kind === "level" ? [] : change.evidence.evidence.windows;
    for (const window of windows.slice(0, 3)) out.push([window[0], Math.min(window[1], window[0] + 8)]);
  }
  return out;
}

/** The engine settings a document plays with, from the same monitor path playback uses. */
export function engineVariant(name: string, document: ProjectDocument): MixCheckVariant {
  const monitor = monitorState(document, idleBalance(), idleEq(), idleSpace(), idleDynamics());
  return {
    name,
    tracks: document.tracks.map((track) => ({ id: track.id, gainDb: monitor.gains.get(track.id) ?? track.gainDb, muted: track.muted })),
    gainRegions: monitor.gainRegions,
    eq: monitor.eq,
    spatial: monitor.spatial,
    dynamics: monitor.dynamics,
  };
}

async function renderCheck(platform: DesktopPlatform, projectFile: string, document: ProjectDocument, candidate: ProjectDocument | null, windows: Array<[number, number]>): Promise<MixCheckResult[] | null> {
  try {
    const variants = [engineVariant("current", document), ...(candidate ? [engineVariant("candidate", candidate)] : [])];
    const results = await platform.checkMix(projectFile, {
      tracks: document.tracks.map((track) => ({ trackId: track.id, relativePath: track.file.relativePath })),
      variants,
      windows,
      sections: document.sections.map((section) => ({ id: section.id, startSeconds: section.startTime, endSeconds: section.endTime })),
      durationSeconds: document.project.durationSeconds,
    });
    return results.length === variants.length ? results : null;
  } catch {
    return null;
  }
}

/**
 * The broad final check: Current and the candidate as Apply would write it (included changes and safety trim) are
 * rendered through the native DSP from the proxies over the song's representative windows and the windows where
 * the changes act, and compared: peak, level, mono fold-down, correlation, and the level step at every boundary.
 */
export async function finalCheck(platform: DesktopPlatform, projectFile: string, document: ProjectDocument, plan: FullMixPlan): Promise<Omit<FullMixCheck, "notes"> & { steps: Array<{ sectionId: string; name: string; changeDb: number }> } | null> {
  const applied = applyFullMixPlan(document, plan, "all");
  if (!applied.ok) return null;
  const results = await renderCheck(platform, projectFile, document, applied.document, [...songWindows(document), ...problemWindows(plan)]);
  if (!results) return null;
  const [now, candidate] = results as [MixCheckResult, MixCheckResult];
  await logEvent(platform, "info", "fullmix.check", "Rendered the Full Mix check.", { seconds: Math.round(now.seconds), currentPeak: now.peakDbfs, candidatePeak: candidate.peakDbfs });
  const ordered = [...document.sections].sort((left, right) => left.startTime - right.startTime);
  const level = (result: MixCheckResult, id: string) => result.sections.find((section) => section.id === id)?.rmsDb ?? null;
  const steps: Array<{ sectionId: string; name: string; changeDb: number }> = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const [previous, section] = [ordered[index - 1]!, ordered[index]!];
    const values = [level(now, previous.id), level(now, section.id), level(candidate, previous.id), level(candidate, section.id)];
    if (values.some((value) => value === null)) continue;
    const [a, b, c, d] = values as number[];
    steps.push({ sectionId: section.id, name: section.name, changeDb: Math.round((d! - c! - (b! - a!)) * 100) / 100 });
  }
  const pick = (result: MixCheckResult) => ({ peakDbfs: round2(result.peakDbfs), rmsDb: round2(result.rmsDb), monoLossDb: round2(result.monoLossDb), correlation: Math.round(result.correlation * 1000) / 1000 });
  return { seconds: now.seconds, current: pick(now), candidate: pick(candidate), steps };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ review */

export function cancelFullMixPlan(): void {
  const state = useAppStore.getState();
  state.setFullMix({ generation: state.fullMix.generation + 1, phase: "idle", plan: null, preview: false, focus: null, selectedProblemId: null, selectedChangeId: null, progress: null, error: null, open: false, check: null });
  void logEvent(getPlatform(), "info", "fullmix.cancel", "Cancelled Full Mix.", { projectId: state.document?.project.id ?? null });
}

/**
 * Writes the chosen changes (gain, EQ, space, dynamics, and the safety trim) in one project update: one undo step
 * restores the whole previous mix. If any change cannot be stored, nothing is written and the reason is shown.
 */
export function applyFullMix(mode: FullMixApplyMode): boolean {
  const state = useAppStore.getState();
  const document = state.document;
  const plan = state.fullMix.plan;
  if (!document || !plan) return false;
  if (fullMixPlanIsStale(plan, document, state.fullMix.fingerprints, state.fullMix.settings)) {
    void logEvent(getPlatform(), "info", "fullmix.stale", "Refused to apply an out-of-date Full Mix plan.", { projectId: document.project.id });
    return false;
  }
  const result = applyFullMixPlan(document, plan, mode);
  if (!result.ok) {
    const names = result.failures.map((failure) => {
      const change = plan.changes.find((item) => item.id === failure.changeId);
      const track = document.tracks.find((item) => item.id === change?.trackId)?.name ?? "a stem";
      return `${track}: ${failure.message}`;
    });
    state.setFullMix({ error: `Nothing was applied. ${names.join(" ")} Reject that change or make room for it, then apply again.` });
    void logEvent(getPlatform(), "warn", "fullmix.apply", "Refused to apply a Full Mix plan partly.", { projectId: document.project.id, failures: result.failures.length });
    return false;
  }
  useAppStore.getState().replaceDocument(result.document, true, { mode: "record" });
  useAppStore.getState().setFullMix({ generation: state.fullMix.generation + 1, phase: "idle", plan: null, preview: false, focus: null, selectedProblemId: null, selectedChangeId: null, progress: null, error: null, check: null });
  useAppStore.getState().setNotice("Full Mix applied. Undo restores the whole previous mix.");
  void logEvent(getPlatform(), "info", "fullmix.apply", "Applied a Full Mix plan.", { projectId: document.project.id, mode, changes: result.applied });
  return true;
}

function stopOthers(): void {
  useAppStore.getState().setBalance({ preview: false, auditionId: null });
  useAppStore.getState().setEq({ preview: false, auditionId: null });
  useAppStore.getState().setSpace({ preview: false, auditionId: null });
  useAppStore.getState().setDynamics({ preview: false, auditionId: null });
}

/** Whole-mix A/B: Current or the Full Mix Candidate. Starting it stops any other plan's audition. */
export function setFullMixPreview(preview: boolean): void {
  useAppStore.getState().setFullMix({ preview, focus: null });
  if (preview) stopOthers();
  void logEvent(getPlatform(), "info", "fullmix.preview", preview ? "Playing the Full Mix Candidate." : "Playing the current mix.", { mode: preview ? "candidate" : "current" });
}

/**
 * Per-problem or per-change A/B: "only" plays the saved mix with just that solution (or change); "without" plays
 * the whole candidate without it. The same button again stops the focus.
 */
export function auditionFullMix(focus: FullMixFocus): void {
  const full = useAppStore.getState().fullMix;
  const same = full.focus?.kind === focus.kind && full.focus.id === focus.id && full.focus.side === focus.side;
  useAppStore.getState().setFullMix(same ? { focus: null } : { focus, preview: focus.side === "without" });
  if (!same) stopOthers();
  void logEvent(getPlatform(), "info", "fullmix.preview", "Auditioned part of the Full Mix plan.", { kind: focus.kind, side: same ? "off" : focus.side });
}

function updatePlan(next: FullMixPlan): void {
  useAppStore.getState().setFullMix({ plan: next });
}

export function setFullMixChangeStatus(id: string, status: "accepted" | "rejected" | "proposed"): void {
  const plan = useAppStore.getState().fullMix.plan;
  if (plan) updatePlan(setChangeStatus(plan, id, status));
}

export function setFullMixProblemStatus(problemId: string, status: "accepted" | "rejected"): void {
  const plan = useAppStore.getState().fullMix.plan;
  if (plan) updatePlan(setProblemStatus(plan, problemId, status));
}

/** Edits one change with its own planner's bounds and re-checks it; the edit is heard right away. */
export function editFullMixChange(id: string, patch: ChangePatch): void {
  const plan = useAppStore.getState().fullMix.plan;
  if (!plan) return;
  updatePlan(editChange(plan, id, patch));
  const full = useAppStore.getState().fullMix;
  const change = full.plan?.changes.find((item) => item.id === id);
  if (!change) return;
  if (full.preview && !full.focus && changeIncluded(change, "preview")) return;
  if (full.focus?.kind === "change" && full.focus.id === id && full.focus.side === "only") return;
  useAppStore.getState().setFullMix({ focus: { kind: "change", id, side: "only" }, preview: false });
  stopOthers();
}

export function resetFullMixChange(id: string): void {
  const plan = useAppStore.getState().fullMix.plan;
  if (plan) updatePlan(resetChange(plan, id));
}

/** What the Full Mix panel is playing right now, in words. */
export function fullMixHearing(document: ProjectDocument, full: FullMixSession): string {
  const plan = full.plan;
  if (!plan || full.phase !== "ready") return "Hearing the saved mix";
  const matched = full.loudnessMatch ? ", loudness-matched" : "";
  if (full.focus) {
    if (full.focus.kind === "problem") {
      const problem = plan.problems.find((item) => item.id === full.focus!.id);
      return full.focus.side === "only" ? `Hearing only the fix for: ${problem?.title ?? "this problem"}${matched}` : `Hearing the candidate without the fix for: ${problem?.title ?? "this problem"}${matched}`;
    }
    const change = plan.changes.find((item) => item.id === full.focus!.id);
    const name = document.tracks.find((track) => track.id === change?.trackId)?.name ?? "this stem";
    return full.focus.side === "only" ? `Hearing ${name} with only this change${matched}` : `Hearing the candidate without this ${name} change${matched}`;
  }
  return full.preview ? `Hearing the Full Mix Candidate${matched}` : "Hearing Current (saved mix)";
}

export { solutionChanges };
