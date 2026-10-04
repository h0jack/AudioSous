import { TRACK_ROLE_LABELS, type ProjectDocument } from "@audiosous/project-model";
import { useEffect, useState } from "react";
import { loadTrackAnalysis, TrackAnalysisError, type AnalysisJobStatus } from "../lib/track-analysis";
import type { TrackFileMeasurement } from "@audiosous/analysis-contract";
import { getPlatform } from "../platform";
import { useAppStore } from "../state/app-store";
import { Button } from "./ui";

const STATUS_LABEL: Record<AnalysisJobStatus, string> = {
  "not-analyzed": "Not analyzed",
  queued: "Queued",
  analyzing: "Analyzing",
  complete: "Complete",
  failed: "Failed",
  stale: "Stale",
};

export function AnalysisView({ document, projectFile }: { document: ProjectDocument; projectFile: string | null }) {
  const selectedId = document.uiState.selectedTrackId;
  const section = document.sections.find((item) => item.id === document.uiState.selectedSectionId);
  const track = document.tracks.find((item) => item.id === selectedId) ?? null;
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useState<AnalysisJobStatus>("not-analyzed");
  const [measurement, setMeasurement] = useState<TrackFileMeasurement | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    if (!track || !projectFile) {
      setStatus("not-analyzed");
      setMeasurement(null);
      setMessage(null);
      setDetail(null);
      setFromCache(false);
      return;
    }
    let cancelled = false;
    setStatus("queued");
    setMeasurement(null);
    setFromCache(false);
    setMessage(null);
    setDetail(null);
    void loadTrackAnalysis(getPlatform(), projectFile, { id: track.id, filename: track.file.filename, relativePath: track.file.relativePath }, (next) => {
      if (!cancelled) setStatus(next);
    })
      .then((loaded) => {
        if (cancelled) return;
        setMeasurement(loaded.measurement);
        setFromCache(loaded.fromCache);
        setStatus("complete");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setMeasurement(null);
        setFromCache(false);
        setStatus("failed");
        if (error instanceof TrackAnalysisError) {
          setMessage(error.message);
          setDetail(error.detail || null);
          return;
        }
        setMessage(error instanceof Error ? error.message : "Unable to analyze this stem.");
        setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [track?.id, track?.file.relativePath, track?.metadata.fileSizeBytes, projectFile, retry]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 shrink-0 flex-col gap-1 overflow-auto border-r border-line px-3 py-3">
        <p className="px-2 pb-1 text-[10px] tracking-wide text-faint uppercase">Tracks</p>
        {document.tracks.map((item) => {
          const selected = item.id === selectedId;
          const role = item.role === "other" && item.customLabel ? item.customLabel : TRACK_ROLE_LABELS[item.role];
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected}
              onClick={() => selectTrack(item.id)}
              className={`rounded-md px-2 py-2 text-left ${selected ? "bg-panel-2 text-ink" : "text-muted hover:bg-panel"}`}
            >
              <span className="block truncate text-sm">{item.name}</span>
              <span className="block truncate text-[11px] text-faint">{role}</span>
            </button>
          );
        })}
      </aside>
      <section className="min-w-0 flex-1 overflow-auto px-6 py-5" aria-label="Stem analysis">
        {!track ? (
          <p className="text-sm text-muted">Select a stem to see its measurements.</p>
        ) : (
          <div className="max-w-xl">
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <h2 className="font-display text-3xl">{track.name}</h2>
                <p className="mt-1 text-sm text-muted">Whole stem</p>
                {section || document.uiState.timeRange ? (
                  <p className="mt-1 text-xs text-faint">
                    {section ? `${section.name} is selected. ` : ""}
                    {document.uiState.timeRange ? "A time range is selected. " : ""}
                    These measurements cover the entire stem.
                  </p>
                ) : null}
              </div>
              <p className="font-mono text-xs text-faint" aria-label="Analysis status">
                {STATUS_LABEL[status]}
                {status === "complete" && fromCache ? " · cached" : ""}
              </p>
            </div>
            {status === "failed" ? (
              <div className="mt-6 rounded-md border border-line bg-panel px-4 py-3">
                <p className="text-sm text-ink">{message ?? `Unable to analyze ${track.file.filename}`}</p>
                {detail ? <p className="mt-2 text-sm text-muted">Reason: {detail}</p> : null}
                <Button className="mt-3" title="Measure this stem again" onClick={() => setRetry((current) => current + 1)}>
                  Retry
                </Button>
              </div>
            ) : null}
            {measurement ? <MeasurementSummary measurement={measurement} /> : null}
            {!measurement && status !== "failed" ? <p className="mt-6 text-sm text-muted">{STATUS_LABEL[status]}…</p> : null}
          </div>
        )}
      </section>
    </div>
  );
}

function MeasurementSummary({ measurement }: { measurement: TrackFileMeasurement }) {
  const { levels, bandEnergy } = measurement;
  const dominant = bandEnergy.reduce((best, band) => (band.normalizedEnergy > best.normalizedEnergy ? band : best));
  return (
    <div className="mt-6 space-y-8">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
        <Level label="Peak" value={levels.peakDbfs} unit="dBFS" />
        <Level label="RMS" value={levels.rmsDbfs} unit="dBFS" />
        <Level label="Integrated LUFS" value={levels.integratedLufs} unit="LUFS" note={lufsNote(levels.integratedLufsStatus, levels.peakDbfs)} />
        <Level label="Crest factor" value={levels.crestFactorDb} unit="dB" />
      </dl>
      <div>
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-[10px] tracking-wide text-muted uppercase">Frequency bands</h3>
          {dominant.normalizedEnergy > 0 ? <p className="text-xs text-faint">Largest share · {dominant.name}</p> : null}
        </div>
        <ul className="space-y-2">
          {bandEnergy.map((band) => (
            <li key={band.id} className="grid grid-cols-[7.5rem_1fr_3rem] items-center gap-3 text-sm">
              <span>
                <span className="block text-ink">{band.name}</span>
                <span className="block font-mono text-[10px] text-faint">
                  {formatHz(band.lowHz)}–{formatHz(band.highHz)}
                </span>
              </span>
              <span className="h-2 overflow-hidden rounded bg-panel-2">
                <span className="block h-2 rounded bg-accent" style={{ width: `${Math.max(0, Math.min(100, band.normalizedEnergy * 100))}%` }} />
              </span>
              <span className="text-right font-mono text-xs text-muted">{Math.round(band.normalizedEnergy * 100)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Level({ label, value, unit, note }: { label: string; value: number | null; unit: string; note?: string | null }) {
  return (
    <div>
      <dt className="text-[10px] tracking-wide text-muted uppercase">{label}</dt>
      <dd className="font-mono text-ink">
        {value === null ? "—" : `${value.toFixed(1)} ${unit}`}
        {note ? <span className="mt-0.5 block font-sans text-[11px] text-faint">{note}</span> : null}
      </dd>
    </div>
  );
}

function lufsNote(status: TrackFileMeasurement["levels"]["integratedLufsStatus"], peak: number | null): string | null {
  if (status === "measured") return null;
  if (status === "too-short") return "Too short for integrated loudness.";
  if (peak === null) return "This stem is silent.";
  return "Integrated loudness is below the measurement gate.";
}

function formatHz(hz: number): string {
  if (hz >= 1000) return `${hz / 1000} kHz`;
  return `${hz} Hz`;
}

function selectTrack(trackId: string) {
  const current = useAppStore.getState().document;
  if (!current || current.uiState.selectedTrackId === trackId) return;
  useAppStore.getState().replaceDocument({ ...current, uiState: { ...current.uiState, selectedTrackId: trackId } }, true, { mode: "skip" });
}
