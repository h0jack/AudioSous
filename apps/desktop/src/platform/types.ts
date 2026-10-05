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
  jobId: number;
}

export interface EqCheckFilter {
  kind: "high-pass" | "low-pass" | "bell" | "low-shelf" | "high-shelf";
  frequencyHz: number;
  gainDb: number;
  q: number;
}

export interface EqCheckRequest {
  id: string;
  trackId: string;
  relativePath: string;
  windows: Array<[number, number]>;
  saved: EqCheckFilter[];
  candidate: EqCheckFilter[];
  lowHz: number;
  highHz: number;
}

export interface EqCheckResponse {
  id: string;
  result: { regionBeforeDb: number; regionAfterDb: number; totalBeforeDb: number; totalAfterDb: number; seconds: number } | null;
  error: string | null;
}

export interface SpatialStatsDto {
  leftDb: number;
  rightDb: number;
  correlation: number;
  monoLossDb: number;
  peakDbfs: number;
}

export interface SpatialCheckRequest {
  id: string;
  trackId: string;
  relativePath: string;
  windows: Array<[number, number]>;
  /** Saved EQ that runs before the spatial stage in this scope. */
  saved: EqCheckFilter[];
  before: { pan: number; width: number };
  after: { pan: number; width: number };
}

export interface SpatialCheckResponse {
  id: string;
  result: { before: SpatialStatsDto; after: SpatialStatsDto; seconds: number } | null;
  error: string | null;
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
  cancelAnalysis(jobId: number): Promise<void>;
  /** Runs candidate EQ filters over the playback proxies and measures the result. Desktop only. */
  checkEq(projectFile: string, requests: EqCheckRequest[]): Promise<EqCheckResponse[]>;
  /** Band levels measured from the playback proxies for EQ planning, cached per track. Desktop only. */
  eqBandFrames(projectFile: string, tracks: Array<{ trackId: string; relativePath: string }>): Promise<Array<{ trackId: string; json: string | null; error: string | null }>>;
  /** Stereo statistics measured from the playback proxies for spatial planning, cached per track. Desktop only. */
  stereoFrames(projectFile: string, tracks: Array<{ trackId: string; relativePath: string }>): Promise<Array<{ trackId: string; json: string | null; error: string | null }>>;
  /** Runs candidate pan/width through the native spatial stage on the playback proxies and measures the result. Desktop only. */
  checkSpatial(projectFile: string, requests: SpatialCheckRequest[]): Promise<SpatialCheckResponse[]>;
  measureWaveform(projectFile: string, relativePath: string, trackId: string, onProgress: (ratio: number) => void): Promise<void>;
  cancelWaveform(): Promise<void>;
  hasPreview(): boolean;
  readPreview(): string | null;
  appendLog(line: string): Promise<void>;
}
