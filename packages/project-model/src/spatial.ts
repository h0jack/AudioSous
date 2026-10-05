import { SPATIAL_LIMITS, emptyProcessingGraph, type ProjectDocument, type SongSection, type Track, type TrackSectionState } from "./schema";
import { sectionSettingInUse, type SectionEditResult } from "./sections";

/**
 * Spatial state, per track:
 *
 *   source → EQ (track, then section) → width (stereo stems) → pan / balance → gain → mix
 *
 * `track.pan` and `track.width` hold the whole-song setting. A Track × Section `overrides.pan` or
 * `overrides.width` replaces it inside that section, the same way a section gain override replaces the
 * fader. There is no second copy of either value anywhere in the project.
 *
 * Pan on a mono stem is an equal-power pan. Pan on a stereo stem is a balance control: each channel is
 * scaled, nothing is crossfed. Width scales the side signal (L − R) / 2 of a stereo stem and leaves the
 * mid (L + R) / 2 alone, so the mono fold-down of a stem never changes with width.
 */
export interface SpatialSetting {
  pan: number;
  width: number;
}

export const NEUTRAL_SPATIAL: SpatialSetting = { pan: 0, width: 1 };

/** A stem whose proxy has one channel. Width does nothing on it, and the UI calls its pan Pan, not Balance. */
export function isMonoTrack(track: Pick<Track, "metadata">): boolean {
  return track.metadata.channelCount < 2;
}

/** Hundredths: the precision the controls show (pan ±100, width in %). */
export function normalizePan(value: number): number {
  const safe = Number.isFinite(value) ? value : 0;
  return Math.round(clamp(safe, SPATIAL_LIMITS.minPan, SPATIAL_LIMITS.maxPan) * 100) / 100;
}

export function normalizeWidth(value: number): number {
  const safe = Number.isFinite(value) ? value : 1;
  return Math.round(clamp(safe, SPATIAL_LIMITS.minWidth, SPATIAL_LIMITS.maxWidth) * 100) / 100;
}

export function trackSpatial(document: ProjectDocument, trackId: string): SpatialSetting {
  const track = document.tracks.find((item) => item.id === trackId);
  return track ? { pan: track.pan, width: track.width } : { ...NEUTRAL_SPATIAL };
}

export function sectionSpatialOverride(document: ProjectDocument, trackId: string, sectionId: string): { pan: number | null; width: number | null } {
  const row = document.sectionTrackSettings.find((item) => item.trackId === trackId && item.sectionId === sectionId);
  return { pan: row?.overrides.pan ?? null, width: row?.overrides.width ?? null };
}

/** Pan and width in effect for one track inside one section (or outside every section when `sectionId` is null). */
export function spatialForSection(document: ProjectDocument, trackId: string, sectionId: string | null): SpatialSetting {
  const own = trackSpatial(document, trackId);
  if (!sectionId) return own;
  const override = sectionSpatialOverride(document, trackId, sectionId);
  return { pan: override.pan ?? own.pan, width: override.width ?? own.width };
}

export function spatialAt(document: ProjectDocument, trackId: string, seconds: number): SpatialSetting {
  return spatialForSection(document, trackId, sectionAt(document.sections, seconds)?.id ?? null);
}

/** True when a track has spatial processing beyond a plain pan: a width other than 100%, or a section pan or width. */
export function hasSavedSpatial(document: ProjectDocument, trackId: string): boolean {
  const track = document.tracks.find((item) => item.id === trackId);
  if (!track) return false;
  if (Math.abs(track.width - 1) > 1e-9) return true;
  return document.sectionTrackSettings.some((row) => row.trackId === trackId && (row.overrides.pan !== null || row.overrides.width !== null));
}

export function setTrackSpatial(document: ProjectDocument, trackId: string, patch: Partial<SpatialSetting>): SectionEditResult {
  if (!document.tracks.some((track) => track.id === trackId)) return { ok: false, message: "That track is no longer in the project." };
  return {
    ok: true,
    document: {
      ...document,
      tracks: document.tracks.map((track) =>
        track.id === trackId
          ? {
              ...track,
              pan: patch.pan === undefined ? track.pan : normalizePan(patch.pan),
              width: patch.width === undefined ? track.width : normalizeWidth(patch.width),
            }
          : track,
      ),
    },
  };
}

/**
 * Sets or clears (null) the section pan and width overrides. An override equal to the track's own value is
 * cleared, so a section never stores a duplicate of the whole-song setting.
 */
export function setSectionSpatial(
  document: ProjectDocument,
  trackId: string,
  sectionId: string,
  patch: { pan?: number | null; width?: number | null },
): SectionEditResult {
  const track = document.tracks.find((item) => item.id === trackId);
  if (!track) return { ok: false, message: "That track is no longer in the project." };
  if (!document.sections.some((section) => section.id === sectionId)) return { ok: false, message: "That section is no longer in the project." };
  const existing = document.sectionTrackSettings.find((row) => row.trackId === trackId && row.sectionId === sectionId);
  const current = existing?.overrides ?? { gainDb: null, pan: null, width: null };
  const pan = patch.pan === undefined ? current.pan : patch.pan === null ? null : normalizePan(patch.pan);
  const width = patch.width === undefined ? current.width : patch.width === null ? null : normalizeWidth(patch.width);
  const next: TrackSectionState = {
    trackId,
    sectionId,
    userIntent: existing?.userIntent ?? null,
    prominence: existing?.prominence ?? null,
    overrides: {
      gainDb: current.gainDb,
      pan: pan !== null && Math.abs(pan - track.pan) < 0.005 ? null : pan,
      width: width !== null && Math.abs(width - track.width) < 0.005 ? null : width,
    },
    processing: existing?.processing ?? emptyProcessingGraph(),
  };
  const rest = document.sectionTrackSettings.filter((row) => row.trackId !== trackId || row.sectionId !== sectionId);
  return { ok: true, document: { ...document, sectionTrackSettings: sectionSettingInUse(next) ? [...rest, next] : rest } };
}

/** Everything about saved spatial state that changes what a planner would hear, in a stable order. */
export function spatialIdentity(document: ProjectDocument): unknown {
  return {
    tracks: document.tracks.map((track) => [track.id, track.pan, track.width, track.metadata.channelCount]),
    sections: [...document.sectionTrackSettings]
      .filter((row) => row.overrides.pan !== null || row.overrides.width !== null)
      .sort((left, right) => `${left.trackId}:${left.sectionId}`.localeCompare(`${right.trackId}:${right.sectionId}`))
      .map((row) => [row.trackId, row.sectionId, row.overrides.pan, row.overrides.width]),
  };
}

function sectionAt(sections: readonly SongSection[], seconds: number): SongSection | null {
  return sections.find((section) => seconds >= section.startTime && seconds < section.endTime) ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
