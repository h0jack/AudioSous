import { useEffect, useState } from "react";
import { AnalysisView } from "../components/AnalysisView";
import { FrequencyInteractionView } from "../components/FrequencyInteractionView";
import { PlansPanel } from "../components/PlansPanel";
import { SpatialInteractionView } from "../components/SpatialInteractionView";
import { Timeline } from "../components/Timeline";
import { usePlayback } from "../lib/playback";
import { loadProjectWaveforms, waveformLoadRatio, type LoadedWaveform, type WaveformLoadProgress } from "../lib/waveforms";
import { getPlatform } from "../platform";
import { useAppStore } from "../state/app-store";

export function ProjectScreen() {
  const document = useAppStore((state) => state.document);
  const projectFilePath = useAppStore((state) => state.projectFilePath);
  const warnings = useAppStore((state) => state.warnings);
  const workspace = useAppStore((state) => state.workspace);
  const [waveforms, setWaveforms] = useState<Record<string, LoadedWaveform>>({});
  const [analysisView, setAnalysisView] = useState<"stems" | "interaction" | "spatial">("stems");
  const [status, setStatus] = useState<string | null>("Measuring waveforms");
  const [progress, setProgress] = useState<WaveformLoadProgress | null>(() => initialWaveformProgress());
  const trackKey = document?.tracks.map((track) => `${track.id}:${track.metadata.fileSizeBytes}:${track.metadata.durationSeconds}`).join("|") ?? "";
  const playback = usePlayback(document, projectFilePath);

  useEffect(() => {
    if (!document || !projectFilePath) return;
    let cancelled = false;
    const finish = () => {
      if (!cancelled) useAppStore.getState().setPreparing(false);
    };
    if (document.tracks.length === 0) {
      setWaveforms({});
      setProgress(null);
      setStatus(null);
      finish();
      return;
    }
    setWaveforms({});
    setStatus("Measuring waveforms");
    setProgress({
      index: 0,
      total: document.tracks.length,
      filename: document.tracks[0]?.file.filename ?? "",
      fileRatio: 0,
    });
    useAppStore.getState().setPreparing(true);
    void loadProjectWaveforms(getPlatform(), projectFilePath, document, {
      shouldCancel: () => cancelled,
      onProgress: (next) => {
        if (!cancelled) {
          setProgress(next);
          setStatus(`Measuring ${next.index + 1} of ${next.total}: ${next.filename}`);
        }
      },
    })
      .then((loaded) => {
        if (cancelled) return;
        setWaveforms(loaded);
        setProgress(null);
        setStatus(null);
        finish();
      })
      .catch(() => {
        if (cancelled) return;
        setProgress(null);
        setStatus("Waveforms could not be measured.");
        finish();
      });
    return () => {
      cancelled = true;
      void getPlatform().cancelWaveform();
    };
  }, [document?.project.id, projectFilePath, trackKey]);

  if (!document) return null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {progress ? <MeasurementGate progress={progress} /> : null}
      <div className="flex min-h-0 flex-1 flex-col" inert={progress ? true : undefined}>
        {warnings.length > 0 ? (
          <ul className="space-y-1 px-5 py-2 text-sm text-danger">
            {warnings.map((warning) => (
              <li key={`${warning.code}-${warning.trackId ?? warning.filename}`}>{warning.message}</li>
            ))}
          </ul>
        ) : null}
        <div className={workspace === "mix" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <div className="min-h-0 flex-1">
            <Timeline document={document} waveforms={waveforms} status={status} playback={playback} />
          </div>
          <PlansPanel document={document} playback={playback} />
        </div>
        {workspace === "analysis" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-1 border-b border-line px-4 py-1.5" role="tablist" aria-label="Analysis views">
              {(["stems", "interaction", "spatial"] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  role="tab"
                  aria-selected={analysisView === view}
                  className={`rounded px-2.5 py-1 text-xs ${analysisView === view ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"}`}
                  onClick={() => setAnalysisView(view)}
                >
                  {view === "stems" ? "Stems" : view === "interaction" ? "Frequency interaction" : "Spatial interaction"}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {analysisView === "stems" ? (
                <AnalysisView document={document} projectFile={projectFilePath} playheadSeconds={playback.playhead} onSeek={playback.seek} />
              ) : analysisView === "interaction" ? (
                <FrequencyInteractionView document={document} onSeek={playback.seek} />
              ) : (
                <SpatialInteractionView document={document} onSeek={playback.seek} />
              )}
            </div>
          </div>
        ) : null}
        <p className="px-5 py-2 text-xs text-faint">
          Space plays and pauses. Home returns to the start. Arrows seek one second, Shift+arrows seek five seconds, and Ctrl+arrows seek one millisecond. Hold an arrow to keep moving. Drag a range to add a section, or drag a section guide to align it. Ctrl+Z undoes an edit.
          {getPlatform().kind === "browser" ? " Media is not copied in the browser preview." : " Source files were not modified."}
        </p>
      </div>
    </div>
  );
}

function initialWaveformProgress(): WaveformLoadProgress | null {
  const current = useAppStore.getState().document;
  if (!current || current.tracks.length === 0) return null;
  return {
    index: 0,
    total: current.tracks.length,
    filename: current.tracks[0]?.file.filename ?? "",
    fileRatio: 0,
  };
}

function MeasurementGate({ progress }: { progress: WaveformLoadProgress }) {
  const ratio = waveformLoadRatio(progress);
  const percent = Math.round(ratio * 100);
  const label = progress.filename
    ? `Measuring ${progress.index + 1} of ${progress.total}: ${progress.filename}`
    : "Measuring waveforms";
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-canvas/90 px-6">
      <div className="w-full max-w-md rounded-lg border border-line bg-panel px-6 py-5" role="status" aria-live="polite">
        <h2 className="font-display text-3xl">Measuring waveforms</h2>
        <p className="mt-2 text-sm text-muted">Playback and editing stay off until every stem has been measured.</p>
        <div
          className="mt-5 h-2 overflow-hidden rounded-full bg-panel-2"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={label}
        >
          <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-2 font-mono text-xs text-faint">
          {label}
          {percent > 0 ? ` · ${percent}%` : ""}
        </p>
      </div>
    </div>
  );
}
