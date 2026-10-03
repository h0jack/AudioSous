import { describe, expect, it } from "vitest";
import { bufferSource, inspectAudioFile } from "./inspect";
import { arrangementLevel, encodePcm16Wav, renderTestStem } from "./synthesize";

describe("test project stems", () => {
  it("keeps the kick quiet in the intro and loud in both drops", () => {
    expect(arrangementLevel("kick", 4)).toBe(0);
    expect(arrangementLevel("kick", 20)).toBeGreaterThan(0);
    expect(arrangementLevel("kick", 40)).toBe(1);
    expect(arrangementLevel("kick", 55)).toBe(0);
    expect(arrangementLevel("kick", 70)).toBe(1);
    const samples = renderTestStem("kick", 8_000, 80);
    const energy = (start: number, end: number) => {
      let sum = 0;
      const from = start * 8_000;
      const to = end * 8_000;
      for (let index = from; index < to; index += 1) sum += Math.abs(samples[index] ?? 0);
      return sum / (to - from);
    };
    expect(energy(30, 50)).toBeGreaterThan(energy(0, 15));
    expect(energy(65, 80)).toBeGreaterThan(energy(50, 65));
  });

  it("writes a WAV the importer can read", async () => {
    const wav = encodePcm16Wav(renderTestStem("bass", 8_000, 1), 8_000);
    const inspection = await inspectAudioFile(bufferSource(wav), "bass.wav");
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.format).toBe("wav");
    expect(inspection.sampleRate).toBe(8_000);
    expect(inspection.channelCount).toBe(1);
    expect(inspection.bitDepth).toBe(16);
    expect(inspection.durationSeconds).toBeCloseTo(1, 2);
  });
});
