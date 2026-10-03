import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { CopyProgress, DesktopPlatform, ListedFile, MediaStatus } from "./types";

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
  async writeProject(projectFile, projectJson) {
    await invoke("write_project_file", { projectFile, projectJson });
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
