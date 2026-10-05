import { stereoFramesCacheSchema, type StereoFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import { eqChainForSection, type ProjectDocument } from "@audiosous/project-model";
import {
  applySpacePlan,
  planSpace,
  spatialPlanIsStale,
  spatialRecommendationIncluded,
  withSpatialProxyChecks,
  type SpatialApplyMode,
  type SpatialPlan,
  type SpatialProxyCheck,
} from "@audiosous/spatial-planner";
import { getPlatform } from "../platform";
import type { DesktopPlatform, SpatialCheckRequest } from "../platform/types";
import { useAppStore, type SpaceSession } from "../state/app-store";
import { loadBandFrames } from "./eq";
import { logEvent } from "./log";
import { loadTrackAnalysis } from "./track-analysis";

/** What spatial planning looks at. The timeline selection never narrows it. */
export function spaceScope(document: ProjectDocument): string {
  const sections = document.sections.length;
  const parts =
    sections === 0
      ? "the whole song as one part"
      : `the whole song and each of the ${sections} ${sections === 1 ? "section" : "sections"} separately`;
  return `Compares where every pair of stems that play together sits in the stereo field, in the frequencies they compete for, over ${parts}. It hears the current faders, saved EQ, pan, and width. The selection does not limit it.`;
}

export function spacePlanFresh(document: ProjectDocument, space: SpaceSession): boolean {
  return Boolean(space.plan && space.phase === "ready" && !spatialPlanIsStale(space.plan, document, space.fingerprints, space.settings));
}

export async function runSpacePlan(): Promise<void> {
  const store = useAppStore.getState();
  const document = store.document;
  const projectFile = store.projectFilePath;
  if (!document || !projectFile) return;
  const generation = store.space.generation + 1;
  const projectId = document.project.id;
  store.setPlanTab("space");
  store.setSpace({ open: true, generation, phase: "analyzing", progress: "Analyzing…", error: null, plan: null, preview: false, auditionId: null, selectedId: null });
  const platform = getPlatform();
  await logEvent(platform, "info", "spatialplan.start", "Started spatial planning.", { projectId, tracks: document.tracks.length, strength: store.space.settings.strength });
  // A newer run, a cancel, or another project makes every later step of this run a no-op.
  const current = () => useAppStore.getState().space.generation === generation && useAppStore.getState().document?.project.id === projectId;
  try {
    if (platform.kind !== "tauri") throw new Error("Spatial planning reads the desktop analysis cache. Open this project in the desktop app.");
    const analysisStarted = performance.now();
    const measurements: Record<string, TrackFileMeasurement | null> = {};
    const fingerprints: SpaceSession["fingerprints"] = [];
    for (const [index, track] of document.tracks.entries()) {
      if (!current()) return;
      useAppStore.getState().setSpace({ progress: `Analyzing ${index + 1} of ${document.tracks.length}: ${track.name}` });
      const loaded = await loadTrackAnalysis(platform, projectFile, { id: track.id, filename: track.file.filename, relativePath: track.file.relativePath }, undefined, 15);
      if (!current()) return;
      measurements[track.id] = loaded.measurement;
      const [status] = await platform.projectMediaStatus(projectFile, [track.file.relativePath]);
      if (status) fingerprints.push({ trackId: track.id, fileSizeBytes: status.fileSizeBytes, modifiedAtNs: status.modifiedAtNs });
    }
    if (!current()) return;
    useAppStore.getState().setSpace({ progress: "Measuring bands and stereo on the playback proxies…" });
    const bands = await loadBandFrames(platform, projectFile, document);
    if (!current()) return;
    const stereo = await loadStereoFrames(platform, projectFile, document);
    const analysisMs = Math.round(performance.now() - analysisStarted);
    if (!current()) return;
    useAppStore.getState().setSpace({ phase: "planning", progress: "Planning…" });
    const latest = useAppStore.getState().document;
    if (!latest || latest.project.id !== projectId) return;
    const started = performance.now();
    let plan = planSpace({ document: latest, measurements, bands, stereo, fingerprints, settings: useAppStore.getState().space.settings });
    const durationMs = Math.round(performance.now() - started);
    if (!current()) return;
    if (refuseStale(plan, fingerprints, "Discarded a spatial plan because the project changed while it was planned.")) return;
    useAppStore.getState().setSpace({ phase: "verifying", progress: "Checking pan and width on the playback proxies…" });
    const verifyStarted = performance.now();
    plan = await verifySpaceOnProxies(platform, projectFile, latest, plan);
    const verifyMs = Math.round(performance.now() - verifyStarted);
    if (!current()) return;
    if (refuseStale(plan, fingerprints, "Discarded a spatial plan because the project changed while it was checked.")) return;
    useAppStore.getState().setSpace({ phase: "ready", progress: null, plan, fingerprints, error: null, selectedId: plan.changes[0]?.id ?? null });
    await logEvent(platform, "info", "spatialplan.complete", "Finished a spatial plan.", {
      projectId,
      changes: plan.changes.length,
      review: plan.summary.reviewCount,
      pairs: plan.summary.pairsAnalyzed,
      confidence: plan.summary.confidence,
      analysisMs,
      durationMs,
      verifyMs,
    });
  } catch (caught) {
    if (!current()) return;
    const message = caught instanceof Error && caught.message ? caught.message : "Spatial planning could not finish.";
    useAppStore.getState().setSpace({ phase: "failed", progress: null, error: message, plan: null });
  }

  function refuseStale(plan: SpatialPlan, fingerprints: SpaceSession["fingerprints"], message: string): boolean {
    const after = useAppStore.getState().document;
    if (after && !spatialPlanIsStale(plan, after, fingerprints, useAppStore.getState().space.settings)) return false;
    void logEvent(platform, "info", "spatialplan.stale", message, { projectId });
    useAppStore.getState().setSpace({ phase: "failed", progress: null, error: "The project changed while Space was planning. Run it again." });
    return true;
  }
}

/** Proxy stereo frames per track; a track that fails falls back to its whole-file stereo figures in the planner. */
async function loadStereoFrames(platform: DesktopPlatform, projectFile: string, document: ProjectDocument): Promise<Record<string, StereoFrames | null>> {
  const out: Record<string, StereoFrames | null> = {};
  try {
    const responses = await platform.stereoFrames(
      projectFile,
      document.tracks.filter((track) => !track.muted).map((track) => ({ trackId: track.id, relativePath: track.file.relativePath })),
    );
    for (const response of responses) {
      if (!response.json) continue;
      const parsed = stereoFramesCacheSchema.safeParse(JSON.parse(response.json));
      out[response.trackId] = parsed.success ? parsed.data.stereo : null;
    }
  } catch {
    // The plan summary says which stems used whole-file stereo figures.
  }
  return out;
}

/** Second evaluation tier: the native spatial stage over the 48 kHz proxies, where the parts compete. */
export async function verifySpaceOnProxies(platform: DesktopPlatform, projectFile: string, document: ProjectDocument, plan: SpatialPlan): Promise<SpatialPlan> {
  if (plan.changes.length === 0) return plan;
  const requests: SpatialCheckRequest[] = plan.changes.map((change) => {
    const track = document.tracks.find((item) => item.id === change.trackId)!;
    // Measured from what the row is applied on top of: a section row sits on the plan's whole-song row.
    const before = change.scope.type === "section" ? (change.evidence.scopes[0]?.baseline ?? change.current) : change.current;
    return {
      id: change.id,
      trackId: change.trackId,
      relativePath: track.file.relativePath,
      windows: change.evidence.windows,
      saved: eqChainForSection(document, change.trackId, change.scope.type === "section" ? change.scope.sectionId : null),
      before,
      after: { pan: change.processing.pan ?? before.pan, width: change.processing.width ?? before.width },
    };
  });
  try {
    const responses = await platform.checkSpatial(projectFile, requests);
    const checks: SpatialProxyCheck[] = [];
    let failed = 0;
    for (const response of responses) {
      if (!response.result) {
        failed += 1;
        continue;
      }
      checks.push({
        id: response.id,
        correlationBefore: response.result.before.correlation,
        correlationAfter: response.result.after.correlation,
        monoLossBeforeDb: response.result.before.monoLossDb,
        monoLossAfterDb: response.result.after.monoLossDb,
        peakBeforeDbfs: response.result.before.peakDbfs,
        peakAfterDbfs: response.result.after.peakDbfs,
        seconds: response.result.seconds,
      });
    }
    await logEvent(platform, "info", "spatialplan.verify", "Checked pan and width on the playback proxies.", { checked: checks.length, failed });
    return withSpatialProxyChecks(plan, checks, failed);
  } catch {
    return withSpatialProxyChecks(plan, [], plan.changes.length);
  }
}

export function cancelSpacePlan(): void {
  const state = useAppStore.getState();
  state.setSpace({ generation: state.space.generation + 1, phase: "idle", plan: null, preview: false, auditionId: null, selectedId: null, progress: null, error: null, open: false });
  void logEvent(getPlatform(), "info", "spatialplan.cancel", "Cancelled spatial planning.", { projectId: state.document?.project.id ?? null });
}

/** Writes the chosen pan and width into the project. One undo step restores the whole pre-plan spatial state. */
export function applySpace(mode: SpatialApplyMode): boolean {
  const state = useAppStore.getState();
  const document = state.document;
  const plan = state.space.plan;
  if (!document || !plan) return false;
  if (spatialPlanIsStale(plan, document, state.space.fingerprints, state.space.settings)) {
    void logEvent(getPlatform(), "info", "spatialplan.stale", "Refused to apply an out-of-date spatial plan.", { projectId: document.project.id });
    return false;
  }
  const next = applySpacePlan(document, plan, mode);
  useAppStore.getState().replaceDocument(next, true, { mode: "record" });
  useAppStore.getState().setSpace({ generation: state.space.generation + 1, phase: "idle", plan: null, preview: false, auditionId: null, selectedId: null, progress: null, error: null });
  useAppStore.getState().setNotice("Pan and width applied. Undo restores the previous mix.");
  void logEvent(getPlatform(), "info", "spatialplan.apply", "Applied a spatial plan.", {
    projectId: document.project.id,
    mode,
    changes: plan.changes.filter((change) => (mode === "accepted" ? change.status === "accepted" : change.status === "accepted" || change.status === "proposed")).length,
  });
  return true;
}

/** Whole-plan A/B. Starting a spatial audition stops a gain or EQ audition, so one comparison plays at a time. */
export function setSpacePreview(preview: boolean): void {
  useAppStore.getState().setSpace({ preview, auditionId: null });
  if (preview) {
    useAppStore.getState().setBalance({ preview: false, auditionId: null });
    useAppStore.getState().setEq({ preview: false, auditionId: null });
    useAppStore.getState().setDynamics({ preview: false, auditionId: null });
  }
  void logEvent(getPlatform(), "info", "spatialplan.preview", preview ? "Playing the Spatial Candidate." : "Playing the current mix.", { mode: preview ? "candidate" : "current" });
}

/** Single-row A/B in the full mix. The same button again stops the audition. */
export function auditionSpace(id: string, side: "bypassed" | "recommended"): void {
  const space = useAppStore.getState().space;
  const same = space.auditionId === id && space.auditionSide === side;
  useAppStore.getState().setSpace(same ? { auditionId: null } : { auditionId: id, auditionSide: side, preview: false });
  if (!same) {
    useAppStore.getState().setBalance({ preview: false, auditionId: null });
    useAppStore.getState().setEq({ preview: false, auditionId: null });
    useAppStore.getState().setDynamics({ preview: false, auditionId: null });
  }
  void logEvent(getPlatform(), "info", "spatialplan.preview", "Auditioned one spatial row.", { id, side: same ? "off" : side });
}

/**
 * Called when a row is edited: make sure the edit is heard. If the whole candidate is playing and includes the row,
 * nothing changes; otherwise the row's own audition starts (whole mix, only this row switched).
 */
export function hearSpaceRow(id: string): void {
  const space = useAppStore.getState().space;
  const change = space.plan?.changes.find((item) => item.id === id);
  if (!change) return;
  if (space.preview && spatialRecommendationIncluded(change, "preview")) return;
  if (space.auditionId === id && space.auditionSide === "recommended") return;
  useAppStore.getState().setSpace({ auditionId: id, auditionSide: "recommended", preview: false });
  useAppStore.getState().setBalance({ preview: false, auditionId: null });
  useAppStore.getState().setEq({ preview: false, auditionId: null });
  useAppStore.getState().setDynamics({ preview: false, auditionId: null });
}

/** What the Space panel is playing right now, in words. */
export function spaceHearing(document: ProjectDocument, space: SpaceSession): string {
  if (!space.plan || space.phase !== "ready") return "Hearing the saved mix";
  if (space.auditionId) {
    const change = space.plan.changes.find((item) => item.id === space.auditionId);
    const name = document.tracks.find((track) => track.id === change?.trackId)?.name ?? "this stem";
    return space.auditionSide === "recommended" ? `Hearing ${name} with only this change` : `Hearing ${name} without this change`;
  }
  return space.preview ? "Hearing the Spatial Candidate" : "Hearing Current (saved mix)";
}
