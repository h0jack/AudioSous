import type { AutoBalanceSettings, MixPlan, SourceFingerprint } from "@audiosous/balance-planner";
import type { EqPlan, EqSettings } from "@audiosous/eq-planner";
import type { SpatialPlan, SpatialSettings } from "@audiosous/spatial-planner";
import type { DynamicsPlan, DynamicsSettings } from "@audiosous/dynamics-planner";
import type { FullMixPlan, FullMixSettings } from "@audiosous/mix-planner";
import type { AgentSession } from "@audiosous/mix-agent";
import type { AgentSettingsInfo } from "../platform/types";
import type { ImportWarning, ProjectDocument } from "@audiosous/project-model";
import { create } from "zustand";
import { applyEdit, emptyHistory, redoEdit, undoEdit, type EditHistory, type HistoryMode } from "./history";

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
  assistant: AssistantState;
  planTab: PlanTab;
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
  assistant: idleAssistant(),
  planTab: "gain",
  goWelcome: () => set({ screen: "welcome", notice: null, workspace: "mix", preparing: false, balance: idleBalance(), eq: idleEq(), space: idleSpace(), dynamics: idleDynamics(), fullMix: idleFullMix(), assistant: idleAssistant(false, get().assistant.settings) }),
  setWorkspace: (workspace) => set({ workspace }),
  startImport: () => set({ screen: "import", notice: null, preparing: false }),
  openDocument: (document, projectFilePath, warnings) =>
    set({
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
  setBalance: (patch) => set({ balance: { ...get().balance, ...patch } }),
  setEq: (patch) => set({ eq: { ...get().eq, ...patch } }),
  setSpace: (patch) => set({ space: { ...get().space, ...patch } }),
  setDynamics: (patch) => set({ dynamics: { ...get().dynamics, ...patch } }),
  setFullMix: (patch) => set({ fullMix: { ...get().fullMix, ...patch } }),
  setAssistant: (patch) => set({ assistant: { ...get().assistant, ...patch } }),
  setPlanTab: (planTab) => set({ planTab }),
}));
