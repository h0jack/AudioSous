import { formatSignedDb } from "@audiosous/balance-planner";
import {
  PROCESSOR_LABELS,
  describeProcessing,
  dynamicsPlanIsStale,
  dynamicsRecommendationIncluded,
  editDynamicsRecommendation,
  formatHz,
  resetDynamicsRecommendation,
  setDynamicsRecommendationStatus,
  signedPercent,
  type DynamicsPatch,
  type DynamicsPlan,
  type DynamicsRecommendation,
  type DynamicsStrength,
} from "@audiosous/dynamics-planner";
import { filterMagnitudeDb } from "@audiosous/eq-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { useEffect, useRef, useState } from "react";
import {
  applyDynamics,
  auditionDynamics,
  cancelDynamicsPlan,
  dynamicsHearing,
  dynamicsScope,
  hearDynamicsRow,
  runDynamicsPlan,
  setDynamicsPreview,
} from "../lib/dynamics";
import { logEvent } from "../lib/log";
import { currentDynamicsAudition } from "../lib/monitor";
import type { DynamicsMeterReading } from "../lib/native-playback";
import type { usePlayback } from "../lib/playback";
import { getPlatform } from "../platform";
import { useAppStore, type DynamicsSession } from "../state/app-store";
import { Button } from "./ui";

type Playback = ReturnType<typeof usePlayback>;

const PROBLEM_LABELS: Record<DynamicsRecommendation["problem"], string> = {
  "level-inconsistency": "Level swings",
  "transient-excess": "Spiky attacks",
  "transient-weakness": "Buried attacks",
  "low-end-collision": "Low-end collision",
  "event-masking": "Masks a lead while it plays",
};

export function DynamicsPanel({ document, playback }: { document: ProjectDocument; playback: Playback }) {
  const dynamics = useAppStore((state) => state.dynamics);
  return <DynamicsPanelView document={document} playback={playback} dynamics={dynamics} />;
}

/** The panel for one Dynamics session. Reads nothing from the store, so it renders the same in a test. */
export function DynamicsPanelView({ document, playback, dynamics }: { document: ProjectDocument; playback: Playback; dynamics: DynamicsSession }) {
  const plan = dynamics.plan;
  const stale = plan ? dynamicsPlanIsStale(plan, document, dynamics.fingerprints, dynamics.settings) : false;
  const loggedStale = useRef<string | null>(null);
  useEffect(() => {
    if (!plan || !stale || loggedStale.current === plan.stateIdentity) return;
    loggedStale.current = plan.stateIdentity;
    void logEvent(getPlatform(), "info", "dynamicsplan.stale", "Dynamics plan is out of date.", { projectId: document.project.id });
  }, [plan, stale, document.project.id]);

  if (!dynamics.open) {
    return (
      <div className="flex items-center gap-3 border-t border-line px-4 py-2">
        <Button title="Find level swings, kick/bass collisions, spiky or buried attacks, and masking that comes and goes" tone="accent" className="px-3 py-1.5 text-xs" onClick={() => void runDynamicsPlan()}>
          Dynamics
        </Button>
        <p className="text-xs text-faint">
          Dynamics plan: conservative compression, ducking, transient shaping, and dynamic EQ, only where a problem changes over time. Makeup stays at 0 dB and the A/B is level-matched. No limiting or loudness. {dynamicsScope(document)}
        </p>
      </div>
    );
  }

  const busy = dynamics.phase === "analyzing" || dynamics.phase === "planning" || dynamics.phase === "verifying";
  const accepted = plan?.changes.filter((change) => change.status === "accepted").length ?? 0;
  const audition = plan && dynamics.phase === "ready" && !stale ? currentDynamicsAudition(document, dynamics) : null;
  const selected = plan?.changes.find((change) => change.id === dynamics.selectedId) ?? null;
  const native = playback.engineKind === "native";

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-line bg-panel" aria-label="Dynamics plan">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm text-ink">Dynamics</h2>
        <label className="flex items-center gap-1 text-xs text-muted">
          Strength
          <select
            aria-label="Dynamics strength"
            value={dynamics.settings.strength}
            className="rounded-md border border-line bg-canvas py-1 pr-6 pl-2 text-xs text-ink"
            onChange={(event) => useAppStore.getState().setDynamics({ settings: { strength: event.target.value as DynamicsStrength } })}
          >
            <option value="conservative">Conservative</option>
            <option value="normal">Normal</option>
            <option value="strong">Strong</option>
          </select>
        </label>
        <Button title="Build a new dynamics plan from the current project" className="px-3 py-1.5 text-xs" disabled={busy} onClick={() => void runDynamicsPlan()}>
          {busy ? (dynamics.progress ?? "Working…") : plan ? "Regenerate" : "Plan dynamics"}
        </Button>
        {plan && dynamics.phase === "ready" && !stale ? (
          <span className="text-xs text-accent" role="status" aria-live="polite">
            {dynamicsHearing(document, dynamics)}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-muted" title="Raise each processed stem by the level its processing is predicted to remove, in the audition only, so the comparison is about dynamics and not loudness">
            <input type="checkbox" checked={dynamics.levelMatch} onChange={(event) => useAppStore.getState().setDynamics({ levelMatch: event.target.checked })} />
            Level-match A/B
          </label>
          <Button title="Hear the saved mix with its saved dynamics" className="px-3 py-1.5 text-xs" disabled={!plan || stale} tone={!dynamics.preview ? "accent" : "ghost"} onClick={() => setDynamicsPreview(false)}>
            Current
          </Button>
          <Button title="Hear the included dynamics changes without saving them" className="px-3 py-1.5 text-xs" disabled={!plan || stale} tone={dynamics.preview ? "accent" : "ghost"} onClick={() => setDynamicsPreview(true)}>
            Dynamics Candidate
          </Button>
          <Button title="Write the proposed and accepted changes into the project" className="px-3 py-1.5 text-xs" disabled={!plan || stale || busy} onClick={() => applyDynamics("all")}>
            Apply all
          </Button>
          <Button title="Write only the accepted changes into the project" className="px-3 py-1.5 text-xs" disabled={!plan || stale || accepted === 0} onClick={() => applyDynamics("accepted")}>
            Apply accepted
          </Button>
          <Button title="Discard this plan and return to the saved mix" className="px-3 py-1.5 text-xs" onClick={() => cancelDynamicsPlan()}>
            Cancel
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3 group-data-[collapsed=true]:hidden">
        <p className="mb-2 max-w-3xl text-xs text-faint">{dynamicsScope(document)}</p>
        {!native ? <p className="mb-2 max-w-3xl text-xs text-danger">This audio engine does not play dynamics. Use the native engine to hear compression, ducking, transient shaping, and dynamic EQ.</p> : null}
        {dynamics.progress ? (
          <p className="text-sm text-muted" role="status">
            {dynamics.progress}
          </p>
        ) : null}
        {dynamics.error ? <p className="text-sm text-danger">{dynamics.error}</p> : null}
        {stale ? (
          <p className="mb-2 text-sm text-danger" role="status">
            Plan out of date. Regenerate before applying it.
          </p>
        ) : null}
        {dynamics.preview && !stale ? <p className="mb-2 text-sm text-muted">Previewing the Dynamics Candidate. The saved project has not changed.</p> : null}
        {plan && dynamics.phase === "ready" ? (
          <>
            <p className="max-w-3xl text-sm leading-relaxed text-ink">{plan.summary.headline}</p>
            <p className="mt-1 text-xs text-muted">
              {plan.summary.tracksAnalyzed} stems and {plan.summary.pairsAnalyzed} relationships read. Overall confidence {Math.round(plan.summary.confidence * 100)}%. {plan.summary.analysisSource}
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
                      <th className="py-1 pr-3 font-medium">Processor</th>
                      <th className="py-1 pr-3 font-medium">Key</th>
                      <th className="py-1 pr-3 font-medium">Amount / GR</th>
                      <th className="py-1 pr-3 font-medium">Confidence</th>
                      <th className="py-1 font-medium"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.changes.map((change) => (
                      <DynamicsRow key={change.id} document={document} change={change} selected={change.id === dynamics.selectedId} playback={playback} dynamics={dynamics} />
                    ))}
                  </tbody>
                </table>
                {selected ? <DynamicsDetail document={document} plan={plan} change={selected} disabled={stale} playback={playback} /> : null}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">No dynamics changes were recommended.</p>
            )}
            <Relationships document={document} plan={plan} />
          </>
        ) : null}
      </div>
    </section>
  );
}

function trackName(document: ProjectDocument, id: string): string {
  return document.tracks.find((track) => track.id === id)?.name ?? id;
}

/** "2.5–3.2 dB GR", "max −2.0 dB", "2.6 kHz, max −1.5 dB", "attack −10%". */
function amountOf(change: DynamicsRecommendation): string {
  const processing = change.processing;
  const evaluation = change.evaluation;
  switch (processing.type) {
    case "compressor":
      return evaluation ? `${evaluation.reductionP50Db.toFixed(1)}–${evaluation.reductionP95Db.toFixed(1)} dB GR` : `${processing.ratio.toFixed(1)}:1`;
    case "ducking":
      return `max ${formatSignedDb(processing.rangeDb)} dB`;
    case "dynamic-eq":
      return `${formatHz(processing.filter.frequencyHz)}, max ${formatSignedDb(processing.rangeDb)} dB`;
    case "transient":
      return `attack ${signedPercent(processing.attack)}${processing.sustain !== 0 ? `, sustain ${signedPercent(processing.sustain)}` : ""}`;
  }
}

function keyOf(change: DynamicsRecommendation): string | null {
  return change.processing.type === "ducking" || change.processing.type === "dynamic-eq" ? change.processing.keyTrackId : null;
}

function DynamicsRow({ document, change, selected, playback, dynamics }: { document: ProjectDocument; change: DynamicsRecommendation; selected: boolean; playback: Playback; dynamics: DynamicsSession }) {
  const section = change.scope.type === "section" ? document.sections.find((item) => item.id === (change.scope as { sectionId: string }).sectionId) : null;
  const included = dynamicsRecommendationIncluded(change, "preview");
  const focused = dynamics.auditionId === change.id;
  const key = keyOf(change);
  return (
    <tr className={`border-t border-line align-top ${selected ? "bg-panel-2" : ""} ${included ? "" : "text-faint"}`}>
      <td className="py-2 pr-3">
        <button type="button" className="text-left text-ink" onClick={() => select(document, change, playback)}>
          {trackName(document, change.trackId)}
        </button>
      </td>
      <td className="py-2 pr-3">{change.scope.type === "global" ? "Global" : (section?.name ?? "Section")}</td>
      <td className="py-2 pr-3">
        {PROCESSOR_LABELS[change.processing.type]}
        {change.replacesNodeId ? <span className="ml-1 text-faint">(edits saved)</span> : null}
      </td>
      <td className="py-2 pr-3">{key ? trackName(document, key) : <span className="text-faint">—</span>}</td>
      <td className="py-2 pr-3 font-mono">{amountOf(change)}</td>
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
          <RowButton label="Open this change's settings and evidence" pressed={selected} onClick={() => select(document, change, playback)}>
            Edit
          </RowButton>
          <RowButton label="Hear the whole mix without this change" pressed={focused && dynamics.auditionSide === "bypassed"} onClick={() => auditionDynamics(change.id, "bypassed")}>
            Bypassed
          </RowButton>
          <RowButton label="Hear the whole mix with only this change" pressed={focused && dynamics.auditionSide === "recommended"} onClick={() => auditionDynamics(change.id, "recommended")}>
            Recommended
          </RowButton>
        </div>
        <p className="mt-1 max-w-md text-[11px] leading-snug text-muted">{change.reasons[0]}</p>
      </td>
    </tr>
  );
}

function DynamicsDetail({ document, plan, change, disabled, playback }: { document: ProjectDocument; plan: DynamicsPlan; change: DynamicsRecommendation; disabled: boolean; playback: Playback }) {
  const sectionId = change.scope.type === "section" ? change.scope.sectionId : null;
  const name = trackName(document, change.trackId);
  const edit = (patch: DynamicsPatch) => {
    if (disabled) return;
    const current = useAppStore.getState().dynamics.plan;
    if (!current) return;
    useAppStore.getState().setDynamics({ plan: editDynamicsRecommendation(current, change.id, patch) });
    // An edit is only useful if you hear it.
    hearDynamicsRow(change.id);
  };
  const evaluation = change.evaluation;
  const interactions = plan.interactions.filter((item) => change.interactionIds.includes(item.id));
  const others = document.tracks.filter((track) => track.id !== change.trackId);
  return (
    <div className="min-w-0 rounded-md border border-line bg-canvas/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm text-ink">
          {name} · {sectionId ? (document.sections.find((item) => item.id === sectionId)?.name ?? "Section") : "Global"} · {PROCESSOR_LABELS[change.processing.type]}
        </h3>
        {change.edited ? (
          <button type="button" className="text-[11px] text-muted underline" onClick={() => useAppStore.getState().setDynamics({ plan: resetDynamicsRecommendation(plan, change.id) })}>
            Reset to planned
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-[11px] text-faint">
        Problem: {PROBLEM_LABELS[change.problem]}. {describeProcessing(change.processing, (id) => trackName(document, id))}.
      </p>
      {evaluation ? <ReductionTimeline change={change} /> : null}
      <ReductionNumbers change={change} />
      <LiveMeter trackId={change.trackId} type={change.processing.type} playback={playback} />
      <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
        <Editor change={change} disabled={disabled} others={others} onEdit={edit} />
      </div>
      {change.processing.type === "dynamic-eq" && change.evidence.detail.kind === "masking" ? <DynamicEqCurve change={change} protectedName={keyOf(change) ? trackName(document, keyOf(change)!) : null} targetName={name} /> : null}
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
          From {interactions.length} {interactions.length === 1 ? "relationship" : "relationships"}: {interactions.map((item) => item.explanation).join(" ")}
        </p>
      ) : null}
    </div>
  );
}

/** Predicted gain reduction over the scope (largest per bucket), with the target band for a compressor. */
function ReductionTimeline({ change }: { change: DynamicsRecommendation }) {
  const evaluation = change.evaluation!;
  const values = evaluation.timeline.values;
  const width = 600;
  const height = 80;
  const top = Math.max(4, ...values, change.targetReductionDb ? change.targetReductionDb.max + 1 : 0);
  const y = (db: number) => 4 + (Math.min(top, Math.max(0, db)) / top) * (height - 16);
  const bar = values.length > 0 ? width / values.length : width;
  const span = evaluation.timeline.hopSeconds * values.length;
  const start = evaluation.timeline.startSeconds;
  const label = change.processing.type === "transient" ? "Change per hit" : change.processing.type === "dynamic-eq" ? "Band dip over time" : "Gain reduction over time";
  if (values.length === 0) return null;
  return (
    <figure className="mt-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={`${label}, predicted`}>
        <rect x={0} y={0} width={width} height={height} className="fill-canvas" />
        {change.targetReductionDb ? (
          <rect x={0} y={y(change.targetReductionDb.min)} width={width} height={Math.max(1, y(change.targetReductionDb.max) - y(change.targetReductionDb.min))} className="fill-accent/15" />
        ) : null}
        {[1, 2, 3, 4, 6].filter((db) => db <= top).map((db) => (
          <g key={db}>
            <line x1={0} x2={width} y1={y(db)} y2={y(db)} className="stroke-line" strokeWidth={0.5} />
            <text x={2} y={y(db) - 1} className="fill-faint text-[8px]">
              −{db}
            </text>
          </g>
        ))}
        {values.map((value, index) => (
          <rect key={index} x={index * bar} y={4} width={Math.max(0.5, bar - 0.2)} height={Math.max(0, y(value) - 4)} className="fill-accent" />
        ))}
        <text x={2} y={height - 2} className="fill-faint text-[8px]">
          {start.toFixed(1)} s
        </text>
        <text x={width - 2} y={height - 2} textAnchor="end" className="fill-faint text-[8px]">
          {(start + span).toFixed(1)} s
        </text>
      </svg>
      <figcaption className="text-[10px] text-faint">
        {label}, predicted from the envelopes (bars hang down from 0 dB{change.targetReductionDb ? "; the shaded band is the target" : ""}).
      </figcaption>
    </figure>
  );
}

function ReductionNumbers({ change }: { change: DynamicsRecommendation }) {
  const evaluation = change.evaluation;
  if (!evaluation) return null;
  const proxy = evaluation.proxy;
  const parts: string[] = [];
  switch (change.processing.type) {
    case "compressor":
      parts.push(
        `Target ${change.targetReductionDb?.min ?? 0}–${change.targetReductionDb?.max ?? 0} dB of reduction on the loudest sustained passages; predicted ${evaluation.reductionP50Db.toFixed(1)} dB typical, ${evaluation.reductionP95Db.toFixed(1)} dB on the loudest, ${evaluation.reductionMaxDb.toFixed(1)} dB at most.`,
        `Sustained-level spread ${evaluation.spreadBeforeDb?.toFixed(1)} → ${evaluation.spreadAfterDb?.toFixed(1)} dB; peak-to-average ${evaluation.crestBeforeDb?.toFixed(1)} → ${evaluation.crestAfterDb?.toFixed(1)} dB; average level ${formatSignedDb(evaluation.levelChangeDb)} dB.`,
      );
      break;
    case "ducking":
      parts.push(
        `Duck ${evaluation.reductionP50Db.toFixed(1)} dB typical, ${evaluation.reductionMaxDb.toFixed(1)} dB at most${evaluation.recovery !== null ? `; back to full level ${Math.round(evaluation.recovery * 100)}% of the time between hits` : ""}.`,
        `Where they meet: ${formatSignedDb(evaluation.conflictBeforeDb ?? 0)} → ${formatSignedDb(evaluation.conflictAfterDb ?? 0)} dB against the key; average level ${formatSignedDb(evaluation.levelChangeDb)} dB${evaluation.outsideChangeDb !== null ? `, ${formatSignedDb(evaluation.outsideChangeDb)} dB between hits` : ""}.`,
      );
      break;
    case "dynamic-eq":
      parts.push(
        `Dip ${evaluation.reductionP50Db.toFixed(1)} dB typical while the key plays, ${evaluation.reductionMaxDb.toFixed(1)} dB at most; ${formatSignedDb(evaluation.outsideChangeDb ?? 0)} dB when it rests.`,
        `Competition for the key's range ${Math.round((evaluation.collisionBefore ?? 0) * 100)}% → ${Math.round((evaluation.collisionAfter ?? 0) * 100)}%.`,
      );
      break;
    case "transient":
      parts.push(
        `Attack over body ${evaluation.transientBeforeDb?.toFixed(1)} → ${evaluation.transientAfterDb?.toFixed(1)} dB; attack against the mix ${formatSignedDb(evaluation.attackOverMixBeforeDb ?? 0)} → ${formatSignedDb(evaluation.attackOverMixAfterDb ?? 0)} dB; average level ${formatSignedDb(evaluation.levelChangeDb)} dB.`,
      );
      break;
  }
  if (proxy) {
    const measured =
      change.processing.type === "transient" && proxy.transientBeforeDb !== null && proxy.transientAfterDb !== null
        ? `attack over body ${proxy.transientBeforeDb.toFixed(1)} → ${proxy.transientAfterDb.toFixed(1)} dB`
        : change.processing.type === "compressor"
          ? `${proxy.reductionP50Db.toFixed(1)} dB typical, ${proxy.reductionP95Db.toFixed(1)} dB on the loudest, spread ${proxy.spreadBeforeDb?.toFixed(1)} → ${proxy.spreadAfterDb?.toFixed(1)} dB`
          : `${proxy.bandOnChangeDb !== null ? `${formatSignedDb(proxy.bandOnChangeDb)} dB while the key plays` : ""}${proxy.bandOffChangeDb !== null ? `, ${formatSignedDb(proxy.bandOffChangeDb)} dB while it rests` : ""}${proxy.recovered !== null ? `, back to full level ${Math.round(proxy.recovered * 100)}% of the time` : ""}`;
    parts.push(
      `Measured on the playback proxy (${proxy.seconds.toFixed(1)} s${change.edited ? ", for the planned values, not this edit" : ""}): ${measured}, average level ${formatSignedDb(proxy.levelChangeDb)} dB${proxy.agrees ? ", matching the prediction" : ", not matching the prediction"}.`,
    );
  }
  return (
    <div className="mt-1 space-y-1 text-[11px] leading-snug text-muted">
      {parts.map((part) => (
        <p key={part}>{part}</p>
      ))}
    </div>
  );
}

/** The actual reduction on this track from the native engine, while playing. */
function LiveMeter({ trackId, type, playback }: { trackId: string; type: DynamicsRecommendation["processing"]["type"]; playback: Playback }) {
  const [reading, setReading] = useState<DynamicsMeterReading | null>(null);
  // The playback object is new on every render; poll through a ref so the interval is not restarted 30 times a second.
  const meter = useRef(playback.dynamicsMeter);
  meter.current = playback.dynamicsMeter;
  const live = playback.playing && playback.engineKind === "native";
  useEffect(() => {
    if (!live) {
      setReading(null);
      return;
    }
    let stopped = false;
    const tick = () => {
      void meter.current().then((all) => {
        if (!stopped) setReading(all.find((item) => item.trackId === trackId) ?? null);
      });
    };
    tick();
    const timer = setInterval(tick, 100);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [live, trackId]);
  if (!reading) return <p className="mt-1 text-[10px] text-faint">Live reduction shows here while the native engine plays.</p>;
  const value = type === "compressor" ? reading.compressorDb : type === "ducking" ? reading.duckingDb : type === "dynamic-eq" ? reading.dynamicEqDb : reading.transientDb;
  const widthPercent = Math.min(100, (value / 6) * 100);
  return (
    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted" aria-live="off">
      <span>Now</span>
      <span className="relative h-2 w-40 rounded bg-canvas">
        <span className="absolute inset-y-0 left-0 rounded bg-accent" style={{ width: `${widthPercent}%` }} />
      </span>
      <span className="font-mono text-ink">
        {type === "transient" ? "±" : "−"}
        {value.toFixed(1)} dB
      </span>
      <span className="text-faint">(what is playing now: Current, Candidate, or this row)</span>
    </div>
  );
}

function Editor({ change, disabled, others, onEdit }: { change: DynamicsRecommendation; disabled: boolean; others: ProjectDocument["tracks"]; onEdit: (patch: DynamicsPatch) => void }) {
  const processing = change.processing;
  switch (processing.type) {
    case "compressor":
      return (
        <>
          <NumberSlider label="Threshold" unit="dB" value={processing.thresholdDb} min={-60} max={0} step={0.5} disabled={disabled} onChange={(value) => onEdit({ thresholdDb: value })} />
          <NumberSlider label="Ratio" unit=":1" value={processing.ratio} min={1} max={8} step={0.1} disabled={disabled} onChange={(value) => onEdit({ ratio: value })} />
          <NumberSlider label="Attack" unit="ms" value={processing.attackMs} min={1} max={120} step={1} disabled={disabled} onChange={(value) => onEdit({ attackMs: value })} />
          <NumberSlider label="Release" unit="ms" value={processing.releaseMs} min={20} max={1_000} step={5} disabled={disabled} onChange={(value) => onEdit({ releaseMs: value })} />
          <NumberSlider label="Knee" unit="dB" value={processing.kneeDb} min={0} max={12} step={0.5} disabled={disabled} onChange={(value) => onEdit({ kneeDb: value })} />
          <NumberSlider label="Makeup" unit="dB" value={processing.makeupDb} min={0} max={6} step={0.5} disabled={disabled} onChange={(value) => onEdit({ makeupDb: value })} />
        </>
      );
    case "ducking":
      return (
        <>
          <KeySelect value={processing.keyTrackId} others={others} allowSelf={false} disabled={disabled} onChange={(value) => onEdit({ keyTrackId: value ?? processing.keyTrackId })} />
          <DetectorSelect value={processing.keyDetector} disabled={disabled} onChange={(value) => onEdit({ keyDetector: value })} />
          <NumberSlider label="Max reduction" unit="dB" value={processing.rangeDb} min={-6} max={0} step={0.1} disabled={disabled} onChange={(value) => onEdit({ rangeDb: value })} />
          <NumberSlider label="Threshold" unit="dB" value={processing.thresholdDb} min={-60} max={0} step={1} disabled={disabled} onChange={(value) => onEdit({ thresholdDb: value })} />
          <NumberSlider label="Attack" unit="ms" value={processing.attackMs} min={1} max={80} step={1} disabled={disabled} onChange={(value) => onEdit({ attackMs: value })} />
          <NumberSlider label="Release" unit="ms" value={processing.releaseMs} min={40} max={600} step={10} disabled={disabled} onChange={(value) => onEdit({ releaseMs: value })} />
        </>
      );
    case "dynamic-eq":
      return (
        <>
          <NumberSlider label="Frequency" unit="Hz" value={processing.filter.frequencyHz} min={40} max={12_000} step={10} log disabled={disabled} onChange={(value) => onEdit({ frequencyHz: value })} />
          <NumberSlider label="Q" unit="" value={processing.filter.q} min={0.5} max={4} step={0.1} disabled={disabled} onChange={(value) => onEdit({ q: value })} />
          <NumberSlider label="Max dip" unit="dB" value={processing.rangeDb} min={-6} max={0} step={0.1} disabled={disabled} onChange={(value) => onEdit({ rangeDb: value })} />
          <KeySelect value={processing.keyTrackId} others={others} allowSelf disabled={disabled} onChange={(value) => onEdit({ keyTrackId: value })} />
          <NumberSlider label="Threshold" unit="dB" value={processing.thresholdDb} min={-60} max={0} step={1} disabled={disabled} onChange={(value) => onEdit({ thresholdDb: value })} />
          <NumberSlider label="Release" unit="ms" value={processing.releaseMs} min={40} max={600} step={10} disabled={disabled} onChange={(value) => onEdit({ releaseMs: value })} />
        </>
      );
    case "transient":
      return (
        <>
          <NumberSlider label="Attack" unit="%" value={Math.round(processing.attack * 100)} min={-30} max={30} step={1} disabled={disabled} onChange={(value) => onEdit({ attack: value / 100 })} />
          <NumberSlider label="Sustain" unit="%" value={Math.round(processing.sustain * 100)} min={-20} max={20} step={1} disabled={disabled} onChange={(value) => onEdit({ sustain: value / 100 })} />
        </>
      );
  }
}

/** The bell at rest (0 dB) and fully dipped, over the target and protected stems' band levels while the key plays. */
function DynamicEqCurve({ change, protectedName, targetName }: { change: DynamicsRecommendation; protectedName: string | null; targetName: string }) {
  if (change.processing.type !== "dynamic-eq" || change.evidence.detail.kind !== "masking") return null;
  const processing = change.processing;
  const detail = change.evidence.detail;
  const width = 600;
  const height = 120;
  const x = (hz: number) => (Math.log(Math.max(20, Math.min(20_000, hz)) / 20) / Math.log(1_000)) * width;
  const keyed = detail.keyActive.map((on, index) => (on ? index : -1)).filter((index) => index >= 0);
  const mean = (rows: number[][]) =>
    Array.from({ length: 24 }, (_, band) => {
      const power = keyed.reduce((total, index) => total + 10 ** ((rows[index]?.[band] ?? -200) / 10), 0) / Math.max(1, keyed.length);
      return 10 * Math.log10(Math.max(power, 1e-20));
    });
  const target = mean(detail.targetBands);
  const protectedBands = mean(detail.protectedBands);
  const top = Math.max(...target, ...protectedBands);
  const levelY = (db: number) => 6 + (Math.min(48, Math.max(0, top - db)) / 48) * (height - 30);
  const curveY = (db: number) => height / 2 - (db / 8) * (height / 2 - 8);
  const centers = detail.edgesHz.slice(0, -1).map((low, band) => Math.sqrt(low * detail.edgesHz[band + 1]!));
  const path = (values: number[], y: (db: number) => number) => values.map((value, band) => `${band === 0 ? "M" : "L"}${x(centers[band]!).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const points = Array.from({ length: 80 }, (_, index) => 20 * 1_000 ** (index / 79));
  const dipped = points.map((hz) => filterMagnitudeDb({ kind: "bell", frequencyHz: processing.filter.frequencyHz, gainDb: processing.rangeDb, q: processing.filter.q }, hz));
  const dippedPath = points.map((hz, index) => `${index === 0 ? "M" : "L"}${x(hz).toFixed(1)},${curveY(dipped[index]!).toFixed(1)}`).join(" ");
  return (
    <figure className="mt-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={`Dynamic EQ on ${targetName}`}>
        <rect x={0} y={0} width={width} height={height} className="fill-canvas" />
        <path d={path(target, levelY)} className="fill-none stroke-muted" strokeWidth={1} />
        {protectedName ? <path d={path(protectedBands, levelY)} className="fill-none stroke-ok" strokeWidth={1} /> : null}
        <line x1={0} x2={width} y1={curveY(0)} y2={curveY(0)} className="stroke-faint" strokeDasharray="3 3" />
        <path d={dippedPath} className="fill-none stroke-accent" strokeWidth={1.5} />
        {[100, 1_000, 10_000].map((hz) => (
          <text key={hz} x={x(hz)} y={height - 2} textAnchor="middle" className="fill-faint text-[8px]">
            {formatHz(hz)}
          </text>
        ))}
      </svg>
      <figcaption className="text-[10px] text-faint">
        Dashed: the bell at rest (0 dB, while {protectedName ?? "its detector"} is quiet). Solid accent: fully dipped. Grey: {targetName}; green: {protectedName ?? "—"} while it plays.
      </figcaption>
    </figure>
  );
}

function KeySelect({ value, others, allowSelf, disabled, onChange }: { value: string | null; others: ProjectDocument["tracks"]; allowSelf: boolean; disabled: boolean; onChange: (value: string | null) => void }) {
  return (
    <label className="flex flex-col gap-1 text-muted">
      <span>Key track</span>
      <select
        aria-label="Key track"
        value={value ?? ""}
        disabled={disabled}
        className="rounded-md border border-line bg-canvas py-1 pr-6 pl-2 text-xs text-ink"
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        {allowSelf ? <option value="">Its own signal</option> : null}
        {others.map((track) => (
          <option key={track.id} value={track.id}>
            {track.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function DetectorSelect({ value, disabled, onChange }: { value: "transient" | "smooth"; disabled: boolean; onChange: (value: "transient" | "smooth") => void }) {
  return (
    <label className="flex flex-col gap-1 text-muted">
      <span>Key follows</span>
      <select aria-label="Key detector" value={value} disabled={disabled} className="rounded-md border border-line bg-canvas py-1 pr-6 pl-2 text-xs text-ink" onChange={(event) => onChange(event.target.value as "transient" | "smooth")}>
        <option value="transient">Hits (fast)</option>
        <option value="smooth">Phrases (smooth)</option>
      </select>
    </label>
  );
}

export function NumberSlider({
  label,
  unit,
  value,
  min,
  max,
  step,
  log = false,
  disabled,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  log?: boolean;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  // A log slider maps 0…1000 onto min…max for frequency.
  const toSlider = (input: number) => (log ? Math.round((Math.log(Math.max(min, Math.min(max, input)) / min) / Math.log(max / min)) * 1_000) : input);
  const fromSlider = (input: number) => (log ? min * (max / min) ** (input / 1_000) : input);
  const shown = unit === "Hz" ? formatHz(value) : `${Number.isInteger(step) ? Math.round(value) : value.toFixed(step < 0.5 ? 1 : 1)}${unit === ":1" ? ":1" : unit ? ` ${unit}` : ""}`;
  return (
    <label className="flex flex-col gap-1 text-muted">
      <span>
        {label} <span className="font-mono text-ink">{shown}</span>
      </span>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={log ? 0 : min}
          max={log ? 1_000 : max}
          step={log ? 1 : step}
          value={toSlider(value)}
          disabled={disabled}
          aria-label={label}
          className="min-w-0 flex-1"
          onChange={(event) => onChange(fromSlider(Number(event.target.value)))}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isInteger(step) ? Math.round(value) : Math.round(value * 10) / 10}
          disabled={disabled}
          aria-label={`${label} value`}
          className="w-20 rounded border border-line bg-canvas px-1 py-0.5 font-mono text-xs text-ink"
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)));
          }}
        />
      </div>
    </label>
  );
}

/** What was read and why nothing was done elsewhere: the relationships and per-stem readings. */
function Relationships({ document, plan }: { document: ProjectDocument; plan: DynamicsPlan }) {
  const flagged = plan.readings.filter((reading) => reading.classification !== "steady");
  if (plan.interactions.length === 0 && flagged.length === 0) return null;
  return (
    <details className="mt-4 max-w-4xl text-xs text-muted">
      <summary className="cursor-pointer text-faint">Relationships and readings ({plan.interactions.length + flagged.length})</summary>
      <ul className="mt-1 space-y-1">
        {plan.interactions.map((item) => (
          <li key={item.id}>
            <span className="text-ink">
              {trackName(document, item.trackA)} → {trackName(document, item.trackB)}
            </span>{" "}
            ({item.scopeName}, {item.kind.replace("-", " ")}, {item.outcome.replace("-", " ")}): {item.explanation}
          </li>
        ))}
        {flagged.map((reading) => (
          <li key={`${reading.trackId}:${reading.scopeName}:${reading.classification}`}>
            <span className="text-ink">{trackName(document, reading.trackId)}</span> ({reading.scopeName}): {reading.explanation}
          </li>
        ))}
      </ul>
    </details>
  );
}

function RowButton({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" title={label} aria-pressed={pressed} className={`rounded px-1.5 py-0.5 text-[11px] ${pressed ? "bg-accent text-accent-ink" : "bg-canvas text-muted"}`} onClick={onClick}>
      {children}
    </button>
  );
}

function updateStatus(id: string, status: DynamicsRecommendation["status"]): void {
  const plan = useAppStore.getState().dynamics.plan;
  if (!plan) return;
  useAppStore.getState().setDynamics({ plan: setDynamicsRecommendationStatus(plan, id, status) });
}

/** Opens the row's detail, selects its track and section, and moves the playhead to where it matters. */
function select(document: ProjectDocument, change: DynamicsRecommendation, playback: Playback): void {
  useAppStore.getState().setDynamics({ selectedId: change.id });
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
