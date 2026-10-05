import type { AudioEngine, TrackEqSetting, TrackSpatialSetting } from "@audiosous/audio-engine";
import { auditionMix, planIsStale } from "@audiosous/balance-planner";
import { eqAudition, eqPlanIsStale, type EqAudition } from "@audiosous/eq-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { spatialAudition, spatialAuditionAt, spatialPlanIsStale, type SpatialAudition } from "@audiosous/spatial-planner";
import { idleSpace, type BalanceSession, type EqSession, type SpaceSession } from "../state/app-store";

/**
 * What the engine should play right now: the saved mix, plus whichever plan is being auditioned.
 * No plan touches the saved project. This is the only place the overlays meet.
 *
 *   gain:    saved fader → AutoBalance audition (if any) → EQ or Spatial candidate safety trim (if any)
 *   regions: saved Track × Section gain, then AutoBalance section rows replace theirs
 *   EQ:      saved track and section filters → EQ candidate filters (if any)
 *   spatial: saved pan, width, and section pan/width → Spatial candidate rows (if any)
 */
export interface MonitorState {
  gains: Map<string, number>;
  gainRegions: Array<{ trackId: string; startSeconds: number; endSeconds: number; gainDb: number }>;
  eq: TrackEqSetting[];
  eqAudition: EqAudition;
  spatial: TrackSpatialSetting[];
  spatialAudition: SpatialAudition;
}

export function balanceAudition(document: ProjectDocument, balance: BalanceSession) {
  if (!balance.plan || balance.phase !== "ready") return null;
  if (!balance.preview && !balance.auditionId) return null;
  if (planIsStale(balance.plan, document, balance.fingerprints, balance.settings)) return null;
  return auditionMix(document, balance.plan, {
    mode: balance.preview ? "candidate" : "current",
    focusId: balance.auditionId,
    focusSide: balance.auditionSide,
  });
}

/** Saved EQ always; candidate EQ only while a fresh plan is being previewed or one row is auditioned. */
export function currentEqAudition(document: ProjectDocument, eq: EqSession): EqAudition {
  const live = eq.plan && eq.phase === "ready" && (eq.preview || eq.auditionId) && !eqPlanIsStale(eq.plan, document, eq.fingerprints, eq.settings);
  if (!live) return eqAudition(document, null, { mode: "current" });
  return eqAudition(document, eq.plan, { mode: eq.preview ? "candidate" : "current", focusId: eq.auditionId, focusSide: eq.auditionSide });
}

/** Saved pan and width always; candidate rows only while a fresh plan is being previewed or one row is auditioned. */
export function currentSpatialAudition(document: ProjectDocument, space: SpaceSession): SpatialAudition {
  const live = space.plan && space.phase === "ready" && (space.preview || space.auditionId) && !spatialPlanIsStale(space.plan, document, space.fingerprints, space.settings);
  if (!live) return spatialAudition(document, null, { mode: "current" });
  return spatialAudition(document, space.plan, { mode: space.preview ? "candidate" : "current", focusId: space.auditionId, focusSide: space.auditionSide });
}

export function monitorState(document: ProjectDocument, balance: BalanceSession, eq: EqSession, space: SpaceSession = idleSpace()): MonitorState {
  const gainPlan = balanceAudition(document, balance);
  const audition = currentEqAudition(document, eq);
  const spatial = currentSpatialAudition(document, space);
  const trim = audition.trimDb + spatial.trimDb;
  const gainTrim = gainPlan?.trimApplied ? gainPlan.trimDb : 0;
  const gains = new Map<string, number>();
  for (const track of document.tracks) {
    const base = gainPlan?.tracks.find((item) => item.trackId === track.id)?.gainDb ?? track.gainDb;
    gains.set(track.id, base + trim);
  }
  const regions = new Map<string, MonitorState["gainRegions"][number]>();
  for (const row of document.sectionTrackSettings) {
    if (row.overrides.gainDb === null) continue;
    const section = document.sections.find((item) => item.id === row.sectionId);
    if (!section) continue;
    regions.set(`${row.trackId}:${row.sectionId}`, {
      trackId: row.trackId,
      startSeconds: section.startTime,
      endSeconds: section.endTime,
      gainDb: row.overrides.gainDb + gainTrim + trim,
    });
  }
  for (const region of gainPlan?.regions ?? []) {
    regions.set(`${region.trackId}:${region.sectionId}`, {
      trackId: region.trackId,
      startSeconds: region.startSeconds,
      endSeconds: region.endSeconds,
      gainDb: region.gainDb + trim,
    });
  }
  const eqTracks: TrackEqSetting[] = document.tracks
    .map((track) => ({
      trackId: track.id,
      filters: audition.tracks.find((item) => item.trackId === track.id)?.filters ?? [],
      regions: audition.regions
        .filter((region) => region.trackId === track.id)
        .map((region) => ({ startSeconds: region.startSeconds, endSeconds: region.endSeconds, filters: region.filters })),
    }))
    .filter((item) => item.filters.length > 0 || item.regions.length > 0);
  const spatialTracks: TrackSpatialSetting[] = spatial.tracks.map((track) => ({
    trackId: track.trackId,
    pan: track.pan,
    width: track.width,
    regions: spatial.regions
      .filter((region) => region.trackId === track.trackId)
      .map((region) => ({ startSeconds: region.startSeconds, endSeconds: region.endSeconds, pan: region.pan, width: region.width })),
  }));
  return { gains, gainRegions: [...regions.values()], eq: eqTracks, eqAudition: audition, spatial: spatialTracks, spatialAudition: spatial };
}

/** Gain at `seconds` for engines that cannot schedule section windows. */
export function monitorGainAt(state: MonitorState, trackId: string, seconds: number): number {
  const region = state.gainRegions.find((item) => item.trackId === trackId && seconds >= item.startSeconds && seconds < item.endSeconds);
  return region?.gainDb ?? state.gains.get(trackId) ?? 0;
}

/** Pan at `seconds` for engines that cannot schedule section windows or play width. */
export function monitorPanAt(state: MonitorState, trackId: string, seconds: number): number {
  return spatialAuditionAt(state.spatialAudition, trackId, seconds).pan;
}

export function publishMonitor(engine: AudioEngine, document: ProjectDocument, state: MonitorState, native: boolean): void {
  const time = engine.getCurrentTime();
  const spatial = native && Boolean(engine.setTrackSpatial);
  for (const track of document.tracks) {
    const gain = native ? (state.gains.get(track.id) ?? track.gainDb) : monitorGainAt(state, track.id, time);
    engine.setTrackGain(track.id, gain);
    if (!spatial) engine.setTrackPan(track.id, monitorPanAt(state, track.id, time));
    engine.setMute(track.id, track.muted);
    engine.setSolo(track.id, track.solo);
  }
  engine.setGainRegions?.(native ? state.gainRegions : []);
  engine.setTrackEq?.(state.eq);
  if (spatial) engine.setTrackSpatial!(state.spatial);
}

/** A key that changes whenever anything the monitor sends would change. */
export function monitorKey(state: MonitorState): string {
  return JSON.stringify([[...state.gains.entries()], state.gainRegions, state.eq, state.spatial]);
}
