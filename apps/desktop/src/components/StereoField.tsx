import type { ImageDto } from "@audiosous/spatial-planner";
import { useRef, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";

const WIDTH = 640;
const ROW = 22;
const PAD_TOP = 22;
const PAD_BOTTOM = 8;
const LABEL = 132;
const PAD_RIGHT = 12;
const plotWidth = WIDTH - LABEL - PAD_RIGHT;

function xOf(position: number): number {
  return LABEL + ((Math.max(-1, Math.min(1, position)) + 1) / 2) * plotWidth;
}

function positionOf(x: number): number {
  return Math.max(-1, Math.min(1, ((x - LABEL) / plotWidth) * 2 - 1));
}

export interface FieldStem {
  trackId: string;
  name: string;
  image: ImageDto;
  /** Level relative to the loudest stem in the scope, dB. Quieter stems are drawn fainter. */
  levelDb: number;
  tier: string;
  mono: boolean;
}

const TIER_COLOR: Record<string, string> = {
  focal: "var(--color-ink)",
  primary: "var(--color-ink)",
  supporting: "#c9a56b",
  background: "var(--color-muted)",
  unknown: "var(--color-faint)",
};

/**
 * Where each stem sits, left to right, in one scope. A stem is drawn at its position with a band as wide
 * as its image (a point for a mono or fully correlated part, the whole field for decorrelated noise).
 * The moving stem shows its current image dashed and the proposed one solid; dragging moves its pan,
 * Shift-drag, the wheel, or Shift+arrows change its width.
 */
export function StereoField({
  stems,
  moving,
  related = [],
  onChange,
  label,
}: {
  stems: FieldStem[];
  moving?: { trackId: string; before: ImageDto; after: ImageDto; pan: number; width: number; canWiden: boolean } | null;
  related?: string[];
  onChange?: (patch: { pan?: number; width?: number }) => void;
  label: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; pan: number; width: number; widthMode: boolean } | null>(null);
  const rows = stems.length;
  const height = PAD_TOP + rows * ROW + PAD_BOTTOM;
  const pointer = (event: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * WIDTH;
  };
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (!onChange || !moving) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: pointer(event), pan: moving.pan, width: moving.width, widthMode: event.shiftKey };
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const start = drag.current;
    if (!start || !onChange || !moving) return;
    const dx = pointer(event) - start.x;
    if (start.widthMode) {
      if (moving.canWiden) onChange({ width: round2(start.width + (dx / plotWidth) * 2) });
      return;
    }
    onChange({ pan: round2(positionOf(xOf(start.pan) + dx)) });
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
    if (!onChange || !moving || !moving.canWiden) return;
    event.preventDefault();
    onChange({ width: round2(moving.width + (event.deltaY < 0 ? 0.05 : -0.05)) });
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!onChange || !moving) return;
    const step = event.altKey ? 0.01 : 0.05;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const sign = event.key === "ArrowLeft" ? -1 : 1;
      if (event.shiftKey) {
        if (moving.canWiden) onChange({ width: round2(moving.width + sign * step) });
      } else onChange({ pan: round2(moving.pan + sign * step) });
    }
  };
  const ticks = [
    { at: -1, text: "L" },
    { at: -0.5, text: "50L" },
    { at: 0, text: "C" },
    { at: 0.5, text: "50R" },
    { at: 1, text: "R" },
  ];
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${WIDTH} ${height}`}
      className={`block w-full select-none ${onChange && moving ? "cursor-ew-resize touch-none" : ""}`}
      role={onChange && moving ? "slider" : "img"}
      aria-label={label}
      aria-valuemin={onChange && moving ? -100 : undefined}
      aria-valuemax={onChange && moving ? 100 : undefined}
      aria-valuenow={onChange && moving ? Math.round(moving.pan * 100) : undefined}
      tabIndex={onChange && moving ? 0 : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
    >
      <rect x={xOf(-0.25)} y={PAD_TOP - 4} width={xOf(0.25) - xOf(-0.25)} height={rows * ROW + 4} fill="var(--color-panel-2)" opacity={0.6} />
      {ticks.map((tick) => (
        <g key={tick.text}>
          <line x1={xOf(tick.at)} x2={xOf(tick.at)} y1={PAD_TOP - 4} y2={PAD_TOP + rows * ROW} stroke="var(--color-line)" strokeWidth={tick.at === 0 ? 1 : 0.5} />
          <text x={xOf(tick.at)} y={12} fill="var(--color-faint)" fontSize={10} textAnchor="middle">
            {tick.text}
          </text>
        </g>
      ))}
      {stems.map((stem, row) => {
        const y = PAD_TOP + row * ROW + ROW / 2;
        const isMoving = moving?.trackId === stem.trackId;
        const color = TIER_COLOR[stem.tier] ?? TIER_COLOR.unknown!;
        const fade = Math.max(0.35, Math.min(1, 1 + stem.levelDb / 30));
        const highlight = related.includes(stem.trackId);
        return (
          <g key={stem.trackId} opacity={isMoving ? 1 : fade}>
            <text x={LABEL - 8} y={y + 3.5} fill={isMoving ? "var(--color-accent)" : highlight ? "var(--color-ink)" : "var(--color-muted)"} fontSize={11} textAnchor="end">
              {stem.name.length > 18 ? `${stem.name.slice(0, 17)}…` : stem.name}
            </text>
            {isMoving && moving ? (
              <>
                <Image image={moving.before} y={y} color="var(--color-faint)" dashed />
                <Image image={moving.after} y={y} color="var(--color-accent)" />
              </>
            ) : (
              <Image image={stem.image} y={y} color={color} ring={highlight} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Image({ image, y, color, dashed = false, ring = false }: { image: ImageDto; y: number; color: string; dashed?: boolean; ring?: boolean }) {
  const left = xOf(image.position - image.spread);
  const right = xOf(image.position + image.spread);
  const center = xOf(image.position);
  const band = Math.max(2, right - left);
  return (
    <g>
      {image.spread > 0.02 ? (
        <rect
          x={left}
          y={y - 5}
          width={band}
          height={10}
          rx={5}
          fill={dashed ? "none" : color}
          fillOpacity={dashed ? 0 : 0.18 + 0.2 * image.spread}
          stroke={color}
          strokeOpacity={dashed ? 0.9 : 0.5}
          strokeDasharray={dashed ? "3 3" : undefined}
        />
      ) : null}
      <circle cx={center} cy={y} r={4.5 - 2 * Math.min(1, image.spread)} fill={dashed ? "none" : color} stroke={color} strokeDasharray={dashed ? "2 2" : undefined} />
      {ring ? <circle cx={center} cy={y} r={7} fill="none" stroke="var(--color-ink)" strokeOpacity={0.6} /> : null}
    </g>
  );
}

/**
 * Correlation on a −1…+1 scale with what it means here. +1 is not "good" and 0 is not "bad": a pad or
 * reverb-like part is meant to be wide; what matters is whether it survives a mono fold-down.
 */
export function CorrelationMeter({ value, label }: { value: number; label: string }) {
  const x = ((Math.max(-1, Math.min(1, value)) + 1) / 2) * 100;
  const meaning = value >= 0.9 ? "nearly mono" : value >= 0.5 ? "some width, folds to mono well" : value >= 0.2 ? "wide, folds to mono with some loss" : value >= 0 ? "very wide or decorrelated" : "out of phase: thins out or cancels in mono";
  return (
    <div className="flex items-center gap-2" title={`${label}: ${value.toFixed(2)}`}>
      <div className="relative h-2 w-28 rounded-full bg-gradient-to-r from-danger/60 via-panel-2 to-ok/50" aria-hidden>
        <div className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-ink" style={{ left: `${x}%` }} />
        <div className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-line" style={{ left: "50%" }} />
      </div>
      <span className="font-mono text-[11px] text-ink">{value.toFixed(2)}</span>
      <span className={`text-[11px] ${value < 0 ? "text-danger" : "text-muted"}`}>{meaning}</span>
    </div>
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
