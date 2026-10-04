import type { DesktopPlatform, ListedFile } from "./types";

const PREVIEW_KEY = "audiosous.preview.project";
const files = new Map<string, File>();
const texts = new Map<string, string>();
const projectMedia = new Map<string, File>();
const waveformCache = new Map<string, Uint8Array>();

function rememberFile(file: File): ListedFile {
  const path = `local:${crypto.randomUUID()}:${file.name}`;
  files.set(path, file);
  return { path, filename: file.name, fileSizeBytes: file.size };
}

function pickDomFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener("change", () => resolve([...input.files ?? []]));
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

function downloadText(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export const browserPlatform: DesktopPlatform = {
  kind: "browser",
  async pickAudioFiles() {
    const picked = await pickDomFiles(".wav,.aiff,.aif,.wave,.mp3,.flac", true);
    if (picked.length === 0) return null;
    return picked.map(rememberFile);
  },
  async pickAudioFolder() {
    return null;
  },
  async listAudioFiles() {
    throw new Error("Folder import is available in the desktop app.");
  },
  async pickProjectFile() {
    const [file] = await pickDomFiles(".amix,application/json", false);
    if (!file) return null;
    const path = `preview-file://${file.name}`;
    texts.set(path, await file.text());
    return path;
  },
  async pickParentDirectory() {
    return "preview";
  },
  async readUserRange(path, offset, length) {
    const file = files.get(path);
    if (!file) throw new Error("That stem is no longer available in this preview.");
    const slice = file.slice(offset, offset + length);
    return new Uint8Array(await slice.arrayBuffer());
  },
  async createBundle() {
    throw new Error("Creating a project folder is available in the desktop app.");
  },
  async writeProject(projectFile, projectJson, options) {
    localStorage.setItem(PREVIEW_KEY, projectJson);
    texts.set(projectFile, projectJson);
    if (options?.download) downloadText("project.amix", projectJson);
  },
  async readProject(projectFile) {
    const json = texts.get(projectFile);
    if (json === undefined) throw new Error("That preview project is not open in this window.");
    return { projectFile, json };
  },
  async readProjectMediaRange(_projectFile, relativePath, offset, length) {
    const file = projectMedia.get(relativePath);
    if (!file) throw new Error("That stem is not in this preview.");
    return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  },
  async projectMediaStatus(_projectFile, relativePaths) {
    return relativePaths.map((relativePath) => {
      const file = projectMedia.get(relativePath);
      return {
        relativePath,
        exists: file !== undefined,
        fileSizeBytes: file?.size ?? 0,
        modifiedAtNs: file ? `${Math.round(file.lastModified)}000000` : "0",
      };
    });
  },
  rememberMedia(relativePath, sourcePath) {
    const file = files.get(sourcePath);
    if (file) projectMedia.set(relativePath, file);
  },
  async readProjectCache(_projectFile, relativePath) {
    const bytes = waveformCache.get(relativePath);
    return bytes ? bytes.slice() : null;
  },
  async writeProjectCache(_projectFile, relativePath, bytes) {
    const waveform = /^cache\/waveforms\/[A-Za-z0-9_-]+\.peaks$/.test(relativePath);
    const analysis = /^cache\/analysis\/[A-Za-z0-9_-]+\.json$/.test(relativePath);
    if (!waveform && !analysis) {
      throw new Error("Cache files must stay inside cache/waveforms or cache/analysis.");
    }
    waveformCache.set(relativePath, bytes.slice());
  },
  async analyzeTrackFile() {
    throw new Error("Stem analysis runs in the desktop app.");
  },
  hasPreview() {
    return localStorage.getItem(PREVIEW_KEY) !== null;
  },
  readPreview() {
    return localStorage.getItem(PREVIEW_KEY);
  },
  async appendLog() {},
};

export function browserFilesFromDrop(fileList: FileList | File[]): ListedFile[] {
  return [...fileList].map(rememberFile);
}
