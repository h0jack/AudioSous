import { formatSignedDb } from "@audiosous/balance-planner";
import { isMonoTrack, type ProjectDocument } from "@audiosous/project-model";
import {
  SPATIAL_EDIT_LIMITS,
  describePan,
  describeWidth,
  editSpatialRecommendation,
  recommendationImages,
  resetSpatialRecommendation,
  setSpatialRecommendationStatus,
  spatialPlanIsStale,
  spatialRecommendationIncluded,
  type SpatialPlan,
  type SpatialRecommendation,
  type SpatialStrength,
} from "@audiosous/spatial-planner";
import { useEffect, useRef } from "react";
import { logEvent } from "../lib/log";
import { currentSpatialAudition } from "../lib/monitor";
import type { usePlayback } from "../lib/playback";
import { applySpace, auditionSpace, cancelSpacePlan, hearSpaceRow, runSpacePlan, setSpacePreview, spaceHearing, spaceScope } from "../lib/space";
import { getPlatform } from "../platform";
import { useAppStore, type SpaceSession } from "../state/app-store";
import { CorrelationMeter, StereoField, type FieldStem } from "./StereoField";
import { PlannerStatus } from "./ProcessingStatus";
import { PlanChanges } from "./PlanChanges";
import { Button } from "./ui";

type Playback = ReturnType<typeof usePlayback>;

export function SpacePanel({ document, playback }: { document: ProjectDocument; playback: Playback }) {
  const space = useAppStore((state) => state.space);
  return <SpacePanelView document={document} playback={playback} space={space} />;
}

/** The panel for one Space session. Reads nothing from the store, so it renders the same in a test. */
export function SpacePanelView({ document, playback, space }: { document: ProjectDocument; playback: Playback; space: SpaceSession }) {
  const plan = space.plan;
  const stale = plan ? spatialPlanIsStale(plan, document, space.fingerprints, space.settings) : false;
  const loggedStale = useRef<string | null>(null);
  useEffect(() => {
    if (!plan || !stale || loggedStale.current === plan.stateIdentity) return;
    loggedStale.current = plan.stateIdentity;
    void logEvent(getPlatform(), "info", "spatialplan.stale", "Spatial plan is out of date.", { projectId: document.project.id });
  }, [plan, stale, document.project.id]);

  if (!space.open) {
    return (
      <div className="flex items-center gap-3 border-t border-line px-4 py-2">
        <Button title="Find stereo-field conflicts and plan pan and width" tone="accent" className="px-3 py-1.5 text-xs" onClick={() => void runSpacePlan()}>
          Space
        </Button>
        <p className="text-xs text-faint">
          Spatial plan: modest pan or balance moves and width changes where stems that compete in frequency also share the same place in the stereo field. Kick and bass stay centered. No delay, reverb, or artificial stereo. {spaceScope(document)}
        </p>
      </div>
    );
  }

  const busy = space.phase === "analyzing" || space.phase === "planning" || space.phase === "verifying";
  const accepted = plan?.changes.filter((change) => change.status === "accepted").length ?? 0;
  const audition = plan && space.phase === "ready" && !stale ? currentSpatialAudition(document, space) : null;
  const selected = plan?.changes.find((change) => change.id === space.selectedId) ?? null;
  const native = playback.engineKind === "native";

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-line bg-panel" aria-label="Spatial plan">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm text-ink">Space</h2>
        <label className="flex items-center gap-1 text-xs text-muted">
          Strength
          <select
            aria-label="Spatial strength"
            value={space.settings.strength}
            className="rounded-md border border-line bg-canvas py-1 pr-6 pl-2 text-xs text-ink"
            onChange={(event) => useAppStore.getState().setSpace({ settings: { strength: event.target.value as SpatialStrength } })}
          >
            <option value="conservative">Conservative</option>
            <option value="normal">Normal</option>
            <option value="strong">Strong</option>
          </select>
        </label>
        <Button title="Build a new spatial plan from the current project" className="px-3 py-1.5 text-xs" disabled={busy} onClick={() => void runSpacePlan()}>
          {busy ? (space.progress ?? "Working…") : plan ? "Regenerate" : "Plan space"}
        </Button>
        {plan && space.phase === "ready" && !stale ? (
          <span className="text-xs text-accent" role="status" aria-live="polite">
            {spaceHearing(document, space)}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button title="Hear the saved mix with its saved pan and width" className="px-3 py-1.5 text-xs" disabled={!plan || stale} tone={!space.preview ? "accent" : "ghost"} onClick={() => setSpacePreview(false)}>
            Current
          </Button>
          <Button title="Hear the included pan and width changes without saving them" className="px-3 py-1.5 text-xs" disabled={!plan || stale} tone={space.preview ? "accent" : "ghost"} onClick={() => setSpacePreview(true)}>
            Spatial Candidate
          </Button>
          <Button title="Write the proposed and accepted changes into the project" className="px-3 py-1.5 text-xs" disabled={!plan || stale || busy} onClick={() => applySpace("all")}>
            Apply all
          </Button>
          <Button title="Write only the accepted changes into the project" className="px-3 py-1.5 text-xs" disabled={!plan || stale || accepted === 0} onClick={() => applySpace("accepted")}>
            Apply accepted
          </Button>
          <Button title="Discard this plan and return to the saved mix" className="px-3 py-1.5 text-xs" onClick={() => cancelSpacePlan()}>
            Cancel
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto group-data-[collapsed=true]:hidden px-4 py-3">
        <p className="mb-2 max-w-3xl text-xs text-faint">{spaceScope(document)}</p>
        {!native ? (
          <p className="mb-2 max-w-3xl text-xs text-danger">This audio engine plays pan and balance but not width. Use the native engine to hear width changes.</p>
        ) : null}
        <PlannerStatus kind="space-plan" />
        <PlanChanges tab="space" document={document} />
        {space.error ? <p className="text-sm text-danger">{space.error}</p> : null}
        {stale ? (
          <p className="mb-2 text-sm text-danger" role="status">
            Plan out of date. Regenerate before applying it.
          </p>
        ) : null}
        {space.preview && !stale ? <p className="mb-2 text-sm text-muted">Previewing the Spatial Candidate. The saved project has not changed.</p> : null}
        {plan && space.phase === "ready" ? (
          <>
            <p className="max-w-3xl text-sm leading-relaxed text-ink">{plan.summary.headline}</p>
            <p className="mt-1 text-xs text-muted">
              {plan.summary.pairsAnalyzed} stem pairs compared. Overall confidence {Math.round(plan.summary.confidence * 100)}%. {plan.summary.analysisSource}
            </p>
            <MixLine plan={plan} />
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
                      <th className="py-1 pr-3 font-medium">Pan / Balance</th>
                      <th className="py-1 pr-3 font-medium">Width</th>
                      <th className="py-1 pr-3 font-medium">Confidence</th>
                      <th className="py-1 font-medium"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.changes.map((change) => (
                      <SpaceRow key={change.id} document={document} change={change} selected={change.id === space.selectedId} playback={playback} space={space} />
                    ))}
                  </tbody>
                </table>
                {selected ? <SpaceDetail document={document} plan={plan} change={selected} disabled={stale} /> : null}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">No pan or width changes were recommended.</p>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}

function MixLine({ plan }: { plan: SpatialPlan }) {
  const { before, after } = plan.mix;
  return (
    <p className="mt-1 text-xs text-muted">
      Mix center load {Math.round(before.centerLoad * 100)}% → {Math.round(after.centerLoad * 100)}%, left/right lean {Math.round(before.balance * 100)}% → {Math.round(after.balance * 100)}%, mono fold-down loss{" "}
      {before.monoLossDb.toFixed(1)} → {after.monoLossDb.toFixed(1)} dB (proposed rows only).
    </p>
  );
}

function SpaceRow({ document, change, selected, playback, space }: { document: ProjectDocument; change: SpatialRecommendation; selected: boolean; playback: Playback; space: SpaceSession }) {
  const track = document.tracks.find((item) => item.id === change.trackId);
  const section = change.scope.type === "section" ? document.sections.find((item) => item.id === (change.scope as { sectionId: string }).sectionId) : null;
  const included = spatialRecommendationIncluded(change, "preview");
  const focused = space.auditionId === change.id;
  return (
    <tr className={`border-t border-line align-top ${selected ? "bg-panel-2" : ""} ${included ? "" : "text-faint"}`}>
      <td className="py-2 pr-3">
        <button type="button" className="text-left text-ink" onClick={() => select(document, change, playback)}>
          {track?.name ?? change.trackId}
        </button>
      </td>
      <td className="py-2 pr-3">{change.scope.type === "global" ? "Global" : (section?.name ?? "Section")}</td>
      <td className="py-2 pr-3 font-mono">
        {change.processing.pan === null ? (
          <span className="text-faint">{describePan(change.current.pan)}</span>
        ) : (
          <>
            {describePan(change.current.pan)} → {describePan(change.processing.pan)}
            <span className="ml-1 text-accent">{signedPercent(change.processing.pan - change.current.pan)}</span>
          </>
        )}
      </td>
      <td className="py-2 pr-3 font-mono">
        {change.processing.width === null ? (
          <span className="text-faint">{track && isMonoTrack(track) ? "mono" : describeWidth(change.current.width)}</span>
        ) : (
          <>
            {describeWidth(change.current.width)} → {describeWidth(change.processing.width)}
            <span className="ml-1 text-accent">{signedPercent(change.processing.width - change.current.width)}</span>
          </>
        )}
      </td>
      <td className="py-2 pr-3">
        {change.confidenceLabel} {Math.round(change.confidence * 100)}%
        {change.status === "needs-review" ? " · review" : ""}
        {change.status === "rejected" ? " · rejected" : ""}
        {change.status === "accepted" ? " · accepted" : ""}
        {change.edited ? " · edited" : ""}
      </td>
      <td className="py-2">
        <div className="flex flex-wrap gap-1">
          <RowButton label="Accept this change" pressed={change.status === "accepted"} onClick={() => updateStatus(change.id, change.status === "accepted" ? "proposed" : "accepted")}>
            Accept
          </RowButton>
          <RowButton label="Reject this change" pressed={change.status === "rejected"} onClick={() => updateStatus(change.id, "rejected")}>
            Reject
          </RowButton>
          <RowButton label="Open the stereo field to edit this change" pressed={selected} onClick={() => select(document, change, playback)}>
            Edit
          </RowButton>
          <RowButton label="Hear the whole mix without this change" pressed={focused && space.auditionSide === "bypassed"} onClick={() => auditionSpace(change.id, "bypassed")}>
            Bypassed
          </RowButton>
          <RowButton label="Hear the whole mix with only this change" pressed={focused && space.auditionSide === "recommended"} onClick={() => auditionSpace(change.id, "recommended")}>
            Recommended
          </RowButton>
        </div>
        <p className="mt-1 max-w-md text-[11px] leading-snug text-muted">{change.reasons[0]}</p>
      </td>
    </tr>
  );
}

function SpaceDetail({ document, plan, change, disabled }: { document: ProjectDocument; plan: SpatialPlan; change: SpatialRecommendation; disabled: boolean }) {
  const track = document.tracks.find((item) => item.id === change.trackId);
  const mono = track ? isMonoTrack(track) : false;
  const sectionId = change.scope.type === "section" ? change.scope.sectionId : null;
  const field = plan.fields.find((item) => (sectionId ? item.sectionId === sectionId : item.key === "song")) ?? plan.fields[0];
  const images = recommendationImages(change);
  const pan = change.processing.pan ?? change.current.pan;
  const width = change.processing.width ?? change.current.width;
  const edit = (patch: { pan?: number | null; width?: number | null }) => {
    if (disabled) return;
    const current = useAppStore.getState().space.plan;
    if (!current) return;
    useAppStore.getState().setSpace({ plan: editSpatialRecommendation(current, change.id, patch) });
    // An edit is only useful if you hear it.
    hearSpaceRow(change.id);
  };
  const stems: FieldStem[] = (field?.tracks ?? []).map((item) => ({
    trackId: item.trackId,
    name: document.tracks.find((candidate) => candidate.id === item.trackId)?.name ?? item.trackId,
    image: item.image,
    levelDb: item.levelDb,
    tier: item.tier,
    mono: item.mono,
  }));
  const evaluation = change.evaluation;
  const interactions = plan.interactions.filter((item) => change.interactionIds.includes(item.id));
  return (
    <div className="min-w-0 rounded-md border border-line bg-canvas/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm text-ink">
          {track?.name ?? change.trackId} · {sectionId ? (document.sections.find((item) => item.id === sectionId)?.name ?? "Section") : "Global"}
        </h3>
        {change.edited ? (
          <button type="button" className="text-[11px] text-muted underline" onClick={() => useAppStore.getState().setSpace({ plan: resetSpatialRecommendation(plan, change.id) })}>
            Reset to planned
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-[11px] text-faint">
        {field?.name ?? "Whole song"}. Dashed: where {track?.name ?? "it"} sits now. Solid: proposed. Drag to move it{mono ? "" : "; Shift-drag, the wheel, or Shift+arrows change its width"}.
      </p>
      <StereoField
        stems={stems}
        moving={{ trackId: change.trackId, before: images.before, after: images.after, pan, width, canWiden: !mono }}
        related={change.relatedTrackIds}
        onChange={disabled ? undefined : (patch) => edit(patch)}
        label={`Stereo field for ${track?.name ?? change.trackId}`}
      />
      <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
        <Slider
          label={mono ? "Pan" : "Balance"}
          value={Math.round(pan * 100)}
          min={SPATIAL_EDIT_LIMITS.minPan * 100}
          max={SPATIAL_EDIT_LIMITS.maxPan * 100}
          current={Math.round(change.current.pan * 100)}
          format={(value) => describePan(value / 100)}
          disabled={disabled}
          onChange={(value) => edit({ pan: value / 100 })}
        />
        {mono ? (
          <p className="self-end text-[11px] text-faint">Width does nothing on a mono stem. Audiosous does not create stereo.</p>
        ) : (
          <Slider
            label="Width"
            value={Math.round(width * 100)}
            min={SPATIAL_EDIT_LIMITS.minWidth * 100}
            max={SPATIAL_EDIT_LIMITS.maxWidth * 100}
            current={Math.round(change.current.width * 100)}
            format={(value) => `${value}%`}
            disabled={disabled}
            onChange={(value) => edit({ width: value / 100 })}
          />
        )}
      </div>
      {evaluation ? (
        <div className="mt-2 space-y-1 text-[11px] leading-snug text-muted">
          <p>
            Overlap in the field where they compete {evaluation.overlapBefore.toFixed(2)} → {evaluation.overlapAfter.toFixed(2)}; weighted conflict {evaluation.conflictBefore.toFixed(2)} → {evaluation.conflictAfter.toFixed(2)}; share in the center{" "}
            {Math.round(evaluation.centerBefore * 100)}% → {Math.round(evaluation.centerAfter * 100)}%.
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Correlation now</span>
            <CorrelationMeter value={evaluation.correlationBefore} label="Correlation now" />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Correlation after</span>
            <CorrelationMeter value={evaluation.correlationAfter} label="Correlation after" />
          </div>
          <p>
            Folded to mono, {track?.name ?? "the stem"} loses {evaluation.monoLossBeforeDb.toFixed(1)} → {evaluation.monoLossAfterDb.toFixed(1)} dB. Its stereo level changes {formatSignedDb(evaluation.levelChangeDb)} dB. Mix lean{" "}
            {Math.round(evaluation.mixBefore.balance * 100)}% → {Math.round(evaluation.mixAfter.balance * 100)}%.
            {evaluation.proxy
              ? ` Playback proxy (${evaluation.proxy.seconds.toFixed(1)} s): correlation ${evaluation.proxy.correlationBefore.toFixed(2)} → ${evaluation.proxy.correlationAfter.toFixed(2)}, mono loss ${evaluation.proxy.monoLossBeforeDb.toFixed(1)} → ${evaluation.proxy.monoLossAfterDb.toFixed(1)} dB, peak ${formatSignedDb(evaluation.proxy.peakChangeDb)} dB${evaluation.proxy.agrees ? ", matching the prediction" : ", not matching the prediction"}.`
              : change.edited
                ? " Edited: the proxy check ran on the planned values, not these."
                : ""}
          </p>
        </div>
      ) : null}
      {change.warnings.length > 0 ? (
        <ul className="mt-2 list-disc pl-4 text-[11px] leading-snug text-danger">
          {change.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <ul className="mt-2 list-disc pl-4 text-[11px] leading-snug text-muted">
        {change.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {interactions.length > 0 ? (
        <p className="mt-2 text-[11px] text-faint">
          From {interactions.length} {interactions.length === 1 ? "interaction" : "interactions"}: {interactions.map((item) => `${item.scopeName} (${item.severity.toFixed(2)})`).join(", ")}. Analysis → Spatial interaction shows them.
        </p>
      ) : null}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  current,
  format,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  current: number;
  format: (value: number) => string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-muted">
      <span>
        {label} <span className="font-mono text-ink">{format(value)}</span>
        <span className="ml-1 font-mono text-faint">(now {format(current)})</span>
      </span>
      <div className="flex items-center gap-2">
        <input type="range" min={min} max={max} step={1} value={value} disabled={disabled} aria-label={label} className="min-w-0 flex-1" onChange={(event) => onChange(Number(event.target.value))} />
        <input
          type="number"
          min={min}
          max={max}
          step={1}
          value={value}
          disabled={disabled}
          aria-label={`${label} value`}
          className="w-16 rounded border border-line bg-canvas px-1 py-0.5 font-mono text-xs text-ink"
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)));
          }}
        />
      </div>
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

function signedPercent(delta: number): string {
  const value = Math.round(delta * 100);
  return value > 0 ? `+${value}` : `${value}`;
}

function updateStatus(id: string, status: SpatialRecommendation["status"]): void {
  const plan = useAppStore.getState().space.plan;
  if (!plan) return;
  useAppStore.getState().setSpace({ plan: setSpatialRecommendationStatus(plan, id, status) });
}

/** Opens the row's field, selects its track and section, and moves the playhead to where it matters. */
function select(document: ProjectDocument, change: SpatialRecommendation, playback: Playback): void {
  useAppStore.getState().setSpace({ selectedId: change.id });
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
