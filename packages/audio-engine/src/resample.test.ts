import { describe, expect, it } from "vitest";
import { createStreamResampler } from "./resample";

describe("stream resampler", () => {
  it("leaves audio unchanged when the rates already match", () => {
    const resampler = createStreamResampler(48_000, 48_000);
    const channel = Float32Array.from([0.25, -0.5, 0.75]);
    const [rendered] = resampler.process([channel], channel.length);
    expect(rendered).toBe(channel);
  });

  it("holds a steady level and rejects a 192 kHz tone the speakers cannot play", () => {
    const frames = 192_000;
    const steady = new Float32Array(frames).fill(0.5);
    const aliased = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) aliased[index] = index % 2 === 0 ? 1 : -1;
    const steadyOut = createStreamResampler(192_000, 48_000).process([steady], 48_000)[0]!;
    const aliasedOut = createStreamResampler(192_000, 48_000).process([aliased], 48_000)[0]!;
    expect(steadyOut[24_000]).toBeCloseTo(0.5, 2);
    let peak = 0;
    for (let index = 4_000; index < aliasedOut.length; index += 1) peak = Math.max(peak, Math.abs(aliasedOut[index]!));
    expect(peak).toBeLessThan(0.05);
  });

  it("keeps a 1 kHz sine continuous across chunk boundaries", () => {
    const inputRate = 192_000;
    const outputRate = 48_000;
    const inputFrames = inputRate;
    const outputFrames = outputRate;
    const sine = new Float32Array(inputFrames);
    for (let index = 0; index < inputFrames; index += 1) {
      sine[index] = Math.sin((2 * Math.PI * 1000 * index) / inputRate);
    }
    const whole = createStreamResampler(inputRate, outputRate).process([sine], outputFrames)[0]!;
    const split = createStreamResampler(inputRate, outputRate);
    const first = split.process([sine.subarray(0, inputFrames / 2)], outputFrames / 2)[0]!;
    const second = split.process([sine.subarray(inputFrames / 2)], outputFrames / 2)[0]!;
    expect(second[outputFrames / 4]).toBeCloseTo(whole[outputFrames / 2 + outputFrames / 4]!, 2);
    expect(first[100]).toBeCloseTo(whole[100]!, 2);
    const crossings = zeroCrossings(whole);
    expect(crossings).toBeGreaterThan(1900);
    expect(crossings).toBeLessThan(2100);
  });

  it("downsamples eleven 192 kHz stems for one second without falling behind playback", () => {
    const input = [new Float32Array(192_000), new Float32Array(192_000)];
    for (let index = 0; index < input[0]!.length; index += 8) input[0]![index] = Math.sin(index / 30);
    const started = Date.now();
    for (let stem = 0; stem < 11; stem += 1) {
      createStreamResampler(192_000, 48_000).process(input, 48_000);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

function zeroCrossings(samples: Float32Array): number {
  let count = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1] ?? 0;
    const value = samples[index] ?? 0;
    if ((previous <= 0 && value > 0) || (previous >= 0 && value < 0)) count += 1;
  }
  return count;
}
