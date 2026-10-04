import {
  ANALYSIS_ENGINE_VERSION,
  analysisCacheEntrySchema,
  analysisCacheIsCurrent,
  analysisCachePath,
  trackFileMeasurementSchema,
  type AnalysisCacheEntry,
  type AnalysisFileIdentity,
  type TrackFileMeasurement,
} from "@audiosous/analysis-contract";
import type { DesktopPlatform } from "../platform/types";
import { logEvent } from "./log";

export type AnalysisJobStatus = "not-analyzed" | "queued" | "analyzing" | "complete" | "failed" | "stale";

export class TrackAnalysisError extends Error {
  detail: string;

  constructor(message: string, detail = "") {
    super(message);
    this.name = "TrackAnalysisError";
    this.detail = detail;
  }
}

export interface LoadedTrackAnalysis {
  measurement: TrackFileMeasurement;
  fromCache: boolean;
  durationMs: number;
}

export async function loadTrackAnalysis(
  platform: DesktopPlatform,
  projectFile: string,
  track: { id: string; filename: string; relativePath: string },
  onStatus?: (status: AnalysisJobStatus) => void,
): Promise<LoadedTrackAnalysis> {
  if (platform.kind !== "tauri") {
    throw new TrackAnalysisError("Stem analysis runs in the desktop app.");
  }
  const started = Date.now();
  onStatus?.("queued");
  await logEvent(platform, "info", "analysis.track.queued", `Queued analysis for ${track.filename}.`, { trackId: track.id });
  const [status] = await platform.projectMediaStatus(projectFile, [track.relativePath]);
  if (!status?.exists) {
    throw await fail(platform, track, "Unable to analyze " + track.filename + ".", "The stem file is missing from the project.", started);
  }
  const identity: AnalysisFileIdentity = {
    relativePath: track.relativePath,
    fileSizeBytes: status.fileSizeBytes,
    modifiedAtNs: status.modifiedAtNs,
  };
  const cachePath = analysisCachePath(track.id);
  const cached = await readCache(platform, projectFile, cachePath);
  if (cached?.entry && analysisCacheIsCurrent(cached.entry, identity)) {
    const durationMs = Date.now() - started;
    await logEvent(platform, "info", "analysis.cache.hit", `Used cached analysis for ${track.filename}.`, {
      trackId: track.id,
      durationMs,
      analysisVersion: ANALYSIS_ENGINE_VERSION,
    });
    return { measurement: cached.entry.measurement, fromCache: true, durationMs };
  }
  if (cached) {
    onStatus?.("stale");
    await logEvent(platform, "info", "analysis.cache.invalidated", `Cached analysis for ${track.filename} is stale.`, {
      trackId: track.id,
      reason: cached.entry ? "identity-or-version" : "unreadable",
      analysisVersion: ANALYSIS_ENGINE_VERSION,
    });
  } else {
    await logEvent(platform, "info", "analysis.cache.miss", `No cached analysis for ${track.filename}.`, {
      trackId: track.id,
      analysisVersion: ANALYSIS_ENGINE_VERSION,
    });
  }
  onStatus?.("analyzing");
  await logEvent(platform, "info", "analysis.track.started", `Started analysis for ${track.filename}.`, { trackId: track.id });
  let result;
  try {
    result = await platform.analyzeTrackFile(projectFile, track.relativePath);
  } catch (error) {
    throw await fail(platform, track, errorText(error, `Unable to analyze ${track.filename}.`), "", started);
  }
  if (!result.ok) {
    throw await fail(platform, track, result.message || `Unable to analyze ${track.filename}.`, result.detail, started, result.durationMs);
  }
  let measurement: TrackFileMeasurement;
  try {
    measurement = trackFileMeasurementSchema.parse(JSON.parse(result.measurementJson));
  } catch {
    throw await fail(platform, track, `Unable to analyze ${track.filename}.`, "The analysis result did not match the expected format.", started, result.durationMs);
  }
  const entry: AnalysisCacheEntry = {
    schemaVersion: 1,
    analysisVersion: ANALYSIS_ENGINE_VERSION,
    identity: {
      relativePath: track.relativePath,
      fileSizeBytes: result.fileSizeBytes,
      modifiedAtNs: result.modifiedAtNs,
    },
    measuredAt: new Date().toISOString(),
    measurement,
  };
  try {
    await platform.writeProjectCache(projectFile, cachePath, new TextEncoder().encode(JSON.stringify(entry, null, 2)));
  } catch {
    // The numbers can still be shown. The next selection measures the stem again.
  }
  const durationMs = result.durationMs || Date.now() - started;
  await logEvent(platform, "info", "analysis.track.completed", `Finished analysis for ${track.filename}.`, {
    trackId: track.id,
    durationMs,
    analysisVersion: ANALYSIS_ENGINE_VERSION,
    fromCache: false,
  });
  return { measurement, fromCache: false, durationMs };
}

async function readCache(
  platform: DesktopPlatform,
  projectFile: string,
  cachePath: string,
): Promise<{ entry: AnalysisCacheEntry | null } | null> {
  try {
    const bytes = await platform.readProjectCache(projectFile, cachePath);
    if (!bytes) return null;
    const parsed = analysisCacheEntrySchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return { entry: parsed.success ? parsed.data : null };
  } catch {
    return { entry: null };
  }
}

async function fail(
  platform: DesktopPlatform,
  track: { id: string; filename: string },
  message: string,
  detail: string,
  started: number,
  durationMs = Date.now() - started,
): Promise<TrackAnalysisError> {
  await logEvent(platform, "error", "analysis.track.failed", message, {
    trackId: track.id,
    filename: track.filename,
    detail: detail.slice(0, 500),
    durationMs,
    analysisVersion: ANALYSIS_ENGINE_VERSION,
  });
  return new TrackAnalysisError(message, detail);
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}
