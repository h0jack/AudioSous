class MixProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tracks = new Map();
    this.port.onmessage = (event) => {
      const message = event.data;
      if (!message || typeof message.type !== "string") return;
      if (message.type === "slice") this.addSlice(message);
      if (message.type === "mix") this.setMix(message);
      if (message.type === "cancel") this.cancel(message.id);
      if (message.type === "clear") this.tracks.clear();
    };
  }

  track(id) {
    let row = this.tracks.get(id);
    if (!row) {
      row = { gain: 1, targetGain: 1, pan: 0, slices: [] };
      this.tracks.set(id, row);
    }
    return row;
  }

  addSlice(message) {
    const row = this.track(message.trackId);
    row.slices.push({
      id: message.id,
      start: message.contextTime,
      channels: message.channels,
    });
    row.slices.sort((left, right) => left.start - right.start);
  }

  setMix(message) {
    const row = this.track(message.trackId);
    if (typeof message.gain === "number") row.targetGain = message.gain;
    if (typeof message.pan === "number") row.pan = Math.max(-1, Math.min(1, message.pan));
  }

  cancel(id) {
    for (const row of this.tracks.values()) {
      row.slices = row.slices.filter((slice) => slice.id !== id);
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output?.[0];
    const right = output?.[1] ?? left;
    if (!left || !right) return true;
    left.fill(0);
    if (right !== left) right.fill(0);
    const frameSeconds = 1 / sampleRate;
    const blockStart = currentTime;
    for (const row of this.tracks.values()) {
      const pan = row.pan;
      const step = 1 / (0.02 * sampleRate);
      for (let frame = 0; frame < left.length; frame += 1) {
        const delta = row.targetGain - row.gain;
        row.gain += Math.max(-step, Math.min(step, delta));
        const gainLeft = row.gain * (pan < 0 ? 1 : 1 - pan);
        const gainRight = row.gain * (pan > 0 ? 1 : 1 + pan);
        const crossLeft = row.gain * Math.max(0, -pan);
        const crossRight = row.gain * Math.max(0, pan);
        const time = blockStart + frame * frameSeconds;
        for (const slice of row.slices) {
          const sample = sampleAt(slice, time);
          if (sample === null) continue;
          left[frame] += sample.left * gainLeft + sample.right * crossLeft;
          right[frame] += sample.left * crossRight + sample.right * gainRight;
          break;
        }
      }
      row.slices = row.slices.filter((slice) => sliceEnd(slice) > blockStart);
    }
    return true;
  }
}

function sampleAt(slice, time) {
  const channels = slice.channels;
  const frames = channels[0]?.length ?? 0;
  if (frames === 0) return null;
  const index = Math.round((time - slice.start) * sampleRate);
  if (index < 0 || index >= frames) return null;
  const left = channels[0][index] ?? 0;
  const right = channels.length > 1 ? (channels[1][index] ?? left) : left;
  return { left, right };
}

function sliceEnd(slice) {
  const frames = slice.channels[0]?.length ?? 0;
  return slice.start + frames / sampleRate;
}

registerProcessor("audiosous-mix", MixProcessor);
