import { encodeEnvelopeSeries, envelopeFramesSchema, type EnvelopeFrames, type EqBandFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import { bandFramesFor, song as spectralSong, type FixtureTrack, type SongInput } from "@audiosous/eq-planner/testing";
import { setSectionDynamicsNodes, setTrackDynamicsNodes, setTrackEqNodes, type DynamicsNode, type EqNode, type ProjectDocument } from "@audiosous/project-model";

export { BASS, KICK, LEAD, NOW, PAD_MASKING, PAD_SEPARATED, base, bump, mix, sum, wholeSong } from "@audiosous/eq-planner/testing";

/**
 * Deterministic dynamics fixtures. Each stem has a spectral shape and activity (the EQ fixtures, for phrase-level
 * masking) and a level envelope: what its 10 ms RMS, peak, and low band do over time. A test states a stem's
 * dynamics directly: notes at given levels, drum hits with a given attack and decay.
 */
export interface EnvelopeSample {
  rms: number;
  peak: number;
  low: number;
}

/** dB per 10 ms frame, raw (before the fader). Return null where the stem is silent. */
export type EnvelopeShape = (seconds: number) => EnvelopeSample | null;

/**
 * A sustained part: notes every `period` seconds, cycling through `offsets` (dB from `levelDb`), each decaying by
 * `decayDb` over the note. `lowDb` is the low band relative to the RMS (0 for a bass, −30 for a lead).
 */
export function notes(options: { levelDb: number; period: number; offsets?: number[]; decayDb?: number; lowDb?: number; crestDb?: number }): EnvelopeShape {
  const offsets = options.offsets ?? [0];
  const decay = options.decayDb ?? 1;
  const low = options.lowDb ?? -20;
  const crest = options.crestDb ?? 4;
  return (seconds) => {
    const index = Math.floor(seconds / options.period + 1e-9);
    const local = seconds - index * options.period;
    const rms = options.levelDb + offsets[index % offsets.length]! - (decay * local) / options.period;
    return { rms, peak: rms + crest, low: rms + low };
  };
}

/**
 * Drum hits every `period` from `offset`: the first 10 ms sit `attackDb` over the start of the body, which then
 * decays with time constant `decayMs`. `lowDb` is the low band relative to the RMS.
 */
export function hits(options: { peakDb: number; period: number; offset?: number; attackDb?: number; decayMs?: number; lowDb?: number }): EnvelopeShape {
  const offset = options.offset ?? 0;
  const attack = options.attackDb ?? 8;
  const decay = (options.decayMs ?? 80) / 1_000;
  const low = options.lowDb ?? -20;
  return (seconds) => {
    if (seconds < offset) return null;
    const local = (seconds - offset) % options.period;
    const rms = local < 0.01 ? options.peakDb - 3 : options.peakDb - 3 - attack - (8.686 * (local - 0.01)) / decay;
    if (rms < -95) return null;
    return { rms, peak: local < 0.01 ? options.peakDb : rms + 4, low: rms + low };
  };
}

/** The same shape with its level lowered by `dipDb` for `lengthMs` after each hit of a `period` grid (a part pre-ducked in its source). */
export function dipped(shape: EnvelopeShape, options: { period: number; offset?: number; dipDb: number; lengthMs: number }): EnvelopeShape {
  return (seconds) => {
    const sample = shape(seconds);
    if (!sample) return null;
    const local = (seconds - (options.offset ?? 0) + options.period * 1_000) % options.period;
    const dip = local < options.lengthMs / 1_000 ? options.dipDb : 0;
    return { rms: sample.rms - dip, peak: sample.peak - dip, low: sample.low - dip };
  };
}

export interface DynamicsTrackInput {
  id: string;
  name: string;
  role: SongInput["tracks"][number]["role"];
  gainDb?: number;
  fixture: FixtureTrack;
  envelope: EnvelopeShape;
}

export interface DynamicsSongInput extends Omit<SongInput, "tracks"> {
  tracks: DynamicsTrackInput[];
  /** Saved dynamics nodes, whole-song or in a section. */
  dynamics?: Array<{ track: string; section?: string; nodes: DynamicsNode[] }>;
  eq?: Array<{ track: string; nodes: EqNode[] }>;
}

export interface DynamicsSong {
  document: ProjectDocument;
  measurements: Record<string, TrackFileMeasurement>;
  bands: Record<string, EqBandFrames>;
  envelopes: Record<string, EnvelopeFrames>;
}

export function dynamicsSong(input: DynamicsSongInput): DynamicsSong {
  const duration = input.duration ?? 60;
  const made = spectralSong({ ...input, tracks: input.tracks.map((track) => ({ ...track })) });
  let document: ProjectDocument = made.document;
  for (const row of input.eq ?? []) {
    const result = setTrackEqNodes(document, row.track, row.nodes);
    if (!result.ok) throw new Error(result.message);
    document = result.document;
  }
  for (const row of input.dynamics ?? []) {
    const result = row.section ? setSectionDynamicsNodes(document, row.track, row.section, row.nodes) : setTrackDynamicsNodes(document, row.track, row.nodes);
    if (!result.ok) throw new Error(result.message);
    document = result.document;
  }
  const bands: Record<string, EqBandFrames> = {};
  const envelopes: Record<string, EnvelopeFrames> = {};
  for (const spec of input.tracks) {
    bands[spec.id] = bandFramesFor(spec.fixture, duration);
    envelopes[spec.id] = envelopeFor(spec, duration);
  }
  return { document, measurements: made.measurements, bands, envelopes };
}

/** The envelope frames the Rust measurement would produce for this stem: its shape inside its active ranges. */
export function envelopeFor(spec: Pick<DynamicsTrackInput, "fixture" | "envelope">, duration: number): EnvelopeFrames {
  const frames = Math.ceil(duration / 0.01);
  const active = spec.fixture.active ?? [[0, duration]];
  const rms: number[] = [];
  const peak: number[] = [];
  const low: number[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const seconds = (frame + 0.5) * 0.01;
    const on = active.some(([start, end]) => seconds >= start && seconds < end);
    const sample = on ? spec.envelope(seconds) : null;
    rms.push(sample ? sample.rms : -100);
    peak.push(sample ? sample.peak : -100);
    low.push(sample ? sample.low : -100);
  }
  return envelopeFramesSchema.parse({
    version: 1,
    sampleRate: 48_000,
    channels: 2,
    durationSeconds: duration,
    hopSeconds: 0.01,
    frameCount: frames,
    lowHz: 150,
    rms: encodeEnvelopeSeries(rms),
    peak: encodeEnvelopeSeries(peak),
    low: encodeEnvelopeSeries(low),
  });
}
