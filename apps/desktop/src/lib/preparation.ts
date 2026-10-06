import type { NativeEngineStatus } from "./native-playback";
import type { TaskPatch, TaskStep } from "./tasks";
import { waveformLoadRatio, type WaveformLoadProgress } from "./waveforms";

/** What a stem's playback audio is waiting on, blocking Play and Export until it is ready. */
export const PROXY_BLOCKS = ["playback", "export"] as const;

/**
 * The project-preparation task for the native engine's playback audio, from one status poll: running while stems
 * are still converted, failed (with the stems named, and retry) when one could not be, and complete with a short
 * note when every stem is ready. Null when no stem is loaded.
 */
export function proxyTaskPatch(status: Pick<NativeEngineStatus, "proxyReadyTracks" | "proxyTotalTracks" | "proxyTracks">, names: (id: string) => string): TaskPatch | null {
  const total = status.proxyTotalTracks;
  if (total === 0) return null;
  const tracks = status.proxyTracks ?? [];
  const steps: TaskStep[] = tracks.map((track) => ({
    id: track.id,
    label: names(track.id) || track.label,
    status: track.state === "ready" ? "done" : track.state === "failed" ? "failed" : track.state === "building" ? "running" : "pending",
    detail: track.state === "failed" ? track.error : track.state === "building" ? `${Math.round(track.percent)}%` : null,
  }));
  const failed = tracks.filter((track) => track.state === "failed");
  const ready = Math.min(total, status.proxyReadyTracks);
  const base = { id: "playback-proxy", kind: "playback-proxy" as const, steps, major: true };
  if (failed.length > 0) {
    const which = failed.map((track) => names(track.id) || track.label).join(", ");
    return {
      ...base,
      label: "Playback preparation failed",
      status: "failed",
      progress: null,
      detail: `${ready} of ${total} stems ready`,
      error: `Playback preparation failed for ${which}`,
      blocks: [...PROXY_BLOCKS],
      cancellable: false,
      retryable: true,
    };
  }
  if (ready >= total) {
    return {
      ...base,
      label: "Project ready",
      status: "complete",
      progress: 1,
      detail: `${total} of ${total} stems ready`,
      error: null,
      blocks: [],
      cancellable: false,
      retryable: false,
      completionNote: `Project ready — ${total} ${total === 1 ? "track" : "tracks"} prepared`,
    };
  }
  const building = tracks.find((track) => track.state === "building");
  const partial = building ? Math.min(1, Math.max(0, building.percent / 100)) : 0;
  return {
    ...base,
    label: "Preparing project for playback",
    status: "running",
    progress: (ready + partial) / total,
    detail: `${ready} of ${total} stems ready`,
    error: null,
    blocks: [...PROXY_BLOCKS],
    cancellable: false,
    retryable: false,
  };
}

/**
 * The waveform stage of project preparation. It blocks editing and playback the way the measurement gate always
 * has (the timeline is drawn from these peaks). Null once every stem is measured; a failure does not block anything.
 */
export function waveformTaskPatch(progress: WaveformLoadProgress | null, names: string[], failed: string | null = null): TaskPatch | null {
  const base = { id: "waveform", kind: "waveform" as const, major: true, label: "Preparing project" };
  if (failed) return { ...base, status: "failed", error: failed, detail: null, progress: null, blocks: [], retryable: false };
  if (!progress) return null;
  const ratio = waveformLoadRatio(progress);
  const steps: TaskStep[] = names.map((name, index) => ({
    id: `waveform-${index}`,
    label: name,
    status: index < progress.index ? "done" : index === progress.index ? "running" : "pending",
    detail: index === progress.index && progress.fileRatio > 0 ? `${Math.round(progress.fileRatio * 100)}%` : null,
  }));
  return {
    ...base,
    status: "running",
    progress: ratio,
    detail: `Measuring waveforms — ${Math.min(progress.index + 1, progress.total)} of ${progress.total}${progress.filename ? `: ${progress.filename}` : ""}`,
    steps,
    error: null,
    blocks: ["playback", "editing", "planning", "export"],
    cancellable: false,
  };
}
