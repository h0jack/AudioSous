import { useState } from "react";
import { ProjectFileError } from "@audiosous/project-model";
import { Button } from "../components/ui";
import { openChosenProject } from "../lib/project-actions";
import { getPlatform, isTauri } from "../platform";
import { useAppStore } from "../state/app-store";

export function WelcomeScreen() {
  const startImport = useAppStore((state) => state.startImport);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const platform = getPlatform();
  const desktop = isTauri();

  async function openProject() {
    setError(null);
    const path = await platform.pickProjectFile();
    if (!path) return;
    setBusy(true);
    try {
      await openChosenProject(platform, path);
    } catch (caught) {
      setError(caught instanceof ProjectFileError || caught instanceof Error ? caught.message : "The project could not be opened.");
    } finally {
      setBusy(false);
    }
  }

  async function reopenPreview() {
    const json = platform.readPreview();
    if (!json) return;
    setBusy(true);
    try {
      await platform.writeProject("preview://project.amix", json, { download: false });
      await openChosenProject(platform, "preview://project.amix");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The preview could not be reopened.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center px-6 py-16">
      <p className="font-display text-5xl text-ink">Audiosous</p>
      <p className="mt-4 max-w-md text-lg leading-relaxed text-muted">
        Bring in the WAV stems from a session. Audiosous keeps a copy, guesses what each one is, and saves a project you can reopen.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button title="Start a project from stems" tone="accent" onClick={startImport} disabled={busy}>
          New project
        </Button>
        <Button title="Open a saved project" onClick={() => void openProject()} disabled={busy}>
          Open project
        </Button>
        {!desktop && platform.hasPreview() ? (
          <Button title="Reopen the last browser preview" onClick={() => void reopenPreview()} disabled={busy}>
            Reopen preview
          </Button>
        ) : null}
      </div>
      {!desktop ? (
        <p className="mt-8 max-w-md text-sm leading-relaxed text-faint">
          This window is a browser preview. It can inspect stems you drop and save the project file. Copying audio into a project folder happens in the desktop app.
        </p>
      ) : null}
      {error ? <p className="mt-6 text-sm text-danger">{error}</p> : null}
    </div>
  );
}
