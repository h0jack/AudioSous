import type { AudioInspection } from "@audiosous/audio-files";
import {
  createProject,
  guessTrackRole,
  mediaRelativePath,
  trackNameFromFilename,
  type ImportWarning,
  type ImportedStem,
  type ProjectDocument,
  type TrackRole,
} from "@audiosous/project-model";

export interface PendingStem {
  key: string;
  filename: string;
  sourcePath: string | null;
  name: string;
  role: TrackRole;
  customLabel: string;
  inspection: AudioInspection;
}

export function pendingFromInspection(filename: string, sourcePath: string | null, inspection: AudioInspection): PendingStem {
  return {
    key: crypto.randomUUID(),
    filename,
    sourcePath,
    name: trackNameFromFilename(filename),
    role: guessTrackRole(filename),
    customLabel: "",
    inspection,
  };
}

export function demoStems(): PendingStem[] {
  const names = ["kick.wav", "bass.wav", "trumpet.wav", "synth-pad.wav", "percussion.wav", "fx.wav"];
  return names.map((filename) =>
    pendingFromInspection(filename, null, {
      ok: true,
      format: "wav",
      sampleRate: 48_000,
      channelCount: 2,
      bitDepth: 24,
      durationSeconds: 241.72,
      fileSizeBytes: 34_807_296,
      truncated: false,
    }),
  );
}

export function stemsAsImported(stems: PendingStem[]): ImportedStem[] {
  return stems.map((stem) => {
    if (!stem.inspection.ok) {
      return {
        ok: false,
        filename: stem.filename,
        code: stem.inspection.code,
        message: stem.inspection.message,
        fileSizeBytes: stem.inspection.fileSizeBytes,
      };
    }
    return {
      ok: true,
      filename: stem.filename,
      format: stem.inspection.format,
      sampleRate: stem.inspection.sampleRate,
      channelCount: stem.inspection.channelCount,
      bitDepth: stem.inspection.bitDepth,
      durationSeconds: stem.inspection.durationSeconds,
      fileSizeBytes: stem.inspection.fileSizeBytes,
      truncated: stem.inspection.truncated,
    };
  });
}

export function documentFromStems(input: {
  name: string;
  stems: PendingStem[];
  now?: Date;
  createId?: () => string;
}): { document: ProjectDocument; copies: Array<{ sourcePath: string; relativePath: string }> } {
  const createId = input.createId ?? (() => crypto.randomUUID());
  const copies: Array<{ sourcePath: string; relativePath: string }> = [];
  const tracks = input.stems.flatMap((stem) => {
    if (!stem.inspection.ok) return [];
    const id = createId();
    const relativePath = mediaRelativePath(id, stem.filename);
    if (stem.sourcePath) copies.push({ sourcePath: stem.sourcePath, relativePath });
    return [
      {
        id,
        name: stem.name,
        role: stem.role,
        customLabel: stem.role === "other" ? stem.customLabel : null,
        relativePath,
        filename: stem.filename,
        metadata: {
          format: stem.inspection.format,
          sampleRate: stem.inspection.sampleRate,
          channelCount: stem.inspection.channelCount,
          bitDepth: stem.inspection.bitDepth,
          durationSeconds: stem.inspection.durationSeconds,
          fileSizeBytes: stem.inspection.fileSizeBytes,
        },
      },
    ];
  });

  if (tracks.length === 0) {
    throw new Error("Add at least one readable WAV or AIFF stem.");
  }

  return {
    document: createProject({ name: input.name, tracks, now: input.now }),
    copies,
  };
}

export function warningSummary(warnings: ImportWarning[]): string {
  if (warnings.length === 0) return "No import warnings.";
  return warnings.map((warning) => warning.message).join(" ");
}
