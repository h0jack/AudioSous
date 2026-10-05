import { formatHz, type EqPlan, type TrackInteraction } from "@audiosous/eq-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { useMemo, useState } from "react";
import { eqPlanFresh, runEqPlan } from "../lib/eq";
import { useAppStore } from "../state/app-store";
import { EqCurve } from "./EqCurve";
import { Button } from "./ui";

const KIND_LABEL: Record<TrackInteraction["kind"], string> = {
  "kick-bass": "Kick / Bass",
  "lead-support": "Lead / supporting",
  hierarchy: "Different priority",
  equal: "Same priority",
  layered: "Layered parts",
  "low-end": "Low end",
  intent: "Note",
  presence: "Presence",
};

const OUTCOME_LABEL: Record<TrackInteraction["outcome"], string> = {
  recommendation: "EQ planned",
  review: "Needs review",
  ambiguous: "No clear priority",
  "below-threshold": "Below threshold",
  layered: "Left as layered",
  "no-benefit": "Filter would not help",
  level: "Level, not EQ",
};

export function FrequencyInteractionView({ document, onSeek }: { document: ProjectDocument; onSeek: (seconds: number) => void }) {
  const eq = useAppStore((state) => state.eq);
  const fresh = eqPlanFresh(document, eq);
  const plan = eq.plan;
  const [scope, setScope] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = useMemo(() => {
    if (!plan) return [];
    return plan.interactions.filter((item) => scope === "all" || (scope === "song" ? item.scope.type === "global" : item.scope.type === "section" && item.scope.sectionId === scope));
  }, [plan, scope]);
  const selected = rows.find((item) => item.id === selectedId) ?? rows[0] ?? null;
  const busy = eq.phase === "analyzing" || eq.phase === "planning" || eq.phase === "verifying";

  if (!plan || eq.phase !== "ready") {
    return (
      <div className="max-w-2xl px-6 py-5">
        <h2 className="font-display text-3xl">Frequency interaction</h2>
        <p className="mt-2 text-sm text-muted">
          Shows which stems compete for the same frequencies while they play together, where, and which one should give way. It comes from the EQ analysis. Recommendations appear under Mix → Plans → EQ.
        </p>
        {eq.error ? <p className="mt-2 text-sm text-danger">{eq.error}</p> : null}
        <Button className="mt-4" tone="accent" disabled={busy} onClick={() => void runEqPlan()}>
          {busy ? (eq.progress ?? "Working…") : "Find interactions"}
        </Button>
      </div>
    );
  }

  const name = (id: string | null) => (id ? (document.tracks.find((track) => track.id === id)?.name ?? id) : "");
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-80 shrink-0 flex-col border-r border-line">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <label className="flex flex-1 items-center gap-2 text-xs text-muted">
            Scope
            <select aria-label="Interaction scope" value={scope} className="min-w-0 flex-1 rounded border border-line bg-canvas py-1 pr-6 pl-2 text-xs text-ink" onChange={(event) => setScope(event.target.value)}>
              <option value="all">Everything</option>
              <option value="song">Whole song</option>
              {document.sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.name}
                </option>
              ))}
            </select>
          </label>
          <Button className="px-2 py-1 text-[11px]" disabled={busy} title="Analyze again" onClick={() => void runEqPlan()}>
            {busy ? "…" : "Refresh"}
          </Button>
        </div>
        {!fresh ? <p className="px-3 py-2 text-xs text-danger">The project changed since this analysis. Refresh before relying on it.</p> : null}
        <ul className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 ? <li className="px-3 py-3 text-xs text-muted">No pair competes enough to show here.</li> : null}
          {rows.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={item.id === selected?.id}
                className={`block w-full border-b border-line px-3 py-2 text-left ${item.id === selected?.id ? "bg-panel-2" : "hover:bg-panel"}`}
                onClick={() => setSelectedId(item.id)}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm text-ink">
                    {name(item.trackA)} ↔ {name(item.trackB)}
                  </span>
                  <span className="font-mono text-[11px] text-muted">{item.severity.toFixed(2)}</span>
                </span>
                <span className="mt-1 block h-1 overflow-hidden rounded bg-panel-2">
                  <span className="block h-1 rounded bg-accent" style={{ width: `${Math.round(item.severity * 100)}%` }} />
                </span>
                <span className="mt-1 block truncate text-[11px] text-faint">
                  {item.scopeName} · {KIND_LABEL[item.kind]} · {OUTCOME_LABEL[item.outcome]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto px-6 py-5" aria-label="Selected interaction">
        {selected ? <InteractionDetail document={document} plan={plan} item={selected} onSeek={onSeek} /> : null}
      </section>
    </div>
  );
}

function InteractionDetail({ document, plan, item, onSeek }: { document: ProjectDocument; plan: EqPlan; item: TrackInteraction; onSeek: (seconds: number) => void }) {
  const name = (id: string | null) => (id ? (document.tracks.find((track) => track.id === id)?.name ?? id) : "");
  const recommendation = plan.changes.find((change) => change.interactionIds.includes(item.id));
  const victim = item.protectedTrackId ?? (item.regions.length > 0 ? null : item.trackA);
  const masker = item.yieldingTrackId;
  const targetName = masker ? name(masker) : name(item.trackB);
  const referenceName = victim ? name(victim) : name(item.trackA);
  const region = item.regions[0];
  const firstWindow = item.evidence.windows[0];
  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-3xl">
        {name(item.trackA)} ↔ {name(item.trackB)}
      </h2>
      <p className="mt-1 text-sm text-muted">
        {item.scopeName} · {KIND_LABEL[item.kind]} · {OUTCOME_LABEL[item.outcome]}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <Stat label="Competition score" value={item.severity.toFixed(2)} note="Heuristic, 0 to 1" />
        <Stat label="Plain band overlap" value={`${Math.round(item.overlap * 100)}%`} note="Shared spectrum, ignoring level" />
        <Stat label="Play together" value={`${Math.round(item.simultaneousActivity * 100)}%`} note="Of the sparser part's active time" />
        <Stat label="Coverage" value={`${Math.round(item.coverage * 100)}%`} note={`Of ${item.scopeName === "Whole song" ? "the song" : item.scopeName}`} />
        <Stat label="Stereo separation" value={item.stereoSeparation.toFixed(2)} note={item.stereoSeparation > 0.3 ? "Apart, so less concern" : "Both near the center"} />
        <Stat label="Confidence" value={`${Math.round(item.confidence * 100)}%`} />
        <Stat
          label="Priority"
          value={item.protectedTrackId ? `${name(item.protectedTrackId)} leads` : "No clear lead"}
          note={`${name(item.trackA)} ${item.tierA}, ${name(item.trackB)} ${item.tierB}`}
        />
        {region ? <Stat label="Conflict range" value={`${formatHz(region.lowHz)} – ${formatHz(region.highHz)}`} note={`${targetName} ${region.levelDifferenceDb >= 0 ? "+" : ""}${region.levelDifferenceDb.toFixed(1)} dB vs ${referenceName}`} /> : null}
        {region ? <Stat label="Persistence" value={`${Math.round(region.persistence * 100)}%`} note="Of the shared time it stays within 6 dB" /> : null}
      </dl>
      <p className="mt-4 text-sm leading-relaxed text-ink">{item.explanation}</p>
      <div className="mt-4">
        <EqCurve
          evidence={item.evidence}
          filter={recommendation && recommendation.trackId === masker ? recommendation.processing.filter : null}
          targetName={targetName}
          referenceName={referenceName}
          label={`Spectra of ${targetName} and ${referenceName} while both play`}
        />
      </div>
      {recommendation ? (
        <p className="mt-2 text-xs text-muted">
          Proposed: {name(recommendation.trackId)}, {recommendation.reasons[0]}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {firstWindow ? (
          <Button className="px-3 py-1.5 text-xs" title="Move the playhead to where both parts play" onClick={() => onSeek(firstWindow[0])}>
            Go to where they overlap
          </Button>
        ) : null}
        {recommendation ? (
          <Button
            className="px-3 py-1.5 text-xs"
            title="Show this filter in the EQ plan"
            onClick={() => {
              useAppStore.getState().setEq({ selectedId: recommendation.id });
              useAppStore.getState().setPlanTab("eq");
              useAppStore.getState().setWorkspace("mix");
            }}
          >
            Open in EQ plan
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-[10px] tracking-wide text-faint uppercase">{label}</dt>
      <dd className="text-ink">{value}</dd>
      {note ? <dd className="text-[11px] text-faint">{note}</dd> : null}
    </div>
  );
}
