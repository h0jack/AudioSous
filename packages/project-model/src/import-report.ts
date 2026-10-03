import { projectTiming } from "./create-project";
import type { Track } from "./schema";

export type ImportWarningCode =
  | "sample-rate-mismatch"
  | "duration-mismatch"
  | "unreadable-file"
  | "unsupported-format"
  | "truncated-file"
  | "mixed-bit-depth"
  | "mixed-channel-count"
  | "missing-file";

export interface ImportWarning {
  code: ImportWarningCode;
  message: string;
  filename?: string;
  trackId?: string;
}

export type ImportedStem =
  | {
      ok: true;
      filename: string;
      trackId?: string;
      format: Track["metadata"]["format"];
      sampleRate: number;
      channelCount: number;
      bitDepth: number | null;
      durationSeconds: number;
      fileSizeBytes: number;
      truncated: boolean;
    }
  | {
      ok: false;
      filename: string;
      trackId?: string;
      code: "unsupported" | "unreadable";
      message: string;
      fileSizeBytes: number;
    };

export interface ImportReport {
  warnings: ImportWarning[];
  readableCount: number;
  sampleRate: number | null;
  bitDepth: number | null;
  durationSeconds: number;
}

const DURATION_FRACTION = 0.05;
const DURATION_FLOOR_SECONDS = 2;

export function buildImportReport(stems: ImportedStem[]): ImportReport {
  const warnings: ImportWarning[] = [];
  const readable = stems.filter((stem) => stem.ok);

  for (const stem of stems) {
    if (stem.ok) continue;
    warnings.push({
      code: stem.code === "unsupported" ? "unsupported-format" : "unreadable-file",
      message: stem.message,
      filename: stem.filename,
      trackId: stem.trackId,
    });
  }

  for (const stem of readable) {
    if (stem.truncated) {
      warnings.push({
        code: "truncated-file",
        message: `${stem.filename} is shorter than its header claims. It can still be imported.`,
        filename: stem.filename,
        trackId: stem.trackId,
      });
    }
  }

  let sampleRate: number | null = null;
  let durationSeconds = 0;
  let bitDepth: number | null = null;

  if (readable.length > 0) {
    const timing = projectTiming(readable.map((stem) => ({ metadata: stem })));
    sampleRate = timing.sampleRate;
    durationSeconds = timing.durationSeconds;
    const rates = new Map<number, string[]>();
    for (const stem of readable) {
      const names = rates.get(stem.sampleRate) ?? [];
      names.push(stem.filename);
      rates.set(stem.sampleRate, names);
    }
    if (rates.size > 1) {
      const parts = [...rates.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([rate, names]) => `${rate} Hz (${names.join(", ")})`);
      warnings.push({
        code: "sample-rate-mismatch",
        message: `Sample rates differ: ${parts.join("; ")}. The project rate is ${sampleRate} Hz.`,
      });
    }

    const threshold = Math.max(DURATION_FLOOR_SECONDS, durationSeconds * DURATION_FRACTION);
    for (const stem of readable) {
      if (durationSeconds - stem.durationSeconds > threshold) {
        warnings.push({
          code: "duration-mismatch",
          message: `${stem.filename} is much shorter than the longest stem. It will still load.`,
          filename: stem.filename,
          trackId: stem.trackId,
        });
      }
    }

    const depths = new Set(readable.map((stem) => stem.bitDepth));
    bitDepth = depths.size === 1 ? [...depths][0] ?? null : null;
    if (depths.size > 1) {
      warnings.push({
        code: "mixed-bit-depth",
        message: "Bit depth is not the same on every stem.",
      });
    }

    const channels = new Set(readable.map((stem) => stem.channelCount));
    if (channels.size > 1) {
      warnings.push({
        code: "mixed-channel-count",
        message: "Channel count is not the same on every stem.",
      });
    }
  }

  warnings.sort((a, b) => a.code.localeCompare(b.code) || (a.filename ?? "").localeCompare(b.filename ?? ""));

  return {
    warnings,
    readableCount: readable.length,
    sampleRate,
    bitDepth,
    durationSeconds,
  };
}
