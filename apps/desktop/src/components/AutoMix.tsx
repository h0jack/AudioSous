import type { MixStrength } from "@audiosous/mix-planner";
import { useEffect, useRef, useState } from "react";
import { applyAutoMix, autoMixAvailability, autoMixButtonState, autoMixSummaryLines, cancelAutoMix, discardAutoMix, runAutoMix } from "../lib/auto-mix";
import { setFullMixPreview } from "../lib/full-mix";
import { useAppStore, type AutoMixSession, type AutoMixStage } from "../state/app-store";
import { HoverTip } from "./ui";

const STRENGTHS: Array<{ value: MixStrength; label: string; note: string }> = [
  { value: "conservative", label: "Conservative", note: "Only clear-cut problems, the fewest changes" },
  { value: "normal", label: "Normal", note: "The default balance of benefit and processing" },
  { value: "strong", label: "Strong", note: "Acts on more problems, still only where it measurably helps" },
];

/**
 * The primary action: build one coordinated, verified Recommended Mix from the saved project. Shows what it is
 * doing, when its candidate is ready, and when the mix changed under it. Strength is the Full Mix strength.
 */
export function AutoMixButton({ disabled = false }: { disabled?: boolean }) {
  const autoMix = useAppStore((store) => store.autoMix);
  const fullMix = useAppStore((store) => store.fullMix);
  const document = useAppStore((store) => store.document);
  useAppStore((store) => store.tasks);
  useAppStore((store) => store.assistant.busy);
  const state = { autoMix, fullMix, document };
  const strength = useAppStore((store) => store.fullMix.settings.strength);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);
  const phase = autoMixButtonState(state);
  const available = autoMixAvailability();
  const running = phase === "running";
  const stage = state.autoMix.stages.findIndex((item) => item.status === "running");
  const label = running ? `Building mix… ${stage >= 0 ? `${stage + 1}/${state.autoMix.stages.length}` : ""}` : phase === "ready" ? "Recommended Mix ready" : phase === "stale" ? "Mix changed — Rebuild" : "Auto Mix";
  const tip = running
    ? "Auto Mix is analyzing and planning. Cancel from the status bar."
    : !available.ok
      ? (available.reason ?? "Unavailable")
      : phase === "ready"
        ? "Show the Recommended Mix: preview, compare, and apply it"
        : phase === "stale"
          ? "The project changed since this candidate was built. Build it again from the saved mix."
          : `Analyze every stem and build one coordinated mix across gain, EQ, space, and dynamics (${STRENGTHS.find((item) => item.value === strength)?.label ?? "Normal"}). Nothing is saved until you apply it.`;
  const onClick = () => {
    if (phase === "ready") {
      useAppStore.getState().setPlanTab("full");
      useAppStore.getState().setWorkspace("mix");
      return;
    }
    useAppStore.getState().setWorkspace("mix");
    void runAutoMix();
  };
  return (
    <div className="relative flex" ref={menuRef}>
      <HoverTip label={tip} className="inline-flex">
        <button
          type="button"
          disabled={disabled || running || (!available.ok && phase !== "ready")}
          className={`rounded-l-md px-3.5 py-1.5 text-sm font-medium disabled:opacity-50 ${phase === "stale" ? "border border-accent text-accent" : "bg-accent text-accent-ink hover:brightness-105"}`}
          onClick={onClick}
        >
          {running ? <span aria-hidden="true" className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent-ink border-t-transparent align-[-1px]" /> : null}
          {label}
        </button>
      </HoverTip>
      <button
        type="button"
        aria-label="Auto Mix strength"
        aria-haspopup="menu"
        aria-expanded={menu}
        disabled={disabled || running}
        className="rounded-r-md border-l border-accent-ink/30 bg-accent px-1.5 text-accent-ink disabled:opacity-50"
        onClick={() => setMenu((value) => !value)}
      >
        ▾
      </button>
      {menu ? (
        <div role="menu" className="absolute top-full right-0 z-40 mt-1 w-72 rounded-md border border-line bg-panel p-1 shadow-lg">
          <p className="px-2 py-1 text-[10px] tracking-wide text-faint uppercase">Strength</p>
          {STRENGTHS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="menuitemradio"
              aria-checked={strength === item.value}
              className={`block w-full rounded px-2 py-1.5 text-left hover:bg-panel-2 ${strength === item.value ? "text-ink" : "text-muted"}`}
              onClick={() => {
                const fullMix = useAppStore.getState().fullMix;
                useAppStore.getState().setFullMix({ settings: { ...fullMix.settings, strength: item.value } });
                setMenu(false);
              }}
            >
              <span className="text-sm">
                {strength === item.value ? "● " : "○ "}
                {item.label}
              </span>
              <span className="block text-xs text-faint">{item.note}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const STAGE_GLYPH: Record<AutoMixStage["status"], string> = { done: "✓", reused: "✓", running: "→", pending: "○", failed: "✗", skipped: "–" };
const STAGE_WORD: Record<AutoMixStage["status"], string> = { done: "Done", reused: "Reused (already current)", running: "In progress", pending: "Waiting", failed: "Failed", skipped: "Skipped" };

/** The staged checklist while Auto Mix runs (and after it fails), in the Full Mix tab. */
export function AutoMixProgress({ autoMix }: { autoMix: AutoMixSession }) {
  const running = autoMix.phase === "running";
  const index = autoMix.stages.findIndex((stage) => stage.status === "running");
  const finished = autoMix.stages.filter((stage) => stage.status === "done" || stage.status === "reused").length;
  return (
    <div className={`rounded-lg border px-4 py-3 ${autoMix.phase === "failed" ? "border-danger/60 bg-danger/10" : "border-accent/50 bg-accent/10"}`} role="status" aria-live="polite" aria-label="Auto Mix progress">
      <div className="flex items-center gap-3">
        <h3 className="font-display text-2xl">{autoMix.phase === "failed" ? "Auto Mix could not finish" : "Building your mix"}</h3>
        {running ? <span className="font-mono text-xs text-muted">{index >= 0 ? `Stage ${index + 1} of ${autoMix.stages.length}` : `${finished} of ${autoMix.stages.length}`}</span> : null}
        {running ? (
          <button type="button" className="ml-auto rounded-md border border-line bg-panel-2 px-3 py-1 text-xs text-ink hover:bg-panel" onClick={() => cancelAutoMix()}>
            Cancel
          </button>
        ) : autoMix.phase === "failed" ? (
          <button type="button" className="ml-auto rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-ink" onClick={() => void runAutoMix()}>
            Try again
          </button>
        ) : null}
      </div>
      <ol className="mt-2 space-y-1">
        {autoMix.stages.map((stage) => (
          <li key={stage.id} className={`flex items-baseline gap-2 text-sm ${stage.status === "running" ? "text-ink" : stage.status === "failed" ? "text-danger" : stage.status === "pending" || stage.status === "skipped" ? "text-faint" : "text-muted"}`}>
            <span aria-hidden="true" className="w-4 font-mono">
              {STAGE_GLYPH[stage.status]}
            </span>
            <span className="sr-only">{STAGE_WORD[stage.status]}: </span>
            <span>{stage.label}</span>
            {stage.status === "reused" ? <span className="text-xs text-faint">already current, reused</span> : stage.detail ? <span className="truncate text-xs text-faint">{stage.detail}</span> : null}
          </li>
        ))}
      </ol>
      {autoMix.error ? <p className="mt-2 text-sm text-danger">{autoMix.error}</p> : null}
      {running ? <p className="mt-2 text-xs text-muted">Your saved mix is not changed. When the candidate is ready you can preview it, compare it, and apply it.</p> : null}
    </div>
  );
}

/**
 * The Recommended Mix: what Auto Mix read, what it found, and the few changes Full Mix kept, with preview and the
 * one explicit Apply. Shown above the Full Mix review of the same plan.
 */
export function RecommendedMixCard({ autoMix, preview, stale, disabled }: { autoMix: AutoMixSession; preview: boolean; stale: boolean; disabled: boolean }) {
  const summary = autoMix.summary;
  if (!summary) return null;
  const lines = autoMixSummaryLines(summary);
  return (
    <div className="rounded-lg border border-accent/60 bg-canvas px-4 py-3" aria-label="Recommended Mix">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-display text-2xl">Recommended Mix</h3>
        <span className="text-xs text-faint">
          Auto Mix · {summary.strength[0]!.toUpperCase() + summary.strength.slice(1)}
          {autoMix.durationMs !== null ? ` · built in ${(autoMix.durationMs / 1000).toFixed(1)} s` : ""}
          {summary.reused.length > 0 ? ` · reused current ${summary.reused.length === 7 ? "plan" : "analysis"}` : ""}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" disabled={disabled} aria-pressed={!preview} className={`rounded-md px-3 py-1.5 text-xs disabled:opacity-40 ${!preview ? "bg-panel-2 text-ink ring-1 ring-accent" : "border border-line text-muted"}`} onClick={() => setFullMixPreview(false)}>
            Current
          </button>
          <button type="button" disabled={disabled} aria-pressed={preview} className={`rounded-md px-3 py-1.5 text-xs disabled:opacity-40 ${preview ? "bg-panel-2 text-ink ring-1 ring-accent" : "border border-line text-muted"}`} onClick={() => setFullMixPreview(true)}>
            Recommended
          </button>
          <button type="button" disabled={disabled || stale || summary.changeCount === 0} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-40" title="Write every proposed and accepted change into the project as one undo step" onClick={() => applyAutoMix()}>
            Apply Mix
          </button>
          {stale ? (
            <button type="button" className="rounded-md border border-accent px-3 py-1.5 text-xs text-accent" onClick={() => void runAutoMix()}>
              Rebuild Mix
            </button>
          ) : null}
          <button type="button" className="rounded-md border border-line px-3 py-1.5 text-xs text-muted hover:text-ink" title="Discard the candidate and keep the saved mix" onClick={() => discardAutoMix()}>
            Discard
          </button>
        </div>
      </div>
      {stale ? <p className="mt-1 text-sm text-danger">The mix changed after this candidate was built. Rebuild it before applying.</p> : null}
      <div className="mt-2 grid gap-3 text-sm sm:grid-cols-3">
        <SummaryBlock title="Analyzed" lines={lines.analyzed} />
        <SummaryBlock title="Detected" lines={lines.detected} />
        <SummaryBlock title="Final coordinated plan" lines={lines.kept} />
      </div>
      {lines.omitted ? <p className="mt-2 text-xs text-muted">{lines.omitted} Full Mix kept only what measurably helped the whole mix.</p> : null}
      <p className="mt-1 text-xs text-faint">Nothing is saved until you apply. Apply is one undo step.</p>
    </div>
  );
}

function SummaryBlock({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div>
      <p className="text-[10px] tracking-wide text-faint uppercase">{title}</p>
      <ul className="mt-0.5">
        {lines.map((line) => (
          <li key={line} className="text-ink">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}
