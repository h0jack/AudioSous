import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { AnalyzeAudioRequest, CopyProgress, DesktopPlatform, ListedFile, MediaStatus, TrackAnalysisBridgeResult } from "./types";

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
};
