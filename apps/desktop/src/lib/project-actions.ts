import { inspectAudioFile } from "@audiosous/audio-files";
import {
  deserializeProject,
  sanitizeBundleName,
  serializeProject,
  updateTrack,
  withUpdatedAt,
  type ImportWarning,
  type ProjectDocument,
  type TrackRole,
} from "@audiosous/project-model";
import type { DesktopPlatform } from "../platform/types";
import { useAppStore } from "../state/app-store";
import { logEvent } from "./log";
import { documentFromStems, type PendingStem } from "./stems";

export async function createProjectFromStems(input: {
  platform: DesktopPlatform;
  name: string;
  stems: PendingStem[];
  onProgress: (label: string) => void;
}): Promise<void> {
  const bundleName = sanitizeBundleName(input.name);
  const { document, copies } = documentFromStems({ name: bundleName, stems: input.stems });
  const projectJson = serializeProject(document);

  let projectFile = "preview://project.amix";
  if (input.platform.kind === "tauri") {
    if (copies.length !== document.tracks.length) {
      throw new Error("Every stem needs a source file before the project folder can be created.");
    }
    const parentDir = await input.platform.pickParentDirectory();
    if (!parentDir) return;
    input.onProgress("Copying stems");
    const created = await input.platform.createBundle({
      parentDir,
      bundleName,
      projectJson,
      copies,
      onProgress: (progress) => {
        input.onProgress(`Copying ${Math.min(progress.completedFiles + 1, progress.totalFiles)} of ${progress.totalFiles}: ${progress.filename}`);
      },
    });
    projectFile = created.projectFile;
  } else {
    await input.platform.writeProject(projectFile, projectJson, { download: false });
  }

  await logEvent(input.platform, "info", "project.create", "Created a project.", {
    name: document.project.name,
    tracks: document.tracks.length,
    projectFile,
  });
  for (const track of document.tracks) {
    await logEvent(input.platform, "info", "track.import", "Imported a stem.", {
      trackId: track.id,
      filename: track.file.filename,
      role: track.role,
      sampleRate: track.metadata.sampleRate,
      durationSeconds: track.metadata.durationSeconds,
    });
  }
  useAppStore.getState().openDocument(document, projectFile, []);
}

export async function openChosenProject(platform: DesktopPlatform, projectFile: string): Promise<void> {
  const loaded = await platform.readProject(projectFile);
  const document = deserializeProject(loaded.json);
  const warnings = await warningsForMedia(platform, loaded.projectFile, document);
  await logEvent(platform, "info", "project.open", "Opened a project.", {
    name: document.project.name,
    tracks: document.tracks.length,
    projectFile: loaded.projectFile,
  });
  useAppStore.getState().openDocument(document, loaded.projectFile, warnings);
}

export async function saveOpenProject(platform: DesktopPlatform): Promise<void> {
  const { document, projectFilePath } = useAppStore.getState();
  if (!document || !projectFilePath) return;
  const next = withUpdatedAt(document);
  const projectJson = serializeProject(next);
  await platform.writeProject(projectFilePath, projectJson, { download: platform.kind === "browser" });
  useAppStore.getState().replaceDocument(next, false);
  await logEvent(platform, "info", "project.save", "Saved the project.", {
    name: next.project.name,
    projectFile: projectFilePath,
  });
}

export function editTrack(trackId: string, patch: { name?: string; role?: TrackRole; customLabel?: string | null }): void {
  const document = useAppStore.getState().document;
  if (!document) return;
  useAppStore.getState().replaceDocument(updateTrack(document, trackId, patch), true);
}

export function editProjectName(name: string): void {
  const document = useAppStore.getState().document;
  if (!document) return;
  useAppStore.getState().replaceDocument({ ...document, project: { ...document.project, name } }, true);
}

async function warningsForMedia(
  platform: DesktopPlatform,
  projectFile: string,
  document: ProjectDocument,
): Promise<ImportWarning[]> {
  if (platform.kind !== "tauri") return [];
  const status = await platform.projectMediaStatus(
    projectFile,
    document.tracks.map((track) => track.file.relativePath),
  );
  const warnings: ImportWarning[] = [];
  for (const track of document.tracks) {
    const info = status.find((item) => item.relativePath === track.file.relativePath);
    if (!info?.exists) {
      warnings.push({
        code: "missing-file",
        message: `${track.file.filename} is missing from the project folder.`,
        filename: track.file.filename,
        trackId: track.id,
      });
      await logEvent(platform, "error", "track.decode.failure", "A project stem is missing.", {
        trackId: track.id,
        filename: track.file.filename,
      });
      continue;
    }
    try {
      const inspection = await inspectAudioFile(
        {
          size: info.fileSizeBytes,
          readAt: (offset, length) => platform.readProjectMediaRange(projectFile, track.file.relativePath, offset, length),
        },
        track.file.filename,
      );
      if (!inspection.ok) {
        warnings.push({
          code: inspection.code === "unsupported" ? "unsupported-format" : "unreadable-file",
          message: inspection.message,
          filename: track.file.filename,
          trackId: track.id,
        });
      } else if (inspection.sampleRate !== track.metadata.sampleRate) {
        warnings.push({
          code: "sample-rate-mismatch",
          message: `${track.file.filename} is ${inspection.sampleRate} Hz on disk and ${track.metadata.sampleRate} Hz in the project.`,
          filename: track.file.filename,
          trackId: track.id,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The stem could not be read.";
      warnings.push({
        code: "unreadable-file",
        message: `${track.file.filename} could not be read. ${message}`,
        filename: track.file.filename,
        trackId: track.id,
      });
    }
  }
  return warnings;
}
