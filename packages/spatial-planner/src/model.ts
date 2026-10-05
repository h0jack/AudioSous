import { STEREO_BANDS, type StereoFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import { GRID_BANDS, bandPowerGain, type SpectralModel } from "@audiosous/eq-planner";
import { isMonoTrack, type EqFilter, type ProjectDocument, type SongSection, type Track } from "@audiosous/project-model";
import { ZERO_LRC, addLrc, placeStats, type Lrc, type SpatialSetting } from "./stereo";

/**
 * Stereo statistics for every audible stem on the EQ planner's time grid.
 *
 * `source` is each stem after the fader, the section gain, and the saved EQ, before width and pan.
 * `heard` is the same with the spatial state in effect at each step (saved, or saved plus a candidate).
 * Bands are the EQ grid's 24 bands taken three at a time.
 *
 * With proxy stereo frames the statistics change over time. Without them the sidecar's whole-file
 * balance and mid/side levels shape the stem's measured band levels, so position and width are the
 * same at every step and the plan summary says so.
 */
export const BAND_GROUP = GRID_BANDS / STEREO_BANDS;

export interface StereoTrack {
  track: Track;
  mono: boolean;
  /** steps × STEREO_BANDS, source statistics before width and pan. */
  source: Lrc[];
  /** steps × STEREO_BANDS, as heard with the spatial state of `settings`. */
  heard: Lrc[];
  /** Spatial setting in effect at each step. */
  settings: SpatialSetting[];
  active: Uint8Array;
  origin: "proxy-stereo" | "measurement";
  /** Share of the stem's energy under 150 Hz while it plays. */
  lowShare: number;
}

export interface StereoModel {
  spectral: SpectralModel;
  edgesHz: number[];
  steps: number;
  stepSeconds: number;
  /** Section id per step, null outside every section. */
  sectionAt: Array<string | null>;
  tracks: Map<string, StereoTrack>;
}

/** Candidate spatial settings for evaluation, keyed by track: a new whole-song setting and/or section override values. */
export type SpatialOverlay = Map<string, { global?: SpatialSetting; sections?: Map<string, { pan: number | null; width: number | null }> }>;

export interface BuildStereoInput {
  document: ProjectDocument;
  spectral: SpectralModel;
  measurements: Record<string, TrackFileMeasurement | null | undefined>;
  stereo?: Record<string, StereoFrames | null | undefined>;
}

export function buildStereoModel(input: BuildStereoInput): StereoModel {
  const { document, spectral } = input;
  const edges = Array.from({ length: STEREO_BANDS + 1 }, (_, band) => spectral.grid.edges[band * BAND_GROUP]!);
  const sectionAt = Array.from({ length: spectral.steps }, (_, step) => sectionAtTime(document.sections, (step + 0.5) * spectral.stepSeconds)?.id ?? null);
  const tracks = new Map<string, StereoTrack>();
  for (const [trackId, spectra] of spectral.tracks) {
    const track = spectra.track;
    const frames = usableFrames(input.stereo?.[trackId], spectral.durationSeconds);
    const mono = isMonoTrack(track) || frames?.channels === 1;
    const measurement = input.measurements[trackId] ?? spectra.measurement;
    const factors = new Map<string | null, number[]>();
    const factorFor = (sectionId: string | null) => {
      const cached = factors.get(sectionId);
      if (cached) return cached;
      const made = heardFactors(document, track, sectionId, edges);
      factors.set(sectionId, made);
      return made;
    };
    const source: Lrc[] = new Array(spectral.steps * STEREO_BANDS);
    for (let step = 0; step < spectral.steps; step += 1) {
      const sectionId = sectionAt[step] ?? null;
      for (let band = 0; band < STEREO_BANDS; band += 1) {
        if (frames) {
          const factor = factorFor(sectionId)[band]!;
          source[step * STEREO_BANDS + band] = frameStats(frames, (step + 0.5) * spectral.stepSeconds, band, mono, factor);
        } else {
          let heardMid = 0;
          for (let grid = band * BAND_GROUP; grid < (band + 1) * BAND_GROUP; grid += 1) heardMid += spectra.power[step * GRID_BANDS + grid]!;
          source[step * STEREO_BANDS + band] = fallbackStats(measurement, heardMid, mono);
        }
      }
    }
    let low = 0;
    let all = 0;
    for (let step = 0; step < spectral.steps; step += 1) {
      if (spectra.active[step] !== 1) continue;
      for (let grid = 0; grid < GRID_BANDS; grid += 1) {
        const value = spectra.power[step * GRID_BANDS + grid]!;
        all += value;
        if (spectral.grid.edges[grid + 1]! <= 160) low += value;
      }
    }
    const entry: StereoTrack = {
      track,
      mono,
      source,
      heard: [],
      settings: [],
      active: spectra.active,
      origin: frames ? "proxy-stereo" : "measurement",
      lowShare: all > 0 ? low / all : 0,
    };
    place(document, entry, sectionAt, undefined);
    tracks.set(trackId, entry);
  }
  return { spectral, edgesHz: edges, steps: spectral.steps, stepSeconds: spectral.stepSeconds, sectionAt, tracks };
}

/** A copy of the model with candidate settings heard. Source statistics are shared, not copied. */
export function withOverlay(document: ProjectDocument, model: StereoModel, overlay: SpatialOverlay): StereoModel {
  const tracks = new Map<string, StereoTrack>();
  for (const [trackId, entry] of model.tracks) {
    if (!overlay.has(trackId)) {
      tracks.set(trackId, entry);
      continue;
    }
    const next: StereoTrack = { ...entry, heard: [], settings: [] };
    place(document, next, model.sectionAt, overlay.get(trackId));
    tracks.set(trackId, next);
  }
  return { ...model, tracks };
}

/**
 * Pan and width in effect for one track in one section: a section override replaces the whole-song value,
 * exactly as the saved project and the engine resolve it. A candidate may replace either layer.
 */
export function resolveSetting(
  document: ProjectDocument,
  track: Track,
  sectionId: string | null,
  overlay?: { global?: SpatialSetting; sections?: Map<string, { pan: number | null; width: number | null }> },
): SpatialSetting {
  const base = overlay?.global ?? { pan: track.pan, width: track.width };
  if (!sectionId) return base;
  const saved = document.sectionTrackSettings.find((row) => row.trackId === track.id && row.sectionId === sectionId)?.overrides;
  const override = overlay?.sections?.get(sectionId) ?? { pan: saved?.pan ?? null, width: saved?.width ?? null };
  return { pan: override.pan ?? base.pan, width: override.width ?? base.width };
}

function place(document: ProjectDocument, entry: StereoTrack, sectionAt: Array<string | null>, overlay: Parameters<typeof resolveSetting>[3]): void {
  const settings = new Map<string | null, SpatialSetting>();
  const steps = sectionAt.length;
  entry.heard = new Array(steps * STEREO_BANDS);
  entry.settings = new Array(steps);
  for (let step = 0; step < steps; step += 1) {
    const sectionId = sectionAt[step] ?? null;
    let setting = settings.get(sectionId);
    if (!setting) {
      setting = resolveSetting(document, entry.track, sectionId, overlay);
      settings.set(sectionId, setting);
    }
    entry.settings[step] = setting;
    for (let band = 0; band < STEREO_BANDS; band += 1) {
      entry.heard[step * STEREO_BANDS + band] = placeStats(entry.source[step * STEREO_BANDS + band]!, setting, entry.mono);
    }
  }
}

/** Mean statistics per band over `steps`. */
export function meanStats(stats: Lrc[], steps: number[]): Lrc[] {
  const out: Lrc[] = Array.from({ length: STEREO_BANDS }, () => ({ ...ZERO_LRC }));
  if (steps.length === 0) return out;
  for (const step of steps) {
    for (let band = 0; band < STEREO_BANDS; band += 1) out[band] = addLrc(out[band]!, stats[step * STEREO_BANDS + band]!);
  }
  return out.map((value) => ({ l: value.l / steps.length, r: value.r / steps.length, c: value.c / steps.length }));
}

export function sumBands(stats: Lrc[]): Lrc {
  return stats.reduce((total, value) => addLrc(total, value), { ...ZERO_LRC });
}

/** Fader (or section gain) and the band-averaged power response of the saved EQ, per stereo band. */
function heardFactors(document: ProjectDocument, track: Track, sectionId: string | null, edges: number[]): number[] {
  const row = sectionId ? document.sectionTrackSettings.find((item) => item.trackId === track.id && item.sectionId === sectionId) : undefined;
  const gainDb = row?.overrides.gainDb ?? track.gainDb;
  const filters: EqFilter[] = [
    ...track.processing.nodes.filter((node) => node.enabled).map((node) => node.filter),
    ...(row?.processing.nodes.filter((node) => node.enabled).map((node) => node.filter) ?? []),
  ];
  const gain = 10 ** (gainDb / 10);
  return Array.from({ length: STEREO_BANDS }, (_, band) => gain * bandPowerGain(filters, edges[band]!, edges[band + 1]!));
}

function usableFrames(frames: StereoFrames | null | undefined, duration: number): StereoFrames | null {
  if (!frames || frames.leftDb.length === 0) return null;
  if (Math.abs(frames.durationSeconds - duration) > Math.max(2, duration * 0.05) && frames.durationSeconds < duration * 0.5) return null;
  return frames;
}

function frameStats(frames: StereoFrames, time: number, band: number, mono: boolean, factor: number): Lrc {
  if (time >= frames.durationSeconds) return { ...ZERO_LRC };
  const row = Math.min(frames.leftDb.length - 1, Math.floor(time / frames.hopSeconds));
  const l = power(frames.leftDb[row]?.[band]);
  const r = power(frames.rightDb[row]?.[band]);
  if (mono) {
    const p = (l + r) / 2;
    return { l: p * factor, r: p * factor, c: p * factor };
  }
  const rho = frames.correlation[row]?.[band] ?? 1;
  return { l: l * factor, r: r * factor, c: rho * Math.sqrt(l * r) * factor };
}

/** Whole-file balance and mid/side levels shaping the stem's heard mid power in one band. */
function fallbackStats(measurement: TrackFileMeasurement | null | undefined, heardMid: number, mono: boolean): Lrc {
  if (heardMid <= 0) return { ...ZERO_LRC };
  if (mono || !measurement) return { l: heardMid, r: heardMid, c: heardMid };
  const { midRmsDbfs, sideRmsDbfs, balance } = measurement.stereo;
  const ratio = midRmsDbfs !== null && sideRmsDbfs !== null ? Math.min(4, 10 ** ((sideRmsDbfs - midRmsDbfs) / 10)) : 0;
  const side = heardMid * ratio;
  const total = heardMid + side;
  const b = Math.min(0.99, Math.max(-0.99, balance ?? 0));
  return { l: total * (1 - b), r: total * (1 + b), c: heardMid - side };
}

function power(db: number | undefined): number {
  if (db === undefined || db <= -199) return 0;
  return 10 ** (db / 10);
}

function sectionAtTime(sections: readonly SongSection[], seconds: number): SongSection | null {
  return sections.find((section) => seconds >= section.startTime && seconds < section.endTime) ?? null;
}
