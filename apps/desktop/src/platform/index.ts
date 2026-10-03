import { browserPlatform } from "./browser";
import { isTauri, tauriPlatform } from "./tauri";
import type { DesktopPlatform } from "./types";

export function getPlatform(): DesktopPlatform {
  return isTauri() ? tauriPlatform : browserPlatform;
}

export { browserFilesFromDrop } from "./browser";
export { isTauri } from "./tauri";
export type { DesktopPlatform, ListedFile } from "./types";
