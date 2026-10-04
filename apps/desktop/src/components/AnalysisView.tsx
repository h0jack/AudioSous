import {
  mixAnalysisCacheName,
  rangeAnalysisCacheName,
  sectionAnalysisCacheName,
  type MeasurementScope,
  type TrackFileMeasurement,
} from "@audiosous/analysis-contract";
import { TRACK_ROLE_LABELS, type ProjectDocument, type SongSection, type Track } from "@audiosous/project-model";
import { useEffect, useState, type ReactNode } from "react";
import { loadAnalysis, loadTrackAnalysis, TrackAnalysisError, type AnalysisJobStatus, type AnalysisTarget } from "../lib/track-analysis";
import { getPlatform } from "../platform";
import { useAppStore } from "../state/app-store";
import { ActivityMap, LevelComparison, LoudnessChart, OverlapBars, SpectrogramChart, SpectrumChart } from "./analysis-charts";
import { Button } from "./ui";

const STATUS_LABEL: Record<AnalysisJobStatus, string> = {
  "not-analyzed": "Not analyzed",
  queued: "Queued",
  analyzing: "Analyzing",
  complete: "Complete",
  failed: "Failed",
  stale: "Stale",
};

type ScopeChoice = "track" | "section" | "time-range" | "mix";

const SCOPE_CHOICES: Array<{ id: ScopeChoice; label: string }> = [
  { id: "track", label: "Stem" },
  { id: "section", label: "Section" },
  { id: "time-range", label: "Range" },
  { id: "mix", label: "Mix" },
];

export function AnalysisView({ document, projectFile }: { document: ProjectDocument; projectFile: string | null }) {
  const selectedId = document.uiState.selectedTrackId;
  const section = document.sections.find((item) => item.id === document.uiState.selectedSectionId) ?? null;
  const timeRange = document.uiState.timeRange;
  const track = document.tracks.find((item) => item.id === selectedId) ?? null;
  const [scopeChoice, setScopeChoice] = useState<ScopeChoice>("track");
  const [compareId, setCompareId] = useState<string>("");
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useState<AnalysisJobStatus>("not-analyzed");
  const [measurement, setMeasurement] = useState<TrackFileMeasurement | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [comparison, setComparison] = useState<TrackFileMeasurement | null>(null);
  const [comparisonNote, setComparisonNote] = useState<string | null>(null);
  const [activity, setActivity] = useState<Array<{ id: string; name: string; timeline: TrackFileMeasurement["loudnessTimeline"]; failed: boolean }>>([]);

  const target = measurementTarget(document, track, section, scopeChoice);
  const compareTrack = document.tracks.find((item) => item.id === compareId && item.id !== track?.id) ?? null;
  const compareTarget = compareTrack ? comparisonTarget(compareTrack, section, timeRange, scopeChoice) : null;
  const fileKey = document.tracks.map((item) => `${item.id}:${item.file.relativePath}:${item.metadata.fileSizeBytes}`).join("|");

  useEffect(() => {
    if (!projectFile || !target) {
      setStatus("not-analyzed");
      setMeasurement(null);
      setMessage(scopeMessage(scopeChoice, section, timeRange));
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
    void loadAnalysis(getPlatform(), projectFile, target, (next) => {
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
  }, [target?.cacheName, target?.scopeKey, scopeChoice, section?.id, section?.startTime, section?.endTime, timeRange?.start, timeRange?.end, projectFile, retry, fileKey]);

  useEffect(() => {
    if (!projectFile || !compareTarget) {
      setComparison(null);
      setComparisonNote(null);
      return;
    }
    let cancelled = false;
    setComparison(null);
    setComparisonNote(null);
    void loadAnalysis(getPlatform(), projectFile, compareTarget)
      .then((loaded) => {
        if (cancelled) return;
        setComparison(loaded.measurement);
        setComparisonNote(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setComparison(null);
        setComparisonNote(error instanceof Error && error.message ? error.message : `Unable to analyze ${compareTarget.label}.`);
      });
    return () => {
      cancelled = true;
    };
  }, [compareTarget?.cacheName, compareTarget?.scopeKey, projectFile, fileKey]);

  useEffect(() => {
    if (!projectFile || document.tracks.length === 0) {
      setActivity([]);
      return;
    }
    let cancelled = false;
    setActivity([]);
    const rows: Array<{ id: string; name: string; timeline: TrackFileMeasurement["loudnessTimeline"]; failed: boolean }> = [];
    void (async () => {
      for (const item of document.tracks) {
        if (cancelled) return;
        try {
          const loaded = await loadTrackAnalysis(getPlatform(), projectFile, {
            id: item.id,
            filename: item.file.filename,
            relativePath: item.file.relativePath,
          });
          if (cancelled) return;
          rows.push({ id: item.id, name: item.name, timeline: loaded.measurement.loudnessTimeline, failed: false });
        } catch {
          if (cancelled) return;
          rows.push({ id: item.id, name: item.name, timeline: [], failed: true });
        }
        if (!cancelled) setActivity(rows.slice());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectFile, fileKey]);

  const heading = scopeChoice === "mix" ? "Mix" : (track?.name ?? "Analysis");
  const scopeLabel = describeScope(scopeChoice, section, timeRange, measurement);

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
        <div className="max-w-3xl">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-display text-3xl">{heading}</h2>
              <p className="mt-1 text-sm text-muted">{scopeLabel}</p>
            </div>
            <p className="font-mono text-xs text-faint" aria-label="Analysis status">
              {STATUS_LABEL[status]}
              {status === "complete" && fromCache ? " · cached" : ""}
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Measurement scope">
            {SCOPE_CHOICES.map((choice) => {
              const disabled = choiceDisabled(choice.id, section, timeRange, document.tracks.length);
              return (
                <button
                  key={choice.id}
                  type="button"
                  aria-pressed={scopeChoice === choice.id}
                  disabled={disabled}
                  title={choiceTitle(choice.id, section, timeRange)}
                  onClick={() => setScopeChoice(choice.id)}
                  className={`rounded-md border px-3 py-1 text-sm ${scopeChoice === choice.id ? "border-accent bg-panel-2 text-ink" : "border-line text-muted"} disabled:opacity-40`}
                >
                  {choice.label}
                </button>
              );
            })}
          </div>
          {status === "failed" ? (
            <div className="mt-6 rounded-md border border-line bg-panel px-4 py-3">
              <p className="text-sm text-ink">{message ?? "Unable to analyze this selection."}</p>
              {detail ? <p className="mt-2 text-sm text-muted">Reason: {detail}</p> : null}
              <Button className="mt-3" title="Measure this selection again" onClick={() => setRetry((current) => current + 1)}>
                Retry
              </Button>
            </div>
          ) : null}
          {!target && message ? <p className="mt-6 text-sm text-muted">{message}</p> : null}
          {measurement ? <MeasurementSummary measurement={measurement} /> : null}
          {!measurement && target && status !== "failed" ? <p className="mt-6 text-sm text-muted">{STATUS_LABEL[status]}…</p> : null}
          <div className="mt-10">
            <h3 className="text-[10px] tracking-wide text-muted uppercase">Compare</h3>
            <label className="mt-3 block text-sm text-muted">
              Second stem
              <select
                className="mt-1 block rounded-md border border-line bg-canvas px-2 py-1 pr-7 text-sm text-ink"
                value={compareId}
                onChange={(event) => setCompareId(event.target.value)}
              >
                <option value="">None</option>
                {document.tracks
                  .filter((item) => item.id !== track?.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            {compareTrack && comparison && measurement ? (
              <div className="mt-4 space-y-6">
                <LevelComparison selected={measurement.levels} other={comparison.levels} otherName={compareTrack.name} />
                <div>
                  <h3 className="mb-3 text-[10px] tracking-wide text-muted uppercase">Shared band energy</h3>
                  <OverlapBars left={measurement.bandEnergy} right={comparison.bandEnergy} />
                </div>
              </div>
            ) : comparisonNote ? (
              <p className="mt-3 text-sm text-muted">{comparisonNote}</p>
            ) : compareTrack ? (
              <p className="mt-3 text-sm text-muted">Measuring {compareTrack.name}…</p>
            ) : null}
          </div>
          <div className="mt-10">
            <h3 className="mb-3 text-[10px] tracking-wide text-muted uppercase">Activity</h3>
            <ActivityMap rows={activity} />
          </div>
        </div>
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
      <ChartBlock title="Spectrum">
        <SpectrumChart points={measurement.spectrum} />
      </ChartBlock>
      <ChartBlock title="Loudness timeline">
        <LoudnessChart points={measurement.loudnessTimeline} />
      </ChartBlock>
      <ChartBlock title="Spectrogram">
        <SpectrogramChart image={measurement.spectrogram} />
      </ChartBlock>
    </div>
  );
}

function ChartBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 text-[10px] tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </div>
  );
}

function measurementTarget(
  document: ProjectDocument,
  track: Track | null,
  section: SongSection | null,
  choice: ScopeChoice,
): (AnalysisTarget & { scopeKey: string }) | null {
  if (choice === "mix") {
    if (document.tracks.length === 0) return null;
    const scope: MeasurementScope = { type: "mix" };
    return {
      cacheName: mixAnalysisCacheName(),
      label: "the mix",
      logId: "mix",
      files: document.tracks.map((item) => ({ relativePath: item.file.relativePath, filename: item.file.filename })),
      scope,
      scopeKey: "mix",
    };
  }
  if (!track) return null;
  const file = { relativePath: track.file.relativePath, filename: track.file.filename };
  if (choice === "section") {
    if (!section) return null;
    const scope: MeasurementScope = { type: "section", startSeconds: section.startTime, endSeconds: section.endTime };
    return {
      cacheName: sectionAnalysisCacheName(track.id, section.id),
      label: track.file.filename,
      logId: track.id,
      files: [file],
      scope,
      scopeKey: `${section.id}:${section.startTime}:${section.endTime}`,
    };
  }
  if (choice === "time-range") {
    const range = document.uiState.timeRange;
    if (!range) return null;
    const scope: MeasurementScope = { type: "time-range", startSeconds: range.start, endSeconds: range.end };
    return {
      cacheName: rangeAnalysisCacheName(track.id),
      label: track.file.filename,
      logId: track.id,
      files: [file],
      scope,
      scopeKey: `${range.start}:${range.end}`,
    };
  }
  return {
    cacheName: track.id,
    label: track.file.filename,
    logId: track.id,
    files: [file],
    scope: { type: "track" },
    scopeKey: "track",
  };
}

function comparisonTarget(
  track: Track,
  section: SongSection | null,
  timeRange: ProjectDocument["uiState"]["timeRange"],
  choice: ScopeChoice,
): AnalysisTarget & { scopeKey: string } {
  if (choice === "section" && section) {
    return {
      cacheName: sectionAnalysisCacheName(track.id, section.id),
      label: track.file.filename,
      logId: track.id,
      files: [{ relativePath: track.file.relativePath, filename: track.file.filename }],
      scope: { type: "section", startSeconds: section.startTime, endSeconds: section.endTime },
      scopeKey: `section:${section.id}:${section.startTime}:${section.endTime}`,
    };
  }
  if (choice === "time-range" && timeRange) {
    return {
      cacheName: rangeAnalysisCacheName(track.id),
      label: track.file.filename,
      logId: track.id,
      files: [{ relativePath: track.file.relativePath, filename: track.file.filename }],
      scope: { type: "time-range", startSeconds: timeRange.start, endSeconds: timeRange.end },
      scopeKey: `range:${timeRange.start}:${timeRange.end}`,
    };
  }
  return {
    cacheName: track.id,
    label: track.file.filename,
    logId: track.id,
    files: [{ relativePath: track.file.relativePath, filename: track.file.filename }],
    scope: { type: "track" },
    scopeKey: "track",
  };
}

function choiceDisabled(choice: ScopeChoice, section: SongSection | null, timeRange: ProjectDocument["uiState"]["timeRange"], trackCount: number): boolean {
  if (choice === "section") return !section;
  if (choice === "time-range") return !timeRange;
  if (choice === "mix") return trackCount === 0;
  return false;
}

function choiceTitle(choice: ScopeChoice, section: SongSection | null, timeRange: ProjectDocument["uiState"]["timeRange"]): string {
  if (choice === "section" && !section) return "Select a section on the timeline first.";
  if (choice === "time-range" && !timeRange) return "Drag a time range on the timeline first.";
  if (choice === "mix") return "Sum of the stem files. Faders, mute, and pan stay out of this measurement.";
  if (choice === "section") return "Measure the selected section of this stem.";
  if (choice === "time-range") return "Measure the selected time range of this stem.";
  return "Measure the whole stem.";
}

function scopeMessage(choice: ScopeChoice, section: SongSection | null, timeRange: ProjectDocument["uiState"]["timeRange"]): string | null {
  if (choice === "section" && !section) return "Select a section to measure that part of the stem.";
  if (choice === "time-range" && !timeRange) return "Select a time range to measure that part of the stem.";
  if (choice !== "mix") return "Select a stem to see its measurements.";
  return null;
}

function describeScope(
  choice: ScopeChoice,
  section: SongSection | null,
  timeRange: ProjectDocument["uiState"]["timeRange"],
  measurement: TrackFileMeasurement | null,
): string {
  if (choice === "mix") return "Sum of the stem files. Mixer controls are not part of this measurement.";
  if (choice === "section" && section) {
    const bounds = measurement?.scope.type === "section" ? measurement.scope : null;
    return bounds ? `${section.name} · ${bounds.startSeconds.toFixed(2)}–${bounds.endSeconds.toFixed(2)} s` : section.name;
  }
  if (choice === "time-range" && timeRange) {
    return `${timeRange.start.toFixed(2)}–${timeRange.end.toFixed(2)} s`;
  }
  return "Whole stem";
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
