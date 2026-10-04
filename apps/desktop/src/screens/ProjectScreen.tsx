import { useEffect, useState } from "react";
import { AnalysisView } from "../components/AnalysisView";
import { Timeline } from "../components/Timeline";
import { loadProjectWaveforms, type LoadedWaveform } from "../lib/waveforms";
import { getPlatform } from "../platform";
import { useAppStore } from "../state/app-store";

export function ProjectScreen() {
  const document = useAppStore((state) => state.document);
  const projectFilePath = useAppStore((state) => state.projectFilePath);
  const warnings = useAppStore((state) => state.warnings);
  const workspace = useAppStore((state) => state.workspace);
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {warnings.length > 0 ? (
        <ul className="space-y-1 px-5 py-2 text-sm text-danger">
          {warnings.map((warning) => (
            <li key={`${warning.code}-${warning.trackId ?? warning.filename}`}>{warning.message}</li>
          ))}
        </ul>
      ) : null}
      <div className={workspace === "mix" ? "min-h-0 flex-1" : "hidden"}>
        <Timeline document={document} projectFile={projectFilePath} waveforms={waveforms} status={status} />
      </div>
      {workspace === "analysis" ? (
        <div className="min-h-0 flex-1">
          <AnalysisView document={document} projectFile={projectFilePath} />
        </div>
      ) : null}
      <p className="px-5 py-2 text-xs text-faint">
        Space plays and pauses. Home returns to the start. Arrows seek one second, Shift+arrows seek five seconds, and Ctrl+arrows seek one millisecond. Hold an arrow to keep moving. Drag a range to add a section, or drag a section guide to align it. Ctrl+Z undoes an edit.
        {getPlatform().kind === "browser" ? " Media is not copied in the browser preview." : " Source files were not modified."}
      </p>
    </div>
  );
}
