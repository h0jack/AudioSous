import { describe, expect, it } from "vitest";
import { AUDIO_ENGINE_INTERFACE_VERSION, createUnboundAudioEngine } from "./index";

describe("audio engine contract", () => {
  it("stays unbound until synchronized playback exists", async () => {
    const engine = createUnboundAudioEngine();
    expect(AUDIO_ENGINE_INTERFACE_VERSION).toBe(1);
    expect(engine.getCurrentTime()).toBe(0);
    expect(engine.getDuration()).toBe(0);
    engine.dispose();
    await expect(engine.play()).rejects.toThrow(/not connected/);
  });
});
