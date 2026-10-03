import type { DesktopPlatform, ListedFile } from "./types";

const PREVIEW_KEY = "audiosous.preview.project";
const files = new Map<string, File>();
const texts = new Map<string, string>();

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
  async readProjectMediaRange() {
    throw new Error("Stem files are copied only in the desktop app.");
  },
  async projectMediaStatus(projectFile, relativePaths) {
    void projectFile;
    return relativePaths.map((relativePath) => ({ relativePath, exists: false, fileSizeBytes: 0 }));
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
