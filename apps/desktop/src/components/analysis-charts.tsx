import { bandOverlap, levelDeltaDb, type BandEnergy, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import type { ReactNode } from "react";

const FLOOR_DB = -80;

export function SpectrumChart({ points }: { points: TrackFileMeasurement["spectrum"] }) {
  if (points.length < 2) return <EmptyChart>This selection is too short for a spectrum.</EmptyChart>;
  const width = 480;
  const height = 140;
  const pad = 8;
  const loudest = Math.max(...points.map((point) => point.magnitudeDb));
  const top = Math.max(0, loudest);
  const span = top - FLOOR_DB;
  const coords = points.map((point, index) => {
    const x = pad + (index / (points.length - 1)) * (width - pad * 2);
    const y = pad + ((top - point.magnitudeDb) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-36 w-full" role="img" aria-label="Spectrum">
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent" points={coords.join(" ")} />
    </svg>
  );
}

export function LoudnessChart({
  points,
  playheadSeconds,
  originSeconds = 0,
  spanSeconds,
  onSeek,
}: {
  points: TrackFileMeasurement["loudnessTimeline"];
  playheadSeconds?: number;
  originSeconds?: number;
  spanSeconds?: number;
  onSeek?: (seconds: number) => void;
}) {
  if (points.length === 0) return <EmptyChart>This selection is too short for a loudness timeline.</EmptyChart>;
  const width = 480;
  const height = 72;
  const bars = points.map((point, index) => {
    const level = point.rmsDbfs ?? FLOOR_DB;
    const amount = Math.max(0, Math.min(1, (level - FLOOR_DB) / -FLOOR_DB));
    const barWidth = width / points.length;
    const barHeight = Math.max(1, amount * (height - 4));
    return <rect key={`${point.timeSeconds}-${index}`} x={index * barWidth} y={height - barHeight} width={Math.max(0.5, barWidth - 0.4)} height={barHeight} className="fill-accent" />;
  });
  return (
    <TimeChart
      label="Loudness timeline"
      playheadSeconds={playheadSeconds}
      originSeconds={originSeconds}
      spanSeconds={spanSeconds}
      onSeek={onSeek}
    >
      <svg viewBox={`0 0 ${width} ${height}`} className="h-20 w-full">
        {bars}
      </svg>
    </TimeChart>
  );
}

export function SpectrogramChart({
  image,
  playheadSeconds,
  originSeconds = 0,
  spanSeconds,
  onSeek,
}: {
  image: TrackFileMeasurement["spectrogram"];
  playheadSeconds?: number;
  originSeconds?: number;
  spanSeconds?: number;
  onSeek?: (seconds: number) => void;
}) {
  if (image.columns.length === 0) return <EmptyChart>This selection is too short for a spectrogram.</EmptyChart>;
  return (
    <TimeChart
      label="Spectrogram"
      playheadSeconds={playheadSeconds}
      originSeconds={originSeconds}
      spanSeconds={spanSeconds ?? (image.columns.length > 1 ? image.columns[image.columns.length - 1].timeSeconds : image.hopSeconds)}
      onSeek={onSeek}
    >
    <div className="flex h-36 gap-px" role="img" aria-label="Spectrogram">
      {image.columns.map((column, index) => (
        <div key={`${column.timeSeconds}-${index}`} className="flex min-w-0 flex-1 flex-col-reverse gap-px">
          {column.magnitudesDb.map((db, band) => (
            <div key={band} className="min-h-0 flex-1" style={{ background: heat(db) }} />
          ))}
        </div>
      ))}
    </div>
    </TimeChart>
  );
}

export function OverlapBars({ left, right }: { left: BandEnergy[]; right: BandEnergy[] }) {
  const shared = bandOverlap(left, right);
  return (
    <ul className="space-y-2">
      {shared.map((band) => (
        <li key={band.id} className="grid grid-cols-[7.5rem_1fr_3rem] items-center gap-3 text-sm">
          <span className="text-ink">{band.name}</span>
          <span className="h-2 overflow-hidden rounded bg-panel-2">
            <span className="block h-2 rounded bg-ok" style={{ width: `${Math.max(0, Math.min(100, band.shared * 100))}%` }} />
          </span>
          <span className="text-right font-mono text-xs text-muted">{Math.round(band.shared * 100)}%</span>
        </li>
      ))}
    </ul>
  );
}

export function LevelComparison({
  selected,
  other,
  otherName,
}: {
  selected: TrackFileMeasurement["levels"];
  other: TrackFileMeasurement["levels"];
  otherName: string;
}) {
  const rows = [
    ["Peak", levelDeltaDb(selected.peakDbfs, other.peakDbfs)],
    ["RMS", levelDeltaDb(selected.rmsDbfs, other.rmsDbfs)],
    ["Integrated LUFS", levelDeltaDb(selected.integratedLufs, other.integratedLufs)],
    ["Crest factor", levelDeltaDb(selected.crestFactorDb, other.crestFactorDb)],
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
      {rows.map(([label, delta]) => (
        <div key={label}>
          <dt className="text-[10px] tracking-wide text-muted uppercase">{label}</dt>
          <dd className="font-mono text-ink">{delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} dB`}</dd>
        </div>
      ))}
      <p className="col-span-2 text-[11px] text-faint">Difference from {otherName}. A positive number means this stem measures higher.</p>
    </dl>
  );
}

export function ActivityMap({
  rows,
  playheadSeconds,
  onSeek,
}: {
  rows: Array<{ id: string; name: string; timeline: TrackFileMeasurement["loudnessTimeline"]; durationSeconds: number; failed: boolean }>;
  playheadSeconds?: number;
  onSeek?: (seconds: number) => void;
}) {
  if (rows.length === 0) return <EmptyChart>Activity appears as each stem is measured.</EmptyChart>;
  return (
    <ul className="space-y-2" aria-label="Activity map">
      {rows.map((row) => (
        <li key={row.id} className="grid grid-cols-[7.5rem_1fr] items-center gap-3">
          <span className="truncate text-sm text-ink">{row.name}</span>
          {row.failed || row.timeline.length === 0 ? (
            <span className="text-xs text-faint">{row.failed ? "Unable to measure" : "Too short"}</span>
          ) : (
            <TimeChart label={`${row.name} activity`} playheadSeconds={playheadSeconds} spanSeconds={row.durationSeconds} onSeek={onSeek} className="h-4">
              <span className="flex h-4 gap-px">
                {row.timeline.map((point, index) => (
                  <span key={`${point.timeSeconds}-${index}`} className="min-w-0 flex-1" style={{ background: heat(point.rmsDbfs ?? FLOOR_DB) }} />
                ))}
              </span>
            </TimeChart>
          )}
        </li>
      ))}
    </ul>
  );
}

function TimeChart({
  label,
  playheadSeconds,
  originSeconds = 0,
  spanSeconds,
  onSeek,
  className,
  children,
}: {
  label: string;
  playheadSeconds?: number;
  originSeconds?: number;
  spanSeconds?: number;
  onSeek?: (seconds: number) => void;
  className?: string;
  children: ReactNode;
}) {
  const span = spanSeconds && spanSeconds > 0 ? spanSeconds : 0;
  const fraction = playheadSeconds === undefined || span === 0 ? null : (playheadSeconds - originSeconds) / span;
  const visible = fraction !== null && fraction >= 0 && fraction <= 1;
  return (
    <div
      className={`relative ${onSeek ? "cursor-pointer" : ""} ${className ?? ""}`}
      role="img"
      aria-label={label}
      onClick={
        onSeek && span > 0
          ? (event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              if (bounds.width <= 0) return;
              const next = originSeconds + Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)) * span;
              onSeek(next);
            }
          : undefined
      }
    >
      {children}
      {visible ? <span className="pointer-events-none absolute inset-y-0 w-px bg-ink" style={{ left: `${fraction * 100}%` }} /> : null}
    </div>
  );
}

function heat(db: number): string {
  const amount = Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
  return `color-mix(in srgb, var(--color-accent) ${Math.round(amount * 100)}%, var(--color-panel))`;
}

function EmptyChart({ children }: { children: string }) {
  return <p className="text-sm text-faint">{children}</p>;
}
