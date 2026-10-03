import { useEffect, useState } from "react";
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
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      await saveOpenProject(getPlatform());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The project could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (screen !== "project") return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
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
            <span className="text-xs text-faint">{dirty ? "Unsaved changes" : "Saved"}</span>
            <Button tone="accent" onClick={() => void save()} disabled={saving}>
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
