import type { ProjectDocument } from "@audiosous/project-model";
import type { usePlayback } from "../lib/playback";
import { useAppStore } from "../state/app-store";
import { AutoBalancePanel } from "./AutoBalancePanel";
import { EqPanel } from "./EqPanel";

type Playback = ReturnType<typeof usePlayback>;

/** Mix plans under the timeline: gain (AutoBalance) and EQ. One is shown at a time; both keep their state. */
export function PlansPanel({ document, playback }: { document: ProjectDocument; playback: Playback }) {
  const tab = useAppStore((state) => state.planTab);
  const balanceOpen = useAppStore((state) => state.balance.open);
  const eqOpen = useAppStore((state) => state.eq.open);
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-1 border-t border-line px-4 pt-1.5" role="tablist" aria-label="Mix plans">
        <span className="mr-2 text-[10px] tracking-wide text-faint uppercase">Plans</span>
        <Tab id="gain" label={`Gain${balanceOpen ? " ·" : ""}`} active={tab === "gain"} />
        <Tab id="eq" label={`EQ${eqOpen ? " ·" : ""}`} active={tab === "eq"} />
      </div>
      {tab === "gain" ? <AutoBalancePanel document={document} playback={playback} /> : <EqPanel document={document} playback={playback} />}
    </div>
  );
}

function Tab({ id, label, active }: { id: "gain" | "eq"; label: string; active: boolean }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`rounded-t px-2.5 py-1 text-xs ${active ? "bg-panel text-ink" : "text-muted hover:text-ink"}`}
      onClick={() => useAppStore.getState().setPlanTab(id)}
    >
      {label}
    </button>
  );
}
