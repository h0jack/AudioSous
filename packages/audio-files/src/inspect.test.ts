import { describe, expect, it } from "vitest";
import { bufferSource, decodeExtended80, encodeExtended80, inspectAudioFile, type ByteSource } from "./inspect";

function text(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function wavHeader(options: {
  sampleRate: number;
  channels: number;
  bits: number;
  dataBytes: number;
  junkBytes?: number;
  extensible?: boolean;
  fileSize?: number;
}): { source: ByteSource; fileSize: number } {
  const junk = options.junkBytes ?? 0;
  const junkPad = junk % 2;
  const fmtBody = options.extensible ? 40 : 16;
  const headerSize = 12 + 8 + fmtBody + (junk ? 8 + junk + junkPad : 0) + 8;
  const header = new Uint8Array(headerSize);
  const view = new DataView(header.buffer);
  const blockAlign = options.channels * (options.bits / 8);
  const fileSize = options.fileSize ?? headerSize + options.dataBytes;
  text(header, 0, "RIFF");
  view.setUint32(4, fileSize - 8, true);
  text(header, 8, "WAVE");
  text(header, 12, "fmt ");
  view.setUint32(16, fmtBody, true);
  view.setUint16(20, options.extensible ? 0xfffe : 1, true);
  view.setUint16(22, options.channels, true);
  view.setUint32(24, options.sampleRate, true);
  view.setUint32(28, options.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, options.bits, true);
  let cursor = 36;
  if (options.extensible) {
    view.setUint16(36, 22, true);
    view.setUint16(38, options.bits, true);
    view.setUint32(40, 0, true);
    header[44] = 1;
    header[45] = 0;
    header[46] = 0;
    header[47] = 0;
    header[48] = 0;
    header[49] = 0;
    header[50] = 16;
    header[51] = 0;
    header[52] = 128;
    header[53] = 0;
    header[54] = 0;
    header[55] = 170;
    header[56] = 0;
    header[57] = 56;
    header[58] = 155;
    header[59] = 113;
    cursor = 60;
  }
  if (junk) {
    text(header, cursor, "JUNK");
    view.setUint32(cursor + 4, junk, true);
    cursor += 8 + junk + junkPad;
  }
  text(header, cursor, "data");
  view.setUint32(cursor + 4, options.dataBytes, true);

  return {
    fileSize,
    source: {
      size: fileSize,
      async readAt(offset, length) {
        if (offset < 0 || offset + length > header.byteLength) {
          throw new Error(`unexpected read at ${offset}`);
        }
        return header.subarray(offset, offset + length);
      },
    },
  };
}

describe("WAV inspection", () => {
  it("reads a 24-bit stereo header without loading samples", async () => {
    const dataBytes = 48_000 * 2 * 3;
    const { source } = wavHeader({ sampleRate: 48_000, channels: 2, bits: 24, dataBytes });
    const result = await inspectAudioFile(source, "kick.wav");
    expect(result).toMatchObject({
      ok: true,
      format: "wav",
      sampleRate: 48_000,
      channelCount: 2,
      bitDepth: 24,
      durationSeconds: 1,
      truncated: false,
    });
  });

  it("skips a padded chunk before the data header", async () => {
    const { source } = wavHeader({
      sampleRate: 44_100,
      channels: 1,
      bits: 16,
      dataBytes: 44_100 * 2,
      junkBytes: 5,
    });
    const result = await inspectAudioFile(source, "hat.wav");
    expect(result).toMatchObject({ ok: true, durationSeconds: 1, sampleRate: 44_100, channelCount: 1 });
  });

  it("reads WAVE_FORMAT_EXTENSIBLE PCM", async () => {
    const { source } = wavHeader({
      sampleRate: 48_000,
      channels: 2,
      bits: 24,
      dataBytes: 48_000 * 6,
      extensible: true,
    });
    const result = await inspectAudioFile(source, "bass.wav");
    expect(result).toMatchObject({ ok: true, bitDepth: 24, durationSeconds: 1 });
  });

  it("marks a short file as truncated", async () => {
    const { source } = wavHeader({
      sampleRate: 48_000,
      channels: 2,
      bits: 16,
      dataBytes: 48_000 * 4,
      fileSize: 44 + 1000,
    });
    const result = await inspectAudioFile(source, "cut.wav");
    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) expect(result.durationSeconds).toBeLessThan(1);
  });

  it("rejects mp3 and broken files", async () => {
    const mp3 = await inspectAudioFile(bufferSource(Uint8Array.from([0x49, 0x44, 0x33, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "loop.mp3");
    expect(mp3).toMatchObject({ ok: false, code: "unsupported" });
    const tiny = await inspectAudioFile(bufferSource(Uint8Array.from([1, 2, 3])), "kick.wav");
    expect(tiny).toMatchObject({ ok: false, code: "unreadable" });
  });
});

describe("AIFF inspection", () => {
  it("round-trips common sample rates through the 80-bit rate field", () => {
    for (const rate of [44_100, 48_000, 96_000]) {
      expect(decodeExtended80(encodeExtended80(rate))).toBeCloseTo(rate, 3);
    }
  });

  it("reads an uncompressed AIFF common chunk", async () => {
    const frames = 48_000;
    const comm = new Uint8Array(18);
    const commView = new DataView(comm.buffer);
    commView.setInt16(0, 2, false);
    commView.setUint32(2, frames, false);
    commView.setInt16(6, 16, false);
    comm.set(encodeExtended80(48_000), 8);
    const header = new Uint8Array(12 + 8 + 18);
    const view = new DataView(header.buffer);
    text(header, 0, "FORM");
    view.setUint32(4, header.byteLength - 8, false);
    text(header, 8, "AIFF");
    text(header, 12, "COMM");
    view.setUint32(16, 18, false);
    header.set(comm, 20);
    const result = await inspectAudioFile(bufferSource(header), "pad.aiff");
    expect(result).toMatchObject({
      ok: true,
      format: "aiff",
      sampleRate: 48_000,
      channelCount: 2,
      bitDepth: 16,
      durationSeconds: 1,
    });
  });
});
