import {
  ANALYSIS_ENGINE_VERSION,
  ANALYSIS_SCHEMA_VERSION,
  analysisCacheEntrySchema,
  analysisCacheIsCurrent,
  analysisCachePath,
  trackFileMeasurementSchema,
  type AnalysisCacheEntry,
  type AnalysisFileIdentity,
  type AnalysisIdentity,
  type MeasurementScope,
  type TrackFileMeasurement,
} from "@audiosous/analysis-contract";
import type { DesktopPlatform } from "../platform/types";
import { watchAnalysis } from "./analysis-queue";
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

export interface AnalysisTarget {
  cacheName: string;
  label: string;
  logId: string;
  files: Array<{ relativePath: string; filename: string }>;
  scope: MeasurementScope;
}

export async function loadTrackAnalysis(
  platform: DesktopPlatform,
  projectFile: string,
  track: { id: string; filename: string; relativePath: string },
  onStatus?: (status: AnalysisJobStatus) => void,
  priority = 10,
): Promise<LoadedTrackAnalysis> {
  return loadAnalysis(
    platform,
    projectFile,
    {
      cacheName: track.id,
      label: track.filename,
      logId: track.id,
      files: [{ relativePath: track.relativePath, filename: track.filename }],
      scope: { type: "track" },
    },
    onStatus,
    priority,
  );
}

export async function loadAnalysis(
  platform: DesktopPlatform,
  projectFile: string,
  target: AnalysisTarget,
  onStatus?: (status: AnalysisJobStatus) => void,
  priority = 100,
): Promise<LoadedTrackAnalysis> {
  const watched = watchAnalysis(platform, projectFile, target, onStatus, priority);
  try {
    return await watched.promise;
  } finally {
    watched.stop();
  }
}

export async function runAnalysis(
  platform: DesktopPlatform,
  projectFile: string,
  target: AnalysisTarget,
  jobId: number,
  onStatus?: (status: AnalysisJobStatus) => void,
): Promise<LoadedTrackAnalysis> {
  if (platform.kind !== "tauri") {
    throw new TrackAnalysisError("Stem analysis runs in the desktop app.");
  }
  if (target.files.length === 0) {
    throw new TrackAnalysisError(`Unable to analyze ${target.label}.`, "The analysis request did not include a stem.");
  }
  const started = Date.now();
  onStatus?.("queued");
  await logEvent(platform, "info", "analysis.track.queued", `Queued analysis for ${target.label}.`, { trackId: target.logId });
  const statuses = await platform.projectMediaStatus(
    projectFile,
    target.files.map((file) => file.relativePath),
  );
  const byPath = new Map(statuses.map((status) => [status.relativePath, status]));
  const missing = target.files.find((file) => !byPath.get(file.relativePath)?.exists);
  if (missing) {
    throw await fail(platform, target, `Unable to analyze ${target.label}.`, "The stem file is missing from the project.", started);
  }
  const identity = identityFor(target.files, byPath);
  const cachePath = analysisCachePath(target.cacheName);
  const cached = await readCache(platform, projectFile, cachePath);
  if (cached?.entry && analysisCacheIsCurrent(cached.entry, identity, target.scope)) {
    const durationMs = Date.now() - started;
    await logEvent(platform, "info", "analysis.cache.hit", `Used cached analysis for ${target.label}.`, {
      trackId: target.logId,
      durationMs,
      analysisVersion: ANALYSIS_ENGINE_VERSION,
    });
    return { measurement: cached.entry.measurement, fromCache: true, durationMs };
  }
  if (cached) {
    onStatus?.("stale");
    await logEvent(platform, "info", "analysis.cache.invalidated", `Cached analysis for ${target.label} is stale.`, {
      trackId: target.logId,
      reason: cached.entry ? "identity-or-version" : "unreadable",
      analysisVersion: ANALYSIS_ENGINE_VERSION,
    });
  } else {
    await logEvent(platform, "info", "analysis.cache.miss", `No cached analysis for ${target.label}.`, {
      trackId: target.logId,
      analysisVersion: ANALYSIS_ENGINE_VERSION,
    });
  }
  onStatus?.("analyzing");
  await logEvent(platform, "info", "analysis.track.started", `Started analysis for ${target.label}.`, { trackId: target.logId });
  let result;
  try {
    const window = target.scope.type === "section" || target.scope.type === "time-range" ? target.scope : null;
    result = await platform.analyzeAudio(projectFile, {
      relativePaths: target.files.map((file) => file.relativePath),
      scopeType: target.scope.type,
      startSeconds: window?.startSeconds,
      endSeconds: window?.endSeconds,
      jobId,
    });
  } catch (error) {
    throw await fail(platform, target, errorText(error, `Unable to analyze ${target.label}.`), "", started);
  }
  if (!result.ok) {
    if (result.detail === "cancelled") {
      throw new TrackAnalysisError(result.message || "Analysis was cancelled.", "cancelled");
    }
    throw await fail(platform, target, result.message || `Unable to analyze ${target.label}.`, result.detail, started, result.durationMs);
  }
  let measurement: TrackFileMeasurement;
  try {
    measurement = trackFileMeasurementSchema.parse(JSON.parse(result.measurementJson));
  } catch {
    throw await fail(
      platform,
      target,
      `Unable to analyze ${target.label}.`,
      "The analysis result did not match the expected format.",
      started,
      result.durationMs,
    );
  }
  const entry: AnalysisCacheEntry = {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    analysisVersion: ANALYSIS_ENGINE_VERSION,
    identity,
    scope: target.scope,
    measuredAt: new Date().toISOString(),
    measurement,
  };
  try {
    await platform.writeProjectCache(projectFile, cachePath, new TextEncoder().encode(JSON.stringify(entry, null, 2)));
  } catch {
    // The numbers can still be shown. The next selection measures the stem again.
  }
  const durationMs = result.durationMs || Date.now() - started;
  await logEvent(platform, "info", "analysis.track.completed", `Finished analysis for ${target.label}.`, {
    trackId: target.logId,
    durationMs,
    analysisVersion: ANALYSIS_ENGINE_VERSION,
    fromCache: false,
  });
  return { measurement, fromCache: false, durationMs };
}

function identityFor(
  files: AnalysisTarget["files"],
  statuses: Map<string, { relativePath: string; fileSizeBytes: number; modifiedAtNs: string }>,
): AnalysisIdentity {
  const records: AnalysisFileIdentity[] = files
    .map((file) => {
      const status = statuses.get(file.relativePath);
      return {
        relativePath: file.relativePath,
        fileSizeBytes: status?.fileSizeBytes ?? 0,
        modifiedAtNs: status?.modifiedAtNs ?? "0",
      };
    })
    .sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
  const only = records[0];
  if (records.length === 1 && only) return only;
  return { files: records };
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
  target: AnalysisTarget,
  message: string,
  detail: string,
  started: number,
  durationMs = Date.now() - started,
): Promise<TrackAnalysisError> {
  await logEvent(platform, "error", "analysis.track.failed", message, {
    trackId: target.logId,
    filename: target.label,
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
