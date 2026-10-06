/**
 * The one model of long-running work in the desktop app: project preparation, analysis, the planners, Auto Mix,
 * the assistant, and export all publish here, and the banner, the Play button, the planner tabs, and the Export and
 * Auto Mix buttons all read from here. A task says what it blocks (playback, editing, planning, export), so a
 * running EQ analysis never disables Play while a stem whose playback audio is still being built does.
 *
 * Pure: no store, no DOM. The store keeps the tasks (`state/app-store.ts`); cancel and retry live in a registry
 * here because they are functions, not state.
 */

export type TaskKind =
  | "import"
  | "waveform"
  | "playback-proxy"
  | "playback-prime"
  | "analysis"
  | "gain-plan"
  | "eq-plan"
  | "space-plan"
  | "dynamics-plan"
  | "full-mix"
  | "auto-mix"
  | "assistant"
  | "export";

export type TaskStatus = "queued" | "running" | "complete" | "failed" | "cancelled";

/** What a running (or failed) task keeps the person from doing until it is done. */
export type TaskBlock = "playback" | "editing" | "planning" | "export";

export interface TaskStep {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  detail?: string | null;
}

export interface ProcessingTask {
  id: string;
  kind: TaskKind;
  /** The headline: "Preparing project for playback", "Auto Mix", "Exporting FLAC". */
  label: string;
  status: TaskStatus;
  /** 0–1 when the fraction is real (stems ready, frames rendered); null when only stages are known. */
  progress: number | null;
  /** The current stage or item in words: "Building playback audio — 8 of 11 stems ready". */
  detail: string | null;
  /** Stage counter for staged work ("Stage 4 of 7"); null otherwise. */
  stage: { index: number; count: number } | null;
  /** Per-item or per-stage rows for the detail panel. */
  steps: TaskStep[];
  blocks: TaskBlock[];
  cancellable: boolean;
  retryable: boolean;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** Shown briefly when a major task completes ("Project ready — 11 tracks prepared"). */
  completionNote: string | null;
  /** Major tasks get the banner and a completion note; minor ones only show in the detail panel and their tab. */
  major: boolean;
}

export type TaskPatch = Partial<Omit<ProcessingTask, "id">> & { id: string; kind: TaskKind; label?: string };

export function newTask(patch: TaskPatch, now: number): ProcessingTask {
  return {
    label: patch.label ?? patch.kind,
    status: "running",
    progress: null,
    detail: null,
    stage: null,
    steps: [],
    blocks: [],
    cancellable: false,
    retryable: false,
    error: null,
    startedAt: now,
    finishedAt: null,
    completionNote: null,
    major: false,
    ...patch,
  };
}

/** Merges a patch into the task list. Finishing stamps the time; an unchanged patch returns the same object. */
export function upsertTask(tasks: Record<string, ProcessingTask>, patch: TaskPatch, now: number): Record<string, ProcessingTask> {
  const existing = tasks[patch.id];
  const restarted = existing && isFinished(existing.status) && patch.status !== undefined && !isFinished(patch.status);
  const base = !existing || restarted ? newTask({ ...patch, status: patch.status ?? "running" }, now) : { ...existing, ...patch };
  if (isFinished(base.status) && base.finishedAt === null) base.finishedAt = now;
  if (!isFinished(base.status)) base.finishedAt = null;
  if (existing && !restarted && sameTask(existing, base)) return tasks;
  return { ...tasks, [patch.id]: base };
}

export function removeTask(tasks: Record<string, ProcessingTask>, id: string): Record<string, ProcessingTask> {
  if (!(id in tasks)) return tasks;
  const next = { ...tasks };
  delete next[id];
  return next;
}

/** Drops finished tasks older than `keepMs` (failures stay until dismissed or retried). */
export function pruneTasks(tasks: Record<string, ProcessingTask>, now: number, keepMs = 6_000): Record<string, ProcessingTask> {
  let changed = false;
  const next: Record<string, ProcessingTask> = {};
  for (const [id, task] of Object.entries(tasks)) {
    if ((task.status === "complete" || task.status === "cancelled") && task.finishedAt !== null && now - task.finishedAt > keepMs) {
      changed = true;
      continue;
    }
    next[id] = task;
  }
  return changed ? next : tasks;
}

export function isFinished(status: TaskStatus): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

export function isActive(task: ProcessingTask): boolean {
  return task.status === "running" || task.status === "queued";
}

function sameTask(left: ProcessingTask, right: ProcessingTask): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/* ------------------------------------------------------------------ gates */

export interface Gate {
  blocked: boolean;
  /** Why, in words, for a tooltip or a disabled button: "Preparing playback — 8 of 11 stems ready". */
  reason: string | null;
  task: ProcessingTask | null;
}

const OPEN: Gate = { blocked: false, reason: null, task: null };

/**
 * Whether `what` can happen now. Running and queued tasks that block it gate it; so does a failed task that blocks
 * it (a stem whose playback audio failed cannot play until it is retried).
 */
export function gate(tasks: Record<string, ProcessingTask>, what: TaskBlock): Gate {
  const blocking = Object.values(tasks)
    .filter((task) => task.blocks.includes(what) && (isActive(task) || task.status === "failed"))
    .sort((left, right) => blockOrder(left) - blockOrder(right));
  const task = blocking[0];
  if (!task) return OPEN;
  return { blocked: true, reason: gateReason(task, what), task };
}

function blockOrder(task: ProcessingTask): number {
  return task.status === "failed" ? 0 : KIND_ORDER.indexOf(task.kind) + 1;
}

function gateReason(task: ProcessingTask, what: TaskBlock): string {
  if (task.status === "failed") {
    const verb = what === "playback" ? "Playback is unavailable" : what === "export" ? "Export is unavailable" : "Unavailable";
    return `${verb}: ${task.error ?? `${task.label} failed`}. Retry it from the status bar.`;
  }
  if (task.kind === "playback-proxy") return task.detail ? `Preparing playback — ${task.detail}` : "Preparing playback";
  if (task.kind === "waveform") return task.detail ? `Preparing project — ${task.detail}` : "Preparing project";
  if (task.kind === "export") return "Wait for the export to finish";
  if (task.kind === "auto-mix") return "Wait for Auto Mix to finish";
  return task.detail ? `${task.label} — ${task.detail}` : task.label;
}

/* ------------------------------------------------------------------ banner */

/** Banner priority: preparation first (it gates everything), then the person's foreground work, then the rest. */
const KIND_ORDER: TaskKind[] = [
  "import",
  "waveform",
  "playback-proxy",
  "export",
  "auto-mix",
  "full-mix",
  "assistant",
  "gain-plan",
  "eq-plan",
  "space-plan",
  "dynamics-plan",
  "playback-prime",
  "analysis",
];

/**
 * What the banner shows: a failure first (it must not hide), then the most important running task. A minor task
 * shows only when nothing major runs. Completed major tasks show their note briefly.
 */
export function bannerTask(tasks: Record<string, ProcessingTask>, now: number, noteMs = 4_000): ProcessingTask | null {
  const all = Object.values(tasks);
  const rank = (task: ProcessingTask) => KIND_ORDER.indexOf(task.kind);
  const failed = all.filter((task) => task.status === "failed").sort((left, right) => rank(left) - rank(right));
  if (failed[0]) return failed[0];
  const running = all.filter(isActive).sort((left, right) => Number(right.major) - Number(left.major) || rank(left) - rank(right));
  if (running[0]) return running[0];
  const done = all
    .filter((task) => task.major && task.status === "complete" && task.completionNote && task.finishedAt !== null && now - task.finishedAt <= noteMs)
    .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0));
  return done[0] ?? null;
}

/** Everything worth listing in the detail panel, most important first. */
export function listedTasks(tasks: Record<string, ProcessingTask>): ProcessingTask[] {
  const rank = (task: ProcessingTask) => (task.status === "failed" ? -1 : isActive(task) ? 0 : 1) * 100 + KIND_ORDER.indexOf(task.kind);
  return Object.values(tasks).sort((left, right) => rank(left) - rank(right));
}

/** "Stage 4 of 7", "73%", or nothing: only numbers that are real. */
export function progressText(task: ProcessingTask): string | null {
  if (task.progress !== null) return `${Math.round(Math.min(1, Math.max(0, task.progress)) * 100)}%`;
  if (task.stage) return `Stage ${task.stage.index} of ${task.stage.count}`;
  return null;
}

/* ------------------------------------------------------------------ actions */

export interface TaskActions {
  cancel?: () => void;
  retry?: () => void;
}

const actions = new Map<string, TaskActions>();

/** Cancel and retry for a task id. Registering again replaces them. */
export function registerTaskActions(id: string, next: TaskActions): void {
  actions.set(id, next);
}

export function taskActions(id: string): TaskActions {
  return actions.get(id) ?? {};
}

/* ------------------------------------------------------------------ planner sessions */

type PlanPhase = "idle" | "analyzing" | "planning" | "verifying" | "checking" | "ready" | "failed";

const PLAN_LABELS: Record<"gain-plan" | "eq-plan" | "space-plan" | "dynamics-plan" | "full-mix", { label: string; phases: Partial<Record<PlanPhase, string>> }> = {
  "gain-plan": { label: "Gain", phases: { analyzing: "Analyzing levels", planning: "Planning gain" } },
  "eq-plan": { label: "EQ", phases: { analyzing: "Checking frequency interactions", planning: "Planning EQ", verifying: "Checking filters on the playback audio" } },
  "space-plan": { label: "Space", phases: { analyzing: "Evaluating stereo field", planning: "Planning pan and width", verifying: "Checking pan and width on the playback audio" } },
  "dynamics-plan": { label: "Dynamics", phases: { analyzing: "Analyzing envelopes", planning: "Planning dynamics", verifying: "Checking dynamics on the playback audio" } },
  "full-mix": { label: "Full Mix", phases: { analyzing: "Measuring the mix", planning: "Evaluating coordinated candidate", checking: "Rendering Current and the candidate" } },
};

/**
 * The task a planner session stands for. Idle means no task (cancelled or applied); ready is a quiet completion;
 * failed is visible until dismissed or re-run.
 */
export function planTaskPatch(kind: keyof typeof PLAN_LABELS, session: { phase: PlanPhase; progress: string | null; error: string | null }): TaskPatch | null {
  const meta = PLAN_LABELS[kind];
  if (session.phase === "idle") return null;
  const stage = meta.phases[session.phase] ?? null;
  const label = stage ? `${meta.label}: ${stage}` : meta.label;
  if (session.phase === "ready") return { id: kind, kind, label: `${meta.label} plan ready`, status: "complete", detail: null, error: null, major: false, cancellable: false };
  if (session.phase === "failed") return { id: kind, kind, label: `${meta.label} plan failed`, status: "failed", detail: null, error: session.error ?? `${meta.label} planning could not finish.`, major: false, cancellable: false, retryable: true };
  return { id: kind, kind, label, status: "running", detail: session.progress, error: null, major: false, cancellable: true, blocks: [] };
}
