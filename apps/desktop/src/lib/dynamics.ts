import { envelopeFramesCacheSchema, type EnvelopeFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import {
  applyDynamicsPlan,
  dynamicsPlanIsStale,
  dynamicsRecommendationIncluded,
  engineDynamicsNode,
  planDynamics,
  withDynamicsProxyChecks,
  type DynamicsApplyMode,
  type DynamicsPlan,
  type DynamicsProxyCheck,
  type DynamicsRecommendation,
  type EngineDynamicsNode,
} from "@audiosous/dynamics-planner";
import { dynamicsChainForSection, dynamicsNodeRunnable, eqChainForSection, type DynamicsNode, type ProjectDocument } from "@audiosous/project-model";
import { getPlatform } from "../platform";
import type { DesktopPlatform, DynamicsCheckRequest } from "../platform/types";
import { useAppStore, type DynamicsSession } from "../state/app-store";
import { loadBandFrames } from "./eq";
import { logEvent } from "./log";
import { loadTrackAnalysis } from "./track-analysis";

/** What dynamics planning looks at. The timeline selection never narrows it. */
export function dynamicsScope(document: ProjectDocument): string {
  const sections = document.sections.length;
  const parts = sections === 0 ? "the whole song" : `the whole song and each of the ${sections} ${sections === 1 ? "section" : "sections"}`;
  return `Reads every stem's level, attacks, and low end every 10 ms over ${parts}, as the mix is now: faders, section gain, saved EQ, pan and width, and saved dynamics. The selection does not limit it.`;
}

export function dynamicsPlanFresh(document: ProjectDocument, dynamics: DynamicsSession): boolean {
  return Boolean(dynamics.plan && dynamics.phase === "ready" && !dynamicsPlanIsStale(dynamics.plan, document, dynamics.fingerprints, dynamics.settings));
}

export async function runDynamicsPlan(): Promise<void> {
  const store = useAppStore.getState();
  const document = store.document;
  const projectFile = store.projectFilePath;
  if (!document || !projectFile) return;
  const generation = store.dynamics.generation + 1;
  const projectId = document.project.id;
  store.setPlanTab("dynamics");
  store.setDynamics({ open: true, generation, phase: "analyzing", progress: "Analyzing…", error: null, plan: null, preview: false, auditionId: null, selectedId: null });
  const platform = getPlatform();
  await logEvent(platform, "info", "dynamicsplan.start", "Started dynamics planning.", { projectId, tracks: document.tracks.length, strength: store.dynamics.settings.strength });
  // A newer run, a cancel, or another project makes every later step of this run a no-op.
  const current = () => useAppStore.getState().dynamics.generation === generation && useAppStore.getState().document?.project.id === projectId;
  try {
    if (platform.kind !== "tauri") throw new Error("Dynamics planning reads the desktop analysis cache and the playback proxies. Open this project in the desktop app.");
    const analysisStarted = performance.now();
    const measurements: Record<string, TrackFileMeasurement | null> = {};
    const fingerprints: DynamicsSession["fingerprints"] = [];
    for (const [index, track] of document.tracks.entries()) {
      if (!current()) return;
      useAppStore.getState().setDynamics({ progress: `Analyzing ${index + 1} of ${document.tracks.length}: ${track.name}` });
      const loaded = await loadTrackAnalysis(platform, projectFile, { id: track.id, filename: track.file.filename, relativePath: track.file.relativePath }, undefined, 15);
      if (!current()) return;
      measurements[track.id] = loaded.measurement;
      const [status] = await platform.projectMediaStatus(projectFile, [track.file.relativePath]);
      if (status) fingerprints.push({ trackId: track.id, fileSizeBytes: status.fileSizeBytes, modifiedAtNs: status.modifiedAtNs });
    }
    if (!current()) return;
    useAppStore.getState().setDynamics({ progress: "Measuring envelopes and bands on the playback proxies…" });
    const envelopes = await loadEnvelopeFrames(platform, projectFile, document);
    if (!current()) return;
    const bands = await loadBandFrames(platform, projectFile, document);
    const analysisMs = Math.round(performance.now() - analysisStarted);
    if (!current()) return;
    useAppStore.getState().setDynamics({ phase: "planning", progress: "Planning…" });
    const latest = useAppStore.getState().document;
    if (!latest || latest.project.id !== projectId) return;
    const started = performance.now();
    let plan = planDynamics({ document: latest, measurements, envelopes, bands, fingerprints, settings: useAppStore.getState().dynamics.settings });
    const durationMs = Math.round(performance.now() - started);
    if (!current()) return;
    if (refuseStale(plan, fingerprints, "Discarded a dynamics plan because the project changed while it was planned.")) return;
    useAppStore.getState().setDynamics({ phase: "verifying", progress: "Checking dynamics on the playback proxies…" });
    const verifyStarted = performance.now();
    plan = await verifyDynamicsOnProxies(platform, projectFile, latest, plan);
    const verifyMs = Math.round(performance.now() - verifyStarted);
    if (!current()) return;
    if (refuseStale(plan, fingerprints, "Discarded a dynamics plan because the project changed while it was checked.")) return;
    useAppStore.getState().setDynamics({ phase: "ready", progress: null, plan, fingerprints, error: null, selectedId: plan.changes[0]?.id ?? null });
    await logEvent(platform, "info", "dynamicsplan.complete", "Finished a dynamics plan.", {
      projectId,
      changes: plan.changes.length,
      review: plan.summary.reviewCount,
      tracks: plan.summary.tracksAnalyzed,
      pairs: plan.summary.pairsAnalyzed,
      confidence: plan.summary.confidence,
      analysisMs,
      durationMs,
      verifyMs,
    });
  } catch (caught) {
    if (!current()) return;
    const message = caught instanceof Error && caught.message ? caught.message : "Dynamics planning could not finish.";
    useAppStore.getState().setDynamics({ phase: "failed", progress: null, error: message, plan: null });
  }

  function refuseStale(plan: DynamicsPlan, fingerprints: DynamicsSession["fingerprints"], message: string): boolean {
    const after = useAppStore.getState().document;
    if (after && !dynamicsPlanIsStale(plan, after, fingerprints, useAppStore.getState().dynamics.settings)) return false;
    void logEvent(platform, "info", "dynamicsplan.stale", message, { projectId });
    useAppStore.getState().setDynamics({ phase: "failed", progress: null, error: "The project changed while Dynamics was planning. Run it again." });
    return true;
  }
}

/** Proxy envelope frames per track. Muted stems are measured too: a muted kick can still key a duck. */
async function loadEnvelopeFrames(platform: DesktopPlatform, projectFile: string, document: ProjectDocument): Promise<Record<string, EnvelopeFrames | null>> {
  const out: Record<string, EnvelopeFrames | null> = {};
  try {
    const responses = await platform.envelopeFrames(
      projectFile,
      document.tracks.map((track) => ({ trackId: track.id, relativePath: track.file.relativePath })),
    );
    for (const response of responses) {
      if (!response.json) continue;
      const parsed = envelopeFramesCacheSchema.safeParse(JSON.parse(response.json));
      out[response.trackId] = parsed.success ? parsed.data.envelope : null;
    }
  } catch {
    // The plan summary says which stems had no envelope.
  }
  return out;
}

function processingNode(change: DynamicsRecommendation): EngineDynamicsNode {
  return engineDynamicsNode({ ...change.processing, id: "candidate", enabled: true, origin: "dynamics-plan", note: null } as DynamicsNode);
}

/** The check request for one row: its track, its key, its scope's saved EQ and dynamics, before and with the row. */
export function dynamicsCheckRequest(document: ProjectDocument, change: DynamicsRecommendation): DynamicsCheckRequest | null {
  const track = document.tracks.find((item) => item.id === change.trackId);
  if (!track) return null;
  const sectionId = change.scope.type === "section" ? change.scope.sectionId : null;
  const keyTrackId = change.processing.type === "ducking" || change.processing.type === "dynamic-eq" ? change.processing.keyTrackId : null;
  const key = keyTrackId ? document.tracks.find((item) => item.id === keyTrackId) : null;
  const saved = dynamicsChainForSection(document, track.id, sectionId).filter((node) => dynamicsNodeRunnable(document, track.id, node));
  const before = saved.map(engineDynamicsNode);
  const after = [...saved.filter((node) => node.id !== change.replacesNodeId).map(engineDynamicsNode), processingNode(change)];
  return {
    id: change.id,
    trackId: track.id,
    relativePath: track.file.relativePath,
    keyTrackId: key?.id ?? null,
    keyRelativePath: key?.file.relativePath ?? null,
    windows: change.evidence.windows,
    savedEq: eqChainForSection(document, track.id, sectionId),
    before,
    after,
    kind: change.processing.type,
    band: change.evidence.band,
  };
}

/** Second evaluation tier: the native dynamics over the 48 kHz proxies, where the problem happens. */
export async function verifyDynamicsOnProxies(platform: DesktopPlatform, projectFile: string, document: ProjectDocument, plan: DynamicsPlan): Promise<DynamicsPlan> {
  if (plan.changes.length === 0) return plan;
  const requests = plan.changes.map((change) => dynamicsCheckRequest(document, change)).filter((request): request is DynamicsCheckRequest => request !== null);
  try {
    const responses = await platform.checkDynamics(projectFile, requests);
    const checks: DynamicsProxyCheck[] = [];
    let failed = plan.changes.length - requests.length;
    for (const response of responses) {
      const result = response.result;
      if (!result) {
        failed += 1;
        continue;
      }
      const change = (on: number | null, off: number | null) => (on === null || off === null ? null : off - on);
      const band = result.before.bandOnDb !== null ? "band" : "level";
      checks.push({
        id: response.id,
        reductionP50Db: result.reductionP50Db,
        reductionP95Db: result.reductionP95Db,
        reductionMaxDb: result.reductionMaxDb,
        levelBeforeDb: result.before.rmsDb,
        levelAfterDb: result.after.rmsDb,
        spreadBeforeDb: result.before.p90Db - result.before.p10Db,
        spreadAfterDb: result.after.p90Db - result.after.p10Db,
        transientBeforeDb: result.before.transientDb,
        transientAfterDb: result.after.transientDb,
        bandOnChangeDb: band === "band" ? change(result.before.bandOnDb, result.after.bandOnDb) : change(result.before.levelOnDb, result.after.levelOnDb),
        bandOffChangeDb: band === "band" ? change(result.before.bandOffDb, result.after.bandOffDb) : change(result.before.levelOffDb, result.after.levelOffDb),
        recovered: result.recoveredShare,
        seconds: result.seconds,
      });
    }
    await logEvent(platform, "info", "dynamicsplan.verify", "Checked dynamics on the playback proxies.", { checked: checks.length, failed });
    return withDynamicsProxyChecks(plan, checks, failed);
  } catch {
    return withDynamicsProxyChecks(plan, [], plan.changes.length);
  }
}

export function cancelDynamicsPlan(): void {
  const state = useAppStore.getState();
  state.setDynamics({ generation: state.dynamics.generation + 1, phase: "idle", plan: null, preview: false, auditionId: null, selectedId: null, progress: null, error: null, open: false });
  void logEvent(getPlatform(), "info", "dynamicsplan.cancel", "Cancelled dynamics planning.", { projectId: state.document?.project.id ?? null });
}

/** Writes the chosen rows into the processing graphs. One undo step restores the whole pre-plan dynamics state. */
export function applyDynamics(mode: DynamicsApplyMode): boolean {
  const state = useAppStore.getState();
  const document = state.document;
  const plan = state.dynamics.plan;
  if (!document || !plan) return false;
  if (dynamicsPlanIsStale(plan, document, state.dynamics.fingerprints, state.dynamics.settings)) {
    void logEvent(getPlatform(), "info", "dynamicsplan.stale", "Refused to apply an out-of-date dynamics plan.", { projectId: document.project.id });
    return false;
  }
  const next = applyDynamicsPlan(document, plan, mode);
  useAppStore.getState().replaceDocument(next, true, { mode: "record" });
  useAppStore.getState().setDynamics({ generation: state.dynamics.generation + 1, phase: "idle", plan: null, preview: false, auditionId: null, selectedId: null, progress: null, error: null });
  useAppStore.getState().setNotice("Dynamics applied. Undo restores the previous processing.");
  void logEvent(getPlatform(), "info", "dynamicsplan.apply", "Applied a dynamics plan.", {
    projectId: document.project.id,
    mode,
    changes: plan.changes.filter((change) => (mode === "accepted" ? change.status === "accepted" : dynamicsRecommendationIncluded(change, "all"))).length,
  });
  return true;
}

function stopOthers(): void {
  useAppStore.getState().setBalance({ preview: false, auditionId: null });
  useAppStore.getState().setEq({ preview: false, auditionId: null });
  useAppStore.getState().setSpace({ preview: false, auditionId: null });
}

/** Whole-plan A/B. Starting a dynamics audition stops a gain, EQ, or space audition, so one comparison plays at a time. */
export function setDynamicsPreview(preview: boolean): void {
  useAppStore.getState().setDynamics({ preview, auditionId: null });
  if (preview) stopOthers();
  void logEvent(getPlatform(), "info", "dynamicsplan.preview", preview ? "Playing the Dynamics Candidate." : "Playing the current mix.", { mode: preview ? "candidate" : "current" });
}

/** Single-row A/B in the full mix. The same button again stops the audition. */
export function auditionDynamics(id: string, side: "bypassed" | "recommended"): void {
  const dynamics = useAppStore.getState().dynamics;
  const same = dynamics.auditionId === id && dynamics.auditionSide === side;
  useAppStore.getState().setDynamics(same ? { auditionId: null } : { auditionId: id, auditionSide: side, preview: false });
  if (!same) stopOthers();
  void logEvent(getPlatform(), "info", "dynamicsplan.preview", "Auditioned one dynamics row.", { id, side: same ? "off" : side });
}

/** Called when a row is edited: make sure the edit is heard (the whole candidate if it includes the row, else that row). */
export function hearDynamicsRow(id: string): void {
  const dynamics = useAppStore.getState().dynamics;
  const change = dynamics.plan?.changes.find((item) => item.id === id);
  if (!change) return;
  if (dynamics.preview && dynamicsRecommendationIncluded(change, "preview")) return;
  if (dynamics.auditionId === id && dynamics.auditionSide === "recommended") return;
  useAppStore.getState().setDynamics({ auditionId: id, auditionSide: "recommended", preview: false });
  stopOthers();
}

/** What the Dynamics panel is playing right now, in words. */
export function dynamicsHearing(document: ProjectDocument, dynamics: DynamicsSession): string {
  if (!dynamics.plan || dynamics.phase !== "ready") return "Hearing the saved mix";
  const matched = dynamics.levelMatch ? ", level-matched" : "";
  if (dynamics.auditionId) {
    const change = dynamics.plan.changes.find((item) => item.id === dynamics.auditionId);
    const name = document.tracks.find((track) => track.id === change?.trackId)?.name ?? "this stem";
    return dynamics.auditionSide === "recommended" ? `Hearing ${name} with only this change${matched}` : `Hearing ${name} without this change`;
  }
  return dynamics.preview ? `Hearing the Dynamics Candidate${matched}` : "Hearing Current (saved mix)";
}
