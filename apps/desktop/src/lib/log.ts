import { ANALYSIS_CONTRACT_VERSION } from "@audiosous/analysis-contract";
import { AUDIO_ENGINE_INTERFACE_VERSION } from "@audiosous/audio-engine";
import type { DesktopPlatform } from "../platform/types";

export type LogEvent =
  | "project.create"
  | "project.open"
  | "project.save"
  | "track.import"
  | "track.decode.failure"
  | "audio.play"
  | "audio.seek"
  | "section.create"
  | "section.update"
  | "section.delete"
  | "section.analysis.start"
  | "section.analysis.complete"
  | "section.analysis.failure"
  | "analysis.track.queued"
  | "analysis.track.started"
  | "analysis.track.completed"
  | "analysis.track.failed"
  | "analysis.cache.hit"
  | "analysis.cache.miss"
  | "analysis.cache.invalidated";

export async function logEvent(
  platform: DesktopPlatform,
  level: "info" | "warn" | "error",
  event: LogEvent,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    message,
    analysisContractVersion: ANALYSIS_CONTRACT_VERSION,
    audioEngineInterfaceVersion: AUDIO_ENGINE_INTERFACE_VERSION,
    data: data ?? {},
  });
  if (level === "error") console.error(line);
  else console.info(line);
  try {
    await platform.appendLog(line);
  } catch {
    // A log failure must not block import or save.
  }
}
