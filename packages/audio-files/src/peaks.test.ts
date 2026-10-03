import { describe, expect, it } from "vitest";
import { encodeExtended80 } from "./inspect";
import {
  bufferSource,
  buildWaveformPeaks,
  chooseWaveformLevel,
  clampScroll,
  decodeWaveformPeaks,
  encodeWaveformPeaks,
  energyEnvelope,
  pixelsPerSecondFor,
  timeToX,
  waveformCachePath,
  xToTime,
} from "./index";

function text(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function wav(options: { sampleRate: number; channels: number; bits: 16 | 24; samples: number[] }): Uint8Array {
  const bytesPerSample = options.bits / 8;
  const dataBytes = options.samples.length * bytesPerSample;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  text(bytes, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  text(bytes, 8, "WAVE");
  text(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, options.channels, true);
  view.setUint32(24, options.sampleRate, true);
  const blockAlign = options.channels * bytesPerSample;
  view.setUint32(28, options.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, options.bits, true);
  text(bytes, 36, "data");
  view.setUint32(40, dataBytes, true);
  options.samples.forEach((sample, index) => {
    const offset = 44 + index * bytesPerSample;
    if (options.bits === 16) {
      view.setInt16(offset, sample, true);
      return;
    }
    view.setUint8(offset, sample & 0xff);
    view.setUint8(offset + 1, (sample >> 8) & 0xff);
    view.setUint8(offset + 2, (sample >> 16) & 0xff);
  });
  return bytes;
}

function repeat(value: number, count: number): number[] {
  return Array.from({ length: count }, () => value);
}

describe("waveform peaks", () => {
  it("keeps a full-scale impulse and silence in the first resolution", async () => {
    const impulse = wav({
      sampleRate: 48_000,
      channels: 1,
      bits: 16,
      samples: [32_767, ...repeat(0, 255)],
    });
    const peaks = await buildWaveformPeaks(bufferSource(impulse), "kick.wav");
    expect(peaks.frames).toBe(256);
    expect(peaks.levels[0]?.maxs[0]).toBe(32_767);
    expect(peaks.levels[0]?.mins[0]).toBe(0);

    const silence = wav({ sampleRate: 48_000, channels: 1, bits: 16, samples: repeat(0, 256) });
    const quiet = await buildWaveformPeaks(bufferSource(silence), "silence.wav");
    expect(quiet.levels[0]?.mins[0]).toBe(0);
    expect(quiet.levels[0]?.maxs[0]).toBe(0);
  });

  it("scales 24-bit samples into the peak range", async () => {
    const samples = [0x7fffff, ...repeat(0, 255)];
    const peaks = await buildWaveformPeaks(
      bufferSource(wav({ sampleRate: 48_000, channels: 1, bits: 24, samples })),
      "bass.wav",
    );
    expect(peaks.levels[0]?.maxs[0]).toBe(32_767);
    expect(peaks.levels[0]?.mins[0]).toBe(0);
  });

  it("builds coarser levels from the finest min and max", async () => {
    const samples = [...repeat(32_000, 256), ...repeat(0, 768)];
    const peaks = await buildWaveformPeaks(
      bufferSource(wav({ sampleRate: 48_000, channels: 1, bits: 16, samples })),
      "hat.wav",
    );
    const fine = peaks.levels.find((level) => level.samplesPerPeak === 256)!;
    const coarse = peaks.levels.find((level) => level.samplesPerPeak === 1024)!;
    expect(fine.maxs[0]).toBe(32_000);
    expect(fine.maxs[1]).toBe(0);
    expect(coarse.mins.length).toBe(1);
    expect(coarse.maxs[0]).toBe(32_000);
    expect(coarse.mins[0]).toBe(0);
  });

  it("reads big-endian AIFF samples", async () => {
    const frames = 256;
    const data = new Uint8Array(frames * 2);
    const dataView = new DataView(data.buffer);
    dataView.setInt16(0, 32_000, false);
    const comm = new Uint8Array(18);
    const commView = new DataView(comm.buffer);
    commView.setInt16(0, 1, false);
    commView.setUint32(2, frames, false);
    commView.setInt16(6, 16, false);
    comm.set(encodeExtended80(48_000), 8);
    const bytes = new Uint8Array(12 + 8 + 18 + 8 + 8 + data.byteLength);
    const view = new DataView(bytes.buffer);
    text(bytes, 0, "FORM");
    view.setUint32(4, bytes.byteLength - 8, false);
    text(bytes, 8, "AIFF");
    text(bytes, 12, "COMM");
    view.setUint32(16, 18, false);
    bytes.set(comm, 20);
    text(bytes, 38, "SSND");
    view.setUint32(42, 8 + data.byteLength, false);
    view.setUint32(46, 0, false);
    view.setUint32(50, 0, false);
    bytes.set(data, 54);
    const peaks = await buildWaveformPeaks(bufferSource(bytes), "pad.aiff");
    expect(peaks.levels[0]?.maxs[0]).toBe(32_000);
  });

  it("round-trips the cache bytes", async () => {
    const peaks = await buildWaveformPeaks(
      bufferSource(wav({ sampleRate: 44_100, channels: 1, bits: 16, samples: [...repeat(-32_768, 10), ...repeat(0, 246)] })),
      "neg.wav",
    );
    const decoded = decodeWaveformPeaks(encodeWaveformPeaks(peaks));
    expect(decoded.sampleRate).toBe(44_100);
    expect(decoded.fileSizeBytes).toBe(peaks.fileSizeBytes);
    expect(decoded.levels[0]?.mins[0]).toBe(-32_768);
    expect(decoded.levels.map((level) => level.samplesPerPeak)).toEqual([256, 1024, 4096]);
  });

  it("picks one time scale for every stem", () => {
    const zoomedOut = chooseWaveformLevel([{ samplesPerPeak: 256 }, { samplesPerPeak: 1024 }, { samplesPerPeak: 4096 }], 48_000, 2);
    const zoomedIn = chooseWaveformLevel([{ samplesPerPeak: 4096 }, { samplesPerPeak: 256 }], 48_000, 800);
    expect(zoomedOut.samplesPerPeak).toBe(4096);
    expect(zoomedIn.samplesPerPeak).toBe(256);
    const pixelsPerSecond = pixelsPerSecondFor(120, 600, 2);
    expect(pixelsPerSecond).toBe(10);
    expect(timeToX(10, pixelsPerSecond, 2)).toBe(80);
    expect(xToTime(80, pixelsPerSecond, 2)).toBeCloseTo(10, 5);
    expect(clampScroll(500, 120, 600, pixelsPerSecond)).toBe(60);
    expect(waveformCachePath("track-kick")).toBe("cache/waveforms/track-kick.peaks");
    expect(() => waveformCachePath("../secret")).toThrow(/cache/);
  });

  it("averages peak energy without keeping PCM", () => {
    const loud = {
      version: 1 as const,
      sampleRate: 48_000,
      channelCount: 1,
      bitsPerSample: 16,
      fileSizeBytes: 10,
      frames: 48_000,
      levels: [{ samplesPerPeak: 24_000, mins: new Int16Array([0, -32_000]), maxs: new Int16Array([1_000, 32_000]) }],
    };
    const quiet = {
      ...loud,
      levels: [{ samplesPerPeak: 24_000, mins: new Int16Array([0, 0]), maxs: new Int16Array([0, 0]) }],
    };
    const envelope = energyEnvelope([loud, quiet], 1, 2);
    expect(envelope[0]).toBeCloseTo(1000 / 32768 / 2, 5);
    expect(envelope[1]).toBeCloseTo(32000 / 32768 / 2, 5);
    expect(energyEnvelope([null], 10, 4)).toEqual([0, 0, 0, 0]);
  });
});
