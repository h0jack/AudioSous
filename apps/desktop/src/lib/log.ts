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
  | "audio.output.failure"
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
  | "analysis.cache.invalidated"
  | "autobalance.start"
  | "autobalance.complete"
  | "autobalance.apply"
  | "autobalance.cancel"
  | "autobalance.stale"
  | "eqplan.start"
  | "eqplan.complete"
  | "eqplan.verify"
  | "eqplan.preview"
  | "eqplan.apply"
  | "eqplan.cancel"
  | "eqplan.stale"
  | "spatialplan.start"
  | "spatialplan.complete"
  | "spatialplan.verify"
  | "spatialplan.preview"
  | "spatialplan.apply"
  | "spatialplan.cancel"
  | "spatialplan.stale"
  | "dynamicsplan.start"
  | "dynamicsplan.complete"
  | "dynamicsplan.verify"
  | "dynamicsplan.preview"
  | "dynamicsplan.apply"
  | "dynamicsplan.cancel"
  | "dynamicsplan.stale"
  | "fullmix.start"
  | "fullmix.complete"
  | "fullmix.check"
  | "fullmix.preview"
  | "fullmix.apply"
  | "fullmix.cancel"
  | "fullmix.stale"
  | "automix.start"
  | "automix.complete"
  | "automix.failed"
  | "automix.stale"
  | "automix.cancel"
  | "automix.apply"
  | "export.start"
  | "export.analyzed"
  | "export.complete"
  | "export.failed"
  | "export.cancel"
  | "export.decision"
  | "reference.import"
  | "reference.listen"
  | "reference.plan"
  | "agent.request"
  | "agent.tool"
  | "agent.plan"
  | "agent.preview"
  | "agent.apply"
  | "agent.cancel"
  | "agent.error"
  | "agent.grounding"
  | "agent.complete"
  | "agent.settings";

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
