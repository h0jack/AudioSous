import { changeIncluded, fullMixPlanIsStale, fullMixStateIdentity, withRenderedCheck, type FullMixPlan, type FullMixSettings, type MixProblemType, type MixStrength, type PlanFullMixInput } from "@audiosous/mix-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { getPlatform } from "../platform";
import { useAppStore, type AutoMixStage, type AutoMixStageId, type AutoMixSummary, type FullMixCheck } from "../state/app-store";
import { cancelAutoBalance } from "./autobalance";
import { cancelDynamicsPlan } from "./dynamics";
import { cancelEqPlan } from "./eq";
import { applyFullMix, cancelFullMixPlan, finalCheck, loadMixInputs, planOffThread, type LoadedMixInputs, type LoadMixInputsOptions } from "./full-mix";
import { logEvent } from "./log";
import { cancelSpacePlan } from "./space";
import { gate, isActive, registerTaskActions } from "./tasks";

/**
 * Auto Mix: one action from loaded stems to one coordinated, verified candidate.
 *
 * It does not chain the planners' own recommendations. The Gain, EQ, Space, and Dynamics stages gather the evidence
 * those planners measure (analysis, band, stereo, and envelope frames, each reused when current); Full Mix then
 * runs the four planners as measurement, turns what they find into problems, weighs every planner's alternatives
 * for each problem against "no change", re-measures whole-mix candidates, and prunes what the mix does not miss.
 * Only what survives that is the Recommended Mix. It plays as a candidate and is written only by Apply (one undo).
 */

export const AUTO_MIX_STAGES: Array<{ id: AutoMixStageId; label: string }> = [
  { id: "prepare", label: "Preparing audio" },
  { id: "levels", label: "Analyzing levels" },
  { id: "frequency", label: "Checking frequency interactions" },
  { id: "space", label: "Evaluating stereo space" },
  { id: "dynamics", label: "Checking dynamics" },
  { id: "plan", label: "Building coordinated mix" },
  { id: "verify", label: "Verifying candidate" },
];

/** What Auto Mix needs from the app. The desktop passes the real ones; tests pass fixtures. */
export interface AutoMixDeps {
  /** Resolves when playback audio (the proxies every measurement reads) is ready; "failed" names why not. */
  waitForAudio: (current: () => boolean, detail: (text: string) => void) => Promise<{ ok: true } | { ok: false; reason: string }>;
  loadInputs: (document: ProjectDocument, options: LoadMixInputsOptions) => Promise<LoadedMixInputs | null>;
  plan: (input: PlanFullMixInput) => Promise<FullMixPlan>;
  check: (document: ProjectDocument, plan: FullMixPlan) => Promise<Omit<FullMixCheck, "notes"> & { steps: Array<{ sectionId: string; name: string; changeDb: number }> } | null>;
  now: () => number;
}

function desktopDeps(): AutoMixDeps {
  const platform = getPlatform();
  return {
    waitForAudio: waitForPlaybackAudio,
    loadInputs: (document, options) => {
      const projectFile = useAppStore.getState().projectFilePath;
      if (!projectFile) return Promise.resolve(null);
      return loadMixInputs(platform, projectFile, document, options);
    },
    plan: planOffThread,
    check: (document, plan) => {
      const projectFile = useAppStore.getState().projectFilePath;
      return projectFile && platform.kind === "tauri" ? finalCheck(platform, projectFile, document, plan) : Promise.resolve(null);
    },
    now: () => performance.now(),
  };
}

/** Waits for the engine's playback audio, the same proxies analysis frames read, instead of building them twice. */
async function waitForPlaybackAudio(current: () => boolean, detail: (text: string) => void): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (;;) {
    if (!current()) return { ok: true };
    const tasks = useAppStore.getState().tasks;
    const task = tasks["playback-proxy"];
    if (task?.status === "failed") return { ok: false, reason: `${task.error ?? "Playback audio could not be prepared"}. Retry it from the status bar, then run Auto Mix again.` };
    if (!task || !isActive(task)) return { ok: true };
    detail(task.detail ?? "Building playback audio");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function freshStages(): AutoMixStage[] {
  return AUTO_MIX_STAGES.map((stage) => ({ ...stage, status: "pending", detail: null }));
}

/** Whether Auto Mix can start, and why not. */
export function autoMixAvailability(): { ok: boolean; reason: string | null } {
  const state = useAppStore.getState();
  if (!state.document || state.document.tracks.length === 0) return { ok: false, reason: "Add stems first" };
  const planning = gate(state.tasks, "planning");
  if (planning.blocked) return { ok: false, reason: planning.reason };
  if (state.assistant.busy) return { ok: false, reason: "Wait for the assistant to finish, or cancel it" };
  if (state.autoMix.phase === "running") return { ok: false, reason: "Auto Mix is running" };
  return { ok: true, reason: null };
}

/**
 * Builds the Recommended Mix from the saved project. Open, unapplied Gain / EQ / Space / Dynamics candidates are
 * closed (they are never inputs); a fresh, unconstrained Full Mix plan with the same settings is reused as is.
 */
export async function runAutoMix(options: { strength?: MixStrength } = {}, deps: AutoMixDeps = desktopDeps()): Promise<void> {
  const store = useAppStore.getState();
  const document = store.document;
  if (!document || !autoMixAvailability().ok) return;
  const projectId = document.project.id;
  const settings: FullMixSettings = { ...store.fullMix.settings, strength: options.strength ?? store.fullMix.settings.strength };
  const started = deps.now();
  const platform = getPlatform();
  const generation = store.autoMix.generation + 1;
  const fullGeneration = store.fullMix.generation + 1;

  // Reuse: the open Full Mix plan already is this Auto Mix when it is fresh, unconstrained, and planned the same way.
  const existing = store.fullMix;
  if (existing.plan && existing.phase === "ready" && !existing.plan.constraints && existing.plan.settings.strength === settings.strength && existing.plan.settings.goal === settings.goal && !fullMixPlanIsStale(existing.plan, document, existing.fingerprints, settings)) {
    const stages = freshStages().map((stage) => ({ ...stage, status: "reused" as const, detail: "Current" }));
    finish(existing.plan, stages, Math.round(deps.now() - started));
    return;
  }

  supersedeOpenPlans();
  let stages = freshStages();
  const startIdentity = fullMixStateIdentity(document, settings);
  const current = () => {
    const state = useAppStore.getState();
    return state.autoMix.generation === generation && state.document?.project.id === projectId;
  };
  const changed = () => {
    const latest = useAppStore.getState().document;
    return !latest || fullMixStateIdentity(latest, settings) !== startIdentity;
  };
  const publish = () => {
    if (!current()) return;
    const index = stages.findIndex((stage) => stage.status === "running" || stage.status === "pending");
    const active = stages[index === -1 ? stages.length - 1 : index]!;
    useAppStore.getState().setAutoMix({ stages });
    useAppStore.getState().setTask({
      id: "auto-mix",
      kind: "auto-mix",
      label: "Auto Mix",
      status: "running",
      detail: active.detail ? `${active.label} — ${active.detail}` : active.label,
      stage: { index: (index === -1 ? stages.length : index) + 1, count: stages.length },
      steps: stages.map((stage) => ({ id: stage.id, label: stage.label, status: stage.status === "reused" ? "done" : stage.status === "skipped" ? "skipped" : stage.status, detail: stage.status === "reused" ? "reused" : stage.detail })),
      progress: null,
      blocks: ["planning", "export"],
      cancellable: true,
      major: true,
    });
  };
  const set = (id: AutoMixStageId, status: AutoMixStage["status"], detail: string | null = null) => {
    stages = stages.map((stage) => (stage.id === id ? { ...stage, status, detail } : stage));
    publish();
  };

  registerTaskActions("auto-mix", { cancel: cancelAutoMix, retry: () => void runAutoMix(options) });
  useAppStore.getState().setAutoMix({ generation, phase: "running", stages, planCreatedAt: null, summary: null, error: null, durationMs: null });
  publish();
  useAppStore.getState().setPlanTab("full");
  useAppStore.getState().setFullMix({ open: true, generation: fullGeneration, phase: "analyzing", progress: "Auto Mix is building the mix…", settings, plan: null, preview: false, focus: null, selectedProblemId: null, selectedChangeId: null, error: null, check: null });
  await logEvent(platform, "info", "automix.start", "Started Auto Mix.", { projectId, tracks: document.tracks.length, sections: document.sections.length, strength: settings.strength });

  try {
    set("prepare", "running");
    const audio = await deps.waitForAudio(current, (text) => set("prepare", "running", text));
    if (!current()) return;
    if (!audio.ok) return fail(audio.reason, "prepare");
    set("prepare", "done");
    if (changed()) return stale();

    const stageOf: Record<string, AutoMixStageId> = { levels: "levels", frequency: "frequency", space: "space", dynamics: "dynamics", peak: "plan" };
    const loaded = await deps.loadInputs(document, {
      current,
      progress: (label) => {
        const running = stages.find((stage) => stage.status === "running");
        if (running) set(running.id, "running", label.replace(/…$/, ""));
      },
      stage: (stage, state) => set(stageOf[stage]!, state === "running" ? "running" : state === "reused" ? "reused" : stage === "peak" ? "running" : "done"),
    });
    if (!current()) return;
    if (!loaded) return fail("Auto Mix could not read the project's analysis.", "levels");
    if (changed()) return stale();

    set("plan", "running", "Weighing every planner's alternatives against no change");
    const latest = useAppStore.getState().document!;
    useAppStore.getState().setFullMix({ phase: "planning", progress: "Auto Mix: building the coordinated mix…", mixPeakDbfs: loaded.mixPeakDbfs });
    const planStarted = deps.now();
    let plan = await deps.plan({ document: latest, measurements: loaded.measurements, bands: loaded.bands, stereo: loaded.stereo, envelopes: loaded.envelopes, fingerprints: loaded.fingerprints, settings, mixPeakDbfs: loaded.mixPeakDbfs });
    const planMs = Math.round(deps.now() - planStarted);
    if (!current()) return;
    if (changed() || fullMixPlanIsStale(plan, useAppStore.getState().document!, loaded.fingerprints, settings)) return stale();
    set("plan", "done", `${plan.changes.filter((change) => changeIncluded(change, "preview")).length} changes kept`);

    set("verify", "running", "Rendering Current and the candidate through the playback DSP");
    useAppStore.getState().setFullMix({ phase: "checking", progress: "Auto Mix: verifying the candidate…" });
    const checkStarted = deps.now();
    const check = await deps.check(latest, plan);
    if (check) plan = withRenderedCheck(plan, check);
    const checkMs = Math.round(deps.now() - checkStarted);
    if (!current()) return;
    if (changed() || fullMixPlanIsStale(plan, useAppStore.getState().document!, loaded.fingerprints, settings)) return stale();
    set("verify", check ? "done" : "skipped", check ? null : "No render check on this engine");

    const firstProblem = plan.problems.find((problem) => problem.interventionId) ?? plan.problems[0] ?? null;
    useAppStore.getState().setFullMix({ phase: "ready", progress: null, plan, fingerprints: loaded.fingerprints, error: null, check: check ? { ...check, notes: [] } : null, selectedProblemId: firstProblem?.id ?? null });
    const durationMs = Math.round(deps.now() - started);
    finish(plan, stages, durationMs);
    await logEvent(platform, "info", "automix.complete", "Finished Auto Mix.", {
      projectId,
      strength: settings.strength,
      problems: plan.problems.length,
      changes: plan.changes.length,
      independent: plan.evaluation.independent.total,
      reused: stages.filter((stage) => stage.status === "reused").map((stage) => stage.id),
      planMs,
      checkMs,
      durationMs,
    });
  } catch (caught) {
    if (!current()) return;
    fail(caught instanceof Error && caught.message ? caught.message : "Auto Mix could not finish.", stages.find((stage) => stage.status === "running")?.id ?? "plan");
  }

  function finish(plan: FullMixPlan, done: AutoMixStage[], durationMs: number) {
    const summary = autoMixSummary(useAppStore.getState().document!, plan, done.filter((stage) => stage.status === "reused").map((stage) => stage.id));
    useAppStore.getState().setAutoMix({ generation, phase: "ready", stages: done, planCreatedAt: plan.createdAt, summary, error: null, durationMs });
    useAppStore.getState().setPlanTab("full");
    useAppStore.getState().setFullMix({ open: true });
    useAppStore.getState().setTask({
      id: "auto-mix",
      kind: "auto-mix",
      label: "Auto Mix",
      status: "complete",
      detail: null,
      stage: null,
      steps: [],
      blocks: [],
      cancellable: false,
      major: true,
      completionNote: summary.changeCount === 0 ? "Recommended Mix ready — no change needed" : `Recommended Mix ready — ${summary.changeCount} ${summary.changeCount === 1 ? "change" : "changes"} to preview`,
    });
  }

  function fail(message: string, at: AutoMixStageId) {
    stages = stages.map((stage) => (stage.id === at ? { ...stage, status: "failed" } : stage));
    useAppStore.getState().setAutoMix({ phase: "failed", stages, error: message });
    useAppStore.getState().setFullMix({ generation: useAppStore.getState().fullMix.generation + 1, phase: "idle", plan: null, progress: null, error: null, open: false, preview: false, focus: null, check: null });
    useAppStore.getState().setTask({ id: "auto-mix", kind: "auto-mix", label: "Auto Mix failed", status: "failed", error: message, stage: null, blocks: [], cancellable: false, retryable: true, major: true });
    void logEvent(platform, "warn", "automix.failed", "Auto Mix could not finish.", { projectId, stage: at });
  }

  function stale() {
    void logEvent(platform, "info", "automix.stale", "Discarded an Auto Mix candidate because the project changed while it was built.", { projectId });
    fail("The project changed while Auto Mix was building (a fader, EQ, space, dynamics, role, section, note, or stem). Nothing was applied. Run Auto Mix again.", stages.find((stage) => stage.status === "running" || stage.status === "pending")?.id ?? "verify");
  }
}

/** Closes open, unapplied subsystem candidates: Auto Mix plans from the saved project and never folds them in. */
function supersedeOpenPlans(): void {
  const state = useAppStore.getState();
  if (state.balance.open) cancelAutoBalance();
  if (state.eq.open) cancelEqPlan();
  if (state.space.open) cancelSpacePlan();
  if (state.dynamics.open) cancelDynamicsPlan();
}

/** Stops Auto Mix: the work in flight is dropped, the half-built candidate discarded, and the project untouched. */
export function cancelAutoMix(): void {
  const state = useAppStore.getState();
  if (state.autoMix.phase !== "running") return;
  useAppStore.getState().setAutoMix({ generation: state.autoMix.generation + 1, phase: "cancelled", stages: state.autoMix.stages.map((stage) => (stage.status === "running" || stage.status === "pending" ? { ...stage, status: "skipped" } : stage)) });
  useAppStore.getState().setFullMix({ generation: state.fullMix.generation + 1, phase: "idle", plan: null, progress: null, error: null, open: false, preview: false, focus: null, check: null });
  useAppStore.getState().setTask({ id: "auto-mix", kind: "auto-mix", label: "Auto Mix cancelled", status: "cancelled", stage: null, blocks: [], cancellable: false, major: false });
  void logEvent(getPlatform(), "info", "automix.cancel", "Cancelled Auto Mix.", { projectId: state.document?.project.id ?? null });
}

/** Discards the Recommended Mix: the candidate closes and the saved mix is what plays. */
export function discardAutoMix(): void {
  cancelFullMixPlan();
  useAppStore.getState().setAutoMix({ phase: "idle", planCreatedAt: null, summary: null, stages: [] });
}

/** Applies the Recommended Mix with the Full Mix apply: one project update, one undo step. */
export function applyAutoMix(): boolean {
  const state = useAppStore.getState();
  const plan = state.fullMix.plan;
  if (!plan || plan.createdAt !== state.autoMix.planCreatedAt) return false;
  const changes = plan.changes.filter((change) => changeIncluded(change, "all")).length;
  const ok = applyFullMix("all");
  if (ok) {
    useAppStore.getState().setAutoMix({ phase: "idle", planCreatedAt: null, summary: null, stages: [] });
    useAppStore.getState().setNotice("Recommended Mix applied. Undo restores the whole previous mix.");
    void logEvent(getPlatform(), "info", "automix.apply", "Applied the Recommended Mix.", { projectId: state.document?.project.id ?? null, changes });
  }
  return ok;
}

/** The Auto Mix button's state, from the store. */
export function autoMixButtonState(state: Pick<ReturnType<typeof useAppStore.getState>, "autoMix" | "fullMix" | "document">): "idle" | "running" | "ready" | "stale" | "failed" {
  const auto = state.autoMix;
  if (auto.phase === "running") return "running";
  if (auto.phase === "failed") return "failed";
  if (auto.phase !== "ready" || !state.document) return "idle";
  const plan = state.fullMix.plan;
  if (!plan || plan.createdAt !== auto.planCreatedAt || state.fullMix.phase !== "ready") return "idle";
  return fullMixPlanIsStale(plan, state.document, state.fullMix.fingerprints, state.fullMix.settings) ? "stale" : "ready";
}

/* ------------------------------------------------------------------ summary */

const DETECTED: Record<MixProblemType, keyof AutoMixSummary["detected"]> = {
  headroom: "level",
  "level-hierarchy": "level",
  "frequency-conflict": "frequency",
  "low-end-collision": "frequency",
  "event-masking": "frequency",
  "center-congestion": "space",
  "excessive-width": "space",
  "dynamic-instability": "dynamics",
  "transient-problem": "dynamics",
  "section-contrast": "contrast",
  intent: "contrast",
};

/** Counts for the Recommended Mix card: what was read, what was found, what was kept, what was left out. */
export function autoMixSummary(document: ProjectDocument, plan: FullMixPlan, reused: AutoMixStageId[] = []): AutoMixSummary {
  const detected = { level: 0, frequency: 0, space: 0, dynamics: 0, contrast: 0 };
  for (const problem of plan.problems) detected[DETECTED[problem.type]] += 1;
  const kept = { gain: 0, eq: 0, ducking: 0, compressor: 0, transient: 0, dynamicEq: 0, space: 0, trim: 0 };
  const included = plan.changes.filter((change) => changeIncluded(change, "preview"));
  for (const change of included) {
    const processing = change.processing;
    if (processing.type === "gain") kept.gain += 1;
    else if (processing.type === "trim") kept.trim += 1;
    else if (processing.type === "eq") kept.eq += 1;
    else if (processing.type === "spatial") kept.space += 1;
    else if (processing.processing.type === "ducking") kept.ducking += 1;
    else if (processing.processing.type === "compressor") kept.compressor += 1;
    else if (processing.processing.type === "transient") kept.transient += 1;
    else kept.dynamicEq += 1;
  }
  const changeCount = included.filter((change) => change.processing.type !== "trim").length;
  return {
    tracks: document.tracks.length,
    sections: document.sections.length,
    detected,
    kept,
    changeCount,
    omitted: Math.max(0, plan.evaluation.independent.total - changeCount),
    rejectedAlternatives: plan.summary.rejectedCount,
    reused,
    strength: plan.settings.strength,
  };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The summary in lines, as the card shows it. */
export function autoMixSummaryLines(summary: AutoMixSummary): { analyzed: string[]; detected: string[]; kept: string[]; omitted: string | null } {
  const { detected, kept } = summary;
  const detectedLines = [
    detected.level ? plural(detected.level, "level issue") : null,
    detected.frequency ? plural(detected.frequency, "frequency interaction") : null,
    detected.space ? plural(detected.space, "spatial issue") : null,
    detected.dynamics ? plural(detected.dynamics, "dynamics issue") : null,
    detected.contrast ? plural(detected.contrast, "section contrast or intent request", "section contrast or intent requests") : null,
  ].filter((line): line is string => line !== null);
  const keptLines = [
    kept.gain ? plural(kept.gain, "gain change") : null,
    kept.eq ? plural(kept.eq, "EQ change") : null,
    kept.ducking ? plural(kept.ducking, "ducking relationship") : null,
    kept.compressor ? plural(kept.compressor, "compressor") : null,
    kept.transient ? plural(kept.transient, "transient adjustment") : null,
    kept.dynamicEq ? plural(kept.dynamicEq, "dynamic EQ") : null,
    kept.space ? plural(kept.space, "pan or width adjustment") : null,
    kept.trim ? "a safety trim on every fader" : null,
  ].filter((line): line is string => line !== null);
  return {
    analyzed: [plural(summary.tracks, "track"), plural(summary.sections, "section")],
    detected: detectedLines.length ? detectedLines : ["no problem past its threshold"],
    kept: keptLines.length ? keptLines : ["no change: the mix already measures well"],
    omitted: summary.omitted > 0 ? `${plural(summary.omitted, "lower-value or redundant recommendation")} from the individual planners ${summary.omitted === 1 ? "was" : "were"} left out.` : null,
  };
}
