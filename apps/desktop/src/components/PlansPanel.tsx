import type { ProjectDocument } from "@audiosous/project-model";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { usePlayback } from "../lib/playback";
import { useAppStore } from "../state/app-store";
import { AutoBalancePanel } from "./AutoBalancePanel";
import { DynamicsPanel } from "./DynamicsPanel";
import { EqPanel } from "./EqPanel";
import { FullMixPanel } from "./FullMixPanel";
import { SpacePanel } from "./SpacePanel";

type Playback = ReturnType<typeof usePlayback>;

/** The timeline keeps at least this much height, so tracks, loop, and transport stay usable while a plan is open. */
const TIMELINE_MIN_PX = 200;
const PLANS_MIN_PX = 140;
const STORAGE_KEY = "audiosous.plans-drawer";

/**
 * Mix plans under the timeline: gain (AutoBalance), EQ, space (pan and width), dynamics, and Full Mix (all four
 * coordinated). One is shown at a time; each keeps
 * its state. While a plan is open this is a resizable drawer: drag the handle (or use the arrow keys on it) to trade
 * room with the timeline, or collapse it to the tab strip and the plan's Current / Candidate / Apply bar so the whole
 * timeline is visible while you listen.
 */
export function PlansPanel({ document, playback }: { document: ProjectDocument; playback: Playback }) {
  const tab = useAppStore((state) => state.planTab);
  const balanceOpen = useAppStore((state) => state.balance.open);
  const eqOpen = useAppStore((state) => state.eq.open);
  const spaceOpen = useAppStore((state) => state.space.open);
  const dynamicsOpen = useAppStore((state) => state.dynamics.open);
  const fullOpen = useAppStore((state) => state.fullMix.open);
  const open = tab === "gain" ? balanceOpen : tab === "eq" ? eqOpen : tab === "space" ? spaceOpen : tab === "dynamics" ? dynamicsOpen : fullOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const [room, setRoom] = useState(0);
  const [saved] = useState(readSaved);
  const [height, setHeight] = useState<number | null>(saved.height);
  const [collapsed, setCollapsed] = useState(saved.collapsed);

  // Track how much height the mix workspace has, so the drawer never hides the timeline.
  useEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    const measure = () => setRoom(parent.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ height, collapsed }));
    } catch {
      // A remembered size is a convenience only.
    }
  }, [height, collapsed]);

  const max = Math.max(PLANS_MIN_PX, room - TIMELINE_MIN_PX);
  const wanted = height ?? Math.round(room * 0.42);
  const shown = Math.min(max, Math.max(PLANS_MIN_PX, wanted));
  const sized = open && !collapsed && room > 0;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, height: shown };
    if (collapsed) setCollapsed(false);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setHeight(Math.min(max, Math.max(PLANS_MIN_PX, drag.current.height + drag.current.y - event.clientY)));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 96 : 24;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setCollapsed(false);
      setHeight(Math.min(max, Math.max(PLANS_MIN_PX, shown + (event.key === "ArrowUp" ? step : -step))));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setCollapsed((value) => !value);
    }
  };

  return (
    <div
      ref={rootRef}
      className="group flex shrink-0 flex-col border-t border-line"
      data-collapsed={open && collapsed ? "true" : "false"}
      style={sized ? { height: shown } : undefined}
    >
      {open ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the plan panel. Arrow keys resize, Enter collapses or expands."
          aria-valuemin={PLANS_MIN_PX}
          aria-valuemax={max}
          aria-valuenow={collapsed ? 0 : shown}
          tabIndex={0}
          title="Drag to resize. Double-click to collapse or expand."
          className="group/handle flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center hover:bg-panel-2 focus-visible:bg-panel-2"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={() => setCollapsed((value) => !value)}
          onKeyDown={onKeyDown}
        >
          <span className="h-0.5 w-10 rounded bg-line group-hover/handle:bg-muted" />
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-1 px-4 pt-1" role="tablist" aria-label="Mix plans">
        <span className="mr-2 text-[10px] tracking-wide text-faint uppercase">Plans</span>
        <Tab id="gain" label={`Gain${balanceOpen ? " ·" : ""}`} active={tab === "gain"} />
        <Tab id="eq" label={`EQ${eqOpen ? " ·" : ""}`} active={tab === "eq"} />
        <Tab id="space" label={`Space${spaceOpen ? " ·" : ""}`} active={tab === "space"} />
        <Tab id="dynamics" label={`Dynamics${dynamicsOpen ? " ·" : ""}`} active={tab === "dynamics"} />
        <Tab id="full" label={`Full Mix${fullOpen ? " ·" : ""}`} active={tab === "full"} />
        {open ? (
          <button
            type="button"
            className="ml-auto rounded px-2 py-0.5 text-[11px] text-muted hover:text-ink"
            aria-expanded={!collapsed}
            title={collapsed ? "Show the plan details" : "Hide the plan details and give the timeline the room; the A/B and Apply buttons stay"}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? "Show details ▴" : "Hide details ▾"}
          </button>
        ) : null}
      </div>
      {tab === "gain" ? (
        <AutoBalancePanel document={document} playback={playback} />
      ) : tab === "eq" ? (
        <EqPanel document={document} playback={playback} />
      ) : tab === "space" ? (
        <SpacePanel document={document} playback={playback} />
      ) : tab === "dynamics" ? (
        <DynamicsPanel document={document} playback={playback} />
      ) : (
        <FullMixPanel document={document} playback={playback} />
      )}
    </div>
  );
}

function readSaved(): { height: number | null; collapsed: boolean } {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as { height?: unknown; collapsed?: unknown } | null;
    return {
      height: typeof parsed?.height === "number" && Number.isFinite(parsed.height) ? parsed.height : null,
      collapsed: parsed?.collapsed === true,
    };
  } catch {
    return { height: null, collapsed: false };
  }
}

function Tab({ id, label, active }: { id: "gain" | "eq" | "space" | "dynamics" | "full"; label: string; active: boolean }) {
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
