import { decodePcmFrames, inspectAudioFile } from "@audiosous/audio-files";
import { createStreamingEngine, type PcmStream, type StreamingEngine } from "@audiosous/audio-engine";
import type { ProjectDocument } from "@audiosous/project-model";
import { useEffect, useRef, useState } from "react";
import { getPlatform } from "../platform";
import type { DesktopPlatform } from "../platform/types";
import { useAppStore } from "../state/app-store";
import { createWebAudioOutput } from "./web-audio-output";

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

export function usePlayback(document: ProjectDocument, projectFile: string | null) {
  const engineRef = useRef<StreamingEngine | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(document.uiState.playheadSeconds);
  const playingRef = useRef(false);
  playingRef.current = playing;
  const duration = document.project.durationSeconds;

  useEffect(() => {
    const output = createWebAudioOutput();
    const engine = createStreamingEngine(output);
    engineRef.current = engine;
    let cancelled = false;
    const platform = getPlatform();
    const file = projectFile;
    setPlaying(false);
    void (async () => {
      const current = useAppStore.getState().document;
      if (!current || !file) return;
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
      if (cancelled) return;
      const latest = useAppStore.getState().document;
      if (!latest) return;
      for (const track of latest.tracks) {
        engine.setTrackGain(track.id, track.gainDb);
        engine.setTrackPan(track.id, track.pan);
        engine.setMute(track.id, track.muted);
        engine.setSolo(track.id, track.solo);
      }
      const loop = latest.uiState.loop;
      engine.setLoop(loop?.enabled ? { startSeconds: loop.start, endSeconds: loop.end } : null);
      engine.seek(latest.uiState.playheadSeconds);
      setPlayhead(latest.uiState.playheadSeconds);
    })();
    return () => {
      cancelled = true;
      engine.dispose();
      engineRef.current = null;
    };
  }, [document.project.id, projectFile]);

  useEffect(() => {
    const loop = document.uiState.loop;
    engineRef.current?.setLoop(loop?.enabled ? { startSeconds: loop.start, endSeconds: loop.end } : null);
  }, [document.uiState.loop]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    for (const track of document.tracks) {
      engine.setTrackGain(track.id, track.gainDb);
      engine.setTrackPan(track.id, track.pan);
      engine.setMute(track.id, track.muted);
      engine.setSolo(track.id, track.solo);
    }
  }, [document.tracks]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const engine = engineRef.current;
      if (!engine) return;
      void engine.pump();
      const time = engine.getCurrentTime();
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
    if (!engine) return;
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
      setPlaying(true);
    } catch (error) {
      console.error(error);
    }
  }

  function stop() {
    engineRef.current?.stop();
    setPlaying(false);
    setPlayhead(0);
    commitPlayhead(0);
  }

  function seek(seconds: number) {
    const time = Math.min(duration, Math.max(0, seconds));
    engineRef.current?.seek(time);
    setPlayhead(time);
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
    const loop = !enabled
      ? null
      : section && sectionMatches
        ? { enabled: true, start: section.startTime, end: section.endTime, sectionId: section.id }
        : range
          ? { enabled: true, start: range.start, end: range.end, sectionId: null }
          : null;
    if (enabled && !loop) return;
    useAppStore.getState().replaceDocument({ ...current, uiState: { ...current.uiState, loop } }, true);
  }

  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== " " || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select")) return;
      event.preventDefault();
      void toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return {
    playhead,
    playing,
    looping: Boolean(document.uiState.loop?.enabled),
    toggle,
    stop,
    seek,
    setLoopEnabled,
  };
}
