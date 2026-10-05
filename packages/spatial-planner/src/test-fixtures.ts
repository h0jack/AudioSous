import { STEREO_BANDS, stereoFramesSchema, type EqBandFrames, type StereoFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import { bandFramesFor, song as spectralSong, type FixtureTrack, type SongInput } from "@audiosous/eq-planner/testing";
import { setSectionSpatial, type ProjectDocument } from "@audiosous/project-model";

export { BASS, KICK, LEAD, NOW, PAD_MASKING, PAD_SEPARATED, base, bump, mix, sum, wholeSong } from "@audiosous/eq-planner/testing";

/**
 * Deterministic stereo fixtures. Each stem has a spectral shape and activity (from the EQ fixtures) plus a
 * stereo description: the correlation between its channels and its left/right energy balance. The proxy
 * stereo frames carry exactly that in every band, so a test states the stereo field directly.
 */
export interface StereoFixture {
  /** Correlation between the stem's channels, −1 … 1. Default 0.95: nearly mono, as most stems are. */
  correlation?: number;
  /** Energy balance (R − L) / (R + L) of the file itself, before any pan control. */
  balance?: number;
  /** A one-channel file. */
  mono?: boolean;
}

export interface SpatialTrackInput {
  id: string;
  name: string;
  role: SongInput["tracks"][number]["role"];
  gainDb?: number;
  pan?: number;
  width?: number;
  fixture: FixtureTrack;
  stereo?: StereoFixture;
}

export interface SpatialSongInput extends Omit<SongInput, "tracks"> {
  tracks: SpatialTrackInput[];
  /** Saved Track × Section pan and width overrides. */
  overrides?: Array<{ track: string; section: string; pan?: number | null; width?: number | null }>;
}

export interface SpatialSong {
  document: ProjectDocument;
  measurements: Record<string, TrackFileMeasurement>;
  bands: Record<string, EqBandFrames>;
  stereo: Record<string, StereoFrames>;
}

export function spatialSong(input: SpatialSongInput): SpatialSong {
  const duration = input.duration ?? 60;
  const made = spectralSong({ ...input, tracks: input.tracks.map((track) => ({ ...track })) });
  let document: ProjectDocument = {
    ...made.document,
    tracks: made.document.tracks.map((track) => {
      const spec = input.tracks.find((item) => item.id === track.id)!;
      return {
        ...track,
        pan: spec.pan ?? 0,
        width: spec.width ?? 1,
        metadata: { ...track.metadata, channelCount: spec.stereo?.mono ? 1 : 2 },
      };
    }),
  };
  for (const row of input.overrides ?? []) {
    const result = setSectionSpatial(document, row.track, row.section, { pan: row.pan, width: row.width });
    if (!result.ok) throw new Error(result.message);
    document = result.document;
  }
  const measurements: Record<string, TrackFileMeasurement> = {};
  const bands: Record<string, EqBandFrames> = {};
  const stereo: Record<string, StereoFrames> = {};
  for (const spec of input.tracks) {
    const description = describe(spec.stereo);
    const measurement = made.measurements[spec.id]!;
    const sideToMid = (1 - description.correlation) / (1 + description.correlation);
    measurements[spec.id] = {
      ...measurement,
      source: { ...measurement.source, channelCount: description.mono ? 1 : 2 },
      stereo: {
        balance: description.balance,
        correlation: description.correlation,
        width: Math.min(1, sideToMid),
        midRmsDbfs: measurement.stereo.midRmsDbfs,
        sideRmsDbfs: measurement.stereo.midRmsDbfs === null ? null : Math.max(-200, measurement.stereo.midRmsDbfs + 10 * Math.log10(Math.max(1e-20, sideToMid))),
      },
    };
    bands[spec.id] = bandFramesFor(spec.fixture, duration);
    stereo[spec.id] = stereoFramesFor(spec.fixture, spec.stereo, duration);
  }
  return { document, measurements, bands, stereo };
}

function describe(stereo: StereoFixture | undefined): { correlation: number; balance: number; mono: boolean } {
  if (stereo?.mono) return { correlation: 1, balance: 0, mono: true };
  return { correlation: stereo?.correlation ?? 0.95, balance: stereo?.balance ?? 0, mono: false };
}

/** Proxy stereo frames for a fixture: its band levels as the mid, with the stated correlation and balance. */
export function stereoFramesFor(fixture: FixtureTrack, stereo: StereoFixture | undefined, duration: number): StereoFrames {
  const { correlation, balance, mono } = describe(stereo);
  const gridEdges = Array.from({ length: 25 }, (_, index) => 20 * 1_000 ** (index / 24));
  const gridCenters = gridEdges.slice(0, -1).map((low, index) => Math.sqrt(low * gridEdges[index + 1]!));
  const hop = Math.max(0.25, duration / 360);
  const count = Math.min(400, Math.ceil(duration / hop));
  const on = (time: number) => (fixture.active ?? [[0, duration]]).some(([start, end]) => time >= start && time < end);
  const sideToMid = (1 - correlation) / (1 + correlation);
  const rows = Array.from({ length: count }, (_, frame) => {
    const live = on((frame + 0.5) * hop);
    return Array.from({ length: STEREO_BANDS }, (_, band) => {
      if (!live) return { l: -200, r: -200, rho: 1 };
      let mid = 0;
      for (let grid = band * 3; grid < band * 3 + 3; grid += 1) mid += 10 ** (Math.max(-200, Math.min(40, fixture.shape(gridCenters[grid]!))) / 10);
      if (mono) {
        const db = round2(10 * Math.log10(mid));
        return { l: db, r: db, rho: 1 };
      }
      const side = mid * sideToMid;
      const total = mid + side;
      const l = total * (1 - balance);
      const r = total * (1 + balance);
      const rho = Math.max(-1, Math.min(1, (mid - side) / Math.sqrt(l * r)));
      return { l: round2(10 * Math.log10(l)), r: round2(10 * Math.log10(r)), rho: Math.round(rho * 1000) / 1000 };
    });
  });
  return stereoFramesSchema.parse({
    version: 1,
    sampleRate: 48_000,
    channels: mono ? 1 : 2,
    durationSeconds: duration,
    hopSeconds: hop,
    edgesHz: Array.from({ length: STEREO_BANDS + 1 }, (_, band) => gridEdges[band * 3]!),
    leftDb: rows.map((row) => row.map((cell) => cell.l)),
    rightDb: rows.map((row) => row.map((cell) => cell.r)),
    correlation: rows.map((row) => row.map((cell) => cell.rho)),
  });
}

function round2(value: number): number {
  return Math.round(Math.max(-200, Math.min(80, value)) * 100) / 100;
}
