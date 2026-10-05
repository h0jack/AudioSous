import type { AutoBalanceSettings, MixPlan, SourceFingerprint } from "@audiosous/balance-planner";
import type { EqPlan, EqSettings } from "@audiosous/eq-planner";
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

export type PlanTab = "gain" | "eq";

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
  planTab: "gain",
  goWelcome: () => set({ screen: "welcome", notice: null, workspace: "mix", preparing: false, balance: idleBalance(), eq: idleEq() }),
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
  setPlanTab: (planTab) => set({ planTab }),
}));
