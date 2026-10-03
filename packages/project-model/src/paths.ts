import { PathSafetyError } from "./errors";

const TRACK_ID = /^[A-Za-z0-9_-]+$/;

/** Bundle-relative media paths only. Absolute paths and parent segments are rejected. */
export function assertSafeRelativePath(relativePath: string): void {
  if (!relativePath || relativePath.length > 512 || relativePath.includes("\0")) {
    throw new PathSafetyError("Media path must stay inside the project media folder.");
  }
  if (
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(relativePath) ||
    !relativePath.startsWith("media/")
  ) {
    throw new PathSafetyError("Media path must stay inside the project media folder.");
  }

  const parts = relativePath.split(/[\\/]/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new PathSafetyError("Media path must stay inside the project media folder.");
  }
}

export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "stem.wav";
  const cleaned = base.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "stem.wav";
  return cleaned.slice(0, 180);
}

export function mediaRelativePath(trackId: string, filename: string): string {
  if (!TRACK_ID.test(trackId)) {
    throw new PathSafetyError("Track id contains characters that cannot be used in a media path.");
  }
  const relativePath = `media/${trackId}__${sanitizeFilename(filename)}`;
  assertSafeRelativePath(relativePath);
  return relativePath;
}

export function sanitizeBundleName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new PathSafetyError("Enter a project name.");
  }
  return cleaned.slice(0, 120);
}
