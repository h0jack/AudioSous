export const TEST_ARRANGEMENT = [
  { name: "Intro", start: 0, end: 15 },
  { name: "Build", start: 15, end: 30 },
  { name: "Drop", start: 30, end: 50 },
  { name: "Breakdown", start: 50, end: 65 },
  { name: "Drop 2", start: 65, end: 80 },
] as const;

export const TEST_STEMS = ["kick", "bass", "percussion", "pad", "lead", "fx"] as const;

export type TestStemKind = (typeof TEST_STEMS)[number];

const LEVELS: Record<TestStemKind, Record<(typeof TEST_ARRANGEMENT)[number]["name"], number>> = {
  kick: { Intro: 0, Build: 0.35, Drop: 1, Breakdown: 0, "Drop 2": 1 },
  bass: { Intro: 0.08, Build: 0.45, Drop: 0.9, Breakdown: 0.12, "Drop 2": 0.9 },
  percussion: { Intro: 0.05, Build: 0.4, Drop: 0.85, Breakdown: 0.08, "Drop 2": 0.8 },
  pad: { Intro: 0.45, Build: 0.55, Drop: 0.35, Breakdown: 0.7, "Drop 2": 0.35 },
  lead: { Intro: 0, Build: 0.25, Drop: 0.8, Breakdown: 0.15, "Drop 2": 0.85 },
  fx: { Intro: 0.2, Build: 0.35, Drop: 0.15, Breakdown: 0.4, "Drop 2": 0.15 },
};

export function arrangementLevel(kind: TestStemKind, timeSeconds: number): number {
  const region = TEST_ARRANGEMENT.find((item) => timeSeconds >= item.start && timeSeconds < item.end) ?? TEST_ARRANGEMENT[TEST_ARRANGEMENT.length - 1]!;
  return LEVELS[kind][region.name];
}

export function renderTestStem(kind: TestStemKind, sampleRate: number, seconds = 80): Float32Array {
  const frames = Math.max(1, Math.floor(sampleRate * seconds));
  const samples = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const time = index / sampleRate;
    const level = arrangementLevel(kind, time);
    samples[index] = level * voice(kind, time);
  }
  return samples;
}

export function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
  }
  return new Uint8Array(buffer);
}

function voice(kind: TestStemKind, time: number): number {
  if (kind === "kick") {
    const beat = time % 0.5;
    return beat < 0.05 ? Math.sin(2 * Math.PI * 55 * beat) * (1 - beat / 0.05) : 0;
  }
  if (kind === "bass") return Math.sin(2 * Math.PI * 55 * time);
  if (kind === "percussion") {
    const beat = time % 0.25;
    return beat < 0.02 ? (beat / 0.02) * 2 - 1 : 0;
  }
  if (kind === "pad") return Math.sin(2 * Math.PI * 220 * time) * 0.5 + Math.sin(2 * Math.PI * 277 * time) * 0.25;
  if (kind === "lead") return Math.sin(2 * Math.PI * (440 + 40 * Math.sin(2 * Math.PI * 0.25 * time)) * time);
  const noise = Math.sin(2 * Math.PI * 1200 * time) * Math.sin(2 * Math.PI * 0.2 * time);
  return noise * 0.4;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}
