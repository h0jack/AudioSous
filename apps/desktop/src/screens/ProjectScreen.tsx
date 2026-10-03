import { formatClock, formatSampleRate } from "@audiosous/project-model";
import { useEffect, useState } from "react";
import { TextField } from "../components/ui";
import { Timeline } from "../components/Timeline";
import { editProjectName } from "../lib/project-actions";
import { loadProjectWaveforms, type LoadedWaveform } from "../lib/waveforms";
import { getPlatform, isTauri } from "../platform";
import { useAppStore } from "../state/app-store";

export function ProjectScreen() {
  const document = useAppStore((state) => state.document);
  const projectFilePath = useAppStore((state) => state.projectFilePath);
  const warnings = useAppStore((state) => state.warnings);
  const goWelcome = useAppStore((state) => state.goWelcome);
  const dirty = useAppStore((state) => state.dirty);
  const [waveforms, setWaveforms] = useState<Record<string, LoadedWaveform>>({});
  const [status, setStatus] = useState<string | null>("Measuring waveforms");
  const trackKey = document?.tracks.map((track) => `${track.id}:${track.metadata.fileSizeBytes}:${track.metadata.durationSeconds}`).join("|") ?? "";

  useEffect(() => {
    if (!document || !projectFilePath) return;
    let cancelled = false;
    setWaveforms({});
    setStatus("Measuring waveforms");
    void loadProjectWaveforms(getPlatform(), projectFilePath, document, {
      shouldCancel: () => cancelled,
      onProgress: (label) => {
        if (!cancelled && label) setStatus(label);
      },
    })
      .then((loaded) => {
        if (cancelled) return;
        setWaveforms(loaded);
        setStatus(null);
      })
      .catch(() => {
        if (!cancelled) setStatus("Waveforms could not be measured.");
      });
    return () => {
      cancelled = true;
    };
  }, [document?.project.id, projectFilePath, trackKey]);

  if (!document) return null;

  function leave() {
    if (dirty && !window.confirm("Leave this project without saving?")) return;
    goWelcome();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-end justify-between gap-6 px-5 py-3">
        <div className="min-w-0 flex-1">
          <TextField label="Project" value={document.project.name} onChange={editProjectName} />
        </div>
        <button type="button" className="mb-2 text-sm text-muted underline-offset-2 hover:underline" onClick={leave}>
          Close
        </button>
      </div>
      <p className="px-5 pb-2 font-mono text-sm text-muted">
        {document.tracks.length} {document.tracks.length === 1 ? "stem" : "stems"}
        {" · "}
        {formatSampleRate(document.project.sampleRate)}
        {" · "}
        {formatClock(document.project.durationSeconds)}
        {isTauri() && projectFilePath ? ` · ${projectFilePath}` : ""}
      </p>
      {warnings.length > 0 ? (
        <ul className="space-y-1 px-5 pb-2 text-sm text-danger">
          {warnings.map((warning) => (
            <li key={`${warning.code}-${warning.trackId ?? warning.filename}`}>{warning.message}</li>
          ))}
        </ul>
      ) : null}
      <div className="min-h-0 flex-1 border-t border-line">
        <Timeline document={document} projectFile={projectFilePath} waveforms={waveforms} status={status} />
      </div>
      <p className="px-5 py-2 text-xs text-faint">
        Space plays and pauses. Drag a range to add a section, or suggest sections from the waveforms. Ctrl+Z undoes an edit.
        {getPlatform().kind === "browser" ? " Media is not copied in the browser preview." : " Source files were not modified."}
      </p>
    </div>
  );
}
