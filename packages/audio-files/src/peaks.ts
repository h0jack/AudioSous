import { inspectAudioFile, type ByteSource, type PcmLayout } from "./inspect";

/** Frames of audio folded into one min/max pair. Coarser levels are derived from 256. */
export const WAVEFORM_LEVELS = [256, 1024, 4096] as const;

export const MIN_TIMELINE_ZOOM = 1;
export const MAX_TIMELINE_ZOOM = 64;

const FINEST_FRAMES = WAVEFORM_LEVELS[0];
const READ_LIMIT = 1_048_576;
const MAX_PEAKS = 2_000_000;

export interface WaveformLevel {
  samplesPerPeak: number;
  mins: Int16Array;
  maxs: Int16Array;
}

export interface WaveformPeaks {
  version: 1;
  sampleRate: number;
  channelCount: number;
  bitsPerSample: number;
  fileSizeBytes: number;
  frames: number;
  levels: WaveformLevel[];
}

export class WaveformCancelled extends Error {
  constructor() {
    super("Waveform measurement was cancelled.");
    this.name = "WaveformCancelled";
  }
}

export function waveformCachePath(trackId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(trackId)) {
    throw new Error("Waveform cache must stay inside cache/waveforms.");
  }
  return `cache/waveforms/${trackId}.peaks`;
}

export function peaksMatchTrack(
  peaks: WaveformPeaks,
  track: { fileSizeBytes: number; sampleRate: number },
): boolean {
  return peaks.fileSizeBytes > 0 && peaks.fileSizeBytes === track.fileSizeBytes && peaks.sampleRate === track.sampleRate;
}

export async function buildWaveformPeaks(
  source: ByteSource,
  filename: string,
  options?: { shouldCancel?: () => boolean; onProgress?: (ratio: number) => void },
): Promise<WaveformPeaks> {
  const inspection = await inspectAudioFile(source, filename);
  if (!inspection.ok) {
    throw new Error(inspection.message);
  }
  if (inspection.pcm.dataBytes <= 0) {
    throw new Error(`${filename} has no audio samples.`);
  }
  const pcm = inspection.pcm;
  const bytesPerSample = pcm.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || pcm.blockAlign !== inspection.channelCount * bytesPerSample) {
    throw new Error(`${filename} has an unsupported sample layout.`);
  }
  if (![8, 16, 24, 32, 64].includes(pcm.bitsPerSample)) {
    throw new Error(`${filename} uses ${pcm.bitsPerSample}-bit audio, which cannot be measured yet.`);
  }

  const mins: number[] = [];
  const maxs: number[] = [];
  let bucketMin = 32_767;
  let bucketMax = -32_768;
  let framesInBucket = 0;
  let frames = 0;
  const end = pcm.dataOffset + pcm.dataBytes;
  let offset = pcm.dataOffset;
  const chunkBytes = READ_LIMIT - (READ_LIMIT % pcm.blockAlign);

  while (offset + pcm.blockAlign <= end) {
    if (options?.shouldCancel?.()) throw new WaveformCancelled();
    const length = Math.min(chunkBytes, end - offset);
    const aligned = length - (length % pcm.blockAlign);
    if (aligned <= 0) break;
    const bytes = await source.readAt(offset, aligned);
    const usable = bytes.byteLength - (bytes.byteLength % pcm.blockAlign);
    if (usable <= 0) break;
    const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
    const frameCount = usable / pcm.blockAlign;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let sampleMin = 32_767;
      let sampleMax = -32_768;
      for (let channel = 0; channel < inspection.channelCount; channel += 1) {
        const sample = readSample(view, frame * pcm.blockAlign + channel * bytesPerSample, pcm);
        if (sample < sampleMin) sampleMin = sample;
        if (sample > sampleMax) sampleMax = sample;
      }
      if (sampleMin < bucketMin) bucketMin = sampleMin;
      if (sampleMax > bucketMax) bucketMax = sampleMax;
      framesInBucket += 1;
      frames += 1;
      if (framesInBucket === FINEST_FRAMES) {
        mins.push(bucketMin);
        maxs.push(bucketMax);
        bucketMin = 32_767;
        bucketMax = -32_768;
        framesInBucket = 0;
      }
    }
    offset += usable;
    options?.onProgress?.(Math.min(1, (offset - pcm.dataOffset) / pcm.dataBytes));
    await yieldToUi();
  }
  if (framesInBucket > 0) {
    mins.push(bucketMin);
    maxs.push(bucketMax);
  }

  const fine = { samplesPerPeak: FINEST_FRAMES, mins: Int16Array.from(mins), maxs: Int16Array.from(maxs) };
  return {
    version: 1,
    sampleRate: inspection.sampleRate,
    channelCount: inspection.channelCount,
    bitsPerSample: pcm.bitsPerSample,
    fileSizeBytes: source.size,
    frames,
    levels: [
      fine,
      downsample(fine, 1024 / FINEST_FRAMES, 1024),
      downsample(fine, 4096 / FINEST_FRAMES, 4096),
    ],
  };
}

function yieldToUi(): Promise<void> {
  const timer = (globalThis as { setTimeout?: (fn: () => void, delay: number) => void }).setTimeout;
  if (!timer) return Promise.resolve();
  return new Promise((resolve) => timer(resolve, 0));
}

function downsample(source: WaveformLevel, factor: number, samplesPerPeak: number): WaveformLevel {
  const count = Math.ceil(source.mins.length / factor);
  const mins = new Int16Array(count);
  const maxs = new Int16Array(count);
  for (let index = 0; index < count; index += 1) {
    let min = 32_767;
    let max = -32_768;
    for (let step = 0; step < factor; step += 1) {
      const from = index * factor + step;
      if (from >= source.mins.length) break;
      if (source.mins[from]! < min) min = source.mins[from]!;
      if (source.maxs[from]! > max) max = source.maxs[from]!;
    }
    mins[index] = min;
    maxs[index] = max;
  }
  return { samplesPerPeak, mins, maxs };
}

function readSample(view: DataView, offset: number, pcm: PcmLayout): number {
  if (pcm.encoding === "float") {
    const value = pcm.bitsPerSample === 64 ? view.getFloat64(offset, pcm.littleEndian) : view.getFloat32(offset, pcm.littleEndian);
    if (!Number.isFinite(value)) return 0;
    return Math.round(Math.max(-1, Math.min(1, value)) * 32_767);
  }
  if (pcm.bitsPerSample === 8) {
    return (view.getUint8(offset) - 128) << 8;
  }
  if (pcm.bitsPerSample === 16) {
    return view.getInt16(offset, pcm.littleEndian);
  }
  if (pcm.bitsPerSample === 24) {
    const b0 = view.getUint8(offset);
    const b1 = view.getUint8(offset + 1);
    const b2 = view.getUint8(offset + 2);
    const unsigned = pcm.littleEndian ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2;
    const signed = unsigned & 0x800000 ? unsigned - 0x1000000 : unsigned;
    return signed >> 8;
  }
  return view.getInt32(offset, pcm.littleEndian) >> 16;
}

export function encodeWaveformPeaks(peaks: WaveformPeaks): Uint8Array {
  let body = 36;
  for (const level of peaks.levels) {
    if (level.mins.length !== level.maxs.length) throw new Error("Waveform peaks are incomplete.");
    body += 8 + level.mins.length * 4;
  }
  const bytes = new Uint8Array(body);
  const view = new DataView(bytes.buffer);
  bytes.set([0x41, 0x53, 0x50, 0x4b], 0);
  view.setUint32(4, 1, true);
  view.setUint32(8, peaks.sampleRate, true);
  view.setUint16(12, peaks.channelCount, true);
  view.setUint16(14, peaks.bitsPerSample, true);
  view.setBigUint64(16, BigInt(Math.max(0, Math.floor(peaks.fileSizeBytes))), true);
  view.setBigUint64(24, BigInt(peaks.frames), true);
  view.setUint16(32, peaks.levels.length, true);
  let cursor = 36;
  for (const level of peaks.levels) {
    view.setUint32(cursor, level.samplesPerPeak, true);
    view.setUint32(cursor + 4, level.mins.length, true);
    cursor += 8;
    for (let index = 0; index < level.mins.length; index += 1) {
      view.setInt16(cursor, level.mins[index]!, true);
      view.setInt16(cursor + 2, level.maxs[index]!, true);
      cursor += 4;
    }
  }
  return bytes;
}

export function decodeWaveformPeaks(bytes: Uint8Array): WaveformPeaks {
  if (bytes.byteLength < 36) throw new Error("Waveform cache is incomplete.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x41 || bytes[1] !== 0x53 || bytes[2] !== 0x50 || bytes[3] !== 0x4b) {
    throw new Error("Waveform cache is not an Audiosous peak file.");
  }
  if (view.getUint32(4, true) !== 1) throw new Error("Waveform cache version is not supported.");
  const levelCount = view.getUint16(32, true);
  if (levelCount < 1 || levelCount > 8) throw new Error("Waveform cache is incomplete.");
  const levels: WaveformLevel[] = [];
  let cursor = 36;
  for (let levelIndex = 0; levelIndex < levelCount; levelIndex += 1) {
    if (cursor + 8 > bytes.byteLength) throw new Error("Waveform cache is incomplete.");
    const samplesPerPeak = view.getUint32(cursor, true);
    const count = view.getUint32(cursor + 4, true);
    if (![256, 1024, 4096].includes(samplesPerPeak) || count > MAX_PEAKS) {
      throw new Error("Waveform cache is incomplete.");
    }
    cursor += 8;
    if (cursor + count * 4 > bytes.byteLength) throw new Error("Waveform cache is incomplete.");
    const mins = new Int16Array(count);
    const maxs = new Int16Array(count);
    for (let index = 0; index < count; index += 1) {
      mins[index] = view.getInt16(cursor, true);
      maxs[index] = view.getInt16(cursor + 2, true);
      cursor += 4;
    }
    levels.push({ samplesPerPeak, mins, maxs });
  }
  return {
    version: 1,
    sampleRate: view.getUint32(8, true),
    channelCount: view.getUint16(12, true),
    bitsPerSample: view.getUint16(14, true),
    fileSizeBytes: Number(view.getBigUint64(16, true)),
    frames: Number(view.getBigUint64(24, true)),
    levels,
  };
}

export function chooseWaveformLevel<T extends { samplesPerPeak: number }>(
  levels: readonly T[],
  sampleRate: number,
  pixelsPerSecond: number,
): T {
  if (levels.length === 0) throw new Error("Waveform has no levels.");
  const framesPerPixel = sampleRate / Math.max(pixelsPerSecond, 0.001);
  const sorted = [...levels].sort((left, right) => left.samplesPerPeak - right.samplesPerPeak);
  let chosen = sorted[0]!;
  for (const level of sorted) {
    if (level.samplesPerPeak <= framesPerPixel) chosen = level;
  }
  return chosen;
}

export function pixelsPerSecondFor(durationSeconds: number, viewportWidth: number, zoom: number): number {
  const fit = viewportWidth / Math.max(durationSeconds, 0.001);
  return fit * clampTimelineZoom(zoom);
}

export function clampTimelineZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_TIMELINE_ZOOM;
  return Math.min(MAX_TIMELINE_ZOOM, Math.max(MIN_TIMELINE_ZOOM, zoom));
}

export function timeToX(seconds: number, pixelsPerSecond: number, scrollSeconds: number): number {
  return (seconds - scrollSeconds) * pixelsPerSecond;
}

export function xToTime(x: number, pixelsPerSecond: number, scrollSeconds: number): number {
  return scrollSeconds + x / Math.max(pixelsPerSecond, 0.001);
}

export function clampScroll(scrollSeconds: number, durationSeconds: number, viewportWidth: number, pixelsPerSecond: number): number {
  const visible = viewportWidth / Math.max(pixelsPerSecond, 0.001);
  const maxScroll = Math.max(0, durationSeconds - visible);
  if (!Number.isFinite(scrollSeconds)) return 0;
  return Math.min(Math.max(0, scrollSeconds), maxScroll);
}

export function rulerStepSeconds(pixelsPerSecond: number): number {
  const candidates = [0.1, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const step of candidates) {
    if (step * pixelsPerSecond >= 80) return step;
  }
  return 300;
}

/** Shapes for a preview that has no PCM. These are not written to the project cache. */
export function previewWaveformPeaks(input: { sampleRate: number; durationSeconds: number; seed: string }): WaveformPeaks {
  const frames = Math.max(1, Math.round(input.durationSeconds * input.sampleRate));
  const count = Math.ceil(frames / FINEST_FRAMES);
  const mins = new Int16Array(count);
  const maxs = new Int16Array(count);
  let hash = 2166136261;
  for (const char of input.seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const phase = ((hash >>> 8) % 628) / 100;
  const song = Math.max(input.durationSeconds, 0.001);
  for (let index = 0; index < count; index += 1) {
    const time = (index * FINEST_FRAMES) / input.sampleRate;
    const place = time / song;
    const arc = place < 0.18 ? 0.35 : place < 0.42 ? 0.72 : place < 0.7 ? 1 : place < 0.86 ? 0.55 : 0.3;
    const wobble = 0.55 + 0.45 * Math.abs(Math.sin(time * (2 + (hash % 7)) + phase));
    const amp = Math.round(arc * wobble * (12_000 + (hash % 5) * 1_200));
    mins[index] = Math.min(0, amp);
    maxs[index] = Math.max(0, amp);
  }
  const fine = { samplesPerPeak: FINEST_FRAMES, mins, maxs };
  return buildPreview(input, frames, fine);
}

function buildPreview(
  input: { sampleRate: number },
  frames: number,
  fine: WaveformLevel,
): WaveformPeaks {
  return {
    version: 1,
    sampleRate: input.sampleRate,
    channelCount: 1,
    bitsPerSample: 16,
    fileSizeBytes: 0,
    frames,
    levels: [fine, downsample(fine, 4, 1024), downsample(fine, 16, 4096)],
  };
}

/** Average peak level across stems, sampled evenly across the song. PCM is not read. */
export function energyEnvelope(peaks: Array<WaveformPeaks | null | undefined>, durationSeconds: number, points = 240): number[] {
  const usable = peaks.filter((item): item is WaveformPeaks => Boolean(item && item.levels.length > 0 && item.frames > 0 && item.sampleRate > 0));
  const envelope = new Array<number>(Math.max(2, points)).fill(0);
  if (usable.length === 0 || durationSeconds <= 0) return envelope;
  for (const peak of usable) {
    const level = peak.levels[peak.levels.length - 1];
    if (!level || level.mins.length === 0) continue;
    const secondsPerPeak = level.samplesPerPeak / peak.sampleRate;
    for (let index = 0; index < envelope.length; index += 1) {
      const time = (index / (envelope.length - 1)) * durationSeconds;
      const bin = Math.min(level.mins.length - 1, Math.max(0, Math.floor(time / secondsPerPeak)));
      const amplitude = Math.max(Math.abs(level.mins[bin] ?? 0), Math.abs(level.maxs[bin] ?? 0)) / 32768;
      envelope[index] += amplitude;
    }
  }
  for (let index = 0; index < envelope.length; index += 1) envelope[index] /= usable.length;
  return envelope;
}
