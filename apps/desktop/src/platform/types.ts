export interface ListedFile {
  path: string;
  filename: string;
  fileSizeBytes: number;
}

export interface CopyProgress {
  completedFiles: number;
  totalFiles: number;
  filename: string;
}

export interface MediaStatus {
  relativePath: string;
  exists: boolean;
  fileSizeBytes: number;
  modifiedAtNs: string;
}

export interface TrackAnalysisBridgeResult {
  ok: boolean;
  message: string;
  detail: string;
  measurementJson: string;
  fileSizeBytes: number;
  modifiedAtNs: string;
  durationMs: number;
}

export interface AnalyzeAudioRequest {
  relativePaths: string[];
  scopeType: "track" | "section" | "time-range" | "mix";
  startSeconds?: number;
  endSeconds?: number;
}

export interface DesktopPlatform {
  kind: "tauri" | "browser";
  pickAudioFiles(): Promise<ListedFile[] | null>;
  pickAudioFolder(): Promise<ListedFile[] | null>;
  listAudioFiles(paths: string[]): Promise<ListedFile[]>;
  pickProjectFile(): Promise<string | null>;
  pickParentDirectory(): Promise<string | null>;
  readUserRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  createBundle(input: {
    parentDir: string;
    bundleName: string;
    projectJson: string;
    copies: Array<{ sourcePath: string; relativePath: string }>;
    onProgress: (progress: CopyProgress) => void;
  }): Promise<{ bundleDir: string; projectFile: string }>;
  writeProject(projectFile: string, projectJson: string, options?: { download?: boolean }): Promise<string>;
  readProject(projectFile: string): Promise<{ projectFile: string; json: string }>;
  readProjectMediaRange(projectFile: string, relativePath: string, offset: number, length: number): Promise<Uint8Array>;
  projectMediaStatus(projectFile: string, relativePaths: string[]): Promise<MediaStatus[]>;
  rememberMedia(relativePath: string, sourcePath: string): void;
  readProjectCache(projectFile: string, relativePath: string): Promise<Uint8Array | null>;
  writeProjectCache(projectFile: string, relativePath: string, bytes: Uint8Array): Promise<void>;
  analyzeTrackFile(projectFile: string, relativePath: string): Promise<TrackAnalysisBridgeResult>;
  analyzeAudio(projectFile: string, request: AnalyzeAudioRequest): Promise<TrackAnalysisBridgeResult>;
  hasPreview(): boolean;
  readPreview(): string | null;
  appendLog(line: string): Promise<void>;
}
