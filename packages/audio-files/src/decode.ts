import type { PcmLayout } from "./inspect";

/** Deinterleaved channel samples in the range −1..1. The input must be whole frames. */
export function decodePcmFrames(bytes: Uint8Array, pcm: PcmLayout, channelCount: number): Float32Array[] {
  const bytesPerSample = pcm.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0 || channelCount <= 0) {
    return [];
  }
  const frames = Math.floor(bytes.byteLength / pcm.blockAlign);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = readFloatSample(view, frame * pcm.blockAlign + channel * bytesPerSample, pcm);
      channels[channel]![frame] = sample;
    }
  }
  return channels;
}

function readFloatSample(view: DataView, offset: number, pcm: PcmLayout): number {
  if (pcm.encoding === "float") {
    const value = pcm.bitsPerSample === 64 ? view.getFloat64(offset, pcm.littleEndian) : view.getFloat32(offset, pcm.littleEndian);
    return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  }
  if (pcm.bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128;
  if (pcm.bitsPerSample === 16) return view.getInt16(offset, pcm.littleEndian) / 32768;
  if (pcm.bitsPerSample === 24) {
    const b0 = view.getUint8(offset);
    const b1 = view.getUint8(offset + 1);
    const b2 = view.getUint8(offset + 2);
    const unsigned = pcm.littleEndian ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2;
    const signed = unsigned & 0x800000 ? unsigned - 0x1000000 : unsigned;
    return signed / 8388608;
  }
  return view.getInt32(offset, pcm.littleEndian) / 2147483648;
}
