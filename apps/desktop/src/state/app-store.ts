import type { ImportWarning, ProjectDocument } from "@audiosous/project-model";
import { create } from "zustand";

export type Screen = "welcome" | "import" | "project";

interface AppState {
  screen: Screen;
  document: ProjectDocument | null;
  projectFilePath: string | null;
  warnings: ImportWarning[];
  dirty: boolean;
  notice: string | null;
  goWelcome: () => void;
  startImport: () => void;
  openDocument: (document: ProjectDocument, projectFilePath: string | null, warnings: ImportWarning[]) => void;
  replaceDocument: (document: ProjectDocument, dirty: boolean) => void;
  setNotice: (notice: string | null) => void;
  setWarnings: (warnings: ImportWarning[]) => void;
}

export const useAppStore = create<AppState>((set) => ({
  screen: "welcome",
  document: null,
  projectFilePath: null,
  warnings: [],
  dirty: false,
  notice: null,
  goWelcome: () => set({ screen: "welcome", notice: null }),
  startImport: () => set({ screen: "import", notice: null }),
  openDocument: (document, projectFilePath, warnings) =>
    set({ screen: "project", document, projectFilePath, warnings, dirty: false, notice: null }),
  replaceDocument: (document, dirty) => set({ document, dirty }),
  setNotice: (notice) => set({ notice }),
  setWarnings: (warnings) => set({ warnings }),
}));
