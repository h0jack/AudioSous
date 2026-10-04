const TAPS = 63;
const HALF = (TAPS - 1) / 2;

export interface StreamResampler {
  reset(): void;
  process(channels: Float32Array[], outputFrames: number): Float32Array[];
}

export function createStreamResampler(inputRate: number, outputRate: number): StreamResampler {
  if (!(inputRate > 0) || !(outputRate > 0) || inputRate === outputRate) return identityResampler();
  const step = inputRate / outputRate;
  const cutoff = Math.min(0.5, (outputRate / inputRate) * 0.45);
  const kernel = lowpassKernel(cutoff);
  let pending: Float32Array[] = [];
  let pendingStart = 0;
  let produced = 0;

  return {
    reset() {
      pending = [];
      pendingStart = 0;
      produced = 0;
    },
    process(channels, outputFrames) {
      if (outputFrames <= 0 || channels.length === 0 || (channels[0]?.length ?? 0) === 0) {
        return channels.map(() => new Float32Array(Math.max(0, outputFrames)));
      }
      pending = concatSamples(pending, channels);
      const rendered = channels.map(() => new Float32Array(outputFrames));
      const length = pending[0]?.length ?? 0;
      for (let frame = 0; frame < outputFrames; frame += 1) {
        const position = (produced + frame) * step;
        const center = Math.round(position);
        const local = center - pendingStart;
        for (let channel = 0; channel < rendered.length; channel += 1) {
          const samples = pending[channel];
          if (!samples) continue;
          rendered[channel]![frame] = local - HALF >= 0 && local + HALF < length
            ? convolve(samples, local - HALF, kernel)
            : convolveEdge(samples, local, kernel);
        }
      }
      produced += outputFrames;
      const keepFrom = Math.floor(produced * step) - HALF;
      const drop = keepFrom - pendingStart;
      if (drop > 0 && drop < length) {
        pending = pending.map((channel) => channel.subarray(drop));
        pendingStart += drop;
      } else if (drop >= length) {
        pending = [];
        pendingStart += length;
      }
      return rendered;
    },
  };
}

function identityResampler(): StreamResampler {
  return {
    reset() {},
    process(channels, outputFrames) {
      return channels.map((channel) => {
        if (channel.length === outputFrames) return channel;
        const out = new Float32Array(Math.max(0, outputFrames));
        out.set(channel.subarray(0, out.length));
        return out;
      });
    },
  };
}

function lowpassKernel(cutoffCycles: number): Float32Array {
  const kernel = new Float32Array(TAPS);
  let sum = 0;
  for (let index = 0; index < TAPS; index += 1) {
    const offset = index - HALF;
    const sinc = offset === 0 ? 2 * cutoffCycles : Math.sin(2 * Math.PI * cutoffCycles * offset) / (Math.PI * offset);
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (TAPS - 1));
    kernel[index] = sinc * window;
    sum += kernel[index]!;
  }
  if (sum !== 0) {
    for (let index = 0; index < TAPS; index += 1) kernel[index] = kernel[index]! / sum;
  }
  return kernel;
}

function convolve(samples: Float32Array, start: number, kernel: Float32Array): number {
  let acc = 0;
  for (let tap = 0; tap < TAPS; tap += 1) acc += samples[start + tap]! * kernel[tap]!;
  return acc;
}

function convolveEdge(samples: Float32Array, center: number, kernel: Float32Array): number {
  let acc = 0;
  for (let tap = 0; tap < TAPS; tap += 1) {
    const index = center - HALF + tap;
    if (index >= 0 && index < samples.length) acc += samples[index]! * kernel[tap]!;
  }
  return acc;
}

function concatSamples(existing: Float32Array[], incoming: Float32Array[]): Float32Array[] {
  if (existing.length === 0) return incoming.map((channel) => channel.slice());
  return existing.map((channel, index) => {
    const extra = incoming[index] ?? new Float32Array();
    const merged = new Float32Array(channel.length + extra.length);
    merged.set(channel);
    merged.set(extra, channel.length);
    return merged;
  });
}
