import type { EnvelopeFrames, EqBandFrames, StereoFrames, TrackFileMeasurement } from "@audiosous/analysis-contract";
import { envelopeFor, notes, type EnvelopeShape } from "@audiosous/dynamics-planner/testing";
import { setSectionDynamicsNodes, setSectionEqNodes, setTrackDynamicsNodes, setTrackEqNodes, type DynamicsNode, type EqNode, type ProjectDocument } from "@audiosous/project-model";
import { spatialSong, type SpatialSongInput, type SpatialTrackInput } from "@audiosous/spatial-planner/testing";

export { BASS, KICK, LEAD, NOW, PAD_MASKING, PAD_SEPARATED, base, bump, mix, sum, wholeSong } from "@audiosous/spatial-planner/testing";
export { dipped, hits, notes } from "@audiosous/dynamics-planner/testing";
export { SNARE_SHAPE, bassTrack, kickTrack, steadyBass, unstableBass } from "@audiosous/dynamics-planner/testing";

/**
 * Deterministic whole-mix fixtures: every stem has a spectral shape and activity (EQ and AutoBalance), a stereo
 * description (Space), and a level envelope (Dynamics), so all four planners read one consistent song.
 */
export interface MixTrackInput extends SpatialTrackInput {
  /** 10 ms level envelope. Default: steady notes at a level that matches nothing in particular. */
  envelope?: EnvelopeShape;
}

export interface MixSongInput extends Omit<SpatialSongInput, "tracks"> {
  tracks: MixTrackInput[];
  eq?: Array<{ track: string; section?: string; nodes: EqNode[] }>;
  dynamics?: Array<{ track: string; section?: string; nodes: DynamicsNode[] }>;
}

export interface MixSong {
  document: ProjectDocument;
  measurements: Record<string, TrackFileMeasurement>;
  bands: Record<string, EqBandFrames>;
  stereo: Record<string, StereoFrames>;
  envelopes: Record<string, EnvelopeFrames>;
}

export function mixSong(input: MixSongInput): MixSong {
  const duration = input.duration ?? 60;
  const made = spatialSong({ ...input, tracks: input.tracks });
  let document = made.document;
  for (const row of input.eq ?? []) {
    const result = row.section ? setSectionEqNodes(document, row.track, row.section, row.nodes) : setTrackEqNodes(document, row.track, row.nodes);
    if (!result.ok) throw new Error(result.message);
    document = result.document;
  }
  for (const row of input.dynamics ?? []) {
    const result = row.section ? setSectionDynamicsNodes(document, row.track, row.section, row.nodes) : setTrackDynamicsNodes(document, row.track, row.nodes);
    if (!result.ok) throw new Error(result.message);
    document = result.document;
  }
  const envelopes: Record<string, EnvelopeFrames> = {};
  for (const track of input.tracks) envelopes[track.id] = envelopeFor({ fixture: track.fixture, envelope: track.envelope ?? notes({ levelDb: -20, period: 1, decayDb: 1, lowDb: -15 }) }, duration);
  return { document, measurements: made.measurements, bands: made.bands, stereo: made.stereo, envelopes };
}
