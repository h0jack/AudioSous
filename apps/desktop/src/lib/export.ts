import type { ProjectDocument } from "@audiosous/project-model";
import { getPlatform } from "../platform";
import type { DesktopPlatform, ExportFormat, ExportRequest, ExportSettings, ExportStatus, LoudnessTarget } from "../platform/types";
import { useAppStore, type ExportSession } from "../state/app-store";
import { engineVariant } from "./full-mix";
import { logEvent } from "./log";
import { gate, registerTaskActions, type TaskPatch } from "./tasks";

/**
 * Export: the applied (saved) mix, rendered offline in the shell from the original stems, through an optional
 * distribution loudness stage, to WAV, FLAC, or MP3, verified by decoding the written file. Progress goes through
 * the shared task model like every other long job. An open, unapplied candidate is never exported.
 */

export type LoudnessPreset = ExportSession["preset"];

/**
 * Audiosous's export presets: practical starting points with their numbers shown, not platform requirements.
 * Services normalize playback differently and change their policies.
 */
export const LOUDNESS_PRESETS: Record<Exclude<LoudnessPreset, "custom" | "reference">, { label: string; target: LoudnessTarget; note: string }> = {
  preserve: { label: "Preserve Mix Level", target: { mode: "preserve", ceilingDbtp: -1 }, note: "Keeps the mix's level. The limiter only acts if a true peak would pass −1.0 dBTP." },
  balanced: { label: "Streaming Balanced", target: { mode: "target", integratedLufs: -14, ceilingDbtp: -1 }, note: "−14 LUFS integrated, −1.0 dBTP true-peak ceiling." },
  loud: { label: "Streaming Loud", target: { mode: "target", integratedLufs: -10, ceilingDbtp: -1 }, note: "−10 LUFS integrated, −1.0 dBTP true-peak ceiling. Louder masters need more limiting." },
};

export const STREAMING_NOTE = "Streaming services may normalize playback volume. This preset creates a distribution-safe file; it is not a guarantee of identical playback loudness on every service.";

const STORAGE_KEY = "audiosous.export-settings";

/** "3:42": minutes and seconds, for progress and summaries. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function defaultExportSettings(document: ProjectDocument): { preset: LoudnessPreset; settings: ExportSettings } {
  return {
    preset: "balanced",
    settings: { format: { kind: "wav", depth: "pcm24" }, sampleRate: supportedRate(document.project.sampleRate) ?? 48_000, loudness: LOUDNESS_PRESETS.balanced.target, metadata: { title: document.project.name } },
  };
}

/** A per-viewer convenience: the last format, rate, and loudness. Safe when storage is unavailable. */
function remembered(document: ProjectDocument): { preset: LoudnessPreset; settings: ExportSettings } {
  const fallback = defaultExportSettings(document);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as { preset?: LoudnessPreset; settings?: Partial<ExportSettings> } | null;
    if (!saved?.settings?.format || !saved.settings.loudness || !saved.preset) return fallback;
    // A remembered reference match keeps its number but not the reference, which belongs to another project.
    return { preset: saved.preset === "reference" ? "custom" : saved.preset, settings: { ...fallback.settings, format: saved.settings.format, sampleRate: saved.settings.sampleRate ?? fallback.settings.sampleRate, loudness: saved.settings.loudness } };
  } catch {
    return fallback;
  }
}

function remember(preset: LoudnessPreset, settings: ExportSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset, settings: { format: settings.format, sampleRate: settings.sampleRate, loudness: settings.loudness } }));
  } catch {
    // Remembering is a convenience only.
  }
}

/** The rate the project's stems are at, when Audiosous can export it (8–192 kHz). */
export function supportedRate(rate: number): number | null {
  return Number.isFinite(rate) && rate >= 8_000 && rate <= 192_000 ? Math.round(rate) : null;
}

/** The sample rates offered for a format: the project's own when it fits, 44.1, and 48 kHz. MP3 is 44.1 or 48. */
export function rateOptions(document: ProjectDocument, format: ExportFormat): number[] {
  const project = supportedRate(document.project.sampleRate);
  const base = [44_100, 48_000];
  if (format.kind === "mp3" || project === null || base.includes(project)) return base;
  // The FLAC encoder goes up to 96 kHz: a higher project rate is offered as the nearest family rate under it.
  if (format.kind === "flac" && project > MAX_FLAC_RATE) return [project % 44_100 === 0 ? 88_200 : 96_000, ...base];
  return [project, ...base];
}

/** The FLAC encoder's highest sample rate (the WAV writer has no such limit). */
export const MAX_FLAC_RATE = 96_000;

export function extensionOf(format: ExportFormat): string {
  return format.kind;
}

export function formatLabel(format: ExportFormat): string {
  if (format.kind === "wav") return format.depth === "float32" ? "WAV 32-bit float" : `WAV ${format.depth === "pcm24" ? 24 : 16}-bit`;
  if (format.kind === "flac") return `FLAC ${format.bits}-bit`;
  return format.quality === "cbr320" ? "MP3 320 kbps" : "MP3 V0";
}

/** Whether a plan's candidate is open but not applied: export never includes it, and says so. */
export function openCandidate(state: Pick<ReturnType<typeof useAppStore.getState>, "balance" | "eq" | "space" | "dynamics" | "fullMix">): string | null {
  if (state.fullMix.phase === "ready" && state.fullMix.plan) return "Full Mix candidate";
  if (state.balance.phase === "ready" && state.balance.plan) return "Gain candidate";
  if (state.eq.phase === "ready" && state.eq.plan) return "EQ candidate";
  if (state.space.phase === "ready" && state.space.plan) return "Space candidate";
  if (state.dynamics.phase === "ready" && state.dynamics.plan) return "Dynamics candidate";
  return null;
}

/**
 * What the shell renders: the saved mix as the engine plays it (faders and mute, section gain, EQ, space, dynamics;
 * solo is for listening and is not part of the export), every stem's file, and the project's length.
 */
export function exportRequest(document: ProjectDocument, settings: ExportSettings, output: string): ExportRequest {
  return {
    tracks: document.tracks.map((track) => ({ trackId: track.id, relativePath: track.file.relativePath })),
    mix: engineVariant("export", document),
    durationSeconds: document.project.durationSeconds,
    settings,
    output,
  };
}

const STAGES: Array<{ stage: ExportStatus["stage"]; label: string }> = [
  { stage: "rendering", label: "Rendering mix" },
  { stage: "analyzing", label: "Analyzing loudness" },
  { stage: "mastering", label: "Applying distribution level" },
  { stage: "encoding", label: "Encoding" },
  { stage: "verifying", label: "Verifying output" },
];

/** The export as a shared task: real progress while frames are rendered or encoded, stages otherwise. */
export function exportTaskPatch(status: ExportStatus, format: ExportFormat): TaskPatch {
  const base = { id: "export", kind: "export" as const, major: true, cancellable: true, blocks: ["export" as const] };
  const formatName = formatLabel(format);
  if (status.stage === "done" && status.report) {
    const name = status.report.output.split(/[\\/]/).pop() ?? status.report.output;
    return { ...base, label: `Export completed`, status: "complete", progress: 1, stage: null, detail: null, cancellable: false, blocks: [], completionNote: `Export completed — ${name}` };
  }
  if (status.stage === "failed") return { ...base, label: "Export failed", status: "failed", error: status.error ?? "The export could not finish.", progress: null, stage: null, cancellable: false, blocks: [], retryable: false };
  if (status.stage === "cancelled") return { ...base, label: "Export cancelled", status: "cancelled", progress: null, stage: null, cancellable: false, blocks: [] };
  if (status.stage === "deciding") return { ...base, label: `Exporting ${formatName}`, status: "running", progress: null, stage: { index: 2, count: STAGES.length }, detail: "Waiting for your choice: the loudness target would need heavy limiting" };
  const index = Math.max(0, STAGES.findIndex((item) => item.stage === status.stage));
  const rate = status.sampleRate || 48_000;
  const counting = (status.stage === "rendering" || status.stage === "mastering" || status.stage === "encoding") && status.framesTotal > 0;
  const label = status.stage === "encoding" ? `Encoding ${formatName.split(" ")[0]}` : STAGES[index]!.label;
  return {
    ...base,
    label: `Exporting ${formatName}`,
    status: "running",
    progress: counting ? Math.min(1, status.framesDone / status.framesTotal) : null,
    stage: { index: index + 1, count: STAGES.length },
    detail: counting ? `${label} — ${clock(status.framesDone / rate)} / ${clock(status.framesTotal / rate)}` : label,
    steps: STAGES.map((item, at) => ({ id: item.stage, label: item.stage === "encoding" ? `Encoding ${formatName.split(" ")[0]}` : item.label, status: at < index ? "done" : at === index ? "running" : "pending" })),
  };
}

/* ------------------------------------------------------------------ flow */

export function openExportDialog(): void {
  const state = useAppStore.getState();
  const document = state.document;
  if (!document) return;
  const running = state.exportJob && (state.exportJob.phase === "running" || state.exportJob.phase === "deciding");
  if (running) {
    state.setExportJob({ open: true });
    return;
  }
  const { preset, settings } = remembered(document);
  state.setExportJob({ open: true, phase: "setup", preset, settings: { ...settings, metadata: { ...settings.metadata, title: settings.metadata.title ?? document.project.name } }, jobId: null, status: null, plan: null, report: null, error: null, mp3Unavailable: null });
  const platform = getPlatform();
  void platform
    .mp3Available()
    .then(() => useAppStore.getState().setExportJob({ mp3Unavailable: null }))
    .catch((error: unknown) => useAppStore.getState().setExportJob({ mp3Unavailable: error instanceof Error ? error.message : String(error) }));
}

export function closeExportDialog(): void {
  const job = useAppStore.getState().exportJob;
  if (!job) return;
  // A running export keeps going in the status bar; a finished one is forgotten.
  if (job.phase === "running" || job.phase === "deciding") useAppStore.getState().setExportJob({ open: false });
  else useAppStore.getState().setExportJob(null);
}

export function setExportSettings(patch: Partial<ExportSettings>, preset?: LoudnessPreset): void {
  const job = useAppStore.getState().exportJob;
  const document = useAppStore.getState().document;
  if (!job || !document) return;
  let settings = { ...job.settings, ...patch };
  const rates = rateOptions(document, settings.format);
  if (!rates.includes(settings.sampleRate)) settings = { ...settings, sampleRate: rates.includes(48_000) ? 48_000 : rates[0]! };
  useAppStore.getState().setExportJob({ settings, preset: preset ?? job.preset });
}

/** Asks where to save, then renders. Polls the shell and publishes progress to the task model until it ends. */
export async function startExport(platform: DesktopPlatform = getPlatform(), pollMs = 200): Promise<void> {
  const state = useAppStore.getState();
  const document = state.document;
  const projectFile = state.projectFilePath;
  const job = state.exportJob;
  if (!document || !projectFile || !job) return;
  const blocked = gate(state.tasks, "export");
  if (blocked.blocked) {
    state.setExportJob({ error: blocked.reason });
    return;
  }
  const settings = job.settings;
  const output = await platform.pickExportPath(document.project.name || "Mix", extensionOf(settings.format));
  if (!output) return;
  remember(job.preset, settings);
  let jobId: number;
  try {
    jobId = await platform.startExport(projectFile, exportRequest(document, settings, output));
  } catch (caught) {
    useAppStore.getState().setExportJob({ phase: "failed", error: caught instanceof Error ? caught.message : String(caught) });
    return;
  }
  const projectId = document.project.id;
  useAppStore.getState().setExportJob({ phase: "running", jobId, status: null, report: null, error: null, plan: null });
  registerTaskActions("export", { cancel: () => void cancelExport(platform) });
  await logEvent(platform, "info", "export.start", "Started an export.", { projectId, format: formatLabel(settings.format), sampleRate: settings.sampleRate, loudness: settings.loudness.mode, preset: job.preset, targetLufs: settings.loudness.mode === "target" ? settings.loudness.integratedLufs : null, ceilingDbtp: settings.loudness.ceilingDbtp, tracks: document.tracks.length, durationSeconds: document.project.durationSeconds });
  for (;;) {
    let status: ExportStatus;
    try {
      status = await platform.exportStatus(jobId);
    } catch (caught) {
      useAppStore.getState().setTask({ id: "export", kind: "export", label: "Export failed", status: "failed", error: caught instanceof Error ? caught.message : String(caught), blocks: [] });
      useAppStore.getState().setExportJob({ phase: "failed", error: caught instanceof Error ? caught.message : String(caught) });
      return;
    }
    if (useAppStore.getState().exportJob?.jobId !== jobId) return;
    useAppStore.getState().setTask(exportTaskPatch(status, settings.format));
    const phase: ExportSession["phase"] = status.stage === "done" ? "done" : status.stage === "failed" ? "failed" : status.stage === "cancelled" ? "cancelled" : status.stage === "deciding" ? "deciding" : "running";
    useAppStore.getState().setExportJob({ status, phase, plan: status.plan, report: status.report, error: status.error });
    if (phase === "done" && status.report) {
      const report = status.report;
      await logEvent(platform, "info", "export.complete", "Finished an export.", { projectId, format: report.format, sampleRate: report.sampleRate, durationSeconds: report.durationSeconds, integratedLufs: report.integratedLufs, truePeakDbtp: report.truePeakDbtp, mixLufs: report.mix.integratedLufs, mixTruePeakDbtp: report.mix.truePeakDbtp, gainDb: report.gainDb, targetLufs: report.targetLufs, limiterMaxDb: report.limiter.maxReductionDb, renderSeconds: report.renderSeconds, totalSeconds: report.totalSeconds, renderSpeed: report.renderSpeed, peakMemoryMb: status.peakMemoryMb, warnings: report.warnings.length });
      return;
    }
    if (phase === "failed") {
      await logEvent(platform, "warn", "export.failed", "An export failed.", { projectId, stage: status.stage });
      return;
    }
    if (phase === "cancelled") {
      useAppStore.getState().dropTask("export");
      await logEvent(platform, "info", "export.cancel", "Cancelled an export.", { projectId });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function cancelExport(platform: DesktopPlatform = getPlatform()): Promise<void> {
  const job = useAppStore.getState().exportJob;
  if (job?.jobId === null || job?.jobId === undefined) return;
  await platform.cancelExport(job.jobId);
}

/** The answer to heavy limiting. */
export async function decideExport(choice: "safer" | "continue" | null, platform: DesktopPlatform = getPlatform()): Promise<void> {
  const job = useAppStore.getState().exportJob;
  if (job?.jobId === null || job?.jobId === undefined) return;
  useAppStore.getState().setExportJob({ phase: choice ? "running" : "cancelled" });
  void logEvent(platform, "info", "export.decision", "Answered heavy limiting.", { choice: choice ?? "cancel", estimatedMaxReductionDb: job.plan?.estimatedMaxReductionDb ?? null, targetLufs: job.plan?.targetLufs ?? null, saferTargetLufs: job.plan?.saferTargetLufs ?? null });
  await platform.decideExport(job.jobId, choice);
}
