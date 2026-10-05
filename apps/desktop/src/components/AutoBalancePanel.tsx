import {
  editRecommendation,
  formatSignedDb,
  planIsStale,
  recommendationIncluded,
  setRecommendationStatus,
  type BalanceStrength,
  type GainRecommendation,
} from "@audiosous/balance-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { useEffect, useRef } from "react";
import type { usePlayback } from "../lib/playback";
import { applyAutoBalance, autoBalanceScope, cancelAutoBalance, currentAudition, runAutoBalance } from "../lib/autobalance";
import { logEvent } from "../lib/log";
import { getPlatform } from "../platform";
import { useAppStore } from "../state/app-store";
import { Button } from "./ui";

type Playback = ReturnType<typeof usePlayback>;

export function AutoBalancePanel({ document, playback }: { document: ProjectDocument; playback: Playback }) {
  const balance = useAppStore((state) => state.balance);
  const plan = balance.plan;
  const stale = plan ? planIsStale(plan, document, balance.fingerprints, balance.settings) : false;
  const loggedStale = useRef<string | null>(null);
  useEffect(() => {
    if (!plan || !stale || loggedStale.current === plan.stateIdentity) return;
    loggedStale.current = plan.stateIdentity;
    void logEvent(getPlatform(), "info", "autobalance.stale", "AutoBalance plan is out of date.", { projectId: document.project.id });
  }, [plan, stale, document.project.id]);

  if (!balance.open) {
    return (
      <div className="flex items-center gap-3 border-t border-line px-4 py-2">
        <Button title="Plan gain changes from the current analysis" tone="accent" className="px-3 py-1.5 text-xs" onClick={() => void runAutoBalance()}>
          AutoBalance
        </Button>
        <p className="text-xs text-faint">
          Gain-only level plan. It does not change EQ, compression, or the source files. {autoBalanceScope(document)}
        </p>
      </div>
    );
  }

  const audition = plan && balance.phase === "ready" && !stale ? currentAudition(document, balance) : null;
  const accepted = plan?.trackChanges.filter((change) => change.status === "accepted").length ?? 0;
  const busy = balance.phase === "analyzing" || balance.phase === "planning";

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-line bg-panel" aria-label="AutoBalance">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm text-ink">AutoBalance</h2>
        <p className="text-xs text-faint">Balanced</p>
        <label className="flex items-center gap-1 text-xs text-muted">
          Strength
          <select
            aria-label="AutoBalance strength"
            value={balance.settings.strength}
            className="rounded-md border border-line bg-canvas py-1 pr-6 pl-2 text-xs text-ink"
            onChange={(event) =>
              useAppStore.getState().setBalance({
                settings: { style: "balanced", strength: event.target.value as BalanceStrength },
              })
            }
          >
            <option value="conservative">Conservative</option>
            <option value="normal">Normal</option>
            <option value="strong">Strong</option>
          </select>
        </label>
        <Button title="Build a new gain plan from the current project" className="px-3 py-1.5 text-xs" disabled={busy} onClick={() => void runAutoBalance()}>
          {busy ? balance.progress ?? "Working…" : plan ? "Regenerate" : "AutoBalance"}
        </Button>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            title="Hear the saved mix"
            className="px-3 py-1.5 text-xs"
            disabled={!plan || stale}
            tone={!balance.preview ? "accent" : "ghost"}
            onClick={() => useAppStore.getState().setBalance({ preview: false })}
          >
            Current
          </Button>
          <Button
            title="Hear the AutoBalance candidate without saving it"
            className="px-3 py-1.5 text-xs"
            disabled={!plan || stale}
            tone={balance.preview ? "accent" : "ghost"}
            onClick={() => {
              useAppStore.getState().setBalance({ preview: true, auditionId: null });
              useAppStore.getState().setEq({ preview: false, auditionId: null });
              useAppStore.getState().setSpace({ preview: false, auditionId: null });
              useAppStore.getState().setDynamics({ preview: false, auditionId: null });
            }}
          >
            AutoBalance
          </Button>
          <Button title="Write the proposed and accepted changes into the project" className="px-3 py-1.5 text-xs" disabled={!plan || stale || busy} onClick={() => applyAutoBalance("all")}>
            Apply all
          </Button>
          <Button title="Write only the accepted rows into the project" className="px-3 py-1.5 text-xs" disabled={!plan || stale || accepted === 0} onClick={() => applyAutoBalance("accepted")}>
            Apply accepted
          </Button>
          <Button title="Discard this plan and return to the saved mix" className="px-3 py-1.5 text-xs" onClick={() => cancelAutoBalance()}>
            Cancel
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto group-data-[collapsed=true]:hidden px-4 py-3">
        <p className="mb-2 max-w-3xl text-xs text-faint">{autoBalanceScope(document)}</p>
        {balance.progress ? (
          <p className="text-sm text-muted" role="status">
            {balance.progress}
          </p>
        ) : null}
        {balance.error ? <p className="text-sm text-danger">{balance.error}</p> : null}
        {stale ? (
          <p className="mb-2 text-sm text-danger" role="status">
            Plan out of date. Regenerate before applying it.
          </p>
        ) : null}
        {balance.preview && !stale ? (
          <p className="mb-2 text-sm text-muted">Previewing AutoBalance. The saved mix has not changed. Faders still show the saved gain.</p>
        ) : null}
        {plan && balance.phase === "ready" ? (
          <>
            <p className="max-w-3xl text-sm leading-relaxed text-ink">{plan.summary.headline}</p>
            <p className="mt-1 text-xs text-muted">
              Balance anchor: {plan.anchor.label}. {plan.anchor.reason} Overall confidence {Math.round(plan.summary.confidence * 100)}%.
            </p>
            {plan.summary.notes.map((note) => (
              <p key={note} className="mt-1 max-w-3xl text-xs text-muted">
                {note}
              </p>
            ))}
            {audition ? <p className="mt-1 max-w-3xl text-xs text-faint">{audition.note}</p> : null}
            {plan.trackChanges.length === 0 ? <p className="mt-3 text-sm text-muted">No gain changes were recommended.</p> : null}
            {plan.trackChanges.length > 0 ? (
              <table className="mt-3 w-full border-collapse text-left text-xs">
                <thead className="text-[10px] tracking-wide text-faint uppercase">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Track</th>
                    <th className="py-1 pr-3 font-medium">Scope</th>
                    <th className="py-1 pr-3 font-medium">Current</th>
                    <th className="py-1 pr-3 font-medium">Proposed</th>
                    <th className="py-1 pr-3 font-medium">Change</th>
                    <th className="py-1 pr-3 font-medium">Confidence</th>
                    <th className="py-1 font-medium"> </th>
                  </tr>
                </thead>
                <tbody>
                  {plan.trackChanges.map((change) => (
                    <RecommendationRow
                      key={change.id}
                      document={document}
                      change={change}
                      disabled={stale}
                      auditionId={balance.auditionId}
                      auditionSide={balance.auditionSide}
                      onFocus={() => focusRecommendation(document, change, playback)}
                    />
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function RecommendationRow({
  document,
  change,
  disabled,
  auditionId,
  auditionSide,
  onFocus,
}: {
  document: ProjectDocument;
  change: GainRecommendation;
  disabled: boolean;
  auditionId: string | null;
  auditionSide: "original" | "recommended";
  onFocus: () => void;
}) {
  const track = document.tracks.find((item) => item.id === change.trackId);
  const sectionId = change.scope.type === "section" ? change.scope.sectionId : null;
  const section = sectionId ? document.sections.find((item) => item.id === sectionId) : null;
  const included = recommendationIncluded(change, "preview");
  const focused = auditionId === change.id;
  return (
    <tr className={`border-t border-line align-top ${included ? "" : "text-faint"}`}>
      <td className="py-2 pr-3">
        <button type="button" className="text-left text-ink" onClick={onFocus}>
          {track?.name ?? change.trackId}
        </button>
      </td>
      <td className="py-2 pr-3">{change.scope.type === "global" ? "Global" : (section?.name ?? "Section")}</td>
      <td className="py-2 pr-3 font-mono">{formatSignedDb(change.currentGainDb)}</td>
      <td className="py-2 pr-3">
        <input
          type="number"
          step={0.1}
          aria-label={`Proposed gain for ${track?.name ?? change.trackId}`}
          disabled={disabled}
          value={change.recommendedGainDb}
          className="w-20 rounded border border-line bg-canvas px-1 py-0.5 font-mono text-xs"
          onChange={(event) => {
            const value = Number(event.target.value);
            const plan = useAppStore.getState().balance.plan;
            if (!plan || !Number.isFinite(value)) return;
            useAppStore.getState().setBalance({ plan: editRecommendation(plan, change.id, value) });
          }}
        />
      </td>
      <td className="py-2 pr-3 font-mono">{formatSignedDb(change.deltaDb)}</td>
      <td className="py-2 pr-3">
        {change.confidenceLabel} {Math.round(change.confidence * 100)}%
        {change.status === "needs-review" ? " · review" : ""}
        {change.status === "rejected" ? " · rejected" : ""}
        {change.status === "accepted" ? " · accepted" : ""}
      </td>
      <td className="py-2">
        <div className="flex flex-wrap gap-1">
          <RowButton
            label="Accept this recommendation"
            pressed={change.status === "accepted"}
            onClick={() => updateStatus(change.id, change.status === "accepted" ? "proposed" : "accepted")}
          >
            Accept
          </RowButton>
          <RowButton label="Reject this recommendation" pressed={change.status === "rejected"} onClick={() => updateStatus(change.id, "rejected")}>
            Reject
          </RowButton>
          <RowButton label="Hear the saved gain for this stem" pressed={focused && auditionSide === "original"} onClick={() => audition(change.id, "original")}>
            Original
          </RowButton>
          <RowButton label="Hear the recommended gain for this stem" pressed={focused && auditionSide === "recommended"} onClick={() => audition(change.id, "recommended")}>
            Recommended
          </RowButton>
        </div>
        <ul className="mt-1 max-w-md list-disc pl-4 text-[11px] leading-snug text-muted">
          {change.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

function RowButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: string;
}) {
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

function updateStatus(id: string, status: GainRecommendation["status"]): void {
  const plan = useAppStore.getState().balance.plan;
  if (!plan) return;
  useAppStore.getState().setBalance({ plan: setRecommendationStatus(plan, id, status) });
}

function audition(id: string, side: "original" | "recommended"): void {
  const balance = useAppStore.getState().balance;
  const same = balance.auditionId === id && balance.auditionSide === side;
  useAppStore.getState().setBalance(same ? { auditionId: null } : { auditionId: id, auditionSide: side, preview: false });
  if (!same) {
    useAppStore.getState().setEq({ preview: false, auditionId: null });
    useAppStore.getState().setSpace({ preview: false, auditionId: null });
    useAppStore.getState().setDynamics({ preview: false, auditionId: null });
  }
}

function focusRecommendation(document: ProjectDocument, change: GainRecommendation, playback: Playback): void {
  const sectionId = change.scope.type === "section" ? change.scope.sectionId : null;
  const section = sectionId ? document.sections.find((item) => item.id === sectionId) : null;
  useAppStore.getState().replaceDocument(
    {
      ...document,
      uiState: {
        ...document.uiState,
        selectedTrackId: change.trackId,
        selectedSectionId: section?.id ?? document.uiState.selectedSectionId,
        timeRange: section ? { start: section.startTime, end: section.endTime } : document.uiState.timeRange,
        playheadSeconds: section?.startTime ?? document.uiState.playheadSeconds,
      },
    },
    true,
    { mode: "skip" },
  );
  if (section) playback.seek(section.startTime, { log: false });
  const token = useAppStore.getState().balance.focusToken;
  useAppStore.getState().setBalance({ focusToken: token + 1 });
}
