import type { DesktopPlatform } from "../platform/types";
import { runAnalysis, type AnalysisJobStatus, type AnalysisTarget, type LoadedTrackAnalysis } from "./track-analysis";

export class AnalysisCancelled extends Error {
  constructor() {
    super("Analysis was cancelled.");
    this.name = "AnalysisCancelled";
  }
}

interface Slot {
  key: string;
  priority: number;
  holders: number;
  state: "pending" | "running" | "done" | "failed";
  preempted: boolean;
  jobId: number;
  platform: DesktopPlatform;
  projectFile: string;
  target: AnalysisTarget;
  onStatus?: (status: AnalysisJobStatus) => void;
  promise: Promise<LoadedTrackAnalysis>;
  resolve: (value: LoadedTrackAnalysis) => void;
  reject: (error: unknown) => void;
}

const slots = new Map<string, Slot>();
let pending: Slot[] = [];
let running: Slot | null = null;
let pumping = false;
let nextJobId = 1;

export function watchAnalysis(
  platform: DesktopPlatform,
  projectFile: string,
  target: AnalysisTarget,
  onStatus: ((status: AnalysisJobStatus) => void) | undefined,
  priority: number,
): { promise: Promise<LoadedTrackAnalysis>; stop: () => void } {
  const key = analysisKey(projectFile, target);
  const existing = slots.get(key);
  if (existing && (existing.state === "pending" || existing.state === "running")) {
    existing.holders += 1;
    if (priority > existing.priority) {
      existing.priority = priority;
      existing.onStatus = onStatus ?? existing.onStatus;
      preempt();
    }
    return { promise: existing.promise, stop: () => release(existing) };
  }
  let resolve: Slot["resolve"] = () => undefined;
  let reject: Slot["reject"] = () => undefined;
  const promise = new Promise<LoadedTrackAnalysis>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  const slot: Slot = {
    key,
    priority,
    holders: 1,
    state: "pending",
    preempted: false,
    jobId: 0,
    platform,
    projectFile,
    target,
    onStatus,
    promise,
    resolve,
    reject,
  };
  slots.set(key, slot);
  pending.push(slot);
  preempt();
  void pump();
  return { promise, stop: () => release(slot) };
}

export function analysisKey(projectFile: string, target: AnalysisTarget): string {
  return `${projectFile}\n${target.cacheName}\n${JSON.stringify(target.scope)}`;
}

function release(slot: Slot): void {
  slot.holders -= 1;
  if (slot.holders > 0) return;
  if (slot.state === "done" || slot.state === "failed") {
    if (slots.get(slot.key) === slot) slots.delete(slot.key);
    return;
  }
  slot.holders = 0;
  pending = pending.filter((item) => item !== slot);
  if (slots.get(slot.key) === slot) slots.delete(slot.key);
  if (slot.state === "running") {
    slot.preempted = false;
    void slot.platform.cancelAnalysis(slot.jobId);
    return;
  }
  slot.state = "failed";
  slot.reject(new AnalysisCancelled());
}

function preempt(): void {
  if (!running) return;
  const best = pending.reduce<Slot | null>((winner, slot) => (!winner || slot.priority > winner.priority ? slot : winner), null);
  if (best && best.priority > running.priority) {
    running.preempted = true;
    void running.platform.cancelAnalysis(running.jobId);
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (pending.length > 0) {
      pending.sort((left, right) => right.priority - left.priority);
      const slot = pending.shift();
      if (!slot || slot.holders <= 0) continue;
      running = slot;
      slot.state = "running";
      slot.jobId = nextJobId;
      nextJobId += 1;
      try {
        const loaded = await runAnalysis(slot.platform, slot.projectFile, slot.target, slot.jobId, (status) => slot.onStatus?.(status));
        if (slot.preempted && slot.holders > 0) {
          slot.preempted = false;
          slot.state = "pending";
          pending.push(slot);
          continue;
        }
        if (slot.holders <= 0) {
          slot.state = "failed";
          slot.reject(new AnalysisCancelled());
          continue;
        }
        slot.state = "done";
        slot.resolve(loaded);
      } catch (error) {
        if (slot.preempted && slot.holders > 0) {
          slot.preempted = false;
          slot.state = "pending";
          pending.push(slot);
          continue;
        }
        slot.state = "failed";
        if (slots.get(slot.key) === slot && slot.holders <= 0) slots.delete(slot.key);
        slot.reject(isCancellation(error) ? new AnalysisCancelled() : error);
      } finally {
        if (running === slot) running = null;
      }
    }
  } finally {
    pumping = false;
    if (pending.length > 0) void pump();
  }
}

function isCancellation(error: unknown): boolean {
  if (error instanceof AnalysisCancelled) return true;
  if (error instanceof Error && (error.message === "Analysis was cancelled." || error.message.includes("cancelled"))) {
    const detail = "detail" in error ? String(error.detail) : "";
    return detail === "cancelled" || error.message === "Analysis was cancelled.";
  }
  return false;
}
