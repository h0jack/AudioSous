import type { AudioOutput, ScheduledSlice } from "@audiosous/audio-engine";

interface PendingMix {
  gain: number;
  pan: number;
}

export function createWebAudioOutput(): AudioOutput {
  let context: AudioContext | null = null;
  let mix: AudioWorkletNode | null = null;
  let mixReady: Promise<boolean> | null = null;
  let nextId = 1;
  const mixState = new Map<string, PendingMix>();
  const fallbackNodes = new Map<string, { gain: GainNode; pan: StereoPannerNode }>();

  function audio(): AudioContext {
    if (!context) context = new AudioContext();
    return context;
  }

  function remember(trackId: string): PendingMix {
    const existing = mixState.get(trackId);
    if (existing) return existing;
    const created = { gain: 1, pan: 0 };
    mixState.set(trackId, created);
    return created;
  }

  function send(message: Record<string, unknown>, transfer: Transferable[] = []): void {
    mix?.port.postMessage(message, transfer);
  }

  async function ensureMix(): Promise<boolean> {
    const active = audio();
    if (mix) return true;
    if (!mixReady) {
      mixReady = active.audioWorklet
        .addModule(new URL("./playback-worklet.js", import.meta.url))
        .then(() => {
          mix = new AudioWorkletNode(active, "audiosous-mix", { numberOfOutputs: 1, outputChannelCount: [2] });
          mix.connect(active.destination);
          for (const [trackId, row] of mixState) {
            send({ type: "mix", trackId, gain: row.gain, pan: row.pan });
          }
          return true;
        })
        .catch(() => false);
    }
    return mixReady;
  }

  function fallbackTrack(trackId: string): { gain: GainNode; pan: StereoPannerNode } {
    const existing = fallbackNodes.get(trackId);
    if (existing) return existing;
    const active = audio();
    const gain = active.createGain();
    const pan = active.createStereoPanner();
    const row = remember(trackId);
    gain.gain.value = row.gain;
    pan.pan.value = row.pan;
    gain.connect(pan);
    pan.connect(active.destination);
    const created = { gain, pan };
    fallbackNodes.set(trackId, created);
    return created;
  }

  return {
    now: () => audio().currentTime,
    sampleRate: () => audio().sampleRate,
    async resume() {
      const active = audio();
      if (active.state !== "running") {
        try {
          await active.resume();
        } catch (error) {
          const detail = error instanceof Error && error.message ? error.message : "Audio output did not open.";
          throw new Error(`Playback could not start. ${detail}`);
        }
        const outputState = active.state as AudioContextState;
        if (outputState !== "running") throw new Error("Playback could not start. Audio output did not open.");
      }
      await ensureMix();
    },
    prepareTrack(trackId) {
      remember(trackId);
      if (!mix) fallbackTrack(trackId);
    },
    setGain(trackId, linear) {
      const row = remember(trackId);
      row.gain = linear;
      send({ type: "mix", trackId, gain: linear });
      const fallback = fallbackNodes.get(trackId);
      if (fallback) fallback.gain.gain.value = linear;
    },
    setPan(trackId, pan) {
      const row = remember(trackId);
      const clamped = Math.max(-1, Math.min(1, pan));
      row.pan = clamped;
      send({ type: "mix", trackId, pan: clamped });
      const fallback = fallbackNodes.get(trackId);
      if (fallback) fallback.pan.pan.value = clamped;
    },
    start(slice: ScheduledSlice) {
      const active = audio();
      const frames = slice.channels[0]?.length ?? 0;
      if (frames === 0) return { stop() {} };
      const duration = frames / slice.sampleRate;
      if (slice.contextTime + duration < active.currentTime - 0.03) return { stop() {} };
      const id = nextId;
      nextId += 1;
      if (mix) {
        const channels = slice.channels.map((channel) => channel.slice());
        send(
          { type: "slice", id, trackId: slice.trackId, contextTime: Math.max(slice.contextTime, active.currentTime), channels },
          channels.map((channel) => channel.buffer),
        );
        return {
          stop() {
            send({ type: "cancel", id });
          },
        };
      }
      const track = fallbackTrack(slice.trackId);
      const buffer = active.createBuffer(slice.channels.length, frames, slice.sampleRate);
      slice.channels.forEach((channel, index) => {
        buffer.getChannelData(index).set(channel);
      });
      const source = active.createBufferSource();
      source.buffer = buffer;
      source.connect(track.gain);
      source.start(Math.max(slice.contextTime, active.currentTime));
      return {
        stop() {
          try {
            source.stop();
          } catch {
            // This slice has already finished.
          }
        },
      };
    },
    close() {
      send({ type: "clear" });
      const active = context;
      context = null;
      mix = null;
      mixReady = null;
      mixState.clear();
      fallbackNodes.clear();
      if (active) void active.close();
    },
  };
}
