import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui";
import { saveOpenProject } from "./lib/project-actions";
import { getPlatform } from "./platform";
import { NewProjectScreen } from "./screens/NewProjectScreen";
import { ProjectScreen } from "./screens/ProjectScreen";
import { WelcomeScreen } from "./screens/WelcomeScreen";
import { useAppStore } from "./state/app-store";

export function App() {
  const screen = useAppStore((state) => state.screen);
  const document = useAppStore((state) => state.document);
  const dirty = useAppStore((state) => state.dirty);
  const canUndo = useAppStore((state) => state.history.past.length > 0);
  const canRedo = useAppStore((state) => state.history.future.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveTask = useRef<Promise<void> | null>(null);

  async function save(download: boolean) {
    const previous = saveTask.current;
    let run: Promise<void> = Promise.resolve();
    run = (async () => {
      if (previous) await previous.catch(() => undefined);
      setError(null);
      setSaving(true);
      try {
        await saveOpenProject(getPlatform(), { download });
        if (useAppStore.getState().dirty && useAppStore.getState().screen === "project") {
          window.setTimeout(() => {
            void save(false);
          }, 800);
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The project could not be saved.");
      } finally {
        setSaving(false);
        if (saveTask.current === run) saveTask.current = null;
      }
    })();
    saveTask.current = run;
    await run;
  }

  useEffect(() => {
    if (screen !== "project") return;
    let timer: number | null = null;
    const stop = useAppStore.subscribe((state, previous) => {
      if (state.screen !== "project" || !state.dirty || state.document === previous.document) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void save(false);
      }, 800);
    });
    return () => {
      stop();
      if (timer) window.clearTimeout(timer);
    };
  }, [screen]);

  useEffect(() => {
    if (screen !== "project") return;
    const onKey = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (!command) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void save(getPlatform().kind === "browser");
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select")) return;
      if (key === "z" && event.shiftKey) {
        event.preventDefault();
        useAppStore.getState().redo();
      } else if (key === "z") {
        event.preventDefault();
        useAppStore.getState().undo();
      } else if (key === "y") {
        event.preventDefault();
        useAppStore.getState().redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen]);

  return (
    <div className="flex h-full min-h-screen flex-col bg-canvas text-ink">
      <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
        <div className="flex min-w-0 items-baseline gap-4">
          <p className="font-display text-2xl">Audiosous</p>
          {document && screen === "project" ? <p className="truncate text-sm text-muted">{document.project.name}</p> : null}
        </div>
        {screen === "project" ? (
          <div className="flex items-center gap-3">
            <span className="text-xs text-faint">{saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
            <Button onClick={() => useAppStore.getState().undo()} disabled={!canUndo || saving}>
              Undo
            </Button>
            <Button onClick={() => useAppStore.getState().redo()} disabled={!canRedo || saving}>
              Redo
            </Button>
            <Button tone="accent" onClick={() => void save(getPlatform().kind === "browser")} disabled={saving}>
              Save
            </Button>
          </div>
        ) : null}
      </header>
      {error ? <p className="border-b border-line px-5 py-2 text-sm text-danger">{error}</p> : null}
      <main className="min-h-0 flex-1 overflow-auto">
        {screen === "welcome" ? <WelcomeScreen /> : null}
        {screen === "import" ? <NewProjectScreen /> : null}
        {screen === "project" ? <ProjectScreen /> : null}
      </main>
    </div>
  );
}
