import { describePan, formatHz, recommendationImages, type SpatialInteraction, type SpatialPlan } from "@audiosous/spatial-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { useMemo, useState } from "react";
import { runSpacePlan, spacePlanFresh } from "../lib/space";
import { useAppStore, type SpaceSession } from "../state/app-store";
import { CorrelationMeter, StereoField } from "./StereoField";
import { Button } from "./ui";

const OUTCOME_LABEL: Record<SpatialInteraction["outcome"], string> = {
  recommendation: "Space planned",
  review: "Needs review",
  "below-threshold": "Below threshold",
  anchors: "Kept centered",
  "no-priority": "No clear priority",
  level: "Level, not space",
  eq: "EQ suits this better",
  "no-benefit": "No move helps enough",
  intent: "From a note",
};

/** Same layout as Frequency interaction: pairs on the left, the selected pair's place in the field and its numbers on the right. */
export function SpatialInteractionView({ document, onSeek }: { document: ProjectDocument; onSeek: (seconds: number) => void }) {
  const space = useAppStore((state) => state.space);
  return <SpatialInteractionPanel document={document} onSeek={onSeek} space={space} />;
}

/** The view for one Space session. Reads nothing from the store, so it renders the same in a test. */
export function SpatialInteractionPanel({ document, onSeek, space }: { document: ProjectDocument; onSeek: (seconds: number) => void; space: SpaceSession }) {
  const fresh = spacePlanFresh(document, space);
  const plan = space.plan;
  const [scope, setScope] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = useMemo(() => {
    if (!plan) return [];
    return plan.interactions.filter((item) => scope === "all" || (scope === "song" ? item.scope.type === "global" : item.scope.type === "section" && item.scope.sectionId === scope));
  }, [plan, scope]);
  const selected = rows.find((item) => item.id === selectedId) ?? rows[0] ?? null;
  const busy = space.phase === "analyzing" || space.phase === "planning" || space.phase === "verifying";

  if (!plan || space.phase !== "ready") {
    return (
      <div className="max-w-2xl px-6 py-5">
        <h2 className="font-display text-3xl">Spatial interaction</h2>
        <p className="mt-2 text-sm text-muted">
          Shows which stems compete for the same frequencies while they also sit in the same place in the stereo field, where each one sits and how wide it is, and which one should move. It comes from the Space analysis.
          Recommendations appear under Mix → Plans → Space.
        </p>
        {space.error ? <p className="mt-2 text-sm text-danger">{space.error}</p> : null}
        <Button className="mt-4" tone="accent" disabled={busy} onClick={() => void runSpacePlan()}>
          {busy ? (space.progress ?? "Working…") : "Find spatial interactions"}
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
          <Button className="px-2 py-1 text-[11px]" disabled={busy} title="Analyze again" onClick={() => void runSpacePlan()}>
            {busy ? "…" : "Refresh"}
          </Button>
        </div>
        {!fresh ? <p className="px-3 py-2 text-xs text-danger">The project changed since this analysis. Refresh before relying on it.</p> : null}
        <ul className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 ? <li className="px-3 py-3 text-xs text-muted">No pair shares enough of the field and spectrum to show here.</li> : null}
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
                  {item.scopeName} · {OUTCOME_LABEL[item.outcome]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto px-6 py-5" aria-label="Selected spatial interaction">
        {selected ? <Detail document={document} plan={plan} item={selected} onSeek={onSeek} /> : null}
      </section>
    </div>
  );
}

function Detail({ document, plan, item, onSeek }: { document: ProjectDocument; plan: SpatialPlan; item: SpatialInteraction; onSeek: (seconds: number) => void }) {
  const name = (id: string | null) => (id ? (document.tracks.find((track) => track.id === id)?.name ?? id) : "");
  const recommendation = plan.changes.find((change) => change.interactionIds.includes(item.id));
  const moving = recommendation ? recommendationImages(recommendation) : null;
  const tier = (value: string) => (value === "unknown" ? "unlabeled" : value);
  const stems = [
    { trackId: item.trackA, name: name(item.trackA), image: item.imageA, levelDb: 0, tier: item.tierA, mono: false },
    { trackId: item.trackB, name: name(item.trackB), image: item.imageB, levelDb: 0, tier: item.tierB, mono: false },
  ];
  const window = recommendation?.evidence.windows[0];
  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-3xl">
        {name(item.trackA)} ↔ {name(item.trackB)}
      </h2>
      <p className="mt-1 text-sm text-muted">
        {item.scopeName} · {OUTCOME_LABEL[item.outcome]}
      </p>
      <div className="mt-4">
        <StereoField
          stems={stems}
          moving={
            recommendation && moving && (recommendation.trackId === item.trackA || recommendation.trackId === item.trackB)
              ? { trackId: recommendation.trackId, before: moving.before, after: moving.after, pan: recommendation.processing.pan ?? recommendation.current.pan, width: recommendation.processing.width ?? recommendation.current.width, canWiden: true }
              : null
          }
          label={`Where ${name(item.trackA)} and ${name(item.trackB)} sit where they compete`}
        />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <Stat label="Spatial conflict" value={item.severity.toFixed(2)} note="Frequency × field overlap × activity, 0 to 1" />
        <Stat label="Frequency competition" value={`${Math.round(item.frequencyOverlap * 100)}%`} note={`${formatHz(item.lowHz)} – ${formatHz(item.highHz)}, as heard with saved EQ`} />
        <Stat label="Overlap in the field" value={item.stereoOverlap.toFixed(2)} note="Where they compete" />
        <Stat label="Center competition" value={item.centerCompetition.toFixed(2)} note={item.centerCompetition > 0.6 ? "Both in the middle" : "Not both in the middle"} />
        <Stat label="Play together" value={`${Math.round(item.simultaneousActivity * 100)}%`} note="Of the sparser part's active time" />
        <Stat label="Confidence" value={`${Math.round(item.confidence * 100)}%`} />
        <Stat
          label="Priority"
          value={item.protectedTrackId ? `${name(item.protectedTrackId)} stays` : "No clear lead"}
          note={`${name(item.trackA)} ${tier(item.tierA)}, ${name(item.trackB)} ${tier(item.tierB)}`}
        />
        {item.movingTrackId ? <Stat label="Level" value={`${item.levelGapDb >= 0 ? "+" : ""}${item.levelGapDb.toFixed(1)} dB`} note={`${name(item.movingTrackId)} vs ${name(item.protectedTrackId)}`} /> : null}
      </dl>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ImageFacts name={name(item.trackA)} image={item.imageA} />
        <ImageFacts name={name(item.trackB)} image={item.imageB} />
      </div>
      <p className="mt-4 text-sm leading-relaxed text-ink">{item.explanation}</p>
      {recommendation ? (
        <p className="mt-2 text-xs text-muted">
          Proposed: {recommendation.reasons[0]}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {window ? (
          <Button className="px-3 py-1.5 text-xs" title="Move the playhead to where both parts play" onClick={() => onSeek(window[0])}>
            Go to where they overlap
          </Button>
        ) : null}
        {recommendation ? (
          <Button
            className="px-3 py-1.5 text-xs"
            title="Show this change in the Space plan"
            onClick={() => {
              useAppStore.getState().setSpace({ selectedId: recommendation.id });
              useAppStore.getState().setPlanTab("space");
              useAppStore.getState().setWorkspace("mix");
            }}
          >
            Open in Space plan
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ImageFacts({ name, image }: { name: string; image: SpatialInteraction["imageA"] }) {
  return (
    <div className="rounded-md border border-line p-3 text-xs">
      <p className="text-sm text-ink">{name}</p>
      <p className="mt-1 text-muted">
        Sits {describePan(image.position)}, image {image.spread < 0.08 ? "narrow (a point)" : image.spread < 0.5 ? `about ${Math.round(image.spread * 100)}% wide` : "wide"}.
      </p>
      <div className="mt-1">
        <CorrelationMeter value={image.correlation} label={`${name} correlation`} />
      </div>
      <p className="mt-1 text-faint">
        Side {image.msRatioDb.toFixed(1)} dB against mid. Folded to mono it loses {image.monoLossDb.toFixed(1)} dB.
      </p>
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
