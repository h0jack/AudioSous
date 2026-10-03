import { describe, expect, it } from "vitest";
import { decodePcmFrames } from "./decode";
import type { PcmLayout } from "./inspect";

const layout16: PcmLayout = {
  dataOffset: 0,
  dataBytes: 4,
  blockAlign: 4,
  encoding: "int",
  littleEndian: true,
  bitsPerSample: 16,
};

describe("PCM window decode", () => {
  it("splits a 16-bit stereo frame into unit-range channels", () => {
    const bytes = new Uint8Array(4);
    const view = new DataView(bytes.buffer);
    view.setInt16(0, 16_384, true);
    view.setInt16(2, -32_768, true);
    const [left, right] = decodePcmFrames(bytes, layout16, 2);
    expect(left?.[0]).toBeCloseTo(0.5, 5);
    expect(right?.[0]).toBeCloseTo(-1, 5);
  });

  it("scales a full-scale 24-bit sample", () => {
    const bytes = new Uint8Array([0xff, 0xff, 0x7f]);
    const [channel] = decodePcmFrames(bytes, { ...layout16, blockAlign: 3, bitsPerSample: 24, dataBytes: 3 }, 1);
    expect(channel?.[0]).toBeCloseTo(1, 5);
  });
});
