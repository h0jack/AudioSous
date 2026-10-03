export interface ByteSource {
  size: number;
  readAt(offset: number, length: number): Promise<Uint8Array>;
}

export interface PcmLayout {
  dataOffset: number;
  dataBytes: number;
  blockAlign: number;
  encoding: "int" | "float";
  littleEndian: boolean;
  bitsPerSample: number;
}

export type AudioInspection =
  | {
      ok: true;
      format: "wav" | "aiff";
      sampleRate: number;
      channelCount: number;
      bitDepth: number | null;
      durationSeconds: number;
      fileSizeBytes: number;
      truncated: boolean;
      pcm: PcmLayout;
    }
  | {
      ok: false;
      code: "unsupported" | "unreadable";
      message: string;
      fileSizeBytes: number;
    };

const UNSUPPORTED_EXTENSIONS = new Set(["mp3", "flac", "ogg", "m4a", "aac", "wma", "aifc"]);

export async function inspectAudioFile(source: ByteSource, filename: string): Promise<AudioInspection> {
  const extension = extensionOf(filename);
  if (source.size < 12) {
    return fail(source.size, "unreadable", `${filename} is too small to be a WAV or AIFF stem.`);
  }

  let header: Uint8Array;
  try {
    header = await readExact(source, 0, 12);
  } catch {
    return fail(source.size, "unreadable", `${filename} could not be read.`);
  }

  const magic = ascii(header, 0, 4);
  const formType = ascii(header, 8, 4);

  try {
    if (magic === "RIFF" || magic === "RF64") {
      if (formType !== "WAVE") {
        return fail(source.size, "unsupported", `${filename} is not a PCM WAV stem.`);
      }
      return await inspectWav(source, filename, magic === "RF64");
    }
    if (magic === "RIFX") {
      return fail(source.size, "unsupported", `${filename} is big-endian WAV, which is not supported yet. Export standard WAV.`);
    }
    if (magic === "FORM" && (formType === "AIFF" || formType === "AIFC")) {
      return await inspectAiff(source, filename, formType === "AIFC");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : `${filename} could not be read.`;
    return fail(source.size, "unreadable", message);
  }

  if (UNSUPPORTED_EXTENSIONS.has(extension)) {
    return fail(
      source.size,
      "unsupported",
      `${extension.toUpperCase()} stems are not supported. Export WAV or AIFF from the DAW.`,
    );
  }
  return fail(source.size, "unsupported", `${filename} is not a WAV or AIFF stem.`);
}

export function bufferSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    async readAt(offset, length) {
      return bytes.subarray(offset, Math.min(bytes.byteLength, offset + length));
    },
  };
}

async function inspectWav(source: ByteSource, filename: string, rf64: boolean): Promise<AudioInspection> {
  let offset = 12;
  let sampleRate: number | null = null;
  let channelCount: number | null = null;
  let bitDepth: number | null = null;
  let blockAlign: number | null = null;
  let dataSize: number | null = null;
  let dataOffset: number | null = null;
  let rf64DataSize: number | null = null;
  let encoding: "int" | "float" | null = null;

  while (offset + 8 <= source.size) {
    const head = await readExact(source, offset, 8);
    const id = ascii(head, 0, 4);
    let size = viewOf(head).getUint32(4, true);

    if (id === "fmt ") {
      const bodyLength = Math.min(size, 64);
      if (offset + 8 + bodyLength > source.size || bodyLength < 16) {
        return fail(source.size, "unreadable", `${filename} has a broken WAV format chunk.`);
      }
      const body = await readExact(source, offset + 8, bodyLength);
      const parsed = parseFmt(body);
      if (!parsed) {
        return fail(source.size, "unsupported", `${filename} is not uncompressed PCM or float WAV.`);
      }
      sampleRate = parsed.sampleRate;
      channelCount = parsed.channelCount;
      bitDepth = parsed.bitDepth;
      blockAlign = parsed.blockAlign;
      encoding = parsed.encoding;
    } else if (id === "ds64" && rf64) {
      if (offset + 8 + 28 > source.size) {
        return fail(source.size, "unreadable", `${filename} has a broken RF64 header.`);
      }
      const body = await readExact(source, offset + 8, 28);
      const bodyView = viewOf(body);
      rf64DataSize = Number(bodyView.getBigUint64(8, true));
    } else if (id === "data") {
      dataOffset = offset + 8;
      if (size === 0xffffffff && rf64DataSize !== null) {
        dataSize = rf64DataSize;
      } else {
        dataSize = size;
      }
    }

    if (sampleRate !== null && dataOffset !== null && dataSize !== null) break;

    if (size === 0xffffffff) break;
    const padded = size + (size % 2);
    if (offset + 8 + padded > source.size) break;
    offset += 8 + padded;
  }

  if (
    sampleRate === null ||
    channelCount === null ||
    blockAlign === null ||
    encoding === null ||
    dataOffset === null ||
    dataSize === null
  ) {
    return fail(source.size, "unreadable", `${filename} is missing WAV format or audio data.`);
  }
  if (sampleRate <= 0 || channelCount <= 0 || blockAlign <= 0 || blockAlign % channelCount !== 0) {
    return fail(source.size, "unreadable", `${filename} has an invalid WAV format.`);
  }

  const available = Math.max(0, source.size - dataOffset);
  const truncated = dataSize > available;
  const bytes = Math.min(dataSize, available);
  return {
    ok: true,
    format: "wav",
    sampleRate,
    channelCount,
    bitDepth,
    durationSeconds: bytes / (sampleRate * blockAlign),
    fileSizeBytes: source.size,
    truncated,
    pcm: {
      dataOffset,
      dataBytes: bytes,
      blockAlign,
      encoding,
      littleEndian: true,
      bitsPerSample: (blockAlign / channelCount) * 8,
    },
  };
}

function parseFmt(body: Uint8Array): {
  sampleRate: number;
  channelCount: number;
  bitDepth: number;
  blockAlign: number;
  encoding: "int" | "float";
} | null {
  const view = viewOf(body);
  const tag = view.getUint16(0, true);
  const channelCount = view.getUint16(2, true);
  const sampleRate = view.getUint32(4, true);
  const blockAlign = view.getUint16(12, true);
  const bits = view.getUint16(14, true);

  let formatTag = tag;
  let bitDepth = bits;
  if (tag === 0xfffe) {
    if (body.byteLength < 40) return null;
    const validBits = view.getUint16(18, true);
    if (validBits > 0) bitDepth = validBits;
    formatTag = view.getUint16(24, true);
  }
  if (formatTag !== 1 && formatTag !== 3) return null;
  return { sampleRate, channelCount, bitDepth, blockAlign, encoding: formatTag === 3 ? "float" : "int" };
}

async function inspectAiff(source: ByteSource, filename: string, compressed: boolean): Promise<AudioInspection> {
  let offset = 12;
  let channelCount: number | null = null;
  let sampleRate: number | null = null;
  let bitDepth: number | null = null;
  let frames: number | null = null;
  let littleEndian = false;
  let encoding: "int" | "float" = "int";
  let dataOffset: number | null = null;

  while (offset + 8 <= source.size) {
    const head = await readExact(source, offset, 8);
    const id = ascii(head, 0, 4);
    const size = viewOf(head).getUint32(4, false);
    if (id === "COMM") {
      if (offset + 8 + 18 > source.size || size < 18) {
        return fail(source.size, "unreadable", `${filename} has a broken AIFF common chunk.`);
      }
      const body = await readExact(source, offset + 8, Math.min(size, 64));
      const view = viewOf(body);
      channelCount = view.getInt16(0, false);
      frames = view.getUint32(2, false);
      bitDepth = view.getInt16(6, false);
      sampleRate = decodeExtended80(body.subarray(8, 18));
      if (compressed) {
        const compression = ascii(body, 18, 4).toLowerCase();
        const allowed = new Set(["none", "sowt", "twos", "raw ", "in24", "in32", "fl32", "fl64"]);
        if (!allowed.has(compression)) {
          return fail(source.size, "unsupported", `${filename} uses ${compression.trim() || "compressed"} AIFF, which is not supported.`);
        }
        littleEndian = compression === "sowt";
        encoding = compression === "fl32" || compression === "fl64" ? "float" : "int";
      }
    } else if (id === "SSND") {
      if (offset + 16 > source.size || size < 8) {
        return fail(source.size, "unreadable", `${filename} has a broken AIFF sound chunk.`);
      }
      const sound = await readExact(source, offset + 8, 8);
      const soundOffset = viewOf(sound).getUint32(0, false);
      dataOffset = offset + 16 + soundOffset;
    }

    const padded = size + (size % 2);
    if (padded > source.size) break;
    offset += 8 + padded;
  }

  if (
    sampleRate === null ||
    channelCount === null ||
    frames === null ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    channelCount <= 0
  ) {
    return fail(source.size, "unreadable", `${filename} is missing an AIFF common chunk.`);
  }

  const bits = bitDepth && bitDepth > 0 ? bitDepth : 16;
  const bytesPerSample = Math.ceil(bits / 8);
  const blockAlign = channelCount * bytesPerSample;
  const declared = frames * blockAlign;
  const available = dataOffset === null ? 0 : Math.max(0, source.size - dataOffset);
  const dataBytes = Math.min(declared, available);
  return {
    ok: true,
    format: "aiff",
    sampleRate: Math.round(sampleRate),
    channelCount,
    bitDepth,
    durationSeconds: frames / sampleRate,
    fileSizeBytes: source.size,
    truncated: dataOffset !== null && declared > available,
    pcm: {
      dataOffset: dataOffset ?? 0,
      dataBytes,
      blockAlign,
      encoding,
      littleEndian,
      bitsPerSample: bytesPerSample * 8,
    },
  };
}

export function decodeExtended80(bytes: Uint8Array): number {
  const exponent = ((bytes[0]! & 0x7f) << 8) | bytes[1]!;
  let mantissa = 0n;
  for (let index = 0; index < 8; index += 1) {
    mantissa = (mantissa << 8n) | BigInt(bytes[2 + index]!);
  }
  if (exponent === 0 && mantissa === 0n) return 0;
  const value = Number(mantissa) * 2 ** (exponent - 16383 - 63);
  return bytes[0]! & 0x80 ? -value : value;
}

export function encodeExtended80(value: number): Uint8Array {
  const out = new Uint8Array(10);
  if (!Number.isFinite(value) || value === 0) return out;
  const sign = value < 0 ? 1 : 0;
  const magnitude = Math.abs(value);
  const exponent = Math.floor(Math.log2(magnitude));
  const mantissa = BigInt(Math.round((magnitude / 2 ** exponent) * 2 ** 63));
  const biased = exponent + 16383;
  out[0] = ((sign << 7) | (biased >> 8)) & 0xff;
  out[1] = biased & 0xff;
  for (let index = 0; index < 8; index += 1) {
    out[2 + index] = Number((mantissa >> BigInt(56 - index * 8)) & 0xffn);
  }
  return out;
}

function extensionOf(filename: string): string {
  const match = /\.([^.]+)$/.exec(filename.toLowerCase());
  return match?.[1] ?? "";
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return text;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function readExact(source: ByteSource, offset: number, length: number): Promise<Uint8Array> {
  if (offset < 0 || length < 0 || offset + length > source.size) {
    throw new Error("Unexpected end of file.");
  }
  const bytes = await source.readAt(offset, length);
  if (bytes.byteLength !== length) {
    throw new Error("Unexpected end of file.");
  }
  return bytes;
}

function fail(fileSizeBytes: number, code: "unsupported" | "unreadable", message: string): AudioInspection {
  return { ok: false, code, message, fileSizeBytes };
}
