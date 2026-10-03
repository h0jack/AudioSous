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

export async function loadProjectWaveforms(
  platform: DesktopPlatform,
  projectFile: string,
  document: ProjectDocument,
  options: { shouldCancel: () => boolean; onProgress: (label: string) => void },
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
    options.onProgress(`Measuring ${index + 1} of ${tracks.length}: ${track.file.filename}`);
    const status = statuses.find((item) => item.relativePath === track.file.relativePath);
    const cachePath = waveformCachePath(track.id);
    if (status?.exists) {
      try {
        const cached = await platform.readProjectCache(projectFile, cachePath);
        if (cached) {
          const decoded = decodeWaveformPeaks(cached);
          if (peaksMatchTrack(decoded, { fileSizeBytes: status.fileSizeBytes, sampleRate: track.metadata.sampleRate })) {
            loaded[track.id] = { peaks: decoded, measured: true };
            continue;
          }
        }
      } catch {
        // A damaged cache is measured again from the stem.
      }
      try {
        const peaks = await buildWaveformPeaks(
          {
            size: status.fileSizeBytes,
            readAt: (offset, length) => platform.readProjectMediaRange(projectFile, track.file.relativePath, offset, length),
          },
          track.file.filename,
          { shouldCancel: options.shouldCancel, onProgress: () => undefined },
        );
        loaded[track.id] = { peaks, measured: true };
        try {
          await platform.writeProjectCache(projectFile, cachePath, encodeWaveformPeaks(peaks));
        } catch {
          // The lanes still draw. The next open measures this stem again.
        }
        continue;
      } catch (error) {
        if (error instanceof WaveformCancelled) throw error;
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
  }
  return loaded;
}
