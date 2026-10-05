import type { AudioEngine, TrackDynamicsSetting, TrackEqSetting, TrackSpatialSetting } from "@audiosous/audio-engine";
import { dynamicsAudition, dynamicsPlanIsStale, type DynamicsAudition } from "@audiosous/dynamics-planner";
import { auditionMix, planIsStale } from "@audiosous/balance-planner";
import { eqAudition, eqPlanIsStale, type EqAudition } from "@audiosous/eq-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { spatialAudition, spatialAuditionAt, spatialPlanIsStale, type SpatialAudition } from "@audiosous/spatial-planner";
import { idleDynamics, idleSpace, type BalanceSession, type DynamicsSession, type EqSession, type SpaceSession } from "../state/app-store";

/**
 * What the engine should play right now: the saved mix, plus whichever plan is being auditioned.
 * No plan touches the saved project. This is the only place the overlays meet.
 *
 *   gain:    saved fader → AutoBalance audition (if any) → EQ or Spatial candidate safety trim (if any)
 *   regions: saved Track × Section gain, then AutoBalance section rows replace theirs
 *   EQ:      saved track and section filters → EQ candidate filters (if any)
 *   spatial: saved pan, width, and section pan/width → Spatial candidate rows (if any)
 *   dynamics: saved dynamics → Dynamics candidate rows (if any), with level-match offsets on the faders and section
 *            gain windows of the processed stems while the candidate is auditioned (never saved)
 */
export interface MonitorState {
  gains: Map<string, number>;
  gainRegions: Array<{ trackId: string; startSeconds: number; endSeconds: number; gainDb: number }>;
  eq: TrackEqSetting[];
  eqAudition: EqAudition;
  spatial: TrackSpatialSetting[];
  spatialAudition: SpatialAudition;
  dynamics: TrackDynamicsSetting[];
  dynamicsAudition: DynamicsAudition;
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

/** Saved dynamics always; candidate rows (and their level match) only while a fresh plan is previewed or one row is auditioned. */
export function currentDynamicsAudition(document: ProjectDocument, dynamics: DynamicsSession): DynamicsAudition {
  const live =
    dynamics.plan && dynamics.phase === "ready" && (dynamics.preview || dynamics.auditionId) && !dynamicsPlanIsStale(dynamics.plan, document, dynamics.fingerprints, dynamics.settings);
  if (!live) return dynamicsAudition(document, null, { mode: "current" });
  return dynamicsAudition(document, dynamics.plan, {
    mode: dynamics.preview ? "candidate" : "current",
    focusId: dynamics.auditionId,
    focusSide: dynamics.auditionSide,
    levelMatch: dynamics.levelMatch,
  });
}

export function monitorState(document: ProjectDocument, balance: BalanceSession, eq: EqSession, space: SpaceSession = idleSpace(), dynamicsSession: DynamicsSession = idleDynamics()): MonitorState {
  const gainPlan = balanceAudition(document, balance);
  const audition = currentEqAudition(document, eq);
  const spatial = currentSpatialAudition(document, space);
  const dynamics = currentDynamicsAudition(document, dynamicsSession);
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
  // Level match for the dynamics audition: a whole-song offset adds to the fader and to every section gain window of
  // that stem (a window replaces the fader); a section offset adds to that section's window, created if needed.
  const wholeSong = new Map<string, number>();
  for (const item of dynamics.compensation) if (item.sectionId === null) wholeSong.set(item.trackId, (wholeSong.get(item.trackId) ?? 0) + item.gainDb);
  for (const [key, region] of regions) regions.set(key, { ...region, gainDb: region.gainDb + (wholeSong.get(region.trackId) ?? 0) });
  for (const item of dynamics.compensation) {
    if (item.sectionId === null) continue;
    const key = `${item.trackId}:${item.sectionId}`;
    const region = regions.get(key);
    const base = region ? region.gainDb : (gains.get(item.trackId) ?? 0) + (wholeSong.get(item.trackId) ?? 0);
    regions.set(key, { trackId: item.trackId, startSeconds: item.startSeconds, endSeconds: item.endSeconds, gainDb: base + item.gainDb });
  }
  for (const [trackId, offset] of wholeSong) gains.set(trackId, (gains.get(trackId) ?? 0) + offset);
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
  return {
    gains,
    gainRegions: [...regions.values()],
    eq: eqTracks,
    eqAudition: audition,
    spatial: spatialTracks,
    spatialAudition: spatial,
    dynamics: dynamics.tracks,
    dynamicsAudition: dynamics,
  };
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
  if (native) engine.setTrackDynamics?.(state.dynamics);
}

/** A key that changes whenever anything the monitor sends would change. */
export function monitorKey(state: MonitorState): string {
  return JSON.stringify([[...state.gains.entries()], state.gainRegions, state.eq, state.spatial, state.dynamics]);
}
