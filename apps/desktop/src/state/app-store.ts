import type { ImportWarning, ProjectDocument } from "@audiosous/project-model";
import { create } from "zustand";
import { applyEdit, emptyHistory, redoEdit, undoEdit, type EditHistory, type HistoryMode } from "./history";

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
  workspace: Workspace;
  goWelcome: () => void;
  setWorkspace: (workspace: Workspace) => void;
  startImport: () => void;
  openDocument: (document: ProjectDocument, projectFilePath: string | null, warnings: ImportWarning[]) => void;
  replaceDocument: (document: ProjectDocument, dirty: boolean, edit?: DocumentEdit) => void;
  undo: () => void;
  redo: () => void;
  setNotice: (notice: string | null) => void;
  setWarnings: (warnings: ImportWarning[]) => void;
  setHoldAutosave: (held: boolean) => void;
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
  workspace: "mix",
  goWelcome: () => set({ screen: "welcome", notice: null, workspace: "mix" }),
  setWorkspace: (workspace) => set({ workspace }),
  startImport: () => set({ screen: "import", notice: null }),
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
      workspace: "mix",
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
  setWarnings: (warnings) => set({ warnings }),
  setHoldAutosave: (holdAutosave) => set({ holdAutosave }),
}));
