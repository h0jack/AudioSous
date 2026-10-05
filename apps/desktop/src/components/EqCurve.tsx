import { chainMagnitudeDb, EDIT_LIMITS, formatHz, responseCurve, type EqEvidence } from "@audiosous/eq-planner";
import { isPassFilter, type EqFilter } from "@audiosous/project-model";
import { useRef, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";

const WIDTH = 640;
const HEIGHT = 220;
const PAD_LEFT = 34;
const PAD_RIGHT = 10;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;
const EQ_RANGE_DB = 12;
const SPECTRUM_SPAN_DB = 48;
const GRID_HZ = [50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000];

const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;

function xOf(hz: number): number {
  return PAD_LEFT + (Math.log(Math.max(20, Math.min(20_000, hz)) / 20) / Math.log(1_000)) * plotWidth;
}

function hzOf(x: number): number {
  const ratio = Math.max(0, Math.min(1, (x - PAD_LEFT) / plotWidth));
  return 20 * 1_000 ** ratio;
}

function eqY(db: number): number {
  return PAD_TOP + plotHeight / 2 - (Math.max(-EQ_RANGE_DB, Math.min(EQ_RANGE_DB, db)) / EQ_RANGE_DB) * (plotHeight / 2);
}

function dbOfEqY(y: number): number {
  return ((PAD_TOP + plotHeight / 2 - y) / (plotHeight / 2)) * EQ_RANGE_DB;
}

/**
 * Two band spectra (the track being filtered and the track it protects, while both play), the
 * conflict range, and the filter's response on its own ±12 dB scale. The handle edits the filter.
 */
export function EqCurve({
  evidence,
  filter,
  savedFilters = [],
  targetName,
  referenceName,
  onChange,
  label,
}: {
  evidence: EqEvidence;
  filter: EqFilter | null;
  /** Filters already on the track, drawn faintly under the candidate. */
  savedFilters?: EqFilter[];
  targetName: string;
  referenceName: string | null;
  onChange?: (patch: Partial<EqFilter>) => void;
  label: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const levels = [...evidence.targetDb, ...(referenceName ? evidence.referenceDb : [])].filter((value) => value > -150);
  const top = levels.length > 0 ? Math.ceil((Math.max(...levels) + 3) / 3) * 3 : 0;
  const spectrumY = (db: number) => PAD_TOP + (Math.max(0, Math.min(SPECTRUM_SPAN_DB, top - db)) / SPECTRUM_SPAN_DB) * plotHeight;
  const line = (values: number[]) => values.map((db, band) => `${xOf(evidence.bandsHz[band]!).toFixed(1)},${spectrumY(db).toFixed(1)}`).join(" ");
  const after = filter
    ? evidence.targetDb.map((db, band) => db + chainMagnitudeDb([filter], evidence.bandsHz[band]!))
    : evidence.targetDb;
  const curve = filter ? responseCurve([filter], 160) : [];
  const saved = savedFilters.length > 0 ? responseCurve(savedFilters, 160) : [];
  const focus = evidence.focus;
  const handle = filter ? { x: xOf(filter.frequencyHz), y: eqY(isPassFilter(filter.kind) ? 0 : filter.gainDb) } : null;

  const point = (event: PointerEvent<SVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * WIDTH, y: ((event.clientY - rect.top) / rect.height) * HEIGHT };
  };
  const move = (event: PointerEvent<SVGElement>) => {
    if (!dragging.current || !filter || !onChange) return;
    const at = point(event);
    if (!at) return;
    const frequencyHz = Math.round(hzOf(at.x));
    if (isPassFilter(filter.kind)) onChange({ frequencyHz });
    else onChange({ frequencyHz, gainDb: Math.round(Math.max(EDIT_LIMITS.minGainDb, Math.min(EDIT_LIMITS.maxGainDb, dbOfEqY(at.y))) * 10) / 10 });
  };
  const wheel = (event: WheelEvent<SVGElement>) => {
    if (!filter || !onChange) return;
    event.preventDefault();
    onChange({ q: Math.round(filter.q * (event.deltaY < 0 ? 1.1 : 1 / 1.1) * 100) / 100 });
  };
  const key = (event: KeyboardEvent<SVGElement>) => {
    if (!filter || !onChange) return;
    const step = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const factor = 2 ** ((event.key === "ArrowRight" ? 1 : -1) * step / 24);
      onChange({ frequencyHz: Math.round(filter.frequencyHz * factor) });
    } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !isPassFilter(filter.kind)) {
      event.preventDefault();
      onChange({ gainDb: Math.round((filter.gainDb + (event.key === "ArrowUp" ? 0.1 : -0.1) * step) * 10) / 10 });
    } else if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      onChange({ q: Math.round(filter.q * (event.key === "-" ? 1 / 1.1 : 1.1) * 100) / 100 });
    }
  };

  return (
    <figure className="min-w-0">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-56 w-full touch-none select-none"
        role="img"
        aria-label={label}
        onPointerMove={move}
        onPointerUp={() => (dragging.current = false)}
        onPointerLeave={() => (dragging.current = false)}
      >
        <rect x={PAD_LEFT} y={PAD_TOP} width={plotWidth} height={plotHeight} className="fill-canvas" />
        {focus ? (
          <rect
            x={xOf(evidence.edgesHz[focus[0]]!)}
            y={PAD_TOP}
            width={xOf(evidence.edgesHz[focus[1] + 1]!) - xOf(evidence.edgesHz[focus[0]]!)}
            height={plotHeight}
            className="fill-accent"
            opacity={0.1}
          >
            <title>{`Conflict range ${formatHz(evidence.edgesHz[focus[0]]!)} – ${formatHz(evidence.edgesHz[focus[1] + 1]!)}`}</title>
          </rect>
        ) : null}
        {GRID_HZ.map((hz) => (
          <g key={hz}>
            <line x1={xOf(hz)} x2={xOf(hz)} y1={PAD_TOP} y2={PAD_TOP + plotHeight} className="stroke-line" strokeWidth={0.6} />
            <text x={xOf(hz)} y={HEIGHT - 6} textAnchor="middle" className="fill-faint" fontSize={10}>
              {hz >= 1_000 ? `${hz / 1_000}k` : hz}
            </text>
          </g>
        ))}
        {[-6, 0, 6].map((db) => (
          <g key={db}>
            <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={eqY(db)} y2={eqY(db)} className="stroke-line" strokeWidth={db === 0 ? 1 : 0.5} strokeDasharray={db === 0 ? undefined : "3 4"} />
            <text x={PAD_LEFT - 5} y={eqY(db) + 3} textAnchor="end" className="fill-faint" fontSize={10}>
              {db > 0 ? `+${db}` : db}
            </text>
          </g>
        ))}
        {referenceName ? <polyline fill="none" strokeWidth={1.6} className="stroke-ok" points={line(evidence.referenceDb)} /> : null}
        <polyline fill="none" strokeWidth={1.4} className="stroke-muted" points={line(evidence.targetDb)} />
        {filter ? <polyline fill="none" strokeWidth={1.4} strokeDasharray="4 3" className="stroke-accent" points={line(after)} /> : null}
        {saved.length > 0 ? (
          <polyline fill="none" strokeWidth={1} className="stroke-faint" points={saved.map((item) => `${xOf(item.hz).toFixed(1)},${eqY(item.db).toFixed(1)}`).join(" ")} />
        ) : null}
        {curve.length > 0 ? (
          <polyline fill="none" strokeWidth={2.2} className="stroke-accent" points={curve.map((item) => `${xOf(item.hz).toFixed(1)},${eqY(item.db).toFixed(1)}`).join(" ")} />
        ) : null}
        {handle && filter ? (
          <circle
            cx={handle.x}
            cy={handle.y}
            r={7}
            tabIndex={onChange ? 0 : -1}
            role={onChange ? "slider" : undefined}
            aria-label={onChange ? `Filter at ${formatHz(filter.frequencyHz)}. Arrows move it; plus and minus change Q.` : undefined}
            aria-valuetext={onChange ? `${formatHz(filter.frequencyHz)}, ${filter.gainDb} dB, Q ${filter.q}` : undefined}
            className={`fill-accent stroke-canvas ${onChange ? "cursor-grab" : ""}`}
            strokeWidth={2}
            onPointerDown={(event) => {
              if (!onChange) return;
              dragging.current = true;
              (event.target as Element).setPointerCapture?.(event.pointerId);
            }}
            onWheel={wheel}
            onKeyDown={key}
          />
        ) : null}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <Legend className="bg-muted" text={`${targetName}, while both play`} />
        {filter ? <Legend className="bg-accent" text={`${targetName} with this filter (dashed) and the filter's response`} /> : null}
        {referenceName ? <Legend className="bg-ok" text={referenceName} /> : null}
        {focus ? <Legend className="bg-accent/30" text="Conflict range" /> : null}
        {saved.length > 0 ? <Legend className="bg-faint" text="Saved EQ" /> : null}
      </figcaption>
    </figure>
  );
}

function Legend({ className, text }: { className: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2 w-3 rounded-sm ${className}`} />
      {text}
    </span>
  );
}
