import { inspectAudioFile, type ByteSource } from "@audiosous/audio-files";
import type { ListedFile } from "../platform/types";
import { pendingFromInspection, type PendingStem } from "./stems";

export async function inspectListedFiles(
  files: ListedFile[],
  readRange: (path: string, offset: number, length: number) => Promise<Uint8Array>,
  onProgress?: (label: string) => void,
): Promise<PendingStem[]> {
  const stems: PendingStem[] = [];
  for (const [index, file] of files.entries()) {
    onProgress?.(`Reading ${index + 1} of ${files.length}: ${file.filename}`);
    const source: ByteSource = {
      size: file.fileSizeBytes,
      readAt: (offset, length) => readRange(file.path, offset, length),
    };
    try {
      const inspection = await inspectAudioFile(source, file.filename);
      stems.push(pendingFromInspection(file.filename, file.path, inspection));
    } catch (error) {
      const message = error instanceof Error ? error.message : "The file could not be read.";
      stems.push(
        pendingFromInspection(file.filename, file.path, {
          ok: false,
          code: "unreadable",
          message: `${file.filename} could not be read. ${message}`,
          fileSizeBytes: file.fileSizeBytes,
        }),
      );
    }
  }
  return stems;
}
