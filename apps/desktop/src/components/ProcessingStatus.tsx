import { useEffect, useState } from "react";
import { bannerTask, gate, isActive, listedTasks, progressText, taskActions, type Gate, type ProcessingTask, type TaskBlock, type TaskKind, type TaskStep } from "../lib/tasks";
import { useAppStore } from "../state/app-store";

/** Whether `what` (playback, editing, planning, export) is possible now, and why not. */
export function useGate(what: TaskBlock): Gate {
  const tasks = useAppStore((state) => state.tasks);
  return gate(tasks, what);
}

/** Re-renders every `ms` while `active`, so a completion note can expire. */
function useTick(active: boolean, ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [active, ms]);
  return now;
}

/**
 * The global processing strip under the header: the most important running task (or a failure, or a short
 * completion note), its progress in real numbers or stages, Cancel / Retry / Dismiss, and a detail panel listing
 * every task and its stems or stages.
 */
export function ProcessingBanner() {
  const tasks = useAppStore((state) => state.tasks);
  const [open, setOpen] = useState(false);
  const anyFinished = Object.values(tasks).some((task) => task.status === "complete");
  const now = useTick(anyFinished);
  const task = bannerTask(tasks, Math.max(now, Date.now()));
  const listed = listedTasks(tasks).filter((item) => isActive(item) || item.status === "failed");
  if (!task) return null;
  const done = task.status === "complete";
  const failed = task.status === "failed";
  return (
    <div className={`border-b ${failed ? "border-danger/60 bg-danger/10" : done ? "border-ok/50 bg-ok/10" : "border-accent/50 bg-accent/10"}`}>
      <div className="flex flex-wrap items-center gap-3 px-5 py-2" role={failed ? "alert" : "status"} aria-live="polite">
        <StatusGlyph task={task} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">
            {done ? task.completionNote : task.label}
            {!done && task.detail ? <span className="font-normal text-muted"> — {task.detail}</span> : null}
          </p>
          {failed && task.error ? <p className="text-xs text-danger">{task.error}</p> : null}
          {!done && !failed ? <TaskProgress task={task} /> : null}
        </div>
        <TaskButtons task={task} />
        {listed.length > 0 ? (
          <button type="button" className="rounded px-2 py-1 text-xs text-muted underline-offset-2 hover:text-ink hover:underline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? "Hide details" : listed.length > 1 ? `Details (${listed.length} tasks)` : "Details"}
          </button>
        ) : null}
      </div>
      {open && listed.length > 0 ? <TaskDetails tasks={listed} /> : null}
    </div>
  );
}

function TaskDetails({ tasks }: { tasks: ProcessingTask[] }) {
  return (
    <div className="max-h-64 overflow-auto border-t border-line/60 px-5 py-2" aria-label="Processing details">
      {tasks.map((task) => (
        <div key={task.id} className="py-1">
          <p className="text-xs text-ink">
            <span className="font-medium">{task.status === "failed" ? "Failed: " : ""}{task.label}</span>
            {task.detail ? <span className="text-muted"> — {task.detail}</span> : null}
            {progressText(task) ? <span className="ml-2 font-mono text-faint">{progressText(task)}</span> : null}
          </p>
          {task.error ? <p className="text-xs text-danger">{task.error}</p> : null}
          {task.steps.length > 0 ? <StepList steps={task.steps} /> : null}
        </div>
      ))}
    </div>
  );
}

/** Steps with a glyph and a word, so state is never color alone. */
export function StepList({ steps, compact = false }: { steps: TaskStep[]; compact?: boolean }) {
  return (
    <ol className={`mt-1 grid gap-x-6 gap-y-0.5 ${compact ? "" : "sm:grid-cols-2"}`}>
      {steps.map((step) => (
        <li key={step.id} className={`flex items-baseline gap-2 text-xs ${step.status === "failed" ? "text-danger" : step.status === "running" ? "text-ink" : step.status === "done" ? "text-muted" : "text-faint"}`}>
          <span aria-hidden="true" className="w-3 shrink-0 text-center font-mono">
            {STEP_GLYPH[step.status]}
          </span>
          <span className="sr-only">{STEP_WORD[step.status]}: </span>
          <span className="min-w-0 truncate">{step.label}</span>
          {step.detail ? <span className="shrink-0 font-mono text-faint">{step.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}

const STEP_GLYPH: Record<TaskStep["status"], string> = { done: "✓", running: "→", pending: "○", failed: "✗", skipped: "–" };
const STEP_WORD: Record<TaskStep["status"], string> = { done: "Done", running: "In progress", pending: "Waiting", failed: "Failed", skipped: "Skipped" };

function StatusGlyph({ task }: { task: ProcessingTask }) {
  if (task.status === "failed") return <span aria-hidden="true" className="text-lg text-danger">!</span>;
  if (task.status === "complete") return <span aria-hidden="true" className="text-lg text-ok">✓</span>;
  return <span aria-hidden="true" className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />;
}

/** A bar only when the fraction is real; otherwise the stage counter. Always with text. */
export function TaskProgress({ task, className = "" }: { task: ProcessingTask; className?: string }) {
  const text = progressText(task);
  if (task.progress !== null) {
    const percent = Math.round(Math.min(1, Math.max(0, task.progress)) * 100);
    return (
      <div className={`mt-1 flex items-center gap-2 ${className}`}>
        <div className="h-2 max-w-md flex-1 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${task.label}: ${percent}%${task.detail ? `, ${task.detail}` : ""}`}>
          <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${percent}%` }} />
        </div>
        <span className="font-mono text-xs text-muted">{text}</span>
      </div>
    );
  }
  if (task.stage) {
    return (
      <div className={`mt-1 flex items-center gap-2 ${className}`} role="progressbar" aria-valuemin={0} aria-valuemax={task.stage.count} aria-valuenow={task.stage.index - 1} aria-valuetext={`${text}${task.detail ? `: ${task.detail}` : ""}`}>
        <div className="flex gap-1" aria-hidden="true">
          {Array.from({ length: task.stage.count }, (_, index) => (
            <span key={index} className={`h-2 w-6 rounded-full ${index < task.stage!.index - 1 ? "bg-accent" : index === task.stage!.index - 1 ? "animate-pulse bg-accent/60" : "bg-panel-2"}`} />
          ))}
        </div>
        <span className="font-mono text-xs text-muted">{text}</span>
      </div>
    );
  }
  return null;
}

function TaskButtons({ task }: { task: ProcessingTask }) {
  const actions = taskActions(task.id);
  const failed = task.status === "failed";
  return (
    <div className="flex items-center gap-2">
      {isActive(task) && task.cancellable && actions.cancel ? (
        <button type="button" className="rounded-md border border-line bg-panel-2 px-3 py-1 text-xs text-ink hover:bg-panel" onClick={() => actions.cancel?.()}>
          Cancel
        </button>
      ) : null}
      {failed && task.retryable && actions.retry ? (
        <button type="button" className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-ink hover:brightness-105" onClick={() => actions.retry?.()}>
          Retry
        </button>
      ) : null}
      {failed ? (
        <button type="button" className="rounded-md border border-line px-3 py-1 text-xs text-muted hover:text-ink" onClick={() => useAppStore.getState().dropTask(task.id)}>
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

/**
 * Project preparation over the workspace while the waveforms are measured: both stages (waveforms, playback audio),
 * real counts, and what is unavailable until they finish.
 */
export function PreparationGate() {
  const waveform = useAppStore((state) => state.tasks.waveform);
  const proxy = useAppStore((state) => state.tasks["playback-proxy"]);
  const total = waveform?.steps.length ?? proxy?.steps.length ?? 0;
  const [showStems, setShowStems] = useState(false);
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-canvas/90 px-6">
      <div className="w-full max-w-lg rounded-lg border border-line bg-panel px-6 py-5" role="status" aria-live="polite">
        <h2 className="font-display text-3xl">Preparing project</h2>
        <p className="mt-2 text-sm text-muted">
          {total > 0 ? `${total} ${total === 1 ? "stem" : "stems"}. ` : ""}Playback and editing are available when preparation is complete.
        </p>
        <Stage title="Measuring waveforms" task={waveform ?? null} doneText="Waveforms measured" />
        <Stage title="Building playback audio" task={proxy ?? null} doneText="Playback audio ready" waitingText="Starts with the project; runs alongside the waveforms" />
        {waveform && waveform.steps.length > 0 ? (
          <div className="mt-3">
            <button type="button" className="text-xs text-muted underline-offset-2 hover:underline" aria-expanded={showStems} onClick={() => setShowStems((value) => !value)}>
              {showStems ? "Hide stems" : "Show stems"}
            </button>
            {showStems ? <StepList steps={mergeSteps(waveform, proxy ?? null)} compact /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Stage({ title, task, doneText, waitingText }: { title: string; task: ProcessingTask | null; doneText: string; waitingText?: string }) {
  const done = !task || task.status === "complete";
  return (
    <div className="mt-4">
      <p className="text-sm text-ink">
        <span aria-hidden="true" className={`mr-2 font-mono ${task?.status === "failed" ? "text-danger" : done ? "text-ok" : "text-accent"}`}>
          {task?.status === "failed" ? "✗" : done ? "✓" : "→"}
        </span>
        {task?.status === "failed" ? `${title} failed` : done ? doneText : title}
        {task && !done && task.detail ? <span className="text-muted"> — {task.detail}</span> : null}
      </p>
      {task?.status === "failed" && task.error ? <p className="mt-1 text-xs text-danger">{task.error}</p> : null}
      {task && isActive(task) ? <TaskProgress task={task} /> : !task && waitingText && !done ? <p className="text-xs text-faint">{waitingText}</p> : null}
    </div>
  );
}

/** One row per stem: its waveform state, then its playback audio. */
function mergeSteps(waveform: ProcessingTask, proxy: ProcessingTask | null): TaskStep[] {
  return waveform.steps.map((step, index) => {
    const audio = proxy?.steps[index];
    const status: TaskStep["status"] = step.status === "failed" || audio?.status === "failed" ? "failed" : step.status === "done" && (!audio || audio.status === "done") ? "done" : step.status === "running" || audio?.status === "running" ? "running" : step.status === "done" ? "running" : "pending";
    const detail = audio?.status === "failed" ? audio.detail : step.status !== "done" ? (step.detail ?? "waveform") : audio && audio.status !== "done" ? `playback audio ${audio.detail ?? "queued"}` : null;
    return { id: step.id, label: step.label, status, detail };
  });
}

/**
 * A planner tab's own status from the shared model: what it is doing now, in large enough type to notice, with
 * Cancel; or why it failed.
 */
export function PlannerStatus({ kind }: { kind: TaskKind }) {
  const task = useAppStore((state) => state.tasks[kind]);
  if (!task || task.status === "complete" || task.status === "cancelled") return null;
  const failed = task.status === "failed";
  const actions = taskActions(task.id);
  return (
    <div className={`flex items-center gap-3 rounded-md border px-3 py-2 ${failed ? "border-danger/60 bg-danger/10" : "border-accent/50 bg-accent/10"}`} role={failed ? "alert" : "status"} aria-live="polite">
      <StatusGlyph task={task} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">
          {task.label}
          {task.detail ? <span className="text-muted"> — {task.detail}</span> : null}
        </p>
        {failed && task.error ? <p className="text-xs text-danger">{task.error}</p> : null}
        {!failed ? <TaskProgress task={task} /> : null}
      </div>
      {!failed && task.cancellable && actions.cancel ? (
        <button type="button" className="rounded-md border border-line bg-panel-2 px-3 py-1 text-xs text-ink hover:bg-panel" onClick={() => actions.cancel?.()}>
          Cancel
        </button>
      ) : null}
    </div>
  );
}
