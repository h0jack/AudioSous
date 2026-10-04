import {
  WaveformCancelled,
  buildWaveformPeaks,
  decodeWaveformPeaks,
  encodeWaveformPeaks,
  peaksMatchTrack,
  previewWaveformPeaks,
  waveformCachePath,
  type WaveformPeaks,
} from "@audiosous/audio-files";
import type { ProjectDocument } from "@audiosous/project-model";
import type { DesktopPlatform } from "../platform/types";
import { logEvent } from "./log";

export interface LoadedWaveform {
  peaks: WaveformPeaks;
  measured: boolean;
}

export interface WaveformLoadProgress {
  index: number;
  total: number;
  filename: string;
  fileRatio: number;
}

function isCancelledMeasurement(error: unknown): boolean {
  if (error instanceof WaveformCancelled) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.toLowerCase().includes("cancelled");
}

export function waveformLoadRatio(progress: WaveformLoadProgress): number {
  if (progress.total <= 0) return 1;
  const fileRatio = Math.min(1, Math.max(0, progress.fileRatio));
  return Math.min(1, (progress.index + fileRatio) / progress.total);
}

export async function loadProjectWaveforms(
  platform: DesktopPlatform,
  projectFile: string,
  document: ProjectDocument,
  options: { shouldCancel: () => boolean; onProgress: (progress: WaveformLoadProgress) => void },
): Promise<Record<string, LoadedWaveform>> {
  const loaded: Record<string, LoadedWaveform> = {};
  const tracks = document.tracks;
  let statuses: Array<{ relativePath: string; exists: boolean; fileSizeBytes: number }> = [];
  try {
    statuses = await platform.projectMediaStatus(
      projectFile,
      tracks.map((track) => track.file.relativePath),
    );
  } catch {
    statuses = [];
  }

  for (const [index, track] of tracks.entries()) {
    if (options.shouldCancel()) throw new WaveformCancelled();
    const report = (fileRatio: number) =>
      options.onProgress({ index, total: tracks.length, filename: track.file.filename, fileRatio });
    report(0);
    const status = statuses.find((item) => item.relativePath === track.file.relativePath);
    const cachePath = waveformCachePath(track.id);
    if (status?.exists) {
      try {
        const cached = await platform.readProjectCache(projectFile, cachePath);
        if (cached) {
          const decoded = decodeWaveformPeaks(cached);
          if (peaksMatchTrack(decoded, { fileSizeBytes: status.fileSizeBytes, sampleRate: track.metadata.sampleRate })) {
            loaded[track.id] = { peaks: decoded, measured: true };
            report(1);
            continue;
          }
        }
      } catch {
        // A damaged cache is measured again from the stem.
      }
      try {
        if (platform.kind === "tauri") {
          await platform.measureWaveform(projectFile, track.file.relativePath, track.id, (ratio) => {
            if (!options.shouldCancel()) report(ratio);
          });
          if (options.shouldCancel()) throw new WaveformCancelled();
          const written = await platform.readProjectCache(projectFile, cachePath);
          if (!written) throw new Error("Waveform cache was not written.");
          loaded[track.id] = { peaks: decodeWaveformPeaks(written), measured: true };
          report(1);
          continue;
        }
        const peaks = await buildWaveformPeaks(
          {
            size: status.fileSizeBytes,
            readAt: (offset, length) => platform.readProjectMediaRange(projectFile, track.file.relativePath, offset, length),
          },
          track.file.filename,
          { shouldCancel: options.shouldCancel, onProgress: report },
        );
        loaded[track.id] = { peaks, measured: true };
        try {
          await platform.writeProjectCache(projectFile, cachePath, encodeWaveformPeaks(peaks));
        } catch {
          // The lanes still draw. The next open measures this stem again.
        }
        report(1);
        continue;
      } catch (error) {
        if (options.shouldCancel() || isCancelledMeasurement(error)) throw new WaveformCancelled();
        await logEvent(platform, "error", "track.decode.failure", error instanceof Error ? error.message : "Waveform measurement failed.", {
          trackId: track.id,
          filename: track.file.filename,
        });
      }
    }
    loaded[track.id] = {
      peaks: previewWaveformPeaks({
        sampleRate: track.metadata.sampleRate,
        durationSeconds: track.metadata.durationSeconds,
        seed: track.id,
      }),
      measured: false,
    };
    report(1);
  }
  return loaded;
}
