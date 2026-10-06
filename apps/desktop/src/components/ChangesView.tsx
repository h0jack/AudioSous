import {
  explainDynamics,
  explainEq,
  explainGain,
  explainSpace,
  interactionFor,
  panLabel,
  type CurvePoint,
  type DifferenceDomain,
  type DynamicsDifference,
  type EqDifference,
  type GainDifference,
  type InteractionDifference,
  type MetricDifference,
  type MixDifference,
  type SpaceDifference,
} from "@audiosous/mix-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "../state/app-store";

export type ViewMode = "current" | "candidate" | "difference";

const DOMAIN_LETTER: Record<DifferenceDomain, string> = { gain: "G", eq: "E", space: "S", dynamics: "D" };
const DOMAIN_WORD: Record<DifferenceDomain, string> = { gain: "gain", eq: "EQ", space: "space", dynamics: "dynamics" };

/** Current, Candidate, or Difference: the same three views in every plan. */
export function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div className="flex rounded-md border border-line p-0.5" role="radiogroup" aria-label="Compare">
      {(["current", "candidate", "difference"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          className={`rounded px-2.5 py-0.5 text-xs ${mode === value ? "bg-accent text-accent-ink" : "text-muted hover:text-ink"}`}
          onClick={() => onChange(value)}
        >
          {value === "current" ? "Current" : value === "candidate" ? "Candidate" : "Difference"}
        </button>
      ))}
    </div>
  );
}

/** Letters for the domains a section's changes touch, with the words for screen readers and tooltips. */
export function DomainLetters({ domains }: { domains: DifferenceDomain[] }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={domains.map((domain) => DOMAIN_WORD[domain]).join(", ")}>
      {domains.map((domain) => (
        <span key={domain} aria-hidden="true" className="rounded-sm border border-accent/70 px-0.5 font-mono text-[9px] leading-tight text-accent">
          {DOMAIN_LETTER[domain]}
        </span>
      ))}
    </span>
  );
}

/**
 * What a candidate changes: an overview by domain, where in the song, and a drawing per change that shows the
 * delta itself (difference curve, moved bracket, reduction over time), each with numbers and a plain sentence.
 * Every measure is about one stem or one relationship; none of it is a mix-quality score.
 */
export function ChangesView({ document, diff, label }: { document: ProjectDocument; diff: MixDifference; label: string }) {
  const [mode, setMode] = useState<ViewMode>("difference");
  const focus = useAppStore((state) => state.changesFocus);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focus) return;
    const target = root.current?.querySelector<HTMLElement>(`[data-section="${focus.sectionId ?? "song"}"]`);
    target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focus]);
  const total = diff.counts.gain + diff.counts.eq + diff.counts.space + diff.counts.dynamics + (diff.trimDb ? 1 : 0);
  const focusSection = focus?.sectionId ?? null;
  const inFocus = (row: { scope: { sectionId: string | null }; trackId?: string }) => !focus || ((focusSection === null || row.scope.sectionId === focusSection) && (!focus.trackId || row.trackId === focus.trackId));
  const linkedInteraction = (row: EqDifference) => interactionFor(diff, row);
  if (total === 0) {
    return (
      <section className="rounded-md border border-line p-3 text-sm text-muted" aria-label="Changes">
        {label} changes nothing in the saved mix.
      </section>
    );
  }
  return (
    <section ref={root} className="flex flex-col gap-3" aria-label="Changes">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm text-ink">What changes — {label}</h3>
        <ViewModeToggle mode={mode} onChange={setMode} />
        <span className="text-xs text-faint">
          {mode === "current" ? "The saved mix as it is." : mode === "candidate" ? "The candidate, with the saved mix as a dashed ghost." : "Only the change itself, zoomed to its size."}
        </span>
        {focus ? (
          <button type="button" className="text-xs text-accent underline-offset-2 hover:underline" onClick={() => useAppStore.getState().setChangesFocus(null)}>
            Showing {focusSection ? (document.sections.find((section) => section.id === focusSection)?.name ?? "one section") : "the song"}
            {focus.trackId ? `, ${document.tracks.find((track) => track.id === focus.trackId)?.name ?? "one stem"}` : ""} — show all
          </button>
        ) : null}
      </div>
      {diff.subtle ? (
        <p className="max-w-3xl rounded-md bg-panel-2 px-3 py-2 text-xs text-muted">
          These are subtle changes: small enough to be hard to hear in isolation. The drawings show exactly what moves, where, and by how much; listen with Current and Candidate to hear it in context.
        </p>
      ) : null}
      <Overview document={document} diff={diff} />
      {diff.gain.length > 0 || diff.trimDb ? (
        <Group title="Level">
          {diff.trimDb ? <p className="mb-1 text-xs text-muted">Safety trim: every fader {signedDb(diff.trimDb)}, keeping the balance, so the candidate does not peak higher than the saved mix.</p> : null}
          <GainTable rows={diff.gain.filter(inFocus)} mode={mode} />
          {diff.hierarchy && (diff.gain.some((row) => row.scope.sectionId === null) || diff.trimDb) ? <Hierarchy rows={diff.hierarchy} mode={mode} /> : null}
          {diff.gain.filter((row) => row.scope.sectionId !== null && inFocus(row)).map((row) => (
            <SectionGainStrip key={`${row.trackId}:${row.scope.sectionId}`} document={document} row={row} />
          ))}
        </Group>
      ) : null}
      {diff.eq.length > 0 ? (
        <Group title="Frequency">
          <div className="grid gap-3 lg:grid-cols-2">
            {diff.eq.filter(inFocus).map((row) => (
              <EqCard key={`${row.trackId}:${row.scope.sectionId ?? "song"}`} row={row} mode={mode} scaleDb={diff.eqDifferenceScaleDb} interaction={linkedInteraction(row)} />
            ))}
          </div>
        </Group>
      ) : null}
      {diff.interactions.length > 0 ? (
        <Group title="Interaction reduction">
          <Interactions rows={diff.interactions} />
        </Group>
      ) : null}
      {diff.space.length > 0 ? (
        <Group title="Space">
          <div className="grid gap-3 lg:grid-cols-2">
            {diff.space.filter(inFocus).map((row) => (
              <SpaceCard key={`${row.trackId}:${row.scope.sectionId ?? "song"}`} row={row} mode={mode} />
            ))}
          </div>
        </Group>
      ) : null}
      {diff.dynamics.length > 0 ? (
        <Group title="Dynamics">
          <div className="grid gap-3 lg:grid-cols-2">
            {diff.dynamics.filter(inFocus).map((row) => (
              <DynamicsCard key={row.id} row={row} mode={mode} />
            ))}
          </div>
        </Group>
      ) : null}
      {diff.metrics.length > 0 ? (
        <Group title="Measured before and after">
          <Metrics rows={diff.metrics} />
        </Group>
      ) : null}
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[10px] tracking-wide text-faint uppercase">{title}</p>
      {children}
    </div>
  );
}

function focusOn(sectionId: string | null, trackId: string | null) {
  const state = useAppStore.getState();
  state.setChangesFocus({ sectionId, trackId });
  const document = state.document;
  if (!document) return;
  const patch: Partial<ProjectDocument["uiState"]> = {};
  if (trackId && document.tracks.some((track) => track.id === trackId)) patch.selectedTrackId = trackId;
  if (sectionId && document.sections.some((section) => section.id === sectionId)) patch.selectedSectionId = sectionId;
  if (Object.keys(patch).length > 0) state.replaceDocument({ ...document, uiState: { ...document.uiState, ...patch } }, state.dirty, { mode: "skip" });
}

/* ------------------------------------------------------------------ overview */

function signedDb(value: number, digits = 1): string {
  const rounded = value.toFixed(digits);
  return `${value > 0 ? "+" : value < 0 ? "−" : "±"}${rounded.replace("-", "")} dB`;
}

function hz(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} kHz` : `${Math.round(value)} Hz`;
}

function scopeSuffix(scope: { sectionId: string | null; label: string }): string {
  return scope.sectionId ? ` (${scope.label})` : "";
}

/** The change list (what) and the section map (where), each line clickable to focus its stem and section. */
function Overview({ document, diff }: { document: ProjectDocument; diff: MixDifference }) {
  const lines: Array<{ domain: DifferenceDomain; key: string; text: string; trackId: string; sectionId: string | null }> = [
    ...(diff.trimDb ? [{ domain: "gain" as const, key: "trim", text: `Every stem  ${signedDb(diff.trimDb)} (safety trim)`, trackId: "", sectionId: null }] : []),
    ...diff.gain.map((row) => ({ domain: "gain" as const, key: `g:${row.trackId}:${row.scope.sectionId}`, text: `${row.name}  ${signedDb(row.deltaDb)}${scopeSuffix(row.scope)}`, trackId: row.trackId, sectionId: row.scope.sectionId })),
    ...diff.eq.map((row) => ({ domain: "eq" as const, key: `e:${row.trackId}:${row.scope.sectionId}`, text: `${row.name}  ${signedDb(row.peakDeltaDb)} @ ${hz(row.peakHz)}${row.replacesSaved ? " (edits a saved filter)" : ""}${scopeSuffix(row.scope)}`, trackId: row.trackId, sectionId: row.scope.sectionId })),
    ...diff.space.map((row) => ({
      domain: "space" as const,
      key: `s:${row.trackId}:${row.scope.sectionId}`,
      text: `${row.name}  ${Math.abs(row.candidate.width - row.current.width) >= 0.005 ? `Width ${Math.round(row.current.width * 100)}% → ${Math.round(row.candidate.width * 100)}%` : ""}${Math.abs(row.candidate.pan - row.current.pan) >= 0.005 ? ` Pan ${panLabel(row.current.pan)} → ${panLabel(row.candidate.pan)}` : ""}${scopeSuffix(row.scope)}`,
      trackId: row.trackId,
      sectionId: row.scope.sectionId,
    })),
    ...diff.dynamics.map((row) => ({ domain: "dynamics" as const, key: `d:${row.id}`, text: `${row.name}  ${dynamicsHeadline(row)}${scopeSuffix(row.scope)}`, trackId: row.trackId, sectionId: row.scope.sectionId })),
  ];
  const ordered = [...document.sections].sort((left, right) => left.startTime - right.startTime);
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
      <div>
        <p className="text-[10px] tracking-wide text-faint uppercase">Mix changes</p>
        {(["gain", "eq", "space", "dynamics"] as const).map((domain) => {
          const rows = lines.filter((line) => line.domain === domain);
          if (rows.length === 0) return null;
          return (
            <div key={domain} className="mt-1">
              <p className="text-[10px] font-medium tracking-wide text-muted uppercase">{domain === "eq" ? "EQ" : domain}</p>
              <ul>
                {rows.map((line) => (
                  <li key={line.key}>
                    <button type="button" className="font-mono text-xs whitespace-pre text-ink hover:text-accent" onClick={() => focusOn(line.sectionId, line.trackId || null)}>
                      {line.text}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <div>
        <p className="text-[10px] tracking-wide text-faint uppercase">Where it changes</p>
        <ul className="mt-1 space-y-0.5 text-xs">
          <li>
            <button type="button" data-section="song" className="flex w-full items-center justify-between gap-2 rounded px-1 text-left text-ink hover:bg-panel-2" onClick={() => focusOn(null, null)}>
              <span>Song-wide</span>
              {diff.songWide.length ? <DomainLetters domains={diff.songWide} /> : <span className="text-faint">nothing</span>}
            </button>
          </li>
          {ordered.map((section) => {
            const marker = diff.sections.find((item) => item.sectionId === section.id);
            return (
              <li key={section.id}>
                <button type="button" data-section={section.id} className="flex w-full items-center justify-between gap-2 rounded px-1 text-left hover:bg-panel-2" onClick={() => focusOn(section.id, null)}>
                  <span className={marker ? "text-ink" : "text-faint"}>{section.name}</span>
                  {marker ? <DomainLetters domains={marker.domains} /> : <span className="text-faint">{diff.songWide.length ? "song-wide only" : "no change"}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-1 text-[10px] text-faint">G gain · E EQ · S space · D dynamics</p>
      </div>
    </div>
  );
}

function dynamicsHeadline(row: DynamicsDifference): string {
  const amount = row.reductionMaxDb !== null ? ` up to ${signedDb(-Math.abs(row.reductionMaxDb))}` : "";
  if (row.change === "removed") return `${row.before ?? "processing"} removed`;
  switch (row.kind) {
    case "ducking":
      return `Duck${amount} from ${row.keyName ?? "key"}`;
    case "compressor":
      return `Compressor${amount}`;
    case "dynamic-eq":
      return `Dynamic EQ ${row.dynamicEq ? hz(row.dynamicEq.frequencyHz) : ""} 0 to ${row.dynamicEq ? signedDb(row.dynamicEq.rangeDb) : ""}${row.keyName ? `, from ${row.keyName}` : ""}`;
    case "transient":
      return row.after ?? "Transient shaping";
  }
}

/* ------------------------------------------------------------------ gain */

function GainTable({ rows, mode }: { rows: GainDifference[]; mode: ViewMode }) {
  return (
    <table className="w-full max-w-2xl text-left text-xs">
      <thead className="text-[10px] tracking-wide text-faint uppercase">
        <tr>
          <th className="py-0.5 pr-3 font-medium">Stem</th>
          <th className="py-0.5 pr-3 font-medium">Where</th>
          <th className={`py-0.5 pr-3 font-medium ${mode === "current" ? "text-ink" : ""}`}>Current</th>
          <th className={`py-0.5 pr-3 font-medium ${mode === "candidate" ? "text-ink" : ""}`}>Candidate</th>
          <th className={`py-0.5 pr-3 font-medium ${mode === "difference" ? "text-ink" : ""}`}>Delta</th>
          <th className="py-0.5 font-medium" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.trackId}:${row.scope.sectionId}`} className="border-t border-line" data-section={row.scope.sectionId ?? "song"}>
            <td className="py-1 pr-3 text-ink">{row.name}</td>
            <td className="py-1 pr-3 text-muted">{row.scope.label}</td>
            <td className="py-1 pr-3 font-mono text-muted">{row.currentDb.toFixed(1)} dB</td>
            <td className="py-1 pr-3 font-mono text-ink">{row.candidateDb.toFixed(1)} dB</td>
            <td className={`py-1 pr-3 font-mono font-medium ${row.deltaDb > 0 ? "text-ok" : "text-accent"}`}>
              {row.deltaDb > 0 ? "▲ " : "▼ "}
              {signedDb(row.deltaDb)}
            </td>
            <td className="py-1 text-faint">{explainGain(row)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Each stem's estimated level in the mix: solid bar = candidate, dashed outline = current. */
function Hierarchy({ rows, mode }: { rows: NonNullable<MixDifference["hierarchy"]>; mode: ViewMode }) {
  const values = rows.flatMap((row) => [row.currentDb, row.candidateDb]);
  const low = Math.floor(Math.min(...values) - 3);
  const high = Math.ceil(Math.max(...values) + 1);
  const x = (db: number) => ((db - low) / Math.max(1, high - low)) * 100;
  return (
    <div className="mt-2 max-w-2xl" aria-label="Level relationship between stems">
      <p className="text-[10px] text-faint">Estimated level in the mix (dB, louder to the right). Solid: {mode === "current" ? "current" : "candidate"}; dashed outline: current.</p>
      <ul className="mt-1 space-y-0.5">
        {rows.map((row) => {
          const shown = mode === "current" ? row.currentDb : row.candidateDb;
          const moved = Math.abs(row.candidateDb - row.currentDb) >= 0.05;
          return (
            <li key={row.trackId} className="grid grid-cols-[8rem_minmax(0,1fr)_5rem] items-center gap-2 text-xs">
              <span className="truncate text-muted">{row.name}</span>
              <span className="relative h-3 rounded-sm bg-panel-2">
                <span className="absolute inset-y-0 left-0 rounded-sm bg-accent/70" style={{ width: `${x(shown)}%` }} />
                {mode !== "current" && moved ? <span className="absolute inset-y-0 left-0 rounded-sm border border-dashed border-ink/70" style={{ width: `${x(row.currentDb)}%` }} /> : null}
              </span>
              <span className={`font-mono ${moved ? "text-ink" : "text-faint"}`}>{moved ? signedDb(row.candidateDb - row.currentDb) : "unchanged"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A section-only gain move drawn where it happens on the song. */
function SectionGainStrip({ document, row }: { document: ProjectDocument; row: GainDifference }) {
  const duration = Math.max(0.001, document.project.durationSeconds);
  const left = (row.scope.startSeconds / duration) * 100;
  const width = ((row.scope.endSeconds - row.scope.startSeconds) / duration) * 100;
  const up = row.deltaDb > 0;
  return (
    <div className="mt-2 max-w-2xl" data-section={row.scope.sectionId ?? "song"} aria-label={`${row.name}: ${signedDb(row.deltaDb)} in ${row.scope.label} only`}>
      <p className="text-xs text-muted">{row.name}</p>
      <div className="relative h-8 border-b border-line">
        <div className="absolute bottom-0 h-3 border border-accent bg-accent/25" style={{ left: `${left}%`, width: `${width}%`, transform: up ? undefined : "translateY(100%)" }} />
        <span className="absolute -top-0.5 text-[10px] font-medium text-accent" style={{ left: `${left}%` }}>
          {signedDb(row.deltaDb)} · {row.scope.label.toUpperCase()}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ EQ */

const LOG_LOW = Math.log10(20);
const LOG_HIGH = Math.log10(20_000);

/** An EQ response on a log frequency axis with a labelled vertical scale. */
export function CurvePlot({ series, rangeDb, scaleLabel, peak, height = 110 }: { series: Array<{ points: CurvePoint[]; style: "solid" | "dashed" | "area"; label: string }>; rangeDb: number; scaleLabel: string; peak?: { hz: number; db: number } | null; height?: number }) {
  const width = 320;
  const x = (frequency: number) => ((Math.log10(Math.max(20, frequency)) - LOG_LOW) / (LOG_HIGH - LOG_LOW)) * width;
  const y = (db: number) => height / 2 - (Math.max(-rangeDb, Math.min(rangeDb, db)) / rangeDb) * (height / 2 - 6);
  const path = (points: CurvePoint[]) => points.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.hz).toFixed(1)},${y(point.db).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={`${series.map((item) => item.label).join(", ")}; ${scaleLabel}`}>
      {[100, 1_000, 10_000].map((frequency) => (
        <g key={frequency}>
          <line x1={x(frequency)} x2={x(frequency)} y1={0} y2={height} stroke="var(--color-line)" strokeWidth={0.5} />
          <text x={x(frequency) + 2} y={height - 2} fontSize={8} fill="var(--color-faint)">
            {hz(frequency)}
          </text>
        </g>
      ))}
      <line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke="var(--color-muted)" strokeWidth={0.6} />
      <text x={2} y={9} fontSize={8} fill="var(--color-faint)">
        +{rangeDb} dB
      </text>
      <text x={2} y={height - 10} fontSize={8} fill="var(--color-faint)">
        −{rangeDb} dB
      </text>
      <text x={width - 2} y={9} fontSize={8} fill="var(--color-accent)" textAnchor="end">
        {scaleLabel}
      </text>
      {series.map((item) =>
        item.style === "area" ? (
          <g key={item.label}>
            <path d={`${path(item.points)} L${width},${y(0)} L0,${y(0)} Z`} fill="var(--color-accent)" fillOpacity={0.25} />
            <path d={path(item.points)} fill="none" stroke="var(--color-accent)" strokeWidth={1.6} />
          </g>
        ) : (
          <path key={item.label} d={path(item.points)} fill="none" stroke={item.style === "dashed" ? "var(--color-muted)" : "var(--color-accent)"} strokeWidth={item.style === "dashed" ? 1 : 1.6} strokeDasharray={item.style === "dashed" ? "4 3" : undefined} />
        ),
      )}
      {peak ? (
        <g>
          <circle cx={x(peak.hz)} cy={y(peak.db)} r={2.5} fill="var(--color-ink)" />
          <text x={Math.min(width - 60, x(peak.hz) + 4)} y={Math.min(height - 14, Math.max(18, y(peak.db) + (peak.db < 0 ? 12 : -4)))} fontSize={9} fill="var(--color-ink)">
            {signedDb(peak.db)} @ {hz(peak.hz)}
          </text>
        </g>
      ) : null}
    </svg>
  );
}

function EqCard({ row, mode, scaleDb, interaction }: { row: EqDifference; mode: ViewMode; scaleDb: number; interaction: InteractionDifference | null }) {
  const extent = Math.max(12, Math.ceil(Math.max(...row.current.map((point) => Math.abs(point.db)), ...row.candidate.map((point) => Math.abs(point.db))) / 6) * 6);
  const series =
    mode === "current"
      ? [{ points: row.current, style: "solid" as const, label: "Current response (solid)" }]
      : mode === "candidate"
        ? [
            { points: row.current, style: "dashed" as const, label: "Current response (dashed)" },
            { points: row.candidate, style: "solid" as const, label: "Candidate response (solid)" },
          ]
        : [{ points: row.difference, style: "area" as const, label: "Difference: candidate minus current (filled)" }];
  return (
    <div className="rounded-md border border-line p-2" data-section={row.scope.sectionId ?? "song"}>
      <p className="text-xs text-ink">
        {row.name}
        <span className="text-muted">{row.scope.sectionId ? ` · ${row.scope.label} only` : " · song-wide"}</span>
        <span className="ml-2 font-mono text-accent">
          {signedDb(row.peakDeltaDb)} @ {hz(row.peakHz)}
        </span>
      </p>
      <CurvePlot series={series} rangeDb={mode === "difference" ? scaleDb : extent} scaleLabel={mode === "difference" ? `Difference scale ±${scaleDb} dB` : `EQ scale ±${extent} dB`} peak={mode === "difference" ? { hz: row.peakHz, db: row.peakDeltaDb } : null} />
      {row.replacesSaved ? (
        <p className="text-[11px] text-muted">
          Edits a saved filter. Before: {row.currentFilters.length ? row.currentFilters.map(filterWords).join(", ") : "flat"}. After: {row.candidateFilters.length ? row.candidateFilters.map(filterWords).join(", ") : "flat"}. The difference curve is the net change.
        </p>
      ) : null}
      <p className="mt-1 text-[11px] text-muted">{explainEq(row, interaction)}</p>
    </div>
  );
}

function filterWords(filter: EqDifference["currentFilters"][number]): string {
  if (filter.kind === "high-pass" || filter.kind === "low-pass") return `${filter.kind} ${hz(filter.frequencyHz)}`;
  return `${signedDb(filter.gainDb)} @ ${hz(filter.frequencyHz)} Q ${filter.q.toFixed(1)}`;
}

/* ------------------------------------------------------------------ interactions */

function Interactions({ rows }: { rows: InteractionDifference[] }) {
  const top = Math.max(0.01, ...rows.flatMap((row) => [row.before, row.after]));
  return (
    <div className="max-w-2xl">
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.id} className="text-xs">
            <p className="text-ink">
              {row.label}
              <span className="ml-2 text-faint">
                {row.measure} · {row.reduction >= 0 ? `${Math.round(row.reduction * 100)}% lower` : `${Math.round(-row.reduction * 100)}% higher`}
              </span>
            </p>
            <Bar label="Before" value={row.before} top={top} tone="muted" />
            <Bar label="After" value={row.after} top={top} tone="accent" />
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[10px] text-faint">How strongly each pair competes, as the planner measures it, before and after the candidate. A diagnostic per relationship, not a score for the mix.</p>
    </div>
  );
}

function Bar({ label, value, top, tone }: { label: string; value: number; top: number; tone: "muted" | "accent" }) {
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_3rem] items-center gap-2">
      <span className="text-faint">{label}</span>
      <span className="h-2.5 rounded-sm bg-panel-2">
        <span className={`block h-full rounded-sm ${tone === "accent" ? "bg-accent" : "bg-muted/60"}`} style={{ width: `${Math.min(100, (value / top) * 100)}%` }} />
      </span>
      <span className="font-mono text-ink">{value.toFixed(2)}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ space */

/** The stereo field, left to right: the dashed bracket is where the stem is now, the solid one where it goes. */
function SpaceCard({ row, mode }: { row: SpaceDifference; mode: ViewMode }) {
  return (
    <div className="rounded-md border border-line p-2" data-section={row.scope.sectionId ?? "song"}>
      <p className="text-xs text-ink">
        {row.name}
        <span className="text-muted">{row.scope.sectionId ? ` · ${row.scope.label} only` : " · song-wide"}</span>
        <span className="ml-2 text-accent">{row.words}</span>
      </p>
      <StereoBracket current={row.current} candidate={row.candidate} mode={mode} />
      <p className="text-[11px] text-muted">{explainSpace(row)}</p>
    </div>
  );
}

function StereoBracket({ current, candidate, mode }: { current: { pan: number; width: number }; candidate: { pan: number; width: number }; mode: ViewMode }) {
  const width = 320;
  const center = (pan: number) => width / 2 + pan * (width / 2 - 8);
  const span = (stereo: { pan: number; width: number }) => {
    const half = (Math.min(2, Math.max(0, stereo.width)) / 2) * (width / 4);
    const middle = center(stereo.pan);
    return [Math.max(4, middle - half), Math.min(width - 4, middle + half)] as const;
  };
  const draw = (stereo: { pan: number; width: number }, y: number, dashed: boolean, label: string) => {
    const [from, to] = span(stereo);
    return (
      <g aria-label={label}>
        <line x1={from} x2={to} y1={y} y2={y} stroke={dashed ? "var(--color-muted)" : "var(--color-accent)"} strokeWidth={dashed ? 1.5 : 3} strokeDasharray={dashed ? "4 3" : undefined} />
        <line x1={from} x2={from} y1={y - 5} y2={y + 5} stroke={dashed ? "var(--color-muted)" : "var(--color-accent)"} strokeWidth={1.5} />
        <line x1={to} x2={to} y1={y - 5} y2={y + 5} stroke={dashed ? "var(--color-muted)" : "var(--color-accent)"} strokeWidth={1.5} />
        <circle cx={center(stereo.pan)} cy={y} r={2.5} fill={dashed ? "var(--color-muted)" : "var(--color-ink)"} />
      </g>
    );
  };
  const describe = (stereo: { pan: number; width: number }) => `${panLabel(stereo.pan)}, width ${Math.round(stereo.width * 100)}%`;
  return (
    <svg viewBox={`0 0 ${width} 48`} className="h-auto w-full" role="img" aria-label={`Current ${describe(current)}; candidate ${describe(candidate)}`}>
      <line x1={4} x2={width - 4} y1={34} y2={34} stroke="var(--color-line)" />
      {[
        ["L", 4],
        ["C", width / 2],
        ["R", width - 4],
      ].map(([text, at]) => (
        <text key={text as string} x={at as number} y={46} fontSize={9} fill="var(--color-faint)" textAnchor="middle">
          {text}
        </text>
      ))}
      {mode === "current" ? draw(current, 22, false, `Current: ${describe(current)}`) : null}
      {mode === "candidate" ? (
        <>
          {draw(current, 14, true, `Current (dashed): ${describe(current)}`)}
          {draw(candidate, 26, false, `Candidate (solid): ${describe(candidate)}`)}
        </>
      ) : null}
      {mode === "difference" ? (
        <>
          {draw(current, 22, true, `Current (dashed): ${describe(current)}`)}
          {draw(candidate, 22, false, `Candidate (solid): ${describe(candidate)}`)}
          <text x={width - 4} y={10} fontSize={9} fill="var(--color-accent)" textAnchor="end">
            {describe(current)} → {describe(candidate)}
          </text>
        </>
      ) : null}
    </svg>
  );
}

/* ------------------------------------------------------------------ dynamics */

/** Gain reduction over time, downward from 0 dB, with the key's hits above it when there is a key. */
function ReductionTimeline({ row }: { row: DynamicsDifference }) {
  const timeline = row.timeline;
  if (!timeline) return <p className="text-[11px] text-faint">No reduction timeline was measured for this change.</p>;
  const width = 320;
  const height = row.keyEvents ? 74 : 60;
  const top = row.keyEvents ? 16 : 4;
  const values = timeline.values.map((value) => Math.abs(value));
  const deepest = Math.max(1, Math.ceil(Math.max(...values)));
  const span = timeline.hopSeconds * values.length;
  const barWidth = width / values.length;
  const y = (db: number) => top + (db / deepest) * (height - top - 12);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={`${row.kind === "transient" ? "Gain change" : "Gain reduction"} over ${span.toFixed(0)} s, up to ${deepest} dB${row.keyEvents ? `, with ${row.keyEvents.length} ${row.keyName ?? "key"} hits` : ""}`}>
      {row.keyEvents ? (
        <g>
          <text x={0} y={8} fontSize={8} fill="var(--color-faint)">
            {row.keyName}
          </text>
          {row.keyEvents.map((time) => {
            const at = ((time - timeline.startSeconds) / span) * width;
            return <line key={time} x1={at} x2={at} y1={2} y2={12} stroke="var(--color-ink)" strokeWidth={0.8} />;
          })}
        </g>
      ) : null}
      <line x1={0} x2={width} y1={top} y2={top} stroke="var(--color-muted)" strokeWidth={0.6} />
      {values.map((value, index) =>
        value > 0.01 ? <rect key={index} x={index * barWidth} y={top} width={Math.max(0.6, barWidth - 0.2)} height={Math.max(0.5, y(value) - top)} fill="var(--color-accent)" fillOpacity={0.75} /> : null,
      )}
      <text x={width - 2} y={top + 8} fontSize={8} fill="var(--color-faint)" textAnchor="end">
        0 dB
      </text>
      <text x={width - 2} y={height - 2} fontSize={8} fill="var(--color-faint)" textAnchor="end">
        −{deepest} dB
      </text>
    </svg>
  );
}

function DynamicsCard({ row, mode }: { row: DynamicsDifference; mode: ViewMode }) {
  return (
    <div className="rounded-md border border-line p-2" data-section={row.scope.sectionId ?? "song"}>
      <p className="text-xs text-ink">
        {row.name}
        <span className="text-muted">{row.scope.sectionId ? ` · ${row.scope.label} only` : " · song-wide"}</span>
        <span className="ml-2 text-accent">{dynamicsHeadline(row)}</span>
      </p>
      {mode === "current" ? (
        <p className="py-3 text-xs text-muted">{row.before ? `Saved: ${row.before}` : `No ${row.kind === "dynamic-eq" ? "dynamic EQ" : row.kind} on ${row.name} in the saved mix.`}</p>
      ) : (
        <>
          {mode === "candidate" ? <p className="text-[11px] text-muted">{row.after ? `Candidate: ${row.after}` : "Removed in the candidate."}{row.before ? ` (was: ${row.before})` : ""}</p> : null}
          {row.dynamicEq ? (
            <CurvePlot series={[{ points: row.dynamicEq.maxCurve, style: "area", label: "Deepest dynamic EQ curve (filled)" }]} rangeDb={Math.max(1, Math.ceil(Math.abs(row.dynamicEq.rangeDb)))} scaleLabel={`Deepest cut, scale ±${Math.max(1, Math.ceil(Math.abs(row.dynamicEq.rangeDb)))} dB`} height={70} peak={{ hz: row.dynamicEq.frequencyHz, db: row.dynamicEq.rangeDb }} />
          ) : null}
          <ReductionTimeline row={row} />
        </>
      )}
      {row.metrics.length > 0 && mode !== "current" ? <Metrics rows={row.metrics} compact /> : null}
      <p className="mt-1 text-[11px] text-muted">{explainDynamics(row)}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ metrics */

function Metrics({ rows, compact = false }: { rows: MetricDifference[]; compact?: boolean }) {
  return (
    <div className={compact ? "mt-1" : "max-w-2xl"}>
      <table className="text-left text-xs">
        <tbody>
          {rows.map((row) => {
            const moved = Math.abs(row.after - row.before) >= 0.005;
            const improved = row.better === "lower" ? row.after < row.before : row.better === "higher" ? row.after > row.before : null;
            return (
              <tr key={row.label}>
                <td className="py-0.5 pr-3 text-muted">{row.label}</td>
                <td className="py-0.5 pr-1 font-mono text-muted">{row.before.toFixed(2)}</td>
                <td className="py-0.5 pr-1 text-faint">→</td>
                <td className="py-0.5 pr-2 font-mono text-ink">{row.after.toFixed(2)}</td>
                <td className="py-0.5 pr-2 text-faint">{row.unit}</td>
                <td className={`py-0.5 ${!moved || improved === null ? "text-faint" : improved ? "text-ok" : "text-danger"}`}>{!moved ? "unchanged" : improved === null ? "changed" : improved ? `${row.better} (better)` : `${row.better === "lower" ? "higher" : "lower"} (worse)`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {compact ? null : <p className="mt-1 text-[10px] text-faint">Diagnostic measurements from the planners, each about one stem or the mix's stereo field. They are not a mix-quality score.</p>}
    </div>
  );
}
