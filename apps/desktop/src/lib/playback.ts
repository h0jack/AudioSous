import { decodePcmFrames, inspectAudioFile } from "@audiosous/audio-files";
import { createStreamingEngine, type AudioEngine, type PcmStream } from "@audiosous/audio-engine";
import type { ProjectDocument } from "@audiosous/project-model";
import { useEffect, useRef, useState } from "react";
import { getPlatform } from "../platform";
import type { DesktopPlatform } from "../platform/types";
import { refreshLegacyMonitor } from "./autobalance";
import { monitorKey, monitorState, publishMonitor } from "./monitor";
import { logEvent } from "./log";
import { audioEngineKind, createNativeAudioEngine, type NativeEngineStatus } from "./native-playback";
import { useAppStore } from "../state/app-store";
import { createWebAudioOutput } from "./web-audio-output";

type RunningEngine = AudioEngine & {
  pump?: () => Promise<void>;
  poll?: () => Promise<NativeEngineStatus>;
};

const READ_LIMIT = 1_048_576;

async function readBytes(
  readAt: (offset: number, length: number) => Promise<Uint8Array>,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const chunk = Math.min(READ_LIMIT, length - filled);
    const part = await readAt(offset + filled, chunk);
    if (part.byteLength === 0) break;
    out.set(part, filled);
    filled += part.byteLength;
    if (part.byteLength < chunk) break;
  }
  return out.subarray(0, filled);
}

export async function openPcmStream(
  platform: DesktopPlatform,
  projectFile: string,
  relativePath: string,
  filename: string,
): Promise<PcmStream | null> {
  const [status] = await platform.projectMediaStatus(projectFile, [relativePath]);
  if (!status?.exists || status.fileSizeBytes <= 0) return null;
  const inspection = await inspectAudioFile(
    {
      size: status.fileSizeBytes,
      readAt: (offset, length) => platform.readProjectMediaRange(projectFile, relativePath, offset, length),
    },
    filename,
  );
  if (!inspection.ok || inspection.pcm.dataBytes <= 0) return null;
  const pcm = inspection.pcm;
  const channelCount = inspection.channelCount;
  return {
    sampleRate: inspection.sampleRate,
    channelCount,
    async readFrames(frameOffset, frameCount) {
      const start = pcm.dataOffset + frameOffset * pcm.blockAlign;
      const available = Math.max(0, pcm.dataOffset + pcm.dataBytes - start);
      const bytes = Math.min(available, frameCount * pcm.blockAlign);
      if (bytes < pcm.blockAlign) return [];
      const data = await readBytes(
        (offset, length) => platform.readProjectMediaRange(projectFile, relativePath, offset, length),
        start,
        bytes,
      );
      return decodePcmFrames(data, pcm, channelCount);
    },
  };
}

function commitPlayhead(time: number): void {
  const current = useAppStore.getState().document;
  if (!current) return;
  useAppStore.getState().replaceDocument(
    { ...current, uiState: { ...current.uiState, playheadSeconds: time } },
    true,
    { mode: "skip" },
  );
}

export function arrowSeekStep(event: { shiftKey: boolean; ctrlKey: boolean }): number {
  if (event.ctrlKey) return 0.001;
  if (event.shiftKey) return 5;
  return 1;
}

export function usePlayback(document: ProjectDocument | null, projectFile: string | null) {
  const engineRef = useRef<RunningEngine | null>(null);
  const publishedKey = useRef<string | null>(null);
  const nativeRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(document?.uiState.playheadSeconds ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [engineStatus, setEngineStatus] = useState<NativeEngineStatus | null>(null);
  const [engineKind, setEngineKind] = useState<"native" | "legacy" | "browser">("browser");
  const playingRef = useRef(false);
  playingRef.current = playing;
  const preparingRef = useRef(false);
  preparingRef.current = engineStatus?.state === "priming";
  const duration = document?.project.durationSeconds ?? 0;

  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    let timer = 0;
    const held: { engine: RunningEngine | null } = { engine: null };
    const platform = getPlatform();
    const file = projectFile;
    setPlaying(false);
    setEngineStatus(null);
    setEngineKind("browser");
    void (async () => {
      const current = useAppStore.getState().document;
      if (!current || !file) return;
      let native = false;
      if (platform.kind === "tauri") {
        try {
          native = (await audioEngineKind()) === "native";
        } catch {
          native = false;
        }
      }
      if (cancelled) return;
      nativeRef.current = native;
      setEngineKind(native ? "native" : platform.kind === "tauri" ? "legacy" : "browser");
      const engine: RunningEngine = native ? createNativeAudioEngine(file) : createStreamingEngine(createWebAudioOutput());
      if (cancelled) {
        engine.dispose();
        return;
      }
      held.engine = engine;
      engineRef.current = engine;
      if (!native) {
        await engine.loadProject(current, {
          resolve: (path) => path,
          open: async (relativePath) => {
            const track = current.tracks.find((item) => item.file.relativePath === relativePath);
            if (!track) return null;
            try {
              return await openPcmStream(platform, file, relativePath, track.file.filename);
            } catch {
              return null;
            }
          },
        });
      } else {
        await engine.loadProject(current, { resolve: (path) => path });
      }
      if (cancelled) return;
      const latest = useAppStore.getState().document;
      if (!latest) return;
      publishedKey.current = null;
      publish(engine, latest, native);
      const loop = latest.uiState.loop;
      engine.setLoop(loop?.enabled ? { startSeconds: loop.start, endSeconds: loop.end } : null);
      engine.seek(latest.uiState.playheadSeconds);
      setPlayhead(latest.uiState.playheadSeconds);
      if (native && engine.poll) {
        const poll = engine.poll.bind(engine);
        timer = window.setInterval(() => {
          void poll().then((status) => {
            if (cancelled) return;
            setEngineStatus(status);
            if (status.state === "playing") {
              setPlayhead(status.positionSeconds);
              const song = useAppStore.getState().document;
              const looping = Boolean(song?.uiState.loop?.enabled);
              const songDuration = song?.project.durationSeconds ?? 0;
              if (!looping && status.positionSeconds >= songDuration - 0.05) {
                engine.pause();
                setPlaying(false);
                commitPlayhead(Math.min(status.positionSeconds, songDuration));
              }
            }
          }).catch(() => undefined);
        }, 33);
        if (cancelled) window.clearInterval(timer);
      }
    })().catch((caught) => {
      if (cancelled) return;
      const message = caught instanceof Error && caught.message ? caught.message : "Playback could not start.";
      setError(message);
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      held.engine?.dispose();
      engineRef.current = null;
      nativeRef.current = false;
    };
  }, [document?.project.id, projectFile]);

  useEffect(() => {
    const loop = document?.uiState.loop;
    engineRef.current?.setLoop(loop?.enabled ? { startSeconds: loop.start, endSeconds: loop.end } : null);
  }, [document?.uiState.loop]);

  const balance = useAppStore((state) => state.balance);
  const eq = useAppStore((state) => state.eq);
  const space = useAppStore((state) => state.space);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !document) return;
    publish(engine, document, nativeRef.current);
  }, [document, balance, eq, space]);

  /** Sends gain, section gain, EQ, and pan/width only when what the engine would hear changed. */
  function publish(engine: RunningEngine, song: ProjectDocument, native: boolean): void {
    const state = useAppStore.getState();
    const monitor = monitorState(song, state.balance, state.eq, state.space);
    const key = `${native}:${monitorKey(monitor)}:${song.tracks.map((track) => `${track.muted}:${track.solo}`).join("|")}`;
    if (key === publishedKey.current) return;
    publishedKey.current = key;
    publishMonitor(engine, song, monitor, native);
  }

  useEffect(() => {
    if (!playing || nativeRef.current) return;
    let frame = 0;
    const tick = () => {
      const engine = engineRef.current;
      if (!engine) return;
      void engine.pump?.();
      const time = engine.getCurrentTime();
      const song = useAppStore.getState().document;
      if (song) refreshLegacyMonitor(engine, song);
      setPlayhead(time);
      const loop = useAppStore.getState().document?.uiState.loop;
      if (!loop?.enabled && time >= duration - 0.05) {
        engine.pause();
        setPlaying(false);
        commitPlayhead(Math.min(time, duration));
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration]);

  async function toggle() {
    const engine = engineRef.current;
    if (!engine || preparingRef.current) return;
    setError(null);
    if (playingRef.current) {
      engine.pause();
      const time = engine.getCurrentTime();
      setPlaying(false);
      setPlayhead(time);
      commitPlayhead(time);
      return;
    }
    try {
      await engine.play();
      const status = engine.poll ? await engine.poll() : null;
      if (status && status.state !== "playing") {
        setPlayhead(status.positionSeconds);
        setPlaying(false);
        return;
      }
      setPlaying(true);
      void logEvent(getPlatform(), "info", "audio.play", "Started playback.", { time: engine.getCurrentTime() });
    } catch (caught) {
      const message = caught instanceof Error && caught.message ? caught.message : "Playback could not start.";
      setError(message);
      void logEvent(getPlatform(), "error", "audio.output.failure", message);
    }
  }

  function stop() {
    engineRef.current?.stop();
    setPlaying(false);
    setPlayhead(0);
    commitPlayhead(0);
  }

  function seek(seconds: number, options?: { log?: boolean }) {
    const time = Math.round(Math.min(duration, Math.max(0, seconds)) * 1000) / 1000;
    engineRef.current?.seek(time);
    setPlayhead(time);
    commitPlayhead(time);
    if (options?.log !== false) {
      void logEvent(getPlatform(), "info", "audio.seek", "Moved the playhead.", { time });
    }
  }

  function setLoopEnabled(enabled: boolean) {
    const current = useAppStore.getState().document;
    const engine = engineRef.current;
    if (!current || !engine) return;
    const range = current.uiState.timeRange;
    const section = current.sections.find((item) => item.id === current.uiState.selectedSectionId);
    const sectionMatches =
      section !== undefined &&
      (!range || (Math.abs(range.start - section.startTime) < 0.001 && Math.abs(range.end - section.endTime) < 0.001));
    // Turning the loop off keeps its bounds, so the same button turns it back on without a new selection.
    const previous = current.uiState.loop;
    const loop = !enabled
      ? previous
        ? { ...previous, enabled: false }
        : null
      : section && sectionMatches
        ? { enabled: true, start: section.startTime, end: section.endTime, sectionId: section.id }
        : range
          ? { enabled: true, start: range.start, end: range.end, sectionId: null }
          : previous
            ? { ...previous, enabled: true }
            : null;
    if (enabled && !loop) return;
    useAppStore.getState().replaceDocument({ ...current, uiState: { ...current.uiState, loop } }, true);
  }

  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  const seekRef = useRef(seek);
  seekRef.current = seek;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (useAppStore.getState().preparing) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select")) return;
      const command = event.metaKey || event.ctrlKey;
      if (event.key === " " && !command && !event.altKey && !event.repeat) {
        event.preventDefault();
        void toggleRef.current();
        return;
      }
      if (event.altKey || event.metaKey) return;
      const engine = engineRef.current;
      if (!engine) return;
      if (event.key === "Home" && !event.ctrlKey && !event.repeat) {
        event.preventDefault();
        seekRef.current(0);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = arrowSeekStep(event) * (event.key === "ArrowLeft" ? -1 : 1);
        seekRef.current(engine.getCurrentTime() + step, { log: !event.repeat });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return {
    playhead,
    playing,
    preparing: engineStatus?.state === "priming",
    error,
    engineStatus,
    engineKind,
    looping: Boolean(document?.uiState.loop?.enabled),
    toggle,
    stop,
    seek,
    setLoopEnabled,
  };
}
