import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AgentSettingsInfo, AnalyzeAudioRequest, CopyProgress, DesktopPlatform, DynamicsCheckResponse, EqCheckResponse, ListedFile, MediaStatus, MixCheckResult, SpatialCheckResponse, TrackAnalysisBridgeResult, ExportStatus, ReferenceInfo } from "./types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function asPathList(selected: string | string[] | null): string[] | null {
  if (!selected) return null;
  const paths = Array.isArray(selected) ? selected : [selected];
  return paths.length > 0 ? paths : null;
}

async function bytesFrom(command: string, args: Record<string, unknown>): Promise<Uint8Array> {
  const values = await invoke<number[]>(command, args);
  return Uint8Array.from(values);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunk)));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export const tauriPlatform: DesktopPlatform = {
  kind: "tauri",
  async pickAudioFiles() {
    const selected = await open({
      title: "Add stems",
      multiple: true,
      filters: [{ name: "Stems", extensions: ["wav", "wave", "aif", "aiff", "mp3", "flac", "ogg", "m4a"] }],
    });
    const paths = asPathList(selected);
    if (!paths) return null;
    return tauriPlatform.listAudioFiles(paths);
  },
  async pickAudioFolder() {
    const selected = await open({ title: "Add a stem folder", directory: true, multiple: false });
    if (typeof selected !== "string") return null;
    return tauriPlatform.listAudioFiles([selected]);
  },
  listAudioFiles(paths) {
    return invoke<ListedFile[]>("list_audio_files", { paths });
  },
  async pickProjectFile() {
    const selected = await open({
      title: "Open project",
      multiple: false,
      filters: [{ name: "Audiosous project", extensions: ["amix"] }],
    });
    return typeof selected === "string" ? selected : null;
  },
  async pickParentDirectory() {
    const selected = await open({ title: "Choose where to save the project", directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  },
  readUserRange(path, offset, length) {
    return bytesFrom("read_user_file_range", { path, offset, length });
  },
  async createBundle(input) {
    const unlisten = await listen<CopyProgress>("stem-copy-progress", (event) => {
      input.onProgress(event.payload);
    });
    try {
      return await invoke<{ bundleDir: string; projectFile: string }>("create_project_bundle", {
        request: {
          parentDir: input.parentDir,
          bundleName: input.bundleName,
          projectJson: input.projectJson,
          copies: input.copies,
        },
      });
    } finally {
      unlisten();
    }
  },
  writeProject(projectFile, projectJson) {
    return invoke<string>("write_project_file", { projectFile, projectJson });
  },
  readProject(projectFile) {
    return invoke<{ projectFile: string; json: string }>("read_project_file", { projectFile });
  },
  readProjectMediaRange(projectFile, relativePath, offset, length) {
    return bytesFrom("read_project_media_range", { projectFile, relativePath, offset, length });
  },
  projectMediaStatus(projectFile, relativePaths) {
    return invoke<MediaStatus[]>("project_media_status", { projectFile, relativePaths });
  },
  rememberMedia() {},
  async readProjectCache(projectFile, relativePath) {
    const encoded = await invoke<string | null>("read_project_cache", { projectFile, relativePath });
    return encoded ? decodeBase64(encoded) : null;
  },
  async writeProjectCache(projectFile, relativePath, bytes) {
    await invoke("write_project_cache", { projectFile, relativePath, base64Data: encodeBase64(bytes) });
  },
  analyzeTrackFile(projectFile, relativePath) {
    return invoke<TrackAnalysisBridgeResult>("analyze_track_file", { projectFile, relativePath });
  },
  analyzeAudio(projectFile, request: AnalyzeAudioRequest) {
    return invoke<TrackAnalysisBridgeResult>("analyze_audio", {
      request: {
        projectFile,
        relativePaths: request.relativePaths,
        scopeType: request.scopeType,
        startSeconds: request.startSeconds ?? null,
        endSeconds: request.endSeconds ?? null,
        jobId: request.jobId,
      },
    });
  },
  eqBandFrames(projectFile, tracks) {
    return invoke<Array<{ trackId: string; json: string | null; error: string | null }>>("eq_band_frames", { projectFile, tracks });
  },
  checkEq(projectFile, requests) {
    return invoke<EqCheckResponse[]>("eq_check", { projectFile, requests });
  },
  stereoFrames(projectFile, tracks) {
    return invoke<Array<{ trackId: string; json: string | null; error: string | null }>>("stereo_frames", { projectFile, tracks });
  },
  checkSpatial(projectFile, requests) {
    return invoke<SpatialCheckResponse[]>("spatial_check", { projectFile, requests });
  },
  envelopeFrames(projectFile, tracks) {
    return invoke<Array<{ trackId: string; json: string | null; error: string | null }>>("envelope_frames", { projectFile, tracks });
  },
  checkDynamics(projectFile, requests) {
    return invoke<DynamicsCheckResponse[]>("dynamics_check", { projectFile, requests });
  },
  checkMix(projectFile, request) {
    return invoke<MixCheckResult[]>("mix_check", { projectFile, request });
  },
  cancelAnalysis(jobId) {
    return invoke("cancel_analysis", { jobId });
  },
  async measureWaveform(projectFile, relativePath, trackId, onProgress) {
    const unlisten = await listen<{ trackId: string; ratio: number }>("waveform-measure-progress", (event) => {
      if (event.payload.trackId === trackId) onProgress(event.payload.ratio);
    });
    try {
      await invoke("measure_waveform", { projectFile, relativePath, trackId });
    } finally {
      unlisten();
    }
  },
  cancelWaveform() {
    return invoke("cancel_waveform");
  },
  hasPreview() {
    return false;
  },
  readPreview() {
    return null;
  },
  appendLog(line) {
    return invoke("append_log", { line });
  },
  agentSettings() {
    return invoke<AgentSettingsInfo>("agent_settings");
  },
  saveAgentSettings(settings) {
    return invoke<AgentSettingsInfo>("agent_save_settings", { settings });
  },
  agentFetch() {
    return shellFetch;
  },
  async pickExportPath(defaultName, extension) {
    const selected = await save({ title: "Export mix", defaultPath: `${defaultName}.${extension}`, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
    return typeof selected === "string" ? selected : null;
  },
  startExport(projectFile, request) {
    return invoke<number>("export_start", { projectFile, request });
  },
  exportStatus(jobId) {
    return invoke<ExportStatus>("export_status", { jobId });
  },
  decideExport(jobId, choice) {
    return invoke("export_decide", { jobId, choice });
  },
  cancelExport(jobId) {
    return invoke("export_cancel", { jobId });
  },
  revealExport(path) {
    return invoke("export_reveal", { path });
  },
  mp3Available() {
    return invoke<string>("export_mp3_available");
  },
  async pickReferenceFile() {
    const selected = await open({ title: "Choose a reference song", multiple: false, filters: [{ name: "Audio", extensions: ["wav", "wave", "aif", "aiff", "flac", "mp3"] }] });
    return typeof selected === "string" ? selected : null;
  },
  importReference(projectFile, sourcePath) {
    return invoke<ReferenceInfo>("reference_import", { projectFile, sourcePath });
  },
  listReferences(projectFile) {
    return invoke<ReferenceInfo[]>("reference_list", { projectFile });
  },
  deleteReference(projectFile, name) {
    return invoke("reference_delete", { projectFile, name });
  },
  mixProfile(projectFile, request) {
    return invoke("mix_profile", { projectFile, request });
  },
};

/**
 * The assistant SDK's fetch. The request goes to the shell, which accepts only a POST to the provider's Messages
 * endpoint, drops any credential header, and adds the stored key. Cancelling rejects at once; the shell's request
 * finishes on its own and its answer is dropped.
 */
async function shellFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signal = init?.signal ?? null;
  if (signal?.aborted) throw new DOMException("Cancelled.", "AbortError");
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers: Array<[string, string]> = [];
  new Headers(init?.headers).forEach((value, name) => headers.push([name, value]));
  const body = typeof init?.body === "string" ? init.body : init?.body ? await new Response(init.body).text() : "";
  const request = invoke<{ status: number; headers: Array<[string, string]>; body: string }>("agent_http", { request: { url, method: init?.method ?? "GET", headers, body } });
  const aborted = new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Cancelled.", "AbortError")), { once: true }));
  const response = await Promise.race([request, aborted]);
  return new Response(response.body, { status: response.status, headers: response.headers });
}
