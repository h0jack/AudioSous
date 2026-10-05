import { suggestSections } from "@audiosous/analysis-contract";
import { formatSignedDb, type GainRecommendation } from "@audiosous/balance-planner";
import {
  chooseWaveformLevel,
  clampScroll,
  clampTimelineZoom,
  energyEnvelope,
  pixelsPerSecondFor,
  rulerStepSeconds,
  timeToX,
  xToTime,
  type WaveformPeaks,
} from "@audiosous/audio-files";
import {
  SECTION_TYPE_LABELS,
  SECTION_TYPES,
  TRACK_ROLE_LABELS,
  channelLabel,
  formatBitDepth,
  formatClock,
  formatSampleRate,
  type ProjectDocument,
  type SectionType,
  type SongSection,
  type UiState,
} from "@audiosous/project-model";
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { usePlayback } from "../lib/playback";

type Playback = ReturnType<typeof usePlayback>;
import { acceptSectionSuggestions, addSectionFromRange, deleteSection, markSectionAt, dragSectionBoundary, editSection, editTrack, editTrackSection, finishBoundaryDrag, mergeSection, rejectSectionSuggestions, splitSectionAt } from "../lib/project-actions";
import { logEvent } from "../lib/log";
import { getPlatform } from "../platform";
import type { LoadedWaveform } from "../lib/waveforms";
import { isTauri } from "../platform";
import { useAppStore } from "../state/app-store";
import { describeFilter } from "@audiosous/eq-planner";
import { HoverTip, RoleSelect } from "./ui";

const NAME_WIDTH = 232;
const ROW_HEIGHT = 156;
const OTHER_ROW_HEIGHT = 204;
const RULER_HEIGHT = 32;
const SECTION_BAND = 22;
const AMPLITUDES = [0.5, 1, 2, 4];

export function Timeline({
  document,
  waveforms,
  status,
  playback,
}: {
  document: ProjectDocument;
  waveforms: Record<string, LoadedWaveform | undefined>;
  status: string | null;
  playback: Playback;
}) {
  const projectId = document.project.id;
  const balancePlan = useAppStore((state) => (state.balance.phase === "ready" ? state.balance.plan : null));
  const focusToken = useAppStore((state) => state.balance.focusToken);
  const duration = Math.max(document.project.durationSeconds, 0.001);
  const { playhead, playing, seek } = playback;
  const [zoom, setZoom] = useState(() => clampTimelineZoom(document.uiState.timelineZoom));
  const [scrollSeconds, setScrollSeconds] = useState(document.uiState.timelineScroll);
  const [range, setRange] = useState(document.uiState.timeRange);
  const [amplitude, setAmplitude] = useState(1);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(960);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pending = useRef<Partial<UiState>>({});
  const commitMode = useRef<"record" | "skip" | null>(null);
  const timer = useRef<number | null>(null);
  const drag = useRef<{ trackId: string; startX: number; startTime: number; moved: boolean } | null>(null);
  const boundaryDrag = useRef<{ origin: number; current: number; key: string; sectionId: string | null } | null>(null);
  const boundaryListeners = useRef<{ move: (event: PointerEvent) => void; up: () => void } | null>(null);
  const view = useRef({ zoom, scrollSeconds, duration, laneWidth: 1, pps: 1 });

  const laneWidth = Math.max(1, viewportWidth - NAME_WIDTH);
  const pps = pixelsPerSecondFor(duration, laneWidth, zoom);
  const contentWidth = zoom <= 1 ? laneWidth : duration * pps;
  view.current = { zoom, scrollSeconds, duration, laneWidth, pps };

  useEffect(() => {
    const ui = useAppStore.getState().document?.uiState;
    if (!ui) return;
    setZoom(clampTimelineZoom(ui.timelineZoom));
    setScrollSeconds(ui.timelineScroll);
    setRange(ui.timeRange);
  }, [projectId]);

  useEffect(() => {
    if (focusToken === 0) return;
    const current = useAppStore.getState().document;
    if (current?.uiState.timeRange) setRange(current.uiState.timeRange);
    const section = current?.sections.find((item) => item.id === current.uiState.selectedSectionId);
    if (!section) return;
    const frame = view.current;
    setScrollSeconds(clampScroll(Math.max(0, section.startTime - 0.5), frame.duration, frame.laneWidth, frame.pps));
  }, [focusToken]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setViewportWidth(node.clientWidth));
    observer.observe(node);
    setViewportWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const next = scrollSeconds * pps;
    if (Math.abs(node.scrollLeft - next) > 1) node.scrollLeft = next;
  }, [scrollSeconds, pps]);

  function flush() {
    const patch = pending.current;
    pending.current = {};
    const modeOverride = commitMode.current;
    commitMode.current = null;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (Object.keys(patch).length === 0) return;
    const current = useAppStore.getState().document;
    if (!current) return;
    const keys = Object.keys(patch);
    const chrome = keys.every((key) => key === "playheadSeconds" || key === "timelineZoom" || key === "timelineScroll" || key === "selectedTrackId");
    useAppStore.getState().replaceDocument({ ...current, uiState: { ...current.uiState, ...patch } }, true, {
      mode: modeOverride ?? (chrome ? "skip" : "record"),
    });
  }

  useEffect(
    () => () => {
      const listeners = boundaryListeners.current;
      if (!listeners) return;
      window.removeEventListener("pointermove", listeners.move);
      window.removeEventListener("pointerup", listeners.up);
      window.document.body.style.cursor = "";
      useAppStore.getState().setHoldAutosave(false);
    },
    [],
  );

  function scheduleCommit(patch: Partial<UiState>) {
    pending.current = { ...pending.current, ...patch };
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 200);
  }

  useEffect(() => () => flush(), []);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const current = view.current;
      const rect = node.getBoundingClientRect();
      const x = Math.min(Math.max(0, event.clientX - rect.left - NAME_WIDTH), current.laneWidth);
      const time = xToTime(x, current.pps, current.scrollSeconds);
      const nextZoom = clampTimelineZoom(current.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
      const nextPps = pixelsPerSecondFor(current.duration, current.laneWidth, nextZoom);
      const nextScroll = clampScroll(time - x / nextPps, current.duration, current.laneWidth, nextPps);
      setZoom(nextZoom);
      setScrollSeconds(nextScroll);
      scheduleCommit({ timelineZoom: nextZoom, timelineScroll: nextScroll });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  function zoomAround(nextZoom: number) {
    const clamped = clampTimelineZoom(nextZoom);
    const anchor = laneWidth / 2;
    const time = xToTime(anchor, pps, scrollSeconds);
    const nextPps = pixelsPerSecondFor(duration, laneWidth, clamped);
    const nextScroll = clampScroll(time - anchor / nextPps, duration, laneWidth, nextPps);
    setZoom(clamped);
    setScrollSeconds(nextScroll);
    scheduleCommit({ timelineZoom: clamped, timelineScroll: nextScroll });
  }

  function onScroll() {
    const node = viewportRef.current;
    if (!node) return;
    const next = clampScroll(node.scrollLeft / pps, duration, laneWidth, pps);
    if (Math.abs(next - scrollSeconds) < 0.001) return;
    setScrollSeconds(next);
    scheduleCommit({ timelineScroll: next, timelineZoom: zoom });
  }

  function timeAt(event: ReactPointerEvent<HTMLElement>): number {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    return Math.min(duration, Math.max(0, xToTime(x, pps, scrollSeconds)));
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>, trackId: string) {
    const startTime = timeAt(event);
    drag.current = { trackId, startX: event.clientX, startTime, moved: false };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is unavailable for some synthetic pointer events. The drag still tracks move and up.
    }
    commitNow({ selectedTrackId: trackId });
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const current = drag.current;
    if (!current) return;
    if (Math.abs(event.clientX - current.startX) > 4) current.moved = true;
    if (!current.moved) return;
    const time = timeAt(event);
    setRange({ start: Math.min(current.startTime, time), end: Math.max(current.startTime, time) });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLElement>) {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
      if (!current.moved) {
      const time = timeAt(event);
      seek(time);
      commitNow({ playheadSeconds: time, selectedTrackId: current.trackId });
      return;
    }
    const time = timeAt(event);
    const start = Math.min(current.startTime, time);
    const end = Math.max(current.startTime, time);
    if (end <= start) return;
    const next = { start, end };
    setRange(next);
    commitNow({ timeRange: next, selectedTrackId: current.trackId });
  }

  function clearSelection() {
    setRange(null);
    setSectionError(null);
    commitNow({ selectedSectionId: null, timeRange: null, selectedTrackId: null });
  }

  const clearRef = useRef(clearSelection);
  clearRef.current = clearSelection;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [role=dialog]")) return;
      const ui = useAppStore.getState().document?.uiState;
      if (!ui || (!ui.timeRange && !ui.selectedSectionId && !ui.selectedTrackId)) return;
      event.preventDefault();
      clearRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function commitNow(patch: Partial<UiState>, mode: "record" | "skip" = "record") {
    if (mode === "skip" && Object.keys(pending.current).length > 0) flush();
    pending.current = { ...pending.current, ...patch };
    commitMode.current = mode === "skip" ? "skip" : null;
    flush();
  }

  function timeFromClientX(clientX: number): number {
    const node = viewportRef.current;
    const current = view.current;
    if (!node) return 0;
    const x = clientX - node.getBoundingClientRect().left - NAME_WIDTH;
    return Math.min(current.duration, Math.max(0, xToTime(x, current.pps, current.scrollSeconds)));
  }

  function beginBoundaryDrag(event: ReactPointerEvent<HTMLElement>, time: number) {
    event.preventDefault();
    event.stopPropagation();
    const state = useAppStore.getState().document;
    const selected = state?.sections.find((section) => section.id === state.uiState.selectedSectionId);
    const follows =
      selected !== undefined &&
      range !== null &&
      Math.abs(range.start - selected.startTime) < 0.001 &&
      Math.abs(range.end - selected.endTime) < 0.001;
    useAppStore.getState().setHoldAutosave(true);
    boundaryDrag.current = { origin: time, current: time, key: `boundary:${time}`, sectionId: follows ? selected.id : null };
    const move = (pointer: PointerEvent) => {
      const dragState = boundaryDrag.current;
      if (!dragState) return;
      const result = dragSectionBoundary(dragState.current, timeFromClientX(pointer.clientX), dragState.key);
      if (!result.ok) return;
      dragState.current = result.time;
      if (!dragState.sectionId) return;
      const next = useAppStore.getState().document?.sections.find((section) => section.id === dragState.sectionId);
      if (next) setRange({ start: next.startTime, end: next.endTime });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.document.body.style.cursor = "";
      boundaryListeners.current = null;
      useAppStore.getState().setHoldAutosave(false);
      const dragState = boundaryDrag.current;
      boundaryDrag.current = null;
      if (dragState) finishBoundaryDrag(dragState.origin, dragState.current);
      if (!dragState?.sectionId) return;
      const next = useAppStore.getState().document?.sections.find((section) => section.id === dragState.sectionId);
      if (!next) return;
      commitNow({ timeRange: { start: next.startTime, end: next.endTime } }, "skip");
    };
    window.document.body.style.cursor = "col-resize";
    boundaryListeners.current = { move, up };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const step = rulerStepSeconds(pps);
  const firstTick = Math.ceil(scrollSeconds / step) * step;
  const ticks: number[] = [];
  for (let time = firstTick; time <= scrollSeconds + laneWidth / pps + step; time += step) {
    if (time >= 0 && time <= duration + 0.001) ticks.push(Number(time.toFixed(3)));
  }
  const anyPreview = document.tracks.some((track) => waveforms[track.id] && !waveforms[track.id]?.measured);
  const selectedId = document.uiState.selectedTrackId;
  const boundaries = sectionBoundaries(document.sections);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <TipButton
          label={playback.preparing ? "Preparing playback" : playing ? "Pause (Space)" : "Play from the playhead (Space)"}
          aria-label={playing ? "Pause" : "Play"}
          className={ICON_BUTTON}
          onClick={() => void playback.toggle()}
        >
          {playback.preparing ? <span className="text-xs">…</span> : playing ? <PauseIcon /> : <PlayIcon />}
        </TipButton>
        <TipButton label="Stop and return to the start" aria-label="Stop" className={ICON_BUTTON} onClick={() => playback.stop()}>
          <StopIcon />
        </TipButton>
        <TipButton
          label={loopLabel(document, range, playback.looping)}
          pressed={playback.looping}
          className={playback.looping ? `${ICON_BUTTON} border-accent text-accent` : ICON_BUTTON}
          disabled={!range && !document.uiState.selectedSectionId && !document.uiState.loop}
          onClick={() => playback.setLoopEnabled(!playback.looping)}
        >
          <LoopIcon />
        </TipButton>
        <TipButton
          label={sectionAtPlayheadLabel(document, playhead)}
          onClick={() => {
            const message = markSectionAt(playhead);
            setSectionError(message);
            if (message) return;
            const current = useAppStore.getState().document;
            const marked = current?.sections.find((section) => section.id === current.uiState.selectedSectionId);
            if (!marked) return;
            const next = { start: marked.startTime, end: marked.endTime };
            setRange(next);
            commitNow({ timeRange: next }, "skip");
          }}
        >
          <MarkIcon />
        </TipButton>
        <TipButton
          label="Clear the selected section, range, and stem (Esc)"
          disabled={!range && !document.uiState.selectedSectionId && !document.uiState.selectedTrackId}
          onClick={clearSelection}
        >
          <ClearSelectionIcon />
        </TipButton>
        <TipButton
          label="Add a section from the selected range"
          disabled={!range}
          onClick={() => {
            if (!range) return;
            setSectionError(addSectionFromRange(range.start, range.end));
          }}
        >
          <AddSectionIcon />
        </TipButton>
        <TipButton
          label="Suggest sections from the waveforms"
          onClick={() => {
            void logEvent(getPlatform(), "info", "section.analysis.start", "Started section suggestions.", {
              tracks: document.tracks.length,
            });
            const peaks = document.tracks.map((track) => waveforms[track.id]?.peaks);
            const energy = energyEnvelope(peaks, duration);
            const stems = document.tracks.map((track) => ({
              role: track.role,
              energy: energyEnvelope([waveforms[track.id]?.peaks], duration),
            }));
            const suggested = suggestSections({ durationSeconds: duration, energy, stems });
            const message = acceptSectionSuggestions(suggested.suggestions);
            if (message) {
              void logEvent(getPlatform(), "warn", "section.analysis.failure", message, { tracks: document.tracks.length });
            }
            setSectionError(message);
          }}
        >
          <SuggestIcon />
        </TipButton>
        <TipButton
          label="Remove suggestions that have not been edited"
          disabled={!document.sections.some((section) => section.source === "automatic")}
          onClick={() => setSectionError(rejectSectionSuggestions())}
        >
          <ClearSuggestionsIcon />
        </TipButton>
        <TipButton label="Zoom out (Ctrl+wheel)" onClick={() => zoomAround(zoom / 1.25)}>
          <ZoomIcon plus={false} />
        </TipButton>
        <TipButton label="Zoom in (Ctrl+wheel)" onClick={() => zoomAround(zoom * 1.25)}>
          <ZoomIcon plus />
        </TipButton>
        <TipButton
          label="Fit the song to the timeline"
          onClick={() => {
            setZoom(1);
            setScrollSeconds(0);
            scheduleCommit({ timelineZoom: 1, timelineScroll: 0 });
          }}
        >
          <FitIcon />
        </TipButton>
        <TipButton label="Draw shorter waveforms" onClick={() => setAmplitude((current) => AMPLITUDES[Math.max(0, AMPLITUDES.indexOf(current) - 1)] ?? 0.5)}>
          <HeightIcon taller={false} />
        </TipButton>
        <TipButton
          label="Draw taller waveforms"
          onClick={() => setAmplitude((current) => AMPLITUDES[Math.min(AMPLITUDES.length - 1, AMPLITUDES.indexOf(current) + 1)] ?? 4)}
        >
          <HeightIcon taller />
        </TipButton>
        <p className="font-mono text-xs text-muted">
          Playhead {formatClock(playhead)}
          {range ? ` · Range ${formatClock(range.start)}–${formatClock(range.end)}` : ""}
          {document.uiState.loop?.enabled ? ` · Loop ${formatClock(document.uiState.loop.start)}–${formatClock(document.uiState.loop.end)}` : ""}
        </p>
        {playback.preparing || playback.engineStatus?.message ? (
          <p className="text-xs text-muted">{playback.engineStatus?.message || "Preparing playback…"}</p>
        ) : null}
        {playback.engineStatus ? <EngineDetails kind={playback.engineKind} status={playback.engineStatus} /> : null}
        {playback.error ? <p className="text-xs text-danger">{playback.error}</p> : null}
        {sectionError ? <p className="text-xs text-muted">{sectionError}</p> : null}
        <p className="ml-auto text-xs text-faint">
          {status ??
            (anyPreview
              ? "Preview shapes. Import a WAV to measure peaks."
              : isTauri()
                ? "Peaks are cached with the project."
                : "Peaks were measured from the files in this window.")}
        </p>
      </div>
      <SectionEditor
        document={document}
        range={range}
        playhead={playhead}
        onError={setSectionError}
        onSelectRange={(next) => {
          setRange(next);
          commitNow({ timeRange: next });
        }}
      />
      <TrackInspector document={document} />
      <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto" onScroll={onScroll}>
        <div style={{ width: NAME_WIDTH + contentWidth, minHeight: "100%" }}>
          <div className="sticky top-0 z-20 border-b border-line bg-canvas" style={{ width: NAME_WIDTH + contentWidth }}>
            <div className="flex" style={{ height: SECTION_BAND }}>
              <div className="sticky left-0 z-10 flex shrink-0 items-center bg-canvas px-3 text-[10px] tracking-wide text-faint uppercase" style={{ width: NAME_WIDTH }}>
                Sections
              </div>
              <div className="sticky shrink-0" style={{ left: NAME_WIDTH, width: laneWidth, height: SECTION_BAND }}>
                {document.sections.map((section) => (
                  <SectionName
                    key={section.id}
                    section={section}
                    selected={section.id === document.uiState.selectedSectionId}
                    pixelsPerSecond={pps}
                    scrollSeconds={scrollSeconds}
                    onSelect={() => {
                      const next = { start: section.startTime, end: section.endTime };
                      setRange(next);
                      setSectionError(null);
                      commitNow({ selectedSectionId: section.id, timeRange: next });
                    }}
                  />
                ))}
                {boundaries.map((time) => (
                  <BoundaryHandle key={time} time={time} pixelsPerSecond={pps} scrollSeconds={scrollSeconds} onDrag={beginBoundaryDrag} />
                ))}
              </div>
            </div>
            <div className="flex border-t border-line" style={{ height: RULER_HEIGHT }}>
              <div className="sticky left-0 z-10 shrink-0 bg-canvas" style={{ width: NAME_WIDTH }} />
              <div className="sticky shrink-0 overflow-hidden" style={{ left: NAME_WIDTH, width: laneWidth, height: RULER_HEIGHT }}>
                {ticks.map((time) => (
                  <span key={time} className="absolute top-2 font-mono text-[10px] text-faint" style={{ left: timeToX(time, pps, scrollSeconds) }}>
                    {formatClock(time)}
                  </span>
                ))}
                {boundaries.map((time) => (
                  <span
                    key={time}
                    className="pointer-events-none absolute inset-y-0 w-px bg-ink/40"
                    style={{ left: timeToX(time, pps, scrollSeconds) }}
                  />
                ))}
                {boundaries.map((time) => (
                  <BoundaryHandle key={`ruler-${time}`} time={time} pixelsPerSecond={pps} scrollSeconds={scrollSeconds} onDrag={beginBoundaryDrag} />
                ))}
              </div>
            </div>
          </div>
          {document.tracks.map((track) => {
            const waveform = waveforms[track.id];
            const selected = track.id === selectedId;
            const rowHeight = track.role === "other" ? OTHER_ROW_HEIGHT : ROW_HEIGHT;
            const gain = Math.min(12, Math.max(-96, track.gainDb));
            const proposed = balancePlan?.trackChanges.find(
              (change) => change.trackId === track.id && change.scope.type === "global" && change.status !== "rejected",
            );
            const pan = Math.round(track.pan * 100);
            return (
              <div key={track.id} className="flex border-b border-line" style={{ width: NAME_WIDTH + contentWidth, height: rowHeight }}>
                <div className={`sticky left-0 z-10 flex shrink-0 flex-col border-r border-line px-3 py-2 ${selected ? "bg-panel-2" : "bg-panel"}`} style={{ width: NAME_WIDTH, height: rowHeight }}>
                  <TrackNameInput filename={track.file.filename} value={track.name} onChange={(name) => editTrack(track.id, { name })} />
                  <RoleSelect
                    value={track.role}
                    aria-label={`Role for ${track.file.filename}`}
                    className="mt-1 py-1 text-xs"
                    onChange={(role) => editTrack(track.id, { role })}
                  />
                  {track.role === "other" ? (
                    <TrackNameInput
                      filename={track.file.filename}
                      value={track.customLabel ?? ""}
                      placeholder="Custom label"
                      label={`Custom label for ${track.file.filename}`}
                      onChange={(customLabel) => editTrack(track.id, { customLabel: customLabel || null })}
                      className="mt-1 w-full rounded-md border border-line bg-canvas px-2 py-1 text-xs"
                    />
                  ) : null}
                  <div className="mt-1 flex items-center gap-1">
                    <TipButton
                      label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
                      aria-label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
                      pressed={track.muted}
                      className={`rounded px-1.5 py-0.5 text-[11px] ${track.muted ? "bg-accent text-accent-ink" : "bg-canvas text-muted"}`}
                      onClick={() => editTrack(track.id, { muted: !track.muted })}
                    >
                      M
                    </TipButton>
                    <TipButton
                      label={track.solo ? `Unsolo ${track.name}` : `Solo ${track.name}`}
                      aria-label={track.solo ? `Unsolo ${track.name}` : `Solo ${track.name}`}
                      pressed={track.solo}
                      className={`rounded px-1.5 py-0.5 text-[11px] ${track.solo ? "bg-accent text-accent-ink" : "bg-canvas text-muted"}`}
                      onClick={() => editTrack(track.id, { solo: !track.solo })}
                    >
                      S
                    </TipButton>
                    {proposed ? <span className="font-mono text-[10px] text-accent">{formatSignedDb(proposed.deltaDb)}</span> : null}
                    <SavedEqBadge document={document} trackId={track.id} />
                    <HoverTip className="block min-w-0 flex-1" label={`Gain ${formatDb(gain)}`}>
                      <input
                        type="range"
                        min={-96}
                        max={12}
                        step={0.5}
                        value={gain}
                        aria-label={`Gain for ${track.name}`}
                        onPointerDown={holdSave}
                        onChange={(event) => editTrack(track.id, { gainDb: Number(event.target.value) })}
                        className="w-full"
                      />
                    </HoverTip>
                  </div>
                  <HoverTip className="mt-1 block" label={panLabel(pan, track.metadata.channelCount)}>
                    <input
                      type="range"
                      min={-100}
                      max={100}
                      step={1}
                      value={pan}
                      aria-label={`${track.metadata.channelCount === 1 ? "Pan" : "Balance"} for ${track.name}`}
                      onPointerDown={holdSave}
                      onChange={(event) => editTrack(track.id, { pan: Number(event.target.value) / 100 })}
                      className="w-full"
                    />
                  </HoverTip>
                </div>
                <div
                  className="relative sticky shrink-0 cursor-crosshair touch-none select-none"
                  role="button"
                  tabIndex={0}
                  aria-label={`Waveform for ${track.name}`}
                  style={{ left: NAME_WIDTH, width: laneWidth, height: rowHeight }}
                  onPointerDown={(event) => onPointerDown(event, track.id)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    const time = Math.min(duration, Math.max(0, scrollSeconds + laneWidth / pps / 2));
                    seek(time);
                    commitNow({ playheadSeconds: time, selectedTrackId: track.id });
                  }}
                >
                  <WaveformCanvas
                    peaks={waveform?.peaks ?? null}
                    width={laneWidth}
                    height={rowHeight}
                    pixelsPerSecond={pps}
                    scrollSeconds={scrollSeconds}
                    amplitude={amplitude}
                    color={waveform && !waveform.measured ? "#736e66" : selected ? "#e0a04a" : "#c4924a"}
                    range={range}
                    loop={document.uiState.loop}
                    sections={document.sections}
                  />
                  {boundaries.map((time) => (
                    <BoundaryHandle key={time} time={time} pixelsPerSecond={pps} scrollSeconds={scrollSeconds} onDrag={beginBoundaryDrag} />
                  ))}
                  <div className="pointer-events-none absolute inset-y-0 w-px bg-ink" style={{ left: timeToX(playhead, pps, scrollSeconds) }} />
                  {balancePlan?.trackChanges.map((change) => {
                    const bounds = sectionBounds(document, change, track.id);
                    if (!bounds) return null;
                    const left = timeToX(bounds.start, pps, scrollSeconds);
                    const width = Math.max(40, (bounds.end - bounds.start) * pps);
                    return (
                      <div key={change.id} className="pointer-events-none absolute top-1 h-5 overflow-hidden" style={{ left, width }}>
                        <span className="rounded bg-ink/85 px-1 font-mono text-[10px] text-canvas">{formatSignedDb(bounds.offsetDb)} dB</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function holdSave() {
  useAppStore.getState().setHoldAutosave(true);
  const release = () => {
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    useAppStore.getState().setHoldAutosave(false);
  };
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
}

function SectionEditor({
  document,
  range,
  playhead,
  onError,
  onSelectRange,
}: {
  document: ProjectDocument;
  range: { start: number; end: number } | null;
  playhead: number;
  onError: (message: string | null) => void;
  onSelectRange: (range: { start: number; end: number }) => void;
}) {
  const selected = document.sections.find((section) => section.id === document.uiState.selectedSectionId);
  if (!selected) return null;
  const rangeDiffers =
    range !== null && (Math.abs(range.start - selected.startTime) >= 0.001 || Math.abs(range.end - selected.endTime) >= 0.001);
  const ordered = [...document.sections].sort((left, right) => left.startTime - right.startTime);
  const following = ordered[ordered.findIndex((section) => section.id === selected.id) + 1];
  const canMerge = following !== undefined && Math.abs(following.startTime - selected.endTime) <= 0.001;
  const canSplit = playhead >= selected.startTime + 0.25 && playhead <= selected.endTime - 0.25;
  const similar = document.sections.filter(
    (section) => section.id !== selected.id && selected.structuralGroupId !== null && section.structuralGroupId === selected.structuralGroupId,
  );
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
      <SectionNameField key={selected.id} sectionId={selected.id} name={selected.name} onError={onError} />
      <select
        value={selected.type ?? ""}
        aria-label="Section type"
        onChange={(event) => {
          const type = event.target.value ? (event.target.value as SectionType) : null;
          onError(editSection(selected.id, { type }));
        }}
        className="rounded-md border border-line bg-canvas py-1 pr-7 pl-2 text-xs text-ink"
      >
        <option value="">No type</option>
        {SECTION_TYPES.map((type) => (
          <option key={type} value={type}>
            {SECTION_TYPE_LABELS[type]}
          </option>
        ))}
      </select>
      <TipButton
        label="Set this section to the selected range"
        disabled={!rangeDiffers}
        onClick={() => {
          if (!range) return;
          const message = editSection(selected.id, { startTime: range.start, endTime: range.end });
          onError(message);
          if (!message) onSelectRange(range);
        }}
      >
        <UseRangeIcon />
      </TipButton>
      <TipButton label="Split this section at the playhead" disabled={!canSplit} onClick={() => onError(splitSectionAt(selected.id, playhead))}>
        <SplitIcon />
      </TipButton>
      <TipButton label={canMerge ? `Merge with ${following.name}` : "The next section has to start where this one ends"} disabled={!canMerge} onClick={() => onError(mergeSection(selected.id))}>
        <MergeIcon />
      </TipButton>
      <TipButton
        label="Delete this section"
        onClick={() => {
          deleteSection(selected.id);
          onError(null);
        }}
      >
        <DeleteIcon />
      </TipButton>
      <p className="font-mono text-xs text-muted">
        {formatClock(selected.startTime)}–{formatClock(selected.endTime)}
        {selected.source === "automatic" ? " · suggested" : ""}
        {selected.confidence !== null ? ` · ${Math.round(selected.confidence * 100)}% confidence` : ""}
        {similar.length > 0 ? ` · Similar to ${similar.map((section) => section.name).join(", ")}` : ""}
      </p>
      <IntentField
        label="Section intent"
        value={selected.userIntent ?? ""}
        onChange={(value) => onError(editSection(selected.id, { userIntent: value }))}
      />
      <SectionStemTreatments key={selected.id} document={document} sectionId={selected.id} onError={onError} />
    </div>
  );
}

function TrackInspector({ document }: { document: ProjectDocument }) {
  const track = document.tracks.find((item) => item.id === document.uiState.selectedTrackId);
  if (!track) return null;
  const notes = document.sections.flatMap((section) => {
    const setting = document.sectionTrackSettings.find((item) => item.trackId === track.id && item.sectionId === section.id);
    if (!setting?.userIntent && !setting?.prominence) return [];
    return [{ id: section.id, name: section.name, intent: setting.userIntent, prominence: setting.prominence }];
  });
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-1 border-b border-line px-4 py-2 text-xs text-muted">
      <p className="text-sm text-ink">{track.name}</p>
      <p>Role {track.role === "other" && track.customLabel ? track.customLabel : TRACK_ROLE_LABELS[track.role]}</p>
      <p>File {track.file.filename}</p>
      <p>
        {formatSampleRate(track.metadata.sampleRate)} / {channelLabel(track.metadata.channelCount)} / {formatBitDepth(track.metadata.bitDepth)}
      </p>
      <p>Duration {formatClock(track.metadata.durationSeconds)}</p>
      <p>Gain {formatDb(track.gainDb)}</p>
      <p>{panLabel(Math.round(track.pan * 100), track.metadata.channelCount)}</p>
      <div className="min-w-64 flex-1">
        <p className="text-[10px] tracking-wide uppercase">Treatment</p>
        {notes.length === 0 ? <p className="text-faint">No treatment is set for this stem in any section yet.</p> : null}
        {notes.map((note) => (
          <p key={note.id}>
            <span className="text-ink">{`${note.name}${note.prominence ? ` · ${PROMINENCE_LABELS[note.prominence]}` : ""}.`}</span>
            {note.intent ? ` ${note.intent}` : ""}
          </p>
        ))}
      </div>
    </div>
  );
}

const PROMINENCE_LABELS = { primary: "Primary", focal: "Focal", supporting: "Supporting" } as const;

function SectionStemTreatments({
  document,
  sectionId,
  onError,
}: {
  document: ProjectDocument;
  sectionId: string;
  onError: (message: string | null) => void;
}) {
  const [pending, setPending] = useState<string[]>([]);
  useEffect(() => setPending([]), [sectionId]);
  const settingFor = (trackId: string) =>
    document.sectionTrackSettings.find((item) => item.trackId === trackId && item.sectionId === sectionId);
  const listed = document.tracks.filter((track) => {
    const setting = settingFor(track.id);
    return pending.includes(track.id) || Boolean(setting?.prominence) || Boolean(setting?.userIntent);
  });
  const available = document.tracks.filter((track) => !listed.some((item) => item.id === track.id));
  return (
    <div className="flex min-w-72 flex-1 flex-col gap-2">
      <span className="text-[10px] tracking-wide text-muted uppercase">Stem treatment</span>
      {listed.length === 0 ? (
        <p className="text-xs text-faint">Add a stem that should stand out, or that needs its own texture or fix.</p>
      ) : null}
      {listed.map((track) => {
        const setting = settingFor(track.id);
        return (
          <div key={track.id} className="flex flex-wrap items-center gap-2">
            <span className="w-28 truncate text-xs text-ink">{track.name}</span>
            <select
              value={setting?.prominence ?? ""}
              aria-label={`Prominence for ${track.name}`}
              onChange={(event) => {
                const prominence = event.target.value ? (event.target.value as "primary" | "focal" | "supporting") : null;
                onError(editTrackSection(track.id, sectionId, { prominence }));
              }}
              className="rounded-md border border-line bg-canvas py-1 pr-7 pl-2 text-xs text-ink"
            >
              <option value="">No prominence</option>
              <option value="primary">Primary</option>
              <option value="focal">Focal</option>
              <option value="supporting">Supporting</option>
            </select>
            <TreatmentInput
              value={setting?.userIntent ?? ""}
              label={`Treatment for ${track.name}`}
              onChange={(value) => onError(editTrackSection(track.id, sectionId, { userIntent: value }))}
            />
            <TipButton
              label={`Remove ${track.name} from this section`}
              onClick={() => {
                setPending((current) => current.filter((id) => id !== track.id));
                onError(editTrackSection(track.id, sectionId, { prominence: null, userIntent: null }));
              }}
            >
              Remove
            </TipButton>
          </div>
        );
      })}
      {available.length > 0 ? (
        <select
          aria-label="Add a stem to this section"
          value=""
          onChange={(event) => {
            const trackId = event.target.value;
            if (!trackId) return;
            setPending((current) => (current.includes(trackId) ? current : [...current, trackId]));
          }}
          className="w-fit rounded-md border border-line bg-canvas py-1 pr-7 pl-2 text-xs text-ink"
        >
          <option value="">Add a stem</option>
          {available.map((track) => (
            <option key={track.id} value={track.id}>
              {track.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function TreatmentInput({ value, label, onChange }: { value: string; label: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft((current) => (current.trim() === value ? current : value));
  }, [value]);
  return (
    <input
      value={draft}
      aria-label={label}
      placeholder="Texture or fix for this stem only"
      maxLength={8000}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(event.target.value);
      }}
      className="min-w-40 flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-xs"
    />
  );
}

function IntentField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft((current) => (current.trim() === value ? current : value));
  }, [value]);
  return (
    <label className="block min-w-56 flex-1">
      <span className="mb-1 block text-[10px] tracking-wide text-muted uppercase">{label}</span>
      <textarea
        value={draft}
        aria-label={label}
        rows={2}
        maxLength={8000}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(event.target.value);
        }}
        className="w-full resize-y rounded-md border border-line bg-canvas px-2 py-1 text-xs"
      />
    </label>
  );
}

function SectionNameField({
  sectionId,
  name,
  onError,
}: {
  sectionId: string;
  name: string;
  onError: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [sectionId]);
  useEffect(() => {
    setDraft((current) => (current.trim() === name ? current : name));
  }, [name]);
  return (
    <input
      value={draft}
      aria-label="Section name"
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (!next.trim()) return;
        onError(editSection(sectionId, { name: next }));
      }}
      onBlur={() => setDraft(name)}
      className="w-40 rounded-md border border-line bg-canvas px-2 py-1 text-xs"
    />
  );
}

const ICON_BUTTON = "inline-flex h-7 w-8 items-center justify-center rounded-md border border-line bg-panel-2 text-ink";

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
      <path d="M4 2.5v11l9-5.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
      <rect x="3.5" y="2.5" width="3" height="11" rx="0.5" />
      <rect x="9.5" y="2.5" width="3" height="11" rx="0.5" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
      <rect x="3" y="3" width="10" height="10" rx="1" />
    </svg>
  );
}

function LoopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 7V6a2 2 0 0 1 2-2h8" />
      <path d="M10.5 2l2 2-2 2" />
      <path d="M13.5 9v1a2 2 0 0 1-2 2h-8" />
      <path d="M5.5 14l-2-2 2-2" />
    </svg>
  );
}

function StrokeIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

/** A playhead line with a flag: mark a section here. */
function MarkIcon() {
  return (
    <StrokeIcon>
      <path d="M5 2v12" />
      <path d="M5 2.5h7l-1.8 2.5L12 7.5H5" />
    </StrokeIcon>
  );
}

function ClearSelectionIcon() {
  return (
    <StrokeIcon>
      <rect x="2" y="3" width="12" height="10" rx="1" strokeDasharray="2 1.6" />
      <path d="M6 6l4 4M10 6l-4 4" />
    </StrokeIcon>
  );
}

/** Range brackets with a plus: a section from the selected range. */
function AddSectionIcon() {
  return (
    <StrokeIcon>
      <path d="M4 3H2.5v10H4M12 3h1.5v10H12" />
      <path d="M8 5.5v5M5.5 8h5" />
    </StrokeIcon>
  );
}

function SuggestIcon() {
  return (
    <StrokeIcon>
      <path d="M7 2.5l1.1 3.4 3.4 1.1-3.4 1.1L7 11.5 5.9 8.1 2.5 7l3.4-1.1z" />
      <path d="M12.5 10.5v3M11 12h3" />
    </StrokeIcon>
  );
}

function ClearSuggestionsIcon() {
  return (
    <StrokeIcon>
      <path d="M6.5 2.5l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" />
      <path d="M10.5 10.5l3 3M13.5 10.5l-3 3" />
    </StrokeIcon>
  );
}

function ZoomIcon({ plus }: { plus: boolean }) {
  return (
    <StrokeIcon>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.3 10.3L14 14M5 7h4" />
      {plus ? <path d="M7 5v4" /> : null}
    </StrokeIcon>
  );
}

/** Arrows out to two edges: fit the song to the width. */
function FitIcon() {
  return (
    <StrokeIcon>
      <path d="M2 3v10M14 3v10M4.5 8h7" />
      <path d="M6.5 6l-2 2 2 2M9.5 6l2 2-2 2" />
    </StrokeIcon>
  );
}

function HeightIcon({ taller }: { taller: boolean }) {
  return (
    <StrokeIcon>
      <path d="M3 8h10" />
      {taller ? <path d="M8 6.5V2M6 4l2-2 2 2M8 9.5V14M6 12l2 2 2-2" /> : <path d="M8 2v4M6 4l2 2 2-2M8 14v-4M6 12l2-2 2 2" />}
    </StrokeIcon>
  );
}

/** A section box snapping to range brackets. */
function UseRangeIcon() {
  return (
    <StrokeIcon>
      <path d="M3.5 3H2v10h1.5M12.5 3H14v10h-1.5" />
      <rect x="5" y="5.5" width="6" height="5" rx="0.5" />
    </StrokeIcon>
  );
}

function SplitIcon() {
  return (
    <StrokeIcon>
      <rect x="1.5" y="4" width="13" height="8" rx="1" />
      <path d="M8 2v12" strokeDasharray="1.6 1.4" />
    </StrokeIcon>
  );
}

function MergeIcon() {
  return (
    <StrokeIcon>
      <path d="M1.5 4h3M1.5 12h3M11.5 4h3M11.5 12h3" />
      <path d="M3 8h3.5M5 6l2 2-2 2M13 8H9.5M11 6l-2 2 2 2" />
    </StrokeIcon>
  );
}

function DeleteIcon() {
  return (
    <StrokeIcon>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v5M9.2 6.5v5" />
    </StrokeIcon>
  );
}

function loopLabel(document: ProjectDocument, range: { start: number; end: number } | null, looping: boolean): string {
  const loop = document.uiState.loop;
  if (looping && loop) return `Loop on (${formatClock(loop.start)}–${formatClock(loop.end)}). Click to turn it off`;
  if (range || document.uiState.selectedSectionId) return "Loop the selected range or section";
  if (loop) return `Loop off. Click to loop ${formatClock(loop.start)}–${formatClock(loop.end)} again`;
  return "Select a range or section to loop";
}

function sectionAtPlayheadLabel(document: ProjectDocument, time: number): string {
  const inside = document.sections.find((section) => time > section.startTime && time < section.endTime);
  if (inside) return `Split ${inside.name} at the playhead`;
  const previous = document.sections
    .filter((section) => section.endTime <= time + 0.0005)
    .sort((left, right) => right.endTime - left.endTime)[0];
  return previous
    ? `Add a section from the end of ${previous.name} to the playhead`
    : "Add a section from the start of the song to the playhead";
}

function TipButton({
  label,
  className,
  disabled,
  pressed,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; pressed?: boolean }) {
  return (
    <HoverTip label={label} className={`inline-flex ${disabled ? "cursor-not-allowed" : ""}`}>
      <button
        type="button"
        aria-label={label}
        {...props}
        disabled={disabled}
        aria-pressed={pressed}
        className={`${className ?? ICON_BUTTON} ${disabled ? "pointer-events-none opacity-40" : ""}`}
      >
        {children}
      </button>
    </HoverTip>
  );
}

function TrackNameInput({
  filename,
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  filename: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
}) {
  return (
    <HoverTip
      className="block min-w-0"
      label={(host) => {
        const node = host.querySelector("input");
        if (!node || node.scrollWidth <= node.clientWidth + 1) return "";
        return node.value;
      }}
    >
      <input
        value={value}
        placeholder={placeholder}
        aria-label={label ?? `Name for ${filename}`}
        onChange={(event) => onChange(event.target.value)}
        className={className ?? "w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-line focus:border-line"}
      />
    </HoverTip>
  );
}

function SectionName({
  section,
  selected,
  pixelsPerSecond,
  scrollSeconds,
  onSelect,
}: {
  section: SongSection;
  selected: boolean;
  pixelsPerSecond: number;
  scrollSeconds: number;
  onSelect: () => void;
}) {
  const x = timeToX(section.startTime, pixelsPerSecond, scrollSeconds);
  const width = Math.max(0, (section.endTime - section.startTime) * pixelsPerSecond);
  const rangeLabel = `${formatClock(section.startTime)}–${formatClock(section.endTime)}`;
  return (
    <HoverTip
      label={`${section.name} · ${rangeLabel}`}
      className="absolute inset-y-0 z-10 overflow-hidden"
      style={{ left: x, width }}
    >
      <button
        type="button"
        aria-label={`Section ${section.name}, ${rangeLabel}`}
        aria-pressed={selected}
        className={`h-full w-full truncate px-1 text-left text-[10px] ${selected ? "text-accent" : "text-muted"}`}
        onClick={onSelect}
      >
        {section.name}
      </button>
    </HoverTip>
  );
}

function BoundaryHandle({
  time,
  pixelsPerSecond,
  scrollSeconds,
  onDrag,
}: {
  time: number;
  pixelsPerSecond: number;
  scrollSeconds: number;
  onDrag: (event: ReactPointerEvent<HTMLElement>, time: number) => void;
}) {
  return (
    <HoverTip
      label={`Drag to move this guide · ${formatClock(time)}`}
      className="absolute inset-y-0 z-30 w-2 -translate-x-1/2 cursor-col-resize"
      style={{ left: timeToX(time, pixelsPerSecond, scrollSeconds) }}
    >
      <button
        type="button"
        aria-label={`Section guide at ${formatClock(time)}`}
        className="h-full w-full cursor-col-resize"
        onPointerDown={(event) => onDrag(event, time)}
      />
    </HoverTip>
  );
}

function sectionBounds(
  document: ProjectDocument,
  change: GainRecommendation,
  trackId: string,
): { start: number; end: number; offsetDb: number } | null {
  if (change.trackId !== trackId || change.scope.type !== "section" || change.status === "rejected") return null;
  const sectionId = change.scope.sectionId;
  const section = document.sections.find((item) => item.id === sectionId);
  if (!section) return null;
  return { start: section.startTime, end: section.endTime, offsetDb: change.offsetFromGlobalDb };
}

function sectionBoundaries(sections: SongSection[]): number[] {
  const times = new Set<number>();
  for (const section of sections) {
    times.add(section.startTime);
    times.add(section.endTime);
  }
  return [...times].sort((left, right) => left - right);
}

function formatDb(value: number): string {
  if (value <= -96) return "−∞";
  const shown = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
  return `${shown} dB`;
}

function panLabel(value: number, channels: number): string {
  const name = channels === 1 ? "Pan" : "Balance";
  if (value === 0) return `${name} center`;
  return value < 0 ? `${name} ${Math.abs(value)} left` : `${name} ${value} right`;
}

function EngineDetails({ kind, status }: { kind: "native" | "legacy" | "browser"; status: NonNullable<ReturnType<typeof usePlayback>["engineStatus"]> }) {
  const hot = status.callbackBudgetMs > 0 && status.callbackMs > status.callbackBudgetMs * 0.7;
  return (
    <details className="text-xs text-muted">
      <summary>Audio engine</summary>
      <p className="font-mono">
        {kind} · {status.state} · {status.deviceFormat || "f32"} {status.outputSampleRate.toLocaleString()} Hz · {status.callbackFrames} frames
      </p>
      <p className="font-mono">
        Tracks {status.activeTracks} · Proxies {status.proxyReadyTracks}/{status.proxyTotalTracks}
        {status.proxyPercent > 0 && status.proxyPercent < 100 ? ` · Converting ${status.proxyPercent.toFixed(0)}%` : ""} · Backlog {status.readerBacklog}
      </p>
      <p className="font-mono">
        Buffer {status.bufferedAheadMin.toFixed(2)} s min / {status.bufferedAheadAvg.toFixed(2)} s avg · Underruns {status.underruns}
        {status.lastUnderrunTrack ? ` (${status.lastUnderrunTrack})` : ""} · Seek prime {status.seekPrimeMs} ms
      </p>
      <p className={`font-mono ${hot ? "text-danger" : ""}`}>
        Callback {status.callbackMs.toFixed(2)} ms
        {status.callbackBudgetMs > 0 ? ` / ${status.callbackBudgetMs.toFixed(2)} ms` : ""}
        {hot ? " · above 70% of the callback budget" : ""}
      </p>
    </details>
  );
}

function WaveformCanvas({
  peaks,
  width,
  height,
  pixelsPerSecond,
  scrollSeconds,
  amplitude,
  color,
  range,
  loop,
  sections,
}: {
  peaks: WaveformPeaks | null;
  width: number;
  height: number;
  pixelsPerSecond: number;
  scrollSeconds: number;
  amplitude: number;
  color: string;
  range: { start: number; end: number } | null;
  loop: { enabled: boolean; start: number; end: number } | null;
  sections: SongSection[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (range && range.end > range.start) {
      const x = timeToX(range.start, pixelsPerSecond, scrollSeconds);
      ctx.fillStyle = "rgba(224,160,74,0.18)";
      ctx.fillRect(x, 0, (range.end - range.start) * pixelsPerSecond, height);
    }
    if (loop?.enabled && loop.end > loop.start) {
      const x = timeToX(loop.start, pixelsPerSecond, scrollSeconds);
      ctx.strokeStyle = "rgba(224,160,74,0.95)";
      ctx.strokeRect(x + 0.5, 1.5, (loop.end - loop.start) * pixelsPerSecond, height - 3);
    }
    const mid = height / 2;
    ctx.strokeStyle = "rgba(243,239,230,0.12)";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();
    if (peaks && peaks.levels.length > 0 && peaks.frames > 0) {
      const level = chooseWaveformLevel(peaks.levels, peaks.sampleRate, pixelsPerSecond);
      const secondsPerPeak = level.samplesPerPeak / peaks.sampleRate;
      const start = Math.max(0, Math.floor(scrollSeconds / secondsPerPeak) - 1);
      const end = Math.min(level.mins.length, Math.ceil((scrollSeconds + width / pixelsPerSecond) / secondsPerPeak) + 1);
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      for (let index = start; index < end; index += 1) {
        const x = (index * secondsPerPeak - scrollSeconds) * pixelsPerSecond;
        const min = (level.mins[index] ?? 0) / 32768;
        const max = (level.maxs[index] ?? 0) / 32768;
        const yMax = mid - max * (mid - 4) * amplitude;
        const yMin = mid - min * (mid - 4) * amplitude;
        ctx.moveTo(x + 0.5, yMax);
        ctx.lineTo(x + 0.5, Math.max(yMax + 1, yMin));
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const section of sections) {
      ctx.strokeStyle = "rgba(243,239,230,0.4)";
      ctx.setLineDash(section.source === "automatic" ? [4, 4] : []);
      for (const time of [section.startTime, section.endTime]) {
        const x = timeToX(time, pixelsPerSecond, scrollSeconds);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }, [peaks, width, height, pixelsPerSecond, scrollSeconds, amplitude, color, range, loop, sections]);

  return <canvas ref={ref} className="block h-full w-full" />;
}

/** Shows that a track has saved EQ, and lists it on hover. Planned and manual filters alike. */
function SavedEqBadge({ document, trackId }: { document: ProjectDocument; trackId: string }) {
  const own = document.tracks.find((track) => track.id === trackId)?.processing.nodes.filter((node) => node.enabled) ?? [];
  const sections = document.sectionTrackSettings
    .filter((row) => row.trackId === trackId)
    .flatMap((row) => row.processing.nodes.filter((node) => node.enabled).map((node) => ({ node, section: document.sections.find((item) => item.id === row.sectionId)?.name ?? "section" })));
  if (own.length === 0 && sections.length === 0) return null;
  const label = [...own.map((node) => describeFilter(node.filter)), ...sections.map((item) => `${item.section}: ${describeFilter(item.node.filter)}`)].join(" · ");
  return (
    <HoverTip label={`Saved EQ: ${label}`}>
      <span className="rounded bg-canvas px-1 py-0.5 text-[10px] text-ok">EQ</span>
    </HoverTip>
  );
}
