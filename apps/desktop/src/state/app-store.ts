import type { AutoBalanceSettings, MixPlan, SourceFingerprint } from "@audiosous/balance-planner";
import type { EqPlan, EqSettings } from "@audiosous/eq-planner";
import type { SpatialPlan, SpatialSettings } from "@audiosous/spatial-planner";
import type { DynamicsPlan, DynamicsSettings } from "@audiosous/dynamics-planner";
import type { FullMixPlan, FullMixSettings } from "@audiosous/mix-planner";
import type { AgentSession } from "@audiosous/mix-agent";
import type { AgentSettingsInfo, ExportReport, ExportSettings, ExportStatus, MasterPlan } from "../platform/types";
import type { ImportWarning, ProjectDocument } from "@audiosous/project-model";
import { create } from "zustand";
import { applyEdit, emptyHistory, redoEdit, undoEdit, type EditHistory, type HistoryMode } from "./history";
import { isActive, planTaskPatch, pruneTasks, removeTask, taskActions, upsertTask, type ProcessingTask, type TaskPatch } from "../lib/tasks";

export interface BalanceSession {
  open: boolean;
  generation: number;
  phase: "idle" | "analyzing" | "planning" | "ready" | "failed";
  progress: string | null;
  plan: MixPlan | null;
  settings: AutoBalanceSettings;
  preview: boolean;
  auditionId: string | null;
  auditionSide: "original" | "recommended";
  error: string | null;
  focusToken: number;
  fingerprints: SourceFingerprint[];
}

export function idleBalance(): BalanceSession {
  return {
    open: false,
    generation: 0,
    phase: "idle",
    progress: null,
    plan: null,
    settings: { style: "balanced", strength: "normal" },
    preview: false,
    auditionId: null,
    auditionSide: "recommended",
    error: null,
    focusToken: 0,
    fingerprints: [],
  };
}

export interface EqSession {
  open: boolean;
  generation: number;
  phase: "idle" | "analyzing" | "planning" | "verifying" | "ready" | "failed";
  progress: string | null;
  plan: EqPlan | null;
  settings: EqSettings;
  /** Whole-plan A/B: false plays Current, true plays the EQ Candidate. */
  preview: boolean;
  auditionId: string | null;
  auditionSide: "bypassed" | "recommended";
  /** Row whose curve and evidence are open. Selection is not an edit. */
  selectedId: string | null;
  error: string | null;
  fingerprints: SourceFingerprint[];
}

export function idleEq(): EqSession {
  return {
    open: false,
    generation: 0,
    phase: "idle",
    progress: null,
    plan: null,
    settings: { strength: "normal" },
    preview: false,
    auditionId: null,
    auditionSide: "recommended",
    selectedId: null,
    error: null,
    fingerprints: [],
  };
}

export interface SpaceSession {
  open: boolean;
  generation: number;
  phase: "idle" | "analyzing" | "planning" | "verifying" | "ready" | "failed";
  progress: string | null;
  plan: SpatialPlan | null;
  settings: SpatialSettings;
  /** Whole-plan A/B: false plays Current, true plays the Spatial Candidate. */
  preview: boolean;
  auditionId: string | null;
  auditionSide: "bypassed" | "recommended";
  /** Row whose stereo field and evidence are open. Selection is not an edit. */
  selectedId: string | null;
  error: string | null;
  fingerprints: SourceFingerprint[];
}

export function idleSpace(): SpaceSession {
  return {
    open: false,
    generation: 0,
    phase: "idle",
    progress: null,
    plan: null,
    settings: { strength: "normal" },
    preview: false,
    auditionId: null,
    auditionSide: "recommended",
    selectedId: null,
    error: null,
    fingerprints: [],
  };
}

export interface DynamicsSession {
  open: boolean;
  generation: number;
  phase: "idle" | "analyzing" | "planning" | "verifying" | "ready" | "failed";
  progress: string | null;
  plan: DynamicsPlan | null;
  settings: DynamicsSettings;
  /** Whole-plan A/B: false plays Current, true plays the Dynamics Candidate. */
  preview: boolean;
  auditionId: string | null;
  auditionSide: "bypassed" | "recommended";
  /** Row whose detail and evidence are open. Selection is not an edit. */
  selectedId: string | null;
  /** Raise each processed stem by the level its processing is predicted to remove, in the audition only. */
  levelMatch: boolean;
  error: string | null;
  fingerprints: SourceFingerprint[];
}

export function idleDynamics(): DynamicsSession {
  return {
    open: false,
    generation: 0,
    phase: "idle",
    progress: null,
    plan: null,
    settings: { strength: "normal" },
    preview: false,
    auditionId: null,
    auditionSide: "recommended",
    selectedId: null,
    levelMatch: true,
    error: null,
    fingerprints: [],
  };
}

/** What the Full Mix A/B plays: one change or one problem's solution on its own, or the candidate without it. */
export interface FullMixFocus {
  kind: "change" | "problem";
  id: string;
  side: "only" | "without";
}

/** The rendered whole-mix check: Current and the candidate through the native DSP on the proxies. */
export interface FullMixCheck {
  seconds: number;
  current: { peakDbfs: number; rmsDb: number; monoLossDb: number; correlation: number };
  candidate: { peakDbfs: number; rmsDb: number; monoLossDb: number; correlation: number };
  /** Change of each section boundary's level step, candidate against current, dB. */
  steps: Array<{ sectionId: string; changeDb: number }>;
  notes: string[];
}

export interface FullMixSession {
  open: boolean;
  generation: number;
  phase: "idle" | "analyzing" | "planning" | "checking" | "ready" | "failed";
  progress: string | null;
  plan: FullMixPlan | null;
  settings: FullMixSettings;
  /** Whole-mix A/B: false plays Current, true plays the Full Mix Candidate. */
  preview: boolean;
  focus: FullMixFocus | null;
  /** Play the candidate at the current mix's estimated loudness. */
  loudnessMatch: boolean;
  /** Problem whose evidence, alternatives, and changes are open. Selection is not an edit. */
  selectedProblemId: string | null;
  /** Change whose editor is open. */
  selectedChangeId: string | null;
  check: FullMixCheck | null;
  /** Rendered peak of the current mix, read before planning (the headroom check). */
  mixPeakDbfs: number | null;
  error: string | null;
  fingerprints: SourceFingerprint[];
}

export function idleFullMix(): FullMixSession {
  return {
    open: false,
    generation: 0,
    phase: "idle",
    progress: null,
    plan: null,
    settings: { strength: "normal", goal: "balanced" },
    preview: false,
    focus: null,
    loudnessMatch: true,
    selectedProblemId: null,
    selectedChangeId: null,
    check: null,
    mixPeakDbfs: null,
    error: null,
    fingerprints: [],
  };
}

/** The export dialog and the job it runs. Settings are remembered per viewer (`lib/export.ts`). */
export interface ExportSession {
  open: boolean;
  phase: "setup" | "running" | "deciding" | "done" | "failed" | "cancelled";
  preset: "preserve" | "balanced" | "loud" | "custom";
  settings: ExportSettings;
  jobId: number | null;
  status: ExportStatus | null;
  plan: MasterPlan | null;
  report: ExportReport | null;
  error: string | null;
  /** Why MP3 is unavailable, when it is. */
  mp3Unavailable: string | null;
}

export type AutoMixStageId = "prepare" | "levels" | "frequency" | "space" | "dynamics" | "plan" | "verify";

export interface AutoMixStage {
  id: AutoMixStageId;
  label: string;
  status: "pending" | "running" | "done" | "reused" | "failed" | "skipped";
  detail: string | null;
}

/**
 * One-click Auto Mix: the evidence stages, then Full Mix, then the render check. Its candidate lives in the Full
 * Mix session (`planCreatedAt` names it); this records how it was built and the summary shown above it.
 */
export interface AutoMixSession {
  generation: number;
  phase: "idle" | "running" | "ready" | "failed" | "cancelled";
  stages: AutoMixStage[];
  /** The Full Mix plan Auto Mix produced, by its createdAt; null until ready. */
  planCreatedAt: string | null;
  summary: AutoMixSummary | null;
  error: string | null;
  durationMs: number | null;
}

/** What Auto Mix read and what it kept, for the Recommended Mix card. Counts only; the plan holds the detail. */
export interface AutoMixSummary {
  tracks: number;
  sections: number;
  detected: { level: number; frequency: number; space: number; dynamics: number; contrast: number };
  kept: { gain: number; eq: number; ducking: number; compressor: number; transient: number; dynamicEq: number; space: number; trim: number };
  changeCount: number;
  /** What the four planners would have proposed on their own, minus what the coordinated plan kept. */
  omitted: number;
  rejectedAlternatives: number;
  /** Stages whose results were current and reused. */
  reused: AutoMixStageId[];
  strength: FullMixSettings["strength"];
}

export function idleAutoMix(): AutoMixSession {
  return { generation: 0, phase: "idle", stages: [], planCreatedAt: null, summary: null, error: null, durationMs: null };
}

/**
 * The conversational assistant. The session is scoped to the open project and lives only in memory: it is never
 * written to the project file.
 */
export interface AssistantState {
  open: boolean;
  session: AgentSession | null;
  /** The request in flight; a newer message or Cancel bumps it and the old one's results are dropped. */
  generation: number;
  busy: boolean;
  /** The message being worked on, shown until the reply arrives. */
  pending: string | null;
  activity: string | null;
  error: string | null;
  settings: AgentSettingsInfo | null;
  showSettings: boolean;
}

export function idleAssistant(open = false, settings: AgentSettingsInfo | null = null): AssistantState {
  return { open, session: null, generation: 0, busy: false, pending: null, activity: null, error: null, settings, showSettings: false };
}

export type PlanTab = "gain" | "eq" | "space" | "dynamics" | "full";

export type Screen = "welcome" | "import" | "project";
export type Workspace = "mix" | "analysis";

export interface DocumentEdit {
  mode?: HistoryMode;
  key?: string | null;
}

interface AppState {
  screen: Screen;
  document: ProjectDocument | null;
  projectFilePath: string | null;
  warnings: ImportWarning[];
  dirty: boolean;
  notice: string | null;
  history: EditHistory<ProjectDocument>;
  holdAutosave: boolean;
  preparing: boolean;
  workspace: Workspace;
  balance: BalanceSession;
  eq: EqSession;
  space: SpaceSession;
  dynamics: DynamicsSession;
  fullMix: FullMixSession;
  autoMix: AutoMixSession;
  exportJob: ExportSession | null;
  setExportJob: (patch: Partial<ExportSession> | null) => void;
  assistant: AssistantState;
  planTab: PlanTab;
  /** Every long-running piece of work, by id (`lib/tasks.ts`). The banner, Play, and the action buttons read it. */
  tasks: Record<string, ProcessingTask>;
  /** What the Changes view is focused on (a section marker or a change was clicked). */
  changesFocus: { sectionId: string | null; trackId: string | null; token: number } | null;
  setChangesFocus: (focus: { sectionId: string | null; trackId: string | null } | null) => void;
  setTask: (patch: TaskPatch) => void;
  dropTask: (id: string) => void;
  goWelcome: () => void;
  setWorkspace: (workspace: Workspace) => void;
  startImport: () => void;
  openDocument: (document: ProjectDocument, projectFilePath: string | null, warnings: ImportWarning[]) => void;
  replaceDocument: (document: ProjectDocument, dirty: boolean, edit?: DocumentEdit) => void;
  undo: () => void;
  redo: () => void;
  setNotice: (notice: string | null) => void;
  setProjectFilePath: (projectFilePath: string) => void;
  setWarnings: (warnings: ImportWarning[]) => void;
  setHoldAutosave: (held: boolean) => void;
  setPreparing: (preparing: boolean) => void;
  setBalance: (patch: Partial<BalanceSession>) => void;
  setEq: (patch: Partial<EqSession>) => void;
  setSpace: (patch: Partial<SpaceSession>) => void;
  setDynamics: (patch: Partial<DynamicsSession>) => void;
  setFullMix: (patch: Partial<FullMixSession>) => void;
  setAutoMix: (patch: Partial<AutoMixSession>) => void;
  setAssistant: (patch: Partial<AssistantState>) => void;
  setPlanTab: (tab: PlanTab) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  screen: "welcome",
  document: null,
  projectFilePath: null,
  warnings: [],
  dirty: false,
  notice: null,
  history: emptyHistory(),
  holdAutosave: false,
  preparing: false,
  workspace: "mix",
  balance: idleBalance(),
  eq: idleEq(),
  space: idleSpace(),
  dynamics: idleDynamics(),
  fullMix: idleFullMix(),
  autoMix: idleAutoMix(),
  exportJob: null,
  setExportJob: (patch) => set({ exportJob: patch === null ? null : ({ ...(get().exportJob ?? {}), ...patch } as ExportSession) }),
  assistant: idleAssistant(),
  planTab: "gain",
  tasks: {},
  changesFocus: null,
  setChangesFocus: (focus) => set({ changesFocus: focus ? { ...focus, token: (get().changesFocus?.token ?? 0) + 1 } : null }),
  setTask: (patch) => {
    const now = Date.now();
    const next = upsertTask(pruneTasks(get().tasks, now), patch, now);
    if (next !== get().tasks) set({ tasks: next });
  },
  dropTask: (id) => {
    const next = removeTask(get().tasks, id);
    if (next !== get().tasks) set({ tasks: next });
  },
  goWelcome: () => set({ tasks: cancelActive(get().tasks), changesFocus: null, screen: "welcome", notice: null, workspace: "mix", preparing: false, balance: idleBalance(), eq: idleEq(), space: idleSpace(), dynamics: idleDynamics(), fullMix: idleFullMix(), autoMix: idleAutoMix(), exportJob: null, assistant: idleAssistant(false, get().assistant.settings) }),
  setWorkspace: (workspace) => set({ workspace }),
  startImport: () => set({ screen: "import", notice: null, preparing: false }),
  openDocument: (document, projectFilePath, warnings) =>
    set({
      tasks: cancelActive(get().tasks),
      changesFocus: null,
      screen: "project",
      document,
      projectFilePath,
      warnings,
      dirty: false,
      notice: null,
      history: emptyHistory(),
      holdAutosave: false,
      preparing: document.tracks.length > 0,
      workspace: "mix",
      balance: idleBalance(),
      eq: idleEq(),
      space: idleSpace(),
      dynamics: idleDynamics(),
      fullMix: idleFullMix(),
      autoMix: idleAutoMix(),
      exportJob: null,
      // A new project starts a new conversation; the panel stays where the person left it.
      assistant: idleAssistant(get().assistant.open, get().assistant.settings),
      planTab: "gain",
    }),
  replaceDocument: (document, dirty, edit) => {
    const current = get().document;
    if (!current) {
      set({ document, dirty });
      return;
    }
    const mode = edit?.mode ?? (dirty ? "record" : "skip");
    set({
      document,
      dirty,
      history: applyEdit(get().history, current, mode, edit?.key ?? null, Date.now()),
    });
  },
  undo: () => {
    const current = get().document;
    if (!current) return;
    const step = undoEdit(get().history, current);
    if (!step) return;
    set({ document: step.document, history: step.history, dirty: true });
  },
  redo: () => {
    const current = get().document;
    if (!current) return;
    const step = redoEdit(get().history, current);
    if (!step) return;
    set({ document: step.document, history: step.history, dirty: true });
  },
  setNotice: (notice) => set({ notice }),
  setProjectFilePath: (projectFilePath) => set({ projectFilePath }),
  setWarnings: (warnings) => set({ warnings }),
  setHoldAutosave: (holdAutosave) => set({ holdAutosave }),
  setPreparing: (preparing) => set({ preparing }),
  setBalance: (patch) => {
    const balance = { ...get().balance, ...patch };
    set({ balance, tasks: planTasks(get().tasks, "gain-plan", balance) });
  },
  setEq: (patch) => {
    const eq = { ...get().eq, ...patch };
    set({ eq, tasks: planTasks(get().tasks, "eq-plan", eq) });
  },
  setSpace: (patch) => {
    const space = { ...get().space, ...patch };
    set({ space, tasks: planTasks(get().tasks, "space-plan", space) });
  },
  setDynamics: (patch) => {
    const dynamics = { ...get().dynamics, ...patch };
    set({ dynamics, tasks: planTasks(get().tasks, "dynamics-plan", dynamics) });
  },
  setFullMix: (patch) => {
    const fullMix = { ...get().fullMix, ...patch };
    // Auto Mix drives the Full Mix session and publishes its own staged task; it does not show twice.
    const tasks = get().tasks["auto-mix"] && isActive(get().tasks["auto-mix"]!) ? removeTask(get().tasks, "full-mix") : planTasks(get().tasks, "full-mix", fullMix);
    set({ fullMix, tasks });
  },
  setAutoMix: (patch) => set({ autoMix: { ...get().autoMix, ...patch } }),
  setAssistant: (patch) => {
    const assistant = { ...get().assistant, ...patch };
    set({ assistant, tasks: assistantTasks(get().tasks, assistant) });
  },
  setPlanTab: (planTab) => set({ planTab }),
}));

/** Keeps a planner's task in step with its session: the one place planner progress reaches the task model. */
function planTasks(tasks: Record<string, ProcessingTask>, kind: "gain-plan" | "eq-plan" | "space-plan" | "dynamics-plan" | "full-mix", session: Parameters<typeof planTaskPatch>[1]): Record<string, ProcessingTask> {
  const patch = planTaskPatch(kind, session);
  return patch ? upsertTask(tasks, patch, Date.now()) : removeTask(tasks, kind);
}

function assistantTasks(tasks: Record<string, ProcessingTask>, assistant: AssistantState): Record<string, ProcessingTask> {
  if (!assistant.busy) {
    const existing = tasks.assistant;
    if (!existing) return tasks;
    return assistant.error ? upsertTask(tasks, { id: "assistant", kind: "assistant", status: "failed", error: assistant.error, label: "Assistant request failed" }, Date.now()) : removeTask(tasks, "assistant");
  }
  return upsertTask(tasks, { id: "assistant", kind: "assistant", label: "Assistant", status: "running", detail: assistant.activity ?? "Working on your request…", cancellable: true, major: true, blocks: [] }, Date.now());
}

/** Leaving or replacing a project cancels its work; failures and notes from the old project go too. */
function cancelActive(tasks: Record<string, ProcessingTask>): Record<string, ProcessingTask> {
  for (const task of Object.values(tasks)) {
    if (isActive(task)) taskActions(task.id).cancel?.();
  }
  return {};
}
