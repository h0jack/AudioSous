import { formatSignedDb } from "@audiosous/balance-planner";
import {
  PROBLEM_LABELS,
  changeIncluded,
  describeChange,
  fullMixPlanIsStale,
  type FullMixPlan,
  type MixChange,
  type MixGoal,
  type MixProblem,
  type MixStrength, currentSpatialOf } from "@audiosous/mix-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDifference } from "../lib/difference";
import { ChangesView } from "./ChangesView";
import {
  applyFullMix,
  auditionFullMix,
  cancelFullMixPlan,
  editFullMixChange,
  fullMixHearing,
  fullMixScope,
  resetFullMixChange,
  runFullMixPlan,
  setFullMixChangeStatus,
  setFullMixPreview,
  setFullMixProblemStatus,
  solutionChanges,
} from "../lib/full-mix";
import { logEvent } from "../lib/log";
import { currentFullMixAudition } from "../lib/monitor";
import type { usePlayback } from "../lib/playback";
import { getPlatform } from "../platform";
import { idleAutoMix, useAppStore, type AutoMixSession, type FullMixSession } from "../state/app-store";
import { AutoMixProgress, RecommendedMixCard } from "./AutoMix";
import { NumberSlider } from "./DynamicsPanel";
import { PlannerStatus } from "./ProcessingStatus";
import { Button } from "./ui";

type Playback = ReturnType<typeof usePlayback>;

const GOAL_LABELS: Record<MixGoal, string> = {
  balanced: "Balanced",
  punchy: "Punchy",
  open: "Open",
  intimate: "Intimate",
  wide: "Wide",
  controlled: "Controlled",
};

const SOURCE_LABELS: Record<MixChange["source"], string> = { level: "Level", eq: "EQ", space: "Space", dynamics: "Dynamics", "full-mix": "Full Mix", reference: "Reference" };

export function FullMixPanel({ document, playback }: { document: ProjectDocument; playback: Playback }) {
  const fullMix = useAppStore((state) => state.fullMix);
  const autoMix = useAppStore((state) => state.autoMix);
  return <FullMixPanelView document={document} playback={playback} fullMix={fullMix} autoMix={autoMix} />;
}

/** The Full Mix session. Reads nothing from the store, so it renders the same in a test. */
export function FullMixPanelView({ document, playback, fullMix, autoMix = idleAutoMix() }: { document: ProjectDocument; playback: Playback; fullMix: FullMixSession; autoMix?: AutoMixSession }) {
  const plan = fullMix.plan;
  const stale = plan ? fullMixPlanIsStale(plan, document, fullMix.fingerprints, fullMix.settings) : false;
  const loggedStale = useRef<string | null>(null);
  const [chosenView, setView] = useState<"changes" | "problems" | null>(null);
  useEffect(() => {
    if (!plan || !stale || loggedStale.current === plan.stateIdentity) return;
    loggedStale.current = plan.stateIdentity;
    void logEvent(getPlatform(), "info", "fullmix.stale", "Full Mix plan is out of date.", { projectId: document.project.id });
  }, [plan, stale, document.project.id]);

  if (!fullMix.open && autoMix.phase === "failed") {
    return (
      <div className="border-t border-line px-4 py-3">
        <AutoMixProgress autoMix={autoMix} />
      </div>
    );
  }

  if (!fullMix.open) {
    return (
      <div className="flex items-center gap-3 border-t border-line px-4 py-2">
        <Button title="Find the mix's problems across level, EQ, space, and dynamics and plan the fewest changes that fix them" tone="accent" className="px-3 py-1.5 text-xs" onClick={() => void runFullMixPlan()}>
          Full Mix
        </Button>
        <p className="text-xs text-faint">
          Full Mix: one coordinated plan across gain, EQ, space, and dynamics, problem by problem, with the fewest changes that measurably help. No mastering or limiting. {fullMixScope(document)}
        </p>
      </div>
    );
  }

  const busy = fullMix.phase === "analyzing" || fullMix.phase === "planning" || fullMix.phase === "checking";
  const ready = Boolean(plan && fullMix.phase === "ready" && !stale);
  const accepted = plan?.changes.filter((change) => change.status === "accepted").length ?? 0;
  const audition = ready ? currentFullMixAudition(document, fullMix) : null;
  const selected = plan?.problems.find((problem) => problem.id === fullMix.selectedProblemId) ?? null;
  const native = playback.engineKind === "native";
  const fromAutoMix = Boolean(plan && autoMix.phase === "ready" && autoMix.planCreatedAt === plan.createdAt && fullMix.phase === "ready");
  // The Recommended Mix opens on what it changes; an expert Full Mix plan opens on its problems.
  const view = chosenView ?? (fromAutoMix ? "changes" : "problems");

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-line bg-panel" aria-label="Full Mix plan">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm text-ink">Full Mix</h2>
        <label className="flex items-center gap-1 text-xs text-muted">
          Strength
          <select
            aria-label="Full Mix strength"
            value={fullMix.settings.strength}
            className="rounded-md border border-line bg-canvas py-1 pr-6 pl-2 text-xs text-ink"
            onChange={(event) => useAppStore.getState().setFullMix({ settings: { ...fullMix.settings, strength: event.target.value as MixStrength } })}
          >
            <option value="conservative">Conservative</option>
            <option value="normal">Normal</option>
            <option value="strong">Strong</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-muted" title="Leans which problems matter most; it never adds processing on its own">
          Goal
          <select
            aria-label="Full Mix goal"
            value={fullMix.settings.goal}
            className="rounded-md border border-line bg-canvas py-1 pr-6 pl-2 text-xs text-ink"
            onChange={(event) => useAppStore.getState().setFullMix({ settings: { ...fullMix.settings, goal: event.target.value as MixGoal } })}
          >
            {Object.entries(GOAL_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button title="Build a new Full Mix plan from the current project" className="px-3 py-1.5 text-xs" disabled={busy} onClick={() => void runFullMixPlan()}>
          {busy ? (fullMix.progress ?? "Working…") : plan ? "Regenerate" : "Plan full mix"}
        </Button>
        {ready ? (
          <span className="text-xs text-accent" role="status" aria-live="polite">
            {fullMixHearing(document, fullMix)}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-muted" title="Play the candidate at the current mix's estimated loudness, so it does not win the A/B by being louder">
            <input type="checkbox" checked={fullMix.loudnessMatch} onChange={(event) => useAppStore.getState().setFullMix({ loudnessMatch: event.target.checked })} />
            Loudness-match A/B
          </label>
          <Button title="Hear the saved mix" className="px-3 py-1.5 text-xs" disabled={!ready} tone={ready && !fullMix.preview && !fullMix.focus ? "accent" : "ghost"} onClick={() => setFullMixPreview(false)}>
            Current
          </Button>
          <Button title="Hear every included change together, without saving" className="px-3 py-1.5 text-xs" disabled={!ready} tone={fullMix.preview && !fullMix.focus ? "accent" : "ghost"} onClick={() => setFullMixPreview(true)}>
            Full Mix Candidate
          </Button>
          <Button title="Write the proposed and accepted changes into the project as one undo step" className="px-3 py-1.5 text-xs" disabled={!ready || busy} onClick={() => applyFullMix("all")}>
            Apply all
          </Button>
          <Button title="Write only the accepted changes" className="px-3 py-1.5 text-xs" disabled={!ready || accepted === 0} onClick={() => applyFullMix("accepted")}>
            Apply accepted
          </Button>
          <Button title="Discard this plan and return to the saved mix" className="px-3 py-1.5 text-xs" onClick={() => cancelFullMixPlan()}>
            Cancel
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3 group-data-[collapsed=true]:hidden">
        {autoMix.phase === "running" ? (
          <div className="mb-3">
            <AutoMixProgress autoMix={autoMix} />
          </div>
        ) : null}
        {fromAutoMix ? (
          <div className="mb-3">
            <RecommendedMixCard autoMix={autoMix} preview={fullMix.preview && !fullMix.focus} stale={stale} disabled={!ready} />
          </div>
        ) : null}
        <p className="mb-2 max-w-3xl text-xs text-faint">{fullMixScope(document)}</p>
        {!native ? <p className="mb-2 max-w-3xl text-xs text-danger">This audio engine does not play dynamics or width. Use the native engine to hear the whole candidate.</p> : null}
        <PlannerStatus kind="full-mix" />
        {fullMix.error ? <p className="mb-2 text-sm text-danger">{fullMix.error}</p> : null}
        {stale ? (
          <p className="mb-2 text-sm text-danger" role="status">
            Plan out of date. Regenerate before applying it.
          </p>
        ) : null}
        {plan && fullMix.phase === "ready" ? (
          <>
            <Summary plan={plan} audition={audition?.note ?? null} />
            <div className="mt-3 flex items-center gap-1" role="tablist" aria-label="Full Mix review">
              {(["problems", "changes"] as const).map((value) => (
                <button key={value} type="button" role="tab" aria-selected={view === value} className={`rounded px-2.5 py-1 text-xs ${view === value ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"}`} onClick={() => setView(value)}>
                  {value === "changes" ? "Changes (Current / Candidate / Difference)" : `Problems (${plan.problems.length})`}
                </button>
              ))}
            </div>
            {view === "changes" ? (
              <div className="mt-3">
                <FullMixChanges document={document} />
              </div>
            ) : plan.problems.length > 0 ? (
              <div className="mt-3 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,680px)]">
                <ul className="flex flex-col gap-2 self-start" aria-label="Problems">
                  {plan.problems.map((problem) => (
                    <ProblemCard key={problem.id} document={document} plan={plan} problem={problem} selected={problem.id === fullMix.selectedProblemId} fullMix={fullMix} disabled={!ready} />
                  ))}
                </ul>
                {selected ? <ProblemDetail document={document} plan={plan} problem={selected} fullMix={fullMix} disabled={!ready} /> : null}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">No significant problem was found. Nothing needs to change.</p>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}

function trackName(document: ProjectDocument, id: string): string {
  const track = document.tracks.find((item) => item.id === id);
  return track?.customLabel ?? track?.name ?? id;
}

function severityLabel(value: number): "High" | "Medium" | "Low" {
  if (value >= 0.7) return "High";
  if (value >= 0.45) return "Medium";
  return "Low";
}

const OUTCOME_LABELS: Record<MixProblem["outcome"], string> = { solved: "Solved", improved: "Improved", unchanged: "Unchanged", "left-alone": "Left alone", deferred: "Deferred" };

function Summary({ plan, audition }: { plan: FullMixPlan; audition: string | null }) {
  const { summary, evaluation } = plan;
  const processing = Object.entries(summary.processing)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${({ gain: "gain", eq: "EQ", space: "spatial", compressor: "compressor", ducking: "ducking", transient: "transient", dynamicEq: "dynamic EQ", trim: "safety trim" } as Record<string, string>)[kind]}`)
    .join(", ");
  const metric = (label: string, before: number | null, after: number | null, unit: string) =>
    before === null || after === null ? null : (
      <tr key={label}>
        <td className="py-0.5 pr-3 text-muted">{label}</td>
        <td className="py-0.5 pr-3 font-mono text-ink">{before.toFixed(2)}</td>
        <td className="py-0.5 pr-3 font-mono text-ink">{after.toFixed(2)}</td>
        <td className="py-0.5 text-faint">{unit}</td>
      </tr>
    );
  return (
    <div>
      <p className="max-w-3xl text-sm leading-relaxed text-ink">{summary.headline}</p>
      {plan.constraints ? <ConstraintLine plan={plan} /> : null}
      {plan.reference ? <p className="mt-1 text-xs text-accent">Planned toward the reference “{plan.reference.name}”. Compare against it in the Reference tab.</p> : null}
      <p className="mt-1 text-xs text-muted" aria-label="Plan summary">
        {summary.problemCount} {summary.problemCount === 1 ? "issue" : "issues"} · {summary.changeCount} selected {summary.changeCount === 1 ? "change" : "changes"} · {summary.rejectedCount} rejected {summary.rejectedCount === 1 ? "alternative" : "alternatives"} · Overall confidence {Math.round(summary.confidence * 100)}%
        {processing ? ` · ${processing}` : ""}
      </p>
      {summary.lines.map((line) => (
        <p key={line} className="mt-0.5 max-w-3xl text-xs text-muted">
          {line}
        </p>
      ))}
      {audition ? <p className="mt-1 max-w-3xl text-xs text-faint">{audition}</p> : null}
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-faint">How it was decided</summary>
        <table className="mt-1 text-left">
          <thead className="text-[10px] tracking-wide text-faint uppercase">
            <tr>
              <th className="pr-3 font-medium">Re-measured</th>
              <th className="pr-3 font-medium">Current</th>
              <th className="pr-3 font-medium">Candidate</th>
              <th className="font-medium" />
            </tr>
          </thead>
          <tbody>
            {metric("Problem score (lower is better; not a quality score)", evaluation.before.problemScore, evaluation.after.problemScore, "")}
            {metric("Open problems", evaluation.before.openProblems, evaluation.after.openProblems, "")}
            {metric("Estimated peak", evaluation.before.estimatedPeakDbfs, evaluation.after.estimatedPeakDbfs, "dBFS (power-sum estimate)")}
            {metric("Mono fold-down loss", evaluation.before.monoLossDb, evaluation.after.monoLossDb, "dB")}
            {metric("Correlation", evaluation.before.correlation, evaluation.after.correlation, "")}
            {metric("Largest gain reduction on one stem", evaluation.before.maxReductionDb, evaluation.after.maxReductionDb, "dB")}
            {metric("Processing cost", evaluation.before.processingCost, evaluation.after.processingCost, "")}
          </tbody>
        </table>
        <p className="mt-1 text-faint">
          Whole-mix candidates of the first pass: {evaluation.candidates.map((item) => `${item.name} (${item.changeCount} changes, score ${item.score.toFixed(2)}${item.chosen ? ", kept" : ""})`).join("; ")}. Passes:{" "}
          {evaluation.passes.map((item) => `${item.pass}. ${item.note}`).join(" ")} {evaluation.stopReason}
        </p>
        {evaluation.regressions.map((item) => (
          <p key={item.description} className="text-faint">
            Regression {item.resolution}: {item.description}
          </p>
        ))}
        {summary.notes.map((note) => (
          <p key={note} className="mt-0.5 max-w-3xl text-muted">
            {note}
          </p>
        ))}
      </details>
    </div>
  );
}

function ProblemCard({ document, plan, problem, selected, fullMix, disabled }: { document: ProjectDocument; plan: FullMixPlan; problem: MixProblem; selected: boolean; fullMix: FullMixSession; disabled: boolean }) {
  const changes = solutionChanges(plan, problem.id).filter((change) => change.problemIds.includes(problem.id));
  const intervention = plan.interventions.find((item) => item.id === problem.interventionId) ?? null;
  const allAccepted = changes.length > 0 && changes.every((change) => change.status === "accepted");
  const allRejected = changes.length > 0 && changes.every((change) => change.status === "rejected");
  const focus = fullMix.focus?.kind === "problem" && fullMix.focus.id === problem.id ? fullMix.focus.side : null;
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        className={`rounded-md border px-3 py-2 text-xs ${selected ? "border-accent bg-canvas" : "border-line hover:border-muted"}`}
        onClick={() => useAppStore.getState().setFullMix({ selectedProblemId: problem.id, selectedChangeId: null })}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") useAppStore.getState().setFullMix({ selectedProblemId: problem.id, selectedChangeId: null });
        }}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm text-ink">{problem.title}</span>
          <span className="text-faint">{PROBLEM_LABELS[problem.type]}</span>
          <span className={problem.severity >= 0.7 ? "text-danger" : "text-muted"}>Severity: {severityLabel(problem.severity)}</span>
          <span className="text-muted">
            {OUTCOME_LABELS[problem.outcome]} ({problem.severity.toFixed(2)} → {(problem.severityAfter ?? problem.severity).toFixed(2)})
          </span>
          {problem.scope.type === "section" ? <span className="text-faint">in {document.sections.find((section) => section.id === (problem.scope as { sectionId: string }).sectionId)?.name}</span> : null}
        </div>
        {intervention ? (
          <p className="mt-1 text-ink">{intervention.label}</p>
        ) : changes.length > 0 ? (
          <p className="mt-1 text-muted">Served by: {changes.map((change) => `${trackName(document, change.trackId)} ${describeChange(change.processing, (id) => trackName(document, id)).toLowerCase()}`).join("; ")}</p>
        ) : (
          <p className="mt-1 text-muted">{problem.explanation}</p>
        )}
        {changes.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1" onClick={(event) => event.stopPropagation()}>
            <RowButton label="Accept every change of this solution" pressed={allAccepted} disabled={disabled} onClick={() => setFullMixProblemStatus(problem.id, "accepted")}>
              Accept solution
            </RowButton>
            <RowButton label="Reject every change of this solution" pressed={allRejected} disabled={disabled} onClick={() => setFullMixProblemStatus(problem.id, "rejected")}>
              Reject solution
            </RowButton>
            <RowButton label="Hear the saved mix with only this solution" pressed={focus === "only"} disabled={disabled} onClick={() => auditionFullMix({ kind: "problem", id: problem.id, side: "only" })}>
              Only this fix
            </RowButton>
            <RowButton label="Hear the whole candidate without this solution" pressed={focus === "without"} disabled={disabled} onClick={() => auditionFullMix({ kind: "problem", id: problem.id, side: "without" })}>
              Candidate without it
            </RowButton>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function ProblemDetail({ document, plan, problem, fullMix, disabled }: { document: ProjectDocument; plan: FullMixPlan; problem: MixProblem; fullMix: FullMixSession; disabled: boolean }) {
  const names = (id: string) => trackName(document, id);
  const alternatives = plan.interventions.filter((item) => item.problemIds.includes(problem.id));
  const changes = plan.changes.filter((change) => change.problemIds.includes(problem.id));
  const editing = plan.changes.find((change) => change.id === fullMix.selectedChangeId) ?? null;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-3 text-xs" aria-label="Problem detail">
      <div>
        <p className="text-sm text-ink">{problem.title}</p>
        <p className="mt-1 text-muted">{problem.explanation}</p>
        <p className="mt-1 text-faint">
          Severity {problem.severity.toFixed(2)}, confidence {Math.round(problem.confidence * 100)}%, {problem.trackIds.map(names).join(" and ")}
          {problem.sectionIds.length > 0 ? `, measured in ${problem.sectionIds.map((id) => document.sections.find((section) => section.id === id)?.name ?? id).join(", ")}` : ""}.
        </p>
      </div>
      <div>
        <p className="text-[10px] tracking-wide text-faint uppercase">Evidence</p>
        <ul className="mt-1 flex flex-col gap-1">
          {problem.evidence.map((item) => (
            <li key={`${item.source}:${item.label}`} className="text-muted">
              <span className="text-ink">{item.label}</span> ({SOURCE_LABELS[item.source]}): {item.detail}
            </li>
          ))}
        </ul>
      </div>
      {alternatives.length > 0 ? (
        <div>
          <p className="text-[10px] tracking-wide text-faint uppercase">Considered</p>
          <ul className="mt-1 flex flex-col gap-1">
            {alternatives.map((item) => (
              <li key={item.id} className={item.outcome === "selected" ? "text-ink" : "text-muted"}>
                {item.outcome === "selected" ? "Selected: " : item.outcome === "redundant" ? "Redundant: " : item.outcome === "regression" ? "Regressed: " : "Rejected: "}
                {item.label} — removes about {Math.round(item.expectedReduction * 100)}% for cost {item.cost.toFixed(2)}. {item.outcome === "selected" ? item.reason : item.reason.replace(/^Rejected: /, "")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {changes.length > 0 ? (
        <div>
          <p className="text-[10px] tracking-wide text-faint uppercase">Recommended changes</p>
          <table className="mt-1 w-full border-collapse text-left">
            <tbody>
              {changes.map((change) => (
                <ChangeRow key={change.id} document={document} change={change} fullMix={fullMix} disabled={disabled} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editing && changes.some((change) => change.id === editing.id) ? <ChangeEditor document={document} change={editing} disabled={disabled} /> : null}
    </div>
  );
}

function ChangeRow({ document, change, fullMix, disabled }: { document: ProjectDocument; change: MixChange; fullMix: FullMixSession; disabled: boolean }) {
  const names = (id: string) => trackName(document, id);
  const section = change.scope.type === "section" ? document.sections.find((item) => item.id === (change.scope as { sectionId: string }).sectionId)?.name : null;
  const focus = fullMix.focus?.kind === "change" && fullMix.focus.id === change.id ? fullMix.focus.side : null;
  const current = currentSpatialOf(change);
  return (
    <tr className="border-t border-line align-top">
      <td className="py-1 pr-2 text-ink">{change.processing.type === "trim" ? "Every stem" : names(change.trackId)}</td>
      <td className="py-1 pr-2 text-muted">{section ?? "Global"}</td>
      <td className="py-1 pr-2 text-ink">
        {describeChange(change.processing, names, current)}
        <span className="block text-faint">
          from {SOURCE_LABELS[change.source]} · confidence {Math.round(change.confidence * 100)}% · now: {change.current}
          {change.edited ? " · edited" : ""}
        </span>
        {change.evaluation.summary ? <span className="block text-faint">{change.evaluation.summary}</span> : null}
        {change.warnings.map((warning) => (
          <span key={warning} className="block text-danger">
            {warning}
          </span>
        ))}
      </td>
      <td className="py-1 pr-2 text-muted">{change.status === "needs-review" ? "Needs review" : change.status === "accepted" ? "Accepted" : change.status === "rejected" ? "Rejected" : changeIncluded(change, "preview") ? "Proposed" : "—"}</td>
      <td className="py-1">
        <div className="flex flex-wrap gap-1">
          <RowButton label="Accept this change" pressed={change.status === "accepted"} disabled={disabled} onClick={() => setFullMixChangeStatus(change.id, change.status === "accepted" ? "proposed" : "accepted")}>
            Accept
          </RowButton>
          <RowButton label="Reject this change" pressed={change.status === "rejected"} disabled={disabled} onClick={() => setFullMixChangeStatus(change.id, change.status === "rejected" ? "proposed" : "rejected")}>
            Reject
          </RowButton>
          <RowButton label="Edit this change" pressed={fullMix.selectedChangeId === change.id} disabled={disabled || change.processing.type === "trim"} onClick={() => useAppStore.getState().setFullMix({ selectedChangeId: fullMix.selectedChangeId === change.id ? null : change.id })}>
            Edit
          </RowButton>
          <RowButton label="Hear the saved mix with only this change" pressed={focus === "only"} disabled={disabled} onClick={() => auditionFullMix({ kind: "change", id: change.id, side: "only" })}>
            Only this
          </RowButton>
          <RowButton label="Hear the whole candidate without this change" pressed={focus === "without"} disabled={disabled} onClick={() => auditionFullMix({ kind: "change", id: change.id, side: "without" })}>
            Without
          </RowButton>
        </div>
      </td>
    </tr>
  );
}

/** The controls the four planners' own editors use, with their bounds. An edit is re-checked and heard at once. */
function ChangeEditor({ document, change, disabled }: { document: ProjectDocument; change: MixChange; disabled: boolean }) {
  const processing = change.processing;
  const edit = (patch: Parameters<typeof editFullMixChange>[1]) => editFullMixChange(change.id, patch);
  let body: ReactNode = null;
  if (processing.type === "gain") {
    body = <NumberSlider label="Gain" unit="dB" value={processing.gainDb} min={-24} max={12} step={0.1} disabled={disabled} onChange={(value) => edit({ gainDb: value })} />;
  } else if (processing.type === "eq") {
    body = (
      <>
        <NumberSlider label="Frequency" unit="Hz" value={processing.filter.frequencyHz} min={20} max={20_000} step={1} log disabled={disabled} onChange={(value) => edit({ frequencyHz: value })} />
        {processing.filter.kind === "high-pass" || processing.filter.kind === "low-pass" ? null : <NumberSlider label="Gain" unit="dB" value={processing.filter.gainDb} min={-12} max={6} step={0.1} disabled={disabled} onChange={(value) => edit({ gainDb: value })} />}
        <NumberSlider label="Q" unit="" value={processing.filter.q} min={0.3} max={6} step={0.1} disabled={disabled} onChange={(value) => edit({ q: value })} />
      </>
    );
  } else if (processing.type === "spatial") {
    body = (
      <>
        {processing.pan !== null ? <NumberSlider label="Pan / balance" unit="" value={processing.pan} min={-1} max={1} step={0.01} disabled={disabled} onChange={(value) => edit({ pan: value })} /> : null}
        {processing.width !== null ? <NumberSlider label="Width" unit="%" value={processing.width * 100} min={0} max={200} step={1} disabled={disabled} onChange={(value) => edit({ width: value / 100 })} /> : null}
      </>
    );
  } else if (processing.type === "dynamics") {
    const node = processing.processing;
    if (node.type === "compressor") {
      body = (
        <>
          <NumberSlider label="Threshold" unit="dB" value={node.thresholdDb} min={-60} max={0} step={0.5} disabled={disabled} onChange={(value) => edit({ thresholdDb: value })} />
          <NumberSlider label="Ratio" unit=":1" value={node.ratio} min={1} max={10} step={0.1} disabled={disabled} onChange={(value) => edit({ ratio: value })} />
          <NumberSlider label="Attack" unit="ms" value={node.attackMs} min={0.1} max={200} step={1} disabled={disabled} onChange={(value) => edit({ attackMs: value })} />
          <NumberSlider label="Release" unit="ms" value={node.releaseMs} min={10} max={2_000} step={5} disabled={disabled} onChange={(value) => edit({ releaseMs: value })} />
        </>
      );
    } else if (node.type === "ducking" || node.type === "dynamic-eq") {
      body = (
        <>
          {node.type === "dynamic-eq" ? <NumberSlider label="Frequency" unit="Hz" value={node.filter.frequencyHz} min={20} max={20_000} step={1} log disabled={disabled} onChange={(value) => edit({ frequencyHz: value })} /> : null}
          <NumberSlider label="Maximum reduction" unit="dB" value={node.rangeDb} min={-12} max={-0.5} step={0.1} disabled={disabled} onChange={(value) => edit({ rangeDb: value })} />
          <NumberSlider label="Threshold" unit="dB" value={node.thresholdDb} min={-60} max={0} step={0.5} disabled={disabled} onChange={(value) => edit({ thresholdDb: value })} />
          <NumberSlider label="Release" unit="ms" value={node.releaseMs} min={10} max={2_000} step={5} disabled={disabled} onChange={(value) => edit({ releaseMs: value })} />
        </>
      );
    } else {
      body = (
        <>
          <NumberSlider label="Attack" unit="%" value={node.attack * 100} min={-50} max={50} step={1} disabled={disabled} onChange={(value) => edit({ attack: value / 100 })} />
          <NumberSlider label="Sustain" unit="%" value={node.sustain * 100} min={-50} max={50} step={1} disabled={disabled} onChange={(value) => edit({ sustain: value / 100 })} />
        </>
      );
    }
  }
  return (
    <div className="rounded border border-line p-2" aria-label="Edit change">
      <p className="mb-1 text-muted">
        Edit {trackName(document, change.trackId)}: {describeChange(change.processing, (id) => trackName(document, id))}. Re-checked from its evidence; safety, headroom, and gain reduction are re-read. The plan is not run again.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">{body}</div>
      <div className="mt-1">
        <RowButton label="Return to the planned value" disabled={disabled || !change.edited} onClick={() => resetFullMixChange(change.id)}>
          Reset
        </RowButton>
        {change.evaluation.summary ? <span className="ml-2 text-faint">{change.evaluation.summary}</span> : null}
        {change.warnings.length === 0 ? <span className="ml-2 text-faint">{formatSignedDb(change.evaluation.levelChangeDb)} dB average level on this stem.</span> : null}
      </div>
    </div>
  );
}

function RowButton({ label, pressed, disabled, onClick, children }: { label: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={`rounded border px-1.5 py-0.5 text-[11px] disabled:opacity-40 ${pressed ? "border-accent text-accent" : "border-line text-muted hover:text-ink"}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** What a request narrowed (an assistant plan): shown so the review and the conversation say the same thing. */
function ConstraintLine({ plan }: { plan: FullMixPlan }) {
  const document = useAppStore((state) => state.document);
  const constraints = plan.constraints;
  if (!constraints || !document) return null;
  const name = (id: string) => document.tracks.find((track) => track.id === id)?.customLabel ?? document.tracks.find((track) => track.id === id)?.name ?? id;
  const section = (id: string) => document.sections.find((item) => item.id === id)?.name ?? id;
  const parts = [
    constraints.protectedTrackIds.length ? `${constraints.protectedTrackIds.map(name).join(", ")} untouched` : null,
    constraints.excludedDomains.length ? `no ${constraints.excludedDomains.join(", ")} changes` : null,
    constraints.excludedProcessors.length ? `no ${constraints.excludedProcessors.join(", ")}` : null,
    constraints.sectionIds ? `only in ${constraints.sectionIds.map(section).join(", ")}` : null,
    constraints.focusTrackIds.length ? `about ${constraints.focusTrackIds.map(name).join(", ")}` : null,
    constraints.focusSectionIds.length && !constraints.sectionIds ? `focused on ${constraints.focusSectionIds.map(section).join(", ")}` : null,
  ].filter(Boolean);
  return <p className="mt-1 text-xs text-accent">Planned for an assistant request: {parts.join(" · ")}.</p>;
}

/** The Full Mix (or Recommended Mix) candidate as changes: what, where, how much, and when. */
function FullMixChanges({ document }: { document: ProjectDocument }) {
  const active = useDifference("full", document);
  if (!active) return <p className="text-xs text-muted">The changes are drawn when the plan is ready and current.</p>;
  return <ChangesView document={document} diff={active.diff} label={active.label} />;
}
