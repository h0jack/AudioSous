import { formatClock, formatSampleRate } from "@audiosous/project-model";
import { useEffect, useRef, useState } from "react";
import { Button, HoverTip } from "./components/ui";
import { editProjectName, saveOpenProject } from "./lib/project-actions";
import { getPlatform, isTauri } from "./platform";
import { NewProjectScreen } from "./screens/NewProjectScreen";
import { ProjectScreen } from "./screens/ProjectScreen";
import { WelcomeScreen } from "./screens/WelcomeScreen";
import { useAppStore } from "./state/app-store";

export function App() {
  const screen = useAppStore((state) => state.screen);
  const document = useAppStore((state) => state.document);
  const projectFilePath = useAppStore((state) => state.projectFilePath);
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
      if (state.holdAutosave) {
        if (timer) window.clearTimeout(timer);
        timer = null;
        return;
      }
      const released = previous.holdAutosave && !state.holdAutosave;
      const edited = state.dirty && state.document !== previous.document;
      if (state.screen !== "project" || !state.dirty || (!edited && !released)) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (useAppStore.getState().holdAutosave) return;
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

  function leave() {
    if (dirty && !window.confirm("Leave this project without saving?")) return;
    useAppStore.getState().goWelcome();
  }

  const projectOpen = document !== null && screen === "project";
  const summary = projectOpen
    ? `${document.tracks.length} ${document.tracks.length === 1 ? "stem" : "stems"} · ${formatSampleRate(document.project.sampleRate)} · ${formatClock(document.project.durationSeconds)}`
    : "";

  return (
    <div className="flex h-full min-h-screen flex-col bg-canvas text-ink">
      <header className="flex items-center gap-4 border-b border-line px-5 py-2">
        <p className="shrink-0 font-display text-2xl">Audiosous</p>
        {projectOpen ? (
          <>
            <ProjectTitle name={document.project.name} />
            <HoverTip label={isTauri() && projectFilePath ? projectFilePath : summary} className="hidden min-w-0 sm:block">
              <p className="truncate font-mono text-xs text-muted">{summary}</p>
            </HoverTip>
          </>
        ) : (
          <div className="flex-1" />
        )}
        {projectOpen ? (
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <ViewToggle />
            <HoverTip label="Close this project">
              <button type="button" className="text-sm text-muted underline-offset-2 hover:underline" onClick={leave}>
                Close
              </button>
            </HoverTip>
            <span className="text-xs text-faint">{saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
            <Button title="Undo the last edit" onClick={() => useAppStore.getState().undo()} disabled={!canUndo || saving}>
              Undo
            </Button>
            <Button title="Redo the last undone edit" onClick={() => useAppStore.getState().redo()} disabled={!canRedo || saving}>
              Redo
            </Button>
            <Button title="Save the project" tone="accent" onClick={() => void save(getPlatform().kind === "browser")} disabled={saving}>
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

function ViewToggle() {
  const workspace = useAppStore((state) => state.workspace);
  return (
    <div className="flex rounded-md border border-line p-0.5" role="group" aria-label="Project view">
      {(["mix", "analysis"] as const).map((view) => (
        <button
          key={view}
          type="button"
          aria-pressed={workspace === view}
          className={`rounded px-3 py-1 text-xs tracking-wide uppercase ${workspace === view ? "bg-accent text-accent-ink" : "text-muted"}`}
          onClick={() => useAppStore.getState().setWorkspace(view)}
        >
          {view === "mix" ? "Mix" : "Analysis"}
        </button>
      ))}
    </div>
  );
}

function ProjectTitle({ name }: { name: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const cancelEdit = useRef(false);
  if (editing) {
    return (
      <input
        autoFocus
        aria-label="Project name"
        value={draft}
        maxLength={200}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft.trim();
          const cancelled = cancelEdit.current;
          cancelEdit.current = false;
          setEditing(false);
          if (!cancelled && next && next !== name) editProjectName(next);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          const next = draft.trim();
          cancelEdit.current = true;
          setEditing(false);
          if (event.key === "Enter" && next && next !== name) editProjectName(next);
        }}
        className="w-56 rounded-md border border-line bg-canvas px-2 py-1 text-sm"
      />
    );
  }
  return (
    <HoverTip label="Rename this project" className="min-w-0 max-w-56">
      <button
        type="button"
        className="block w-full truncate text-left text-sm text-muted"
        onClick={() => {
          cancelEdit.current = false;
          setDraft(name);
          setEditing(true);
        }}
      >
        {name}
      </button>
    </HoverTip>
  );
}
