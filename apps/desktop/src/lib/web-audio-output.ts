import type { AudioOutput, ScheduledSlice } from "@audiosous/audio-engine";

export function createWebAudioOutput(): AudioOutput {
  let context: AudioContext | null = null;
  const nodes = new Map<string, { gain: GainNode; pan: StereoPannerNode }>();

  function audio(): AudioContext {
    if (!context) context = new AudioContext();
    return context;
  }

  return {
    now: () => audio().currentTime,
    async resume() {
      const active = audio();
      if (active.state !== "running") await active.resume();
    },
    prepareTrack(trackId) {
      if (nodes.has(trackId)) return;
      const active = audio();
      const gain = active.createGain();
      const pan = active.createStereoPanner();
      gain.connect(pan);
      pan.connect(active.destination);
      nodes.set(trackId, { gain, pan });
    },
    setGain(trackId, linear) {
      const track = nodes.get(trackId);
      if (track) track.gain.gain.value = linear;
    },
    setPan(trackId, pan) {
      const track = nodes.get(trackId);
      if (track) track.pan.pan.value = Math.max(-1, Math.min(1, pan));
    },
    start(slice: ScheduledSlice) {
      const active = audio();
      const track = nodes.get(slice.trackId);
      const frames = slice.channels[0]?.length ?? 0;
      if (!track || frames === 0 || slice.contextTime < active.currentTime - 0.05) return { stop() {} };
      const buffer = active.createBuffer(slice.channels.length, frames, slice.sampleRate);
      slice.channels.forEach((channel, index) => {
        buffer.getChannelData(index).set(channel);
      });
      const source = active.createBufferSource();
      source.buffer = buffer;
      source.connect(track.gain);
      source.start(slice.contextTime);
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
      const active = context;
      context = null;
      nodes.clear();
      if (active) void active.close();
    },
  };
}
