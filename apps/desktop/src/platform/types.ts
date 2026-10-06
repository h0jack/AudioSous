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

export type DynamicsCheckNode =
  | { type: "compressor"; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; kneeDb: number; makeupDb: number }
  | { type: "ducking"; keyTrackId: string; keyDetector: "transient" | "smooth"; thresholdDb: number; rangeDb: number; attackMs: number; releaseMs: number }
  | { type: "transient"; attack: number; sustain: number }
  | { type: "dynamic-eq"; frequencyHz: number; q: number; keyTrackId: string | null; keyDetector: "transient" | "smooth"; thresholdDb: number; rangeDb: number; attackMs: number; releaseMs: number };

export interface DynamicsCheckRequest {
  id: string;
  trackId: string;
  relativePath: string;
  keyTrackId: string | null;
  keyRelativePath: string | null;
  windows: Array<[number, number]>;
  savedEq: EqCheckFilter[];
  before: DynamicsCheckNode[];
  after: DynamicsCheckNode[];
  kind: "compressor" | "ducking" | "transient" | "dynamic-eq";
  band: [number, number] | null;
}

export interface LevelStatsDto {
  rmsDb: number;
  peakDbfs: number;
  crestDb: number;
  p10Db: number;
  p50Db: number;
  p90Db: number;
  transientDb: number | null;
  bandOnDb: number | null;
  bandOffDb: number | null;
  levelOnDb: number | null;
  levelOffDb: number | null;
}

export interface DynamicsCheckResponse {
  id: string;
  result: {
    before: LevelStatsDto;
    after: LevelStatsDto;
    reductionP50Db: number;
    reductionP95Db: number;
    reductionMaxDb: number;
    keyOnShare: number | null;
    recoveredShare: number | null;
    seconds: number;
  } | null;
  error: string | null;
}

/** One mix variant as the native engine plays it (the same shape the monitor sends), for a whole-mix render check. */
export interface MixCheckVariant {
  name: string;
  tracks: Array<{ id: string; gainDb: number; muted: boolean }>;
  gainRegions: Array<{ trackId: string; startSeconds: number; endSeconds: number; gainDb: number }>;
  eq: Array<{ trackId: string; filters: EqCheckFilter[]; regions: Array<{ startSeconds: number; endSeconds: number; filters: EqCheckFilter[] }> }>;
  spatial: Array<{ trackId: string; pan: number; width: number; regions: Array<{ startSeconds: number; endSeconds: number; pan: number; width: number }> }>;
  dynamics: Array<{ trackId: string; nodes: DynamicsCheckNode[]; regions: Array<{ startSeconds: number; endSeconds: number; nodes: DynamicsCheckNode[] }> }>;
}

export interface MixCheckRequest {
  tracks: Array<{ trackId: string; relativePath: string }>;
  variants: MixCheckVariant[];
  windows: Array<[number, number]>;
  sections: Array<{ id: string; startSeconds: number; endSeconds: number }>;
  durationSeconds: number;
}

export interface MixCheckResult {
  name: string;
  seconds: number;
  peakDbfs: number;
  rmsDb: number;
  monoLossDb: number;
  correlation: number;
  sections: Array<{ id: string; rmsDb: number | null }>;
}

/** The assistant's provider settings as the shell reports them. Never contains the key. */
export interface AgentSettingsInfo {
  provider: "none" | "anthropic";
  model: string;
  effort: "low" | "medium" | "high";
  /** Where the key comes from: the ANTHROPIC_API_KEY environment variable, the app's settings, or nowhere. */
  keySource: "environment" | "settings" | null;
}

export interface SaveAgentSettings {
  provider: "none" | "anthropic";
  model: string;
  effort: "low" | "medium" | "high";
  /** A new key to store, or null to keep the stored one. */
  apiKey: string | null;
  clearKey: boolean;
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
  /** Level envelopes (10 ms RMS, peak, low band) measured from the playback proxies for dynamics planning, cached per track. Desktop only. */
  envelopeFrames(projectFile: string, tracks: Array<{ trackId: string; relativePath: string }>): Promise<Array<{ trackId: string; json: string | null; error: string | null }>>;
  /** Runs candidate dynamics through the native processors on the playback proxies and measures the result. Desktop only. */
  checkDynamics(projectFile: string, requests: DynamicsCheckRequest[]): Promise<DynamicsCheckResponse[]>;
  /** Renders mix variants from the playback proxies through the native DSP over windows and measures them. Desktop only. */
  checkMix(projectFile: string, request: MixCheckRequest): Promise<MixCheckResult[]>;
  measureWaveform(projectFile: string, relativePath: string, trackId: string, onProgress: (ratio: number) => void): Promise<void>;
  cancelWaveform(): Promise<void>;
  hasPreview(): boolean;
  readPreview(): string | null;
  appendLog(line: string): Promise<void>;
  /** Assistant provider settings, kept outside any project. */
  agentSettings(): Promise<AgentSettingsInfo>;
  saveAgentSettings(settings: SaveAgentSettings): Promise<AgentSettingsInfo>;
  /** A fetch that reaches the provider through the shell (which adds the key), or null where there is none. */
  agentFetch(): typeof fetch | null;
}
