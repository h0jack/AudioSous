import {
  EDIT_LIMITS,
  editEqRecommendation,
  eqPlanIsStale,
  eqRecommendationIncluded,
  formatHz,
  resetEqRecommendation,
  setEqRecommendationStatus,
  type EqPlan,
  type EqRecommendation,
  type EqStrength,
} from "@audiosous/eq-planner";
import { EQ_FILTER_KINDS, EQ_FILTER_LABELS, eqChainForSection, isPassFilter, type EqFilter, type ProjectDocument } from "@audiosous/project-model";
import { formatSignedDb } from "@audiosous/balance-planner";
import { useEffect, useRef } from "react";
import { applyEq, auditionEq, cancelEqPlan, eqHearing, eqScope, hearEqRow, runEqPlan, setEqPreview } from "../lib/eq";
import { logEvent } from "../lib/log";
import { currentEqAudition } from "../lib/monitor";
import type { usePlayback } from "../lib/playback";
import { getPlatform } from "../platform";
import { useAppStore } from "../state/app-store";
import { EqCurve } from "./EqCurve";
import { PlannerStatus } from "./ProcessingStatus";
import { PlanChanges } from "./PlanChanges";
import { Button } from "./ui";

type Playback = ReturnType<typeof usePlayback>;

export function EqPanel({ document, playback }: { document: ProjectDocument; playback: Playback }) {
  const eq = useAppStore((state) => state.eq);
  const plan = eq.plan;
  const stale = plan ? eqPlanIsStale(plan, document, eq.fingerprints, eq.settings) : false;
  const loggedStale = useRef<string | null>(null);
  useEffect(() => {
    if (!plan || !stale || loggedStale.current === plan.stateIdentity) return;
    loggedStale.current = plan.stateIdentity;
    void logEvent(getPlatform(), "info", "eqplan.stale", "EQ plan is out of date.", { projectId: document.project.id });
  }, [plan, stale, document.project.id]);

  if (!eq.open) {
    return (
      <div className="flex items-center gap-3 border-t border-line px-4 py-2">
        <Button title="Find frequency conflicts and plan static EQ" tone="accent" className="px-3 py-1.5 text-xs" onClick={() => void runEqPlan()}>
          EQ
        </Button>
        <p className="text-xs text-faint">
          Static EQ plan: conservative cuts, gentle high-pass where measured, and few boosts. It does not compress, pan, or touch the source files. {eqScope(document)}
        </p>
      </div>
    );
  }

  const busy = eq.phase === "analyzing" || eq.phase === "planning" || eq.phase === "verifying";
  const accepted = plan?.changes.filter((change) => change.status === "accepted").length ?? 0;
  const audition = plan && eq.phase === "ready" && !stale ? currentEqAudition(document, eq) : null;
  const selected = plan?.changes.find((change) => change.id === eq.selectedId) ?? null;
  const native = playback.engineKind === "native";

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-line bg-panel" aria-label="EQ plan">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm text-ink">EQ</h2>
        <label className="flex items-center gap-1 text-xs text-muted">
          Strength
          <select
            aria-label="EQ strength"
            value={eq.settings.strength}
            className="rounded-md border border-line bg-canvas py-1 pr-6 pl-2 text-xs text-ink"
            onChange={(event) => useAppStore.getState().setEq({ settings: { strength: event.target.value as EqStrength } })}
          >
            <option value="conservative">Conservative</option>
            <option value="normal">Normal</option>
            <option value="strong">Strong</option>
          </select>
        </label>
        <Button title="Build a new EQ plan from the current project" className="px-3 py-1.5 text-xs" disabled={busy} onClick={() => void runEqPlan()}>
          {busy ? (eq.progress ?? "Working…") : plan ? "Regenerate" : "Plan EQ"}
        </Button>
        {plan && eq.phase === "ready" && !stale ? (
          <span className="text-xs text-accent" role="status" aria-live="polite">
            {eqHearing(document, eq)}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button title="Hear the saved mix and its saved EQ" className="px-3 py-1.5 text-xs" disabled={!plan || stale} tone={!eq.preview ? "accent" : "ghost"} onClick={() => setEqPreview(false)}>
            Current
          </Button>
          <Button title="Hear the included EQ filters without saving them" className="px-3 py-1.5 text-xs" disabled={!plan || stale} tone={eq.preview ? "accent" : "ghost"} onClick={() => setEqPreview(true)}>
            EQ Candidate
          </Button>
          <Button title="Write the proposed and accepted filters into the project" className="px-3 py-1.5 text-xs" disabled={!plan || stale || busy} onClick={() => applyEq("all")}>
            Apply all
          </Button>
          <Button title="Write only the accepted filters into the project" className="px-3 py-1.5 text-xs" disabled={!plan || stale || accepted === 0} onClick={() => applyEq("accepted")}>
            Apply accepted
          </Button>
          <Button title="Discard this plan and return to the saved mix" className="px-3 py-1.5 text-xs" onClick={() => cancelEqPlan()}>
            Cancel
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto group-data-[collapsed=true]:hidden px-4 py-3">
        <p className="mb-2 max-w-3xl text-xs text-faint">{eqScope(document)}</p>
        {!native ? (
          <p className="mb-2 max-w-3xl text-xs text-danger">This audio engine plays without EQ. Use the native engine to hear the candidate.</p>
        ) : null}
        <PlannerStatus kind="eq-plan" />
        <PlanChanges tab="eq" document={document} />
        {eq.error ? <p className="text-sm text-danger">{eq.error}</p> : null}
        {stale ? (
          <p className="mb-2 text-sm text-danger" role="status">
            Plan out of date. Regenerate before applying it.
          </p>
        ) : null}
        {eq.preview && !stale ? <p className="mb-2 text-sm text-muted">Previewing the EQ Candidate. The saved project has not changed.</p> : null}
        {plan && eq.phase === "ready" ? (
          <>
            <p className="max-w-3xl text-sm leading-relaxed text-ink">{plan.summary.headline}</p>
            <p className="mt-1 text-xs text-muted">
              {plan.summary.pairsAnalyzed} stem pairs compared. Overall confidence {Math.round(plan.summary.confidence * 100)}%. {plan.summary.analysisSource}
            </p>
            {plan.summary.notes.map((note) => (
              <p key={note} className="mt-1 max-w-3xl text-xs text-muted">
                {note}
              </p>
            ))}
            {audition ? <p className="mt-1 max-w-3xl text-xs text-faint">{audition.note}</p> : null}
            {plan.changes.length > 0 ? (
              <div className="mt-3 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,640px)]">
                <table className="w-full border-collapse self-start text-left text-xs">
                  <thead className="text-[10px] tracking-wide text-faint uppercase">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Track</th>
                      <th className="py-1 pr-3 font-medium">Scope</th>
                      <th className="py-1 pr-3 font-medium">Type</th>
                      <th className="py-1 pr-3 font-medium">Frequency</th>
                      <th className="py-1 pr-3 font-medium">Gain</th>
                      <th className="py-1 pr-3 font-medium">Q</th>
                      <th className="py-1 pr-3 font-medium">Confidence</th>
                      <th className="py-1 font-medium"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.changes.map((change) => (
                      <EqRow key={change.id} document={document} change={change} selected={change.id === eq.selectedId} playback={playback} />
                    ))}
                  </tbody>
                </table>
                {selected ? <EqDetail document={document} plan={plan} change={selected} disabled={stale} /> : null}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">No EQ filters were recommended.</p>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}

function EqRow({ document, change, selected, playback }: { document: ProjectDocument; change: EqRecommendation; selected: boolean; playback: Playback }) {
  const eq = useAppStore((state) => state.eq);
  const track = document.tracks.find((item) => item.id === change.trackId);
  const section = change.scope.type === "section" ? document.sections.find((item) => item.id === (change.scope as { sectionId: string }).sectionId) : null;
  const included = eqRecommendationIncluded(change, "preview");
  const filter = change.processing.filter;
  const focused = eq.auditionId === change.id;
  return (
    <tr className={`border-t border-line align-top ${selected ? "bg-panel-2" : ""} ${included ? "" : "text-faint"}`}>
      <td className="py-2 pr-3">
        <button type="button" className="text-left text-ink" onClick={() => select(document, change, playback)}>
          {track?.name ?? change.trackId}
        </button>
      </td>
      <td className="py-2 pr-3">{change.scope.type === "global" ? "Global" : (section?.name ?? "Section")}</td>
      <td className="py-2 pr-3">{EQ_FILTER_LABELS[filter.kind]}</td>
      <td className="py-2 pr-3 font-mono">{formatHz(filter.frequencyHz)}</td>
      <td className="py-2 pr-3 font-mono">{isPassFilter(filter.kind) ? "—" : formatSignedDb(filter.gainDb)}</td>
      <td className="py-2 pr-3 font-mono">{filter.q.toFixed(2)}</td>
      <td className="py-2 pr-3">
        {change.confidenceLabel} {Math.round(change.confidence * 100)}%
        {change.status === "needs-review" ? " · review" : ""}
        {change.status === "rejected" ? " · rejected" : ""}
        {change.status === "accepted" ? " · accepted" : ""}
        {change.edited ? " · edited" : ""}
      </td>
      <td className="py-2">
        <div className="flex flex-wrap gap-1">
          <RowButton label="Accept this filter" pressed={change.status === "accepted"} onClick={() => updateStatus(change.id, change.status === "accepted" ? "proposed" : "accepted")}>
            Accept
          </RowButton>
          <RowButton label="Reject this filter" pressed={change.status === "rejected"} onClick={() => updateStatus(change.id, "rejected")}>
            Reject
          </RowButton>
          <RowButton label="Open the curve to edit this filter" pressed={selected} onClick={() => select(document, change, playback)}>
            Edit
          </RowButton>
          <RowButton label="Hear the whole mix with this filter bypassed" pressed={focused && eq.auditionSide === "bypassed"} onClick={() => auditionEq(change.id, "bypassed")}>
            Bypassed
          </RowButton>
          <RowButton label="Hear the whole mix with only this filter added" pressed={focused && eq.auditionSide === "recommended"} onClick={() => auditionEq(change.id, "recommended")}>
            With filter
          </RowButton>
        </div>
        <p className="mt-1 max-w-md text-[11px] leading-snug text-muted">{change.reasons[0]}</p>
      </td>
    </tr>
  );
}

function EqDetail({ document, plan, change, disabled }: { document: ProjectDocument; plan: EqPlan; change: EqRecommendation; disabled: boolean }) {
  const track = document.tracks.find((item) => item.id === change.trackId);
  const reference = change.protectedTrackIds.length > 0 ? change.protectedTrackIds.map((id) => document.tracks.find((item) => item.id === id)?.name ?? id).join(" + ") : null;
  const referenceLabel = change.purpose === "low-end" ? `${reference} (low-end owners)` : change.purpose === "intent" || change.purpose === "presence" ? "Rest of the mix" : reference;
  const filter = change.processing.filter;
  const saved = eqChainForSection(document, change.trackId, change.scope.type === "section" ? change.scope.sectionId : null);
  const evaluation = change.evaluation;
  const edit = (patch: Partial<EqFilter>) => {
    if (disabled) return;
    const current = useAppStore.getState().eq.plan;
    if (!current) return;
    useAppStore.getState().setEq({ plan: editEqRecommendation(current, change.id, patch) });
    // An edit is only useful if you hear it.
    hearEqRow(change.id);
  };
  const interactions = plan.interactions.filter((item) => change.interactionIds.includes(item.id));
  return (
    <div className="min-w-0 rounded-md border border-line bg-canvas/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm text-ink">
          {track?.name ?? change.trackId} · {change.scope.type === "global" ? "Global" : (document.sections.find((item) => item.id === (change.scope as { sectionId: string }).sectionId)?.name ?? "Section")}
        </h3>
        {change.edited ? (
          <button type="button" className="text-[11px] text-muted underline" onClick={() => useAppStore.getState().setEq({ plan: resetEqRecommendation(plan, change.id) })}>
            Reset to planned
          </button>
        ) : null}
      </div>
      <EqCurve
        evidence={change.evidence}
        filter={filter}
        savedFilters={saved}
        targetName={track?.name ?? change.trackId}
        referenceName={referenceLabel}
        onChange={disabled ? undefined : edit}
        label={`EQ curve for ${track?.name ?? change.trackId}`}
      />
      <div className="mt-2 flex flex-wrap items-end gap-3 text-xs">
        <label className="flex flex-col gap-1 text-muted">
          Type
          <select
            aria-label="Filter type"
            value={filter.kind}
            disabled={disabled}
            className="rounded border border-line bg-canvas py-1 pr-6 pl-2 text-xs text-ink"
            onChange={(event) => edit({ kind: event.target.value as EqFilter["kind"], gainDb: isPassFilter(event.target.value as EqFilter["kind"]) ? 0 : filter.gainDb || -1 })}
          >
            {EQ_FILTER_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {EQ_FILTER_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>
        <NumberField label="Frequency (Hz)" value={filter.frequencyHz} step={1} min={EDIT_LIMITS.minHz} max={EDIT_LIMITS.maxHz} disabled={disabled} onChange={(value) => edit({ frequencyHz: value })} />
        <NumberField label="Gain (dB)" value={filter.gainDb} step={0.1} min={EDIT_LIMITS.minGainDb} max={EDIT_LIMITS.maxGainDb} disabled={disabled || isPassFilter(filter.kind)} onChange={(value) => edit({ gainDb: value })} />
        <NumberField label="Q" value={filter.q} step={0.05} min={EDIT_LIMITS.minQ} max={EDIT_LIMITS.maxQ} disabled={disabled} onChange={(value) => edit({ q: value })} />
      </div>
      {evaluation ? (
        <p className="mt-2 text-[11px] leading-snug text-muted">
          Analysis spectra: {evaluation.gapReductionDb >= 0 ? `${evaluation.gapReductionDb.toFixed(1)} dB more separation` : `${Math.abs(evaluation.gapReductionDb).toFixed(1)} dB less separation`} inside the conflict, {formatSignedDb(evaluation.regionChangeDb)} dB in range,{" "}
          {formatSignedDb(evaluation.identityChangeDb)} dB on {track?.name ?? "the track"} overall.
          {evaluation.proxy
            ? ` Playback proxy (${evaluation.proxy.seconds.toFixed(1)} s): ${formatSignedDb(evaluation.proxy.regionChangeDb)} dB in range, ${formatSignedDb(evaluation.proxy.identityChangeDb)} dB overall${evaluation.proxy.agrees ? ", matching the prediction" : ", not matching the prediction"}.`
            : change.edited
              ? " Edited: the proxy check ran on the planned filter, not this one."
              : ""}
        </p>
      ) : null}
      <ul className="mt-2 list-disc pl-4 text-[11px] leading-snug text-muted">
        {change.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {interactions.length > 0 ? (
        <p className="mt-2 text-[11px] text-faint">
          From {interactions.length} {interactions.length === 1 ? "interaction" : "interactions"}: {interactions.map((item) => `${item.scopeName} (${item.severity.toFixed(2)})`).join(", ")}. Analysis → Frequency interaction shows them.
        </p>
      ) : null}
    </div>
  );
}

function NumberField({
  label,
  value,
  step,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-muted">
      {label}
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        className="w-24 rounded border border-line bg-canvas px-1 py-0.5 font-mono text-xs text-ink"
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

function RowButton({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-pressed={pressed}
      className={`rounded px-1.5 py-0.5 text-[11px] ${pressed ? "bg-accent text-accent-ink" : "bg-canvas text-muted"}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function updateStatus(id: string, status: EqRecommendation["status"]): void {
  const plan = useAppStore.getState().eq.plan;
  if (!plan) return;
  useAppStore.getState().setEq({ plan: setEqRecommendationStatus(plan, id, status) });
}

/** Opens the row's curve, selects its track and section, and moves the playhead to where it matters. */
function select(document: ProjectDocument, change: EqRecommendation, playback: Playback): void {
  useAppStore.getState().setEq({ selectedId: change.id });
  const section = change.scope.type === "section" ? document.sections.find((item) => item.id === (change.scope as { sectionId: string }).sectionId) : null;
  const start = section?.startTime ?? change.evidence.windows[0]?.[0] ?? null;
  useAppStore.getState().replaceDocument(
    {
      ...document,
      uiState: {
        ...document.uiState,
        selectedTrackId: change.trackId,
        selectedSectionId: section?.id ?? document.uiState.selectedSectionId,
        timeRange: section ? { start: section.startTime, end: section.endTime } : document.uiState.timeRange,
        playheadSeconds: start ?? document.uiState.playheadSeconds,
      },
    },
    true,
    { mode: "skip" },
  );
  if (start !== null && !playback.playing) playback.seek(start, { log: false });
}
