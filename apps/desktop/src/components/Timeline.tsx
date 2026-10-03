import { suggestSections } from "@audiosous/analysis-contract";
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
  formatClock,
  type ProjectDocument,
  type SectionType,
  type SongSection,
  type UiState,
} from "@audiosous/project-model";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { usePlayback } from "../lib/playback";
import { acceptSectionSuggestions, addSectionFromRange, deleteSection, editSection, editTrack, editTrackSection } from "../lib/project-actions";
import type { LoadedWaveform } from "../lib/waveforms";
import { isTauri } from "../platform";
import { useAppStore } from "../state/app-store";
import { RoleSelect } from "./ui";

const NAME_WIDTH = 232;
const ROW_HEIGHT = 156;
const RULER_HEIGHT = 32;
const AMPLITUDES = [0.5, 1, 2, 4];

export function Timeline({
  document,
  projectFile,
  waveforms,
  status,
}: {
  document: ProjectDocument;
  projectFile: string | null;
  waveforms: Record<string, LoadedWaveform | undefined>;
  status: string | null;
}) {
  const projectId = document.project.id;
  const duration = Math.max(document.project.durationSeconds, 0.001);
  const playback = usePlayback(document, projectFile);
  const { playhead, playing, seek } = playback;
  const [zoom, setZoom] = useState(() => clampTimelineZoom(document.uiState.timelineZoom));
  const [scrollSeconds, setScrollSeconds] = useState(document.uiState.timelineScroll);
  const [range, setRange] = useState(document.uiState.timeRange);
  const [amplitude, setAmplitude] = useState(1);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(960);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pending = useRef<Partial<UiState>>({});
  const timer = useRef<number | null>(null);
  const drag = useRef<{ trackId: string; startX: number; startTime: number; moved: boolean } | null>(null);
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
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (Object.keys(patch).length === 0) return;
    const current = useAppStore.getState().document;
    if (!current) return;
    const keys = Object.keys(patch);
    const chrome = keys.every((key) => key === "playheadSeconds" || key === "timelineZoom" || key === "timelineScroll" || key === "selectedTrackId");
    useAppStore.getState().replaceDocument({ ...current, uiState: { ...current.uiState, ...patch } }, true, {
      mode: chrome ? "skip" : "record",
    });
  }

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

  function commitNow(patch: Partial<UiState>) {
    pending.current = { ...pending.current, ...patch };
    flush();
  }

  const step = rulerStepSeconds(pps);
  const firstTick = Math.ceil(scrollSeconds / step) * step;
  const ticks: number[] = [];
  for (let time = firstTick; time <= scrollSeconds + laneWidth / pps + step; time += step) {
    if (time >= 0 && time <= duration + 0.001) ticks.push(Number(time.toFixed(3)));
  }
  const anyPreview = document.tracks.some((track) => waveforms[track.id] && !waveforms[track.id]?.measured);
  const selectedId = document.uiState.selectedTrackId;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <button type="button" className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs" onClick={() => void playback.toggle()}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs" onClick={() => playback.stop()}>
          Stop
        </button>
        <button
          type="button"
          className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs disabled:opacity-40"
          disabled={!range && !document.uiState.selectedSectionId && !playback.looping}
          onClick={() => playback.setLoopEnabled(!playback.looping)}
        >
          {playback.looping ? "Looping" : "Loop"}
        </button>
        <button
          type="button"
          className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs disabled:opacity-40"
          disabled={!range}
          onClick={() => {
            if (!range) return;
            setSectionError(addSectionFromRange(range.start, range.end));
          }}
        >
          Add section
        </button>
        <button
          type="button"
          className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs"
          onClick={() => {
            const energy = energyEnvelope(
              document.tracks.map((track) => waveforms[track.id]?.peaks),
              duration,
            );
            const suggested = suggestSections({ durationSeconds: duration, energy });
            setSectionError(acceptSectionSuggestions(suggested.suggestions));
          }}
        >
          Suggest sections
        </button>
        <button type="button" className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs" onClick={() => zoomAround(zoom / 1.25)}>
          Zoom out
        </button>
        <button type="button" className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs" onClick={() => zoomAround(zoom * 1.25)}>
          Zoom in
        </button>
        <button
          type="button"
          className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs"
          onClick={() => {
            setZoom(1);
            setScrollSeconds(0);
            scheduleCommit({ timelineZoom: 1, timelineScroll: 0 });
          }}
        >
          Fit
        </button>
        <button
          type="button"
          className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs"
          onClick={() => setAmplitude((current) => AMPLITUDES[Math.max(0, AMPLITUDES.indexOf(current) - 1)] ?? 0.5)}
        >
          Shorter
        </button>
        <button
          type="button"
          className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs"
          onClick={() => setAmplitude((current) => AMPLITUDES[Math.min(AMPLITUDES.length - 1, AMPLITUDES.indexOf(current) + 1)] ?? 4)}
        >
          Taller
        </button>
        <p className="font-mono text-xs text-muted">
          Playhead {formatClock(playhead)}
          {range ? ` · Range ${formatClock(range.start)}–${formatClock(range.end)}` : ""}
          {document.uiState.loop?.enabled ? ` · Loop ${formatClock(document.uiState.loop.start)}–${formatClock(document.uiState.loop.end)}` : ""}
        </p>
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
        onError={setSectionError}
        onSelectRange={(next) => {
          setRange(next);
          commitNow({ timeRange: next });
        }}
      />
      <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto" onScroll={onScroll}>
        <div style={{ width: NAME_WIDTH + contentWidth, minHeight: "100%" }}>
          <div className="sticky top-0 z-20 flex border-b border-line bg-canvas" style={{ width: NAME_WIDTH + contentWidth, height: RULER_HEIGHT }}>
            <div className="sticky left-0 z-10 shrink-0 bg-canvas" style={{ width: NAME_WIDTH }} />
            <div className="sticky shrink-0 overflow-hidden" style={{ left: NAME_WIDTH, width: laneWidth, height: RULER_HEIGHT }}>
              {ticks.map((time) => (
                <span key={time} className="absolute top-2 font-mono text-[10px] text-faint" style={{ left: timeToX(time, pps, scrollSeconds) }}>
                  {formatClock(time)}
                </span>
              ))}
              {document.sections.map((section) => (
                <SectionMark
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
            </div>
          </div>
          {document.tracks.map((track) => {
            const waveform = waveforms[track.id];
            const selected = track.id === selectedId;
            return (
              <div key={track.id} className="flex border-b border-line" style={{ width: NAME_WIDTH + contentWidth, height: ROW_HEIGHT }}>
                <div className={`sticky left-0 z-10 shrink-0 border-r border-line px-3 py-2 ${selected ? "bg-panel-2" : "bg-panel"}`} style={{ width: NAME_WIDTH }}>
                  <input
                    value={track.name}
                    aria-label={`Name for ${track.file.filename}`}
                    onChange={(event) => editTrack(track.id, { name: event.target.value })}
                    className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-line focus:border-line"
                  />
                  <RoleSelect
                    value={track.role}
                    aria-label={`Role for ${track.file.filename}`}
                    onChange={(role) => editTrack(track.id, { role })}
                  />
                  {track.role === "other" ? (
                    <input
                      value={track.customLabel ?? ""}
                      placeholder="Custom label"
                      aria-label={`Custom label for ${track.file.filename}`}
                      onChange={(event) => editTrack(track.id, { customLabel: event.target.value || null })}
                      className="mt-1 w-full rounded-md border border-line bg-canvas px-2 py-1 text-xs"
                    />
                  ) : null}
                  <div className="mt-1 flex items-center gap-1">
                    <button
                      type="button"
                      aria-pressed={track.muted}
                      aria-label={`Mute ${track.name}`}
                      className={`rounded px-1.5 py-0.5 text-[11px] ${track.muted ? "bg-accent text-accent-ink" : "bg-canvas text-muted"}`}
                      onClick={() => editTrack(track.id, { muted: !track.muted })}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      aria-pressed={track.solo}
                      aria-label={`Solo ${track.name}`}
                      className={`rounded px-1.5 py-0.5 text-[11px] ${track.solo ? "bg-accent text-accent-ink" : "bg-canvas text-muted"}`}
                      onClick={() => editTrack(track.id, { solo: !track.solo })}
                    >
                      S
                    </button>
                    <input
                      type="range"
                      min={-24}
                      max={12}
                      step={0.5}
                      value={Math.min(12, Math.max(-24, track.gainDb))}
                      aria-label={`Gain for ${track.name}`}
                      onChange={(event) => editTrack(track.id, { gainDb: Number(event.target.value) })}
                      className="w-full"
                    />
                  </div>
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    step={1}
                    value={Math.round(track.pan * 100)}
                    aria-label={`Pan for ${track.name}`}
                    title={track.file.filename}
                    onChange={(event) => editTrack(track.id, { pan: Number(event.target.value) / 100 })}
                    className="mt-1 w-full"
                  />
                </div>
                <div
                  className="relative sticky shrink-0 cursor-crosshair touch-none select-none"
                  role="button"
                  tabIndex={0}
                  aria-label={`Waveform for ${track.name}`}
                  style={{ left: NAME_WIDTH, width: laneWidth, height: ROW_HEIGHT }}
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
                    height={ROW_HEIGHT}
                    pixelsPerSecond={pps}
                    scrollSeconds={scrollSeconds}
                    amplitude={amplitude}
                    color={waveform && !waveform.measured ? "#736e66" : selected ? "#e0a04a" : "#c4924a"}
                    range={range}
                    loop={document.uiState.loop}
                    sections={document.sections}
                  />
                  <div className="pointer-events-none absolute inset-y-0 w-px bg-ink" style={{ left: timeToX(playhead, pps, scrollSeconds) }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SectionEditor({
  document,
  range,
  onError,
  onSelectRange,
}: {
  document: ProjectDocument;
  range: { start: number; end: number } | null;
  onError: (message: string | null) => void;
  onSelectRange: (range: { start: number; end: number }) => void;
}) {
  const selected = document.sections.find((section) => section.id === document.uiState.selectedSectionId);
  if (!selected) return null;
  const rangeDiffers =
    range !== null && (Math.abs(range.start - selected.startTime) >= 0.001 || Math.abs(range.end - selected.endTime) >= 0.001);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
      <SectionNameField sectionId={selected.id} name={selected.name} onError={onError} />
      <select
        value={selected.type ?? ""}
        aria-label="Section type"
        onChange={(event) => {
          const type = event.target.value ? (event.target.value as SectionType) : null;
          onError(editSection(selected.id, { type }));
        }}
        className="rounded-md border border-line bg-canvas px-2 py-1 text-xs"
      >
        <option value="">No type</option>
        {SECTION_TYPES.map((type) => (
          <option key={type} value={type}>
            {SECTION_TYPE_LABELS[type]}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs disabled:opacity-40"
        disabled={!rangeDiffers}
        onClick={() => {
          if (!range) return;
          const message = editSection(selected.id, { startTime: range.start, endTime: range.end });
          onError(message);
          if (!message) onSelectRange(range);
        }}
        >
        Use range
      </button>
      <button
        type="button"
        className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs"
        onClick={() => {
          deleteSection(selected.id);
          onError(null);
        }}
      >
        Delete section
      </button>
      <p className="font-mono text-xs text-muted">
        {formatClock(selected.startTime)}–{formatClock(selected.endTime)}
        {selected.source === "automatic" ? " · suggested" : ""}
      </p>
      <IntentField
        label="Section intent"
        value={selected.userIntent ?? ""}
        onChange={(value) => onError(editSection(selected.id, { userIntent: value }))}
      />
      <TrackIntent document={document} sectionId={selected.id} onError={onError} />
    </div>
  );
}

function TrackIntent({
  document,
  sectionId,
  onError,
}: {
  document: ProjectDocument;
  sectionId: string;
  onError: (message: string | null) => void;
}) {
  const track = document.tracks.find((item) => item.id === document.uiState.selectedTrackId);
  if (!track) return <p className="text-xs text-faint">Select a lane to describe that stem in this section.</p>;
  const setting = document.sectionTrackSettings.find((item) => item.trackId === track.id && item.sectionId === sectionId);
  return (
    <>
      <IntentField
        label={`${track.name} in this section`}
        value={setting?.userIntent ?? ""}
        onChange={(value) => onError(editTrackSection(track.id, sectionId, { userIntent: value }))}
      />
      <select
        value={setting?.prominence ?? ""}
        aria-label={`Prominence for ${track.name}`}
        onChange={(event) => {
          const prominence = event.target.value ? (event.target.value as "primary" | "focal" | "supporting") : null;
          onError(editTrackSection(track.id, sectionId, { prominence }));
        }}
        className="rounded-md border border-line bg-canvas px-2 py-1 text-xs"
      >
        <option value="">No prominence</option>
        <option value="primary">Primary</option>
        <option value="focal">Focal</option>
        <option value="supporting">Supporting</option>
      </select>
    </>
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

function SectionMark({
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
  return (
    <button
      type="button"
      aria-label={`Section ${section.name}`}
      aria-pressed={selected}
      className={`absolute top-0 h-full border-l text-left text-[10px] ${selected ? "text-accent" : "text-muted"} ${section.source === "automatic" ? "border-dashed" : ""}`}
      style={{ left: x, borderColor: selected ? "var(--color-accent)" : "rgba(243,239,230,0.45)" }}
      onClick={onSelect}
    >
      <span className="ml-1">{section.name}</span>
    </button>
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
