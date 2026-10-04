import { inspectAudioFile } from "@audiosous/audio-files";
import {
  deserializeProject,
  sanitizeBundleName,
  serializeProject,
  addManualSection,
  applyAutomaticSections,
  clearSuggestedSections,
  mergeSectionWithNext,
  moveSectionBoundary,
  removeSection,
  splitSection,
  setTrackSectionState,
  updateSection,
  updateTrack,
  withUpdatedAt,
  type ImportWarning,
  type ProjectDocument,
  type SuggestedSection,
  type TrackRole,
  type TrackSectionState,
} from "@audiosous/project-model";
import { getPlatform, type DesktopPlatform } from "../platform";
import { useAppStore, type DocumentEdit } from "../state/app-store";
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
  for (const copy of copies) {
    input.platform.rememberMedia(copy.relativePath, copy.sourcePath);
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

export async function saveOpenProject(platform: DesktopPlatform, options?: { download?: boolean }): Promise<void> {
  const { document, projectFilePath } = useAppStore.getState();
  if (!document || !projectFilePath) return;
  const snapshot = document;
  const next = withUpdatedAt(snapshot);
  const projectJson = serializeProject(next);
  const savedPath = await platform.writeProject(projectFilePath, projectJson, { download: options?.download ?? false });
  if (savedPath !== projectFilePath) useAppStore.getState().setProjectFilePath(savedPath);
  if (useAppStore.getState().document !== snapshot) return;
  useAppStore.getState().replaceDocument(next, false, { mode: "skip" });
  await logEvent(platform, "info", "project.save", "Saved the project.", {
    name: next.project.name,
    projectFile: projectFilePath,
  });
}

export function editTrack(
  trackId: string,
  patch: {
    name?: string;
    role?: TrackRole;
    customLabel?: string | null;
    gainDb?: number;
    pan?: number;
    muted?: boolean;
    solo?: boolean;
  },
): void {
  const document = useAppStore.getState().document;
  if (!document) return;
  const key =
    patch.gainDb !== undefined
      ? `gain:${trackId}`
      : patch.pan !== undefined
        ? `pan:${trackId}`
        : patch.name !== undefined
          ? `name:${trackId}`
          : patch.customLabel !== undefined
            ? `label:${trackId}`
            : null;
  useAppStore.getState().replaceDocument(updateTrack(document, trackId, patch), true, {
    mode: key ? "coalesce" : "record",
    key,
  });
}

export function addSectionFromRange(startTime: number, endTime: number): string | null {
  const document = useAppStore.getState().document;
  if (!document) return "No project is open.";
  const result = addManualSection(document, { startTime, endTime });
  if (!result.ok) return result.message;
  useAppStore.getState().replaceDocument(result.document, true);
  void logEvent(getPlatform(), "info", "section.create", "Created a section.", { startTime, endTime });
  return null;
}

export function editSection(
  sectionId: string,
  patch: {
    name?: string;
    type?: ProjectDocument["sections"][number]["type"];
    startTime?: number;
    endTime?: number;
    userIntent?: string | null;
  },
): string | null {
  const document = useAppStore.getState().document;
  if (!document) return "No project is open.";
  const result = updateSection(document, sectionId, patch);
  if (!result.ok) return result.message;
  useAppStore.getState().replaceDocument(result.document, true, editForSection(sectionId, patch));
  void logEvent(getPlatform(), "info", "section.update", "Updated a section.", { sectionId });
  return null;
}

export function editTrackSection(
  trackId: string,
  sectionId: string,
  patch: { userIntent?: string | null; prominence?: TrackSectionState["prominence"] },
): string | null {
  const document = useAppStore.getState().document;
  if (!document) return "No project is open.";
  const result = setTrackSectionState(document, trackId, sectionId, patch);
  if (!result.ok) return result.message;
  const key = patch.userIntent !== undefined ? `track-intent:${trackId}:${sectionId}` : null;
  useAppStore.getState().replaceDocument(result.document, true, { mode: key ? "coalesce" : "record", key });
  return null;
}

export function dragSectionBoundary(fromTime: number, toTime: number, key: string): { ok: true; time: number } | { ok: false; message: string } {
  const document = useAppStore.getState().document;
  if (!document) return { ok: false, message: "No project is open." };
  const result = moveSectionBoundary(document, fromTime, toTime);
  if (!result.ok) return result;
  if (result.document !== document) {
    useAppStore.getState().replaceDocument(result.document, true, { mode: "coalesce", key });
  }
  return { ok: true, time: result.time ?? fromTime };
}

export function finishBoundaryDrag(fromTime: number, toTime: number): void {
  if (Math.abs(fromTime - toTime) < 0.0005) return;
  void logEvent(getPlatform(), "info", "section.update", "Moved a section guide.", { fromTime, toTime });
}

export function splitSectionAt(sectionId: string, time: number): string | null {
  const document = useAppStore.getState().document;
  if (!document) return "No project is open.";
  const result = splitSection(document, sectionId, time);
  if (!result.ok) return result.message;
  useAppStore.getState().replaceDocument(result.document, true);
  void logEvent(getPlatform(), "info", "section.update", "Split a section.", { sectionId, time });
  return null;
}

export function mergeSection(sectionId: string): string | null {
  const document = useAppStore.getState().document;
  if (!document) return "No project is open.";
  const result = mergeSectionWithNext(document, sectionId);
  if (!result.ok) return result.message;
  useAppStore.getState().replaceDocument(result.document, true);
  void logEvent(getPlatform(), "info", "section.update", "Merged a section with the next one.", { sectionId });
  return null;
}

export function rejectSectionSuggestions(): string | null {
  const document = useAppStore.getState().document;
  if (!document) return "No project is open.";
  const next = clearSuggestedSections(document);
  if (next === document) return "There are no unedited suggestions to clear.";
  useAppStore.getState().replaceDocument(next, true);
  void logEvent(getPlatform(), "info", "section.delete", "Cleared suggested sections.", {});
  return null;
}

export function acceptSectionSuggestions(suggestions: SuggestedSection[]): string | null {
  const document = useAppStore.getState().document;
  if (!document) return "No project is open.";
  const result = applyAutomaticSections(document, suggestions);
  if (!result.ok) return result.message;
  useAppStore.getState().replaceDocument(result.document, true);
  void logEvent(getPlatform(), "info", "section.analysis.complete", "Applied section suggestions.", {
    sections: result.document.sections.length,
  });
  return null;
}

function editForSection(
  sectionId: string,
  patch: { name?: string; userIntent?: string | null },
): DocumentEdit {
  if (patch.name !== undefined) return { mode: "coalesce", key: `section-name:${sectionId}` };
  if (patch.userIntent !== undefined) return { mode: "coalesce", key: `section-intent:${sectionId}` };
  return { mode: "record" };
}

export function deleteSection(sectionId: string): void {
  const document = useAppStore.getState().document;
  if (!document) return;
  useAppStore.getState().replaceDocument(removeSection(document, sectionId), true);
  void logEvent(getPlatform(), "info", "section.delete", "Deleted a section.", { sectionId });
}

export function editProjectName(name: string): void {
  const document = useAppStore.getState().document;
  if (!document) return;
  useAppStore.getState().replaceDocument({ ...document, project: { ...document.project, name } }, true, {
    mode: "coalesce",
    key: "project-name",
  });
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
