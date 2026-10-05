import { eqBandsCacheSchema, type EqBandFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import {
  applyEqPlan,
  checkRange,
  eqPlanIsStale,
  eqRecommendationIncluded,
  planEq,
  withProxyChecks,
  type EqApplyMode,
  type EqPlan,
  type ProxyCheck,
} from "@audiosous/eq-planner";
import { eqChainForSection, type ProjectDocument } from "@audiosous/project-model";
import { getPlatform } from "../platform";
import type { DesktopPlatform, EqCheckRequest } from "../platform/types";
import { useAppStore, type EqSession } from "../state/app-store";
import { logEvent } from "./log";
import { loadTrackAnalysis } from "./track-analysis";

/** What EQ planning looks at. The timeline selection never narrows it. */
export function eqScope(document: ProjectDocument): string {
  const sections = document.sections.length;
  const parts =
    sections === 0
      ? "the whole song as one part"
      : `the whole song and each of the ${sections} ${sections === 1 ? "section" : "sections"} separately`;
  return `Compares every pair of stems that play together, over ${parts}. It hears the current faders, section gain, and saved EQ. The selection does not limit it.`;
}

export function eqPlanFresh(document: ProjectDocument, eq: EqSession): boolean {
  return Boolean(eq.plan && eq.phase === "ready" && !eqPlanIsStale(eq.plan, document, eq.fingerprints, eq.settings));
}

export async function runEqPlan(): Promise<void> {
  const store = useAppStore.getState();
  const document = store.document;
  const projectFile = store.projectFilePath;
  if (!document || !projectFile) return;
  const generation = store.eq.generation + 1;
  const projectId = document.project.id;
  store.setPlanTab("eq");
  store.setEq({ open: true, generation, phase: "analyzing", progress: "Analyzing…", error: null, plan: null, preview: false, auditionId: null, selectedId: null });
  const platform = getPlatform();
  await logEvent(platform, "info", "eqplan.start", "Started EQ planning.", { projectId, tracks: document.tracks.length, strength: store.eq.settings.strength });
  const current = () => useAppStore.getState().eq.generation === generation && useAppStore.getState().document?.project.id === projectId;
  try {
    if (platform.kind !== "tauri") throw new Error("EQ planning reads the desktop analysis cache. Open this project in the desktop app.");
    const analysisStarted = performance.now();
    const measurements: Record<string, TrackFileMeasurement | null> = {};
    const fingerprints: EqSession["fingerprints"] = [];
    for (const [index, track] of document.tracks.entries()) {
      if (!current()) return;
      useAppStore.getState().setEq({ progress: `Analyzing ${index + 1} of ${document.tracks.length}: ${track.name}` });
      const loaded = await loadTrackAnalysis(platform, projectFile, { id: track.id, filename: track.file.filename, relativePath: track.file.relativePath }, undefined, 15);
      if (!current()) return;
      measurements[track.id] = loaded.measurement;
      const [status] = await platform.projectMediaStatus(projectFile, [track.file.relativePath]);
      if (status) fingerprints.push({ trackId: track.id, fileSizeBytes: status.fileSizeBytes, modifiedAtNs: status.modifiedAtNs });
    }
    if (!current()) return;
    useAppStore.getState().setEq({ progress: "Measuring EQ bands on the playback proxies…" });
    const bands = await loadBandFrames(platform, projectFile, document);
    const analysisMs = Math.round(performance.now() - analysisStarted);
    if (!current()) return;
    useAppStore.getState().setEq({ phase: "planning", progress: "Planning…" });
    const latest = useAppStore.getState().document;
    if (!latest || latest.project.id !== projectId) return;
    const started = performance.now();
    let plan = planEq({ document: latest, measurements, bands, fingerprints, settings: useAppStore.getState().eq.settings });
    const durationMs = Math.round(performance.now() - started);
    if (!current()) return;
    if (refuseStale(plan, fingerprints, "Discarded an EQ plan because the project changed while it was planned.")) return;
    useAppStore.getState().setEq({ phase: "verifying", progress: "Checking filters on the playback proxies…" });
    const verifyStarted = performance.now();
    plan = await verifyOnProxies(platform, projectFile, latest, plan);
    const verifyMs = Math.round(performance.now() - verifyStarted);
    if (!current()) return;
    if (refuseStale(plan, fingerprints, "Discarded an EQ plan because the project changed while it was checked.")) return;
    useAppStore.getState().setEq({ phase: "ready", progress: null, plan, fingerprints, error: null, selectedId: plan.changes[0]?.id ?? null });
    await logEvent(platform, "info", "eqplan.complete", "Finished an EQ plan.", {
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
    const message = caught instanceof Error && caught.message ? caught.message : "EQ planning could not finish.";
    useAppStore.getState().setEq({ phase: "failed", progress: null, error: message, plan: null });
  }

  function refuseStale(plan: EqPlan, fingerprints: EqSession["fingerprints"], message: string): boolean {
    const after = useAppStore.getState().document;
    if (after && !eqPlanIsStale(plan, after, fingerprints, useAppStore.getState().eq.settings)) return false;
    void logEvent(platform, "info", "eqplan.stale", message, { projectId });
    useAppStore.getState().setEq({ phase: "failed", progress: null, error: "The project changed while EQ was planning. Run it again." });
    return true;
  }
}

/** Proxy band frames per track; a track that fails falls back to the sidecar spectrogram in the planner. */
export async function loadBandFrames(platform: DesktopPlatform, projectFile: string, document: ProjectDocument): Promise<Record<string, EqBandFrames | null>> {
  const out: Record<string, EqBandFrames | null> = {};
  try {
    const responses = await platform.eqBandFrames(
      projectFile,
      document.tracks.filter((track) => !track.muted).map((track) => ({ trackId: track.id, relativePath: track.file.relativePath })),
    );
    for (const response of responses) {
      if (!response.json) continue;
      const parsed = eqBandsCacheSchema.safeParse(JSON.parse(response.json));
      out[response.trackId] = parsed.success ? parsed.data.bands : null;
    }
  } catch {
    // The planner says in its summary which tracks used the coarser spectrogram.
  }
  return out;
}

/** Second evaluation tier: the native filters over the 48 kHz proxies, where the parts overlap. */
export async function verifyOnProxies(platform: DesktopPlatform, projectFile: string, document: ProjectDocument, plan: EqPlan): Promise<EqPlan> {
  if (plan.changes.length === 0) return plan;
  const requests: EqCheckRequest[] = plan.changes.map((change) => {
    const track = document.tracks.find((item) => item.id === change.trackId)!;
    const range = checkRange(change);
    return {
      id: change.id,
      trackId: change.trackId,
      relativePath: track.file.relativePath,
      windows: change.evidence.windows,
      saved: eqChainForSection(document, change.trackId, change.scope.type === "section" ? change.scope.sectionId : null),
      candidate: [change.processing.filter],
      lowHz: range.lowHz,
      highHz: range.highHz,
    };
  });
  try {
    const responses = await platform.checkEq(projectFile, requests);
    const checks: ProxyCheck[] = [];
    let failed = 0;
    for (const response of responses) {
      if (!response.result) {
        failed += 1;
        continue;
      }
      checks.push({
        id: response.id,
        regionChangeDb: response.result.regionAfterDb - response.result.regionBeforeDb,
        identityChangeDb: response.result.totalAfterDb - response.result.totalBeforeDb,
        seconds: response.result.seconds,
      });
    }
    await logEvent(platform, "info", "eqplan.verify", "Checked EQ filters on the playback proxies.", { checked: checks.length, failed });
    return withProxyChecks(plan, checks, failed);
  } catch {
    return withProxyChecks(plan, [], plan.changes.length);
  }
}

export function cancelEqPlan(): void {
  const state = useAppStore.getState();
  state.setEq({ generation: state.eq.generation + 1, phase: "idle", plan: null, preview: false, auditionId: null, selectedId: null, progress: null, error: null, open: false });
  void logEvent(getPlatform(), "info", "eqplan.cancel", "Cancelled EQ planning.", { projectId: state.document?.project.id ?? null });
}

/** Writes the chosen filters into the project. One undo step restores the whole pre-plan processing. */
export function applyEq(mode: EqApplyMode): boolean {
  const state = useAppStore.getState();
  const document = state.document;
  const plan = state.eq.plan;
  if (!document || !plan) return false;
  if (eqPlanIsStale(plan, document, state.eq.fingerprints, state.eq.settings)) {
    void logEvent(getPlatform(), "info", "eqplan.stale", "Refused to apply an out-of-date EQ plan.", { projectId: document.project.id });
    return false;
  }
  const next = applyEqPlan(document, plan, mode);
  useAppStore.getState().replaceDocument(next, true, { mode: "record" });
  useAppStore.getState().setEq({ generation: state.eq.generation + 1, phase: "idle", plan: null, preview: false, auditionId: null, selectedId: null, progress: null, error: null });
  useAppStore.getState().setNotice("EQ applied. Undo restores the previous processing.");
  void logEvent(getPlatform(), "info", "eqplan.apply", "Applied an EQ plan.", {
    projectId: document.project.id,
    mode,
    changes: plan.changes.filter((change) => (mode === "accepted" ? change.status === "accepted" : change.status === "accepted" || change.status === "proposed")).length,
  });
  return true;
}

/** Whole-plan A/B. Starting an EQ audition stops any gain audition, so one comparison plays at a time. */
export function setEqPreview(preview: boolean): void {
  useAppStore.getState().setEq({ preview, auditionId: null });
  if (preview) {
    useAppStore.getState().setBalance({ preview: false, auditionId: null });
    useAppStore.getState().setSpace({ preview: false, auditionId: null });
    useAppStore.getState().setDynamics({ preview: false, auditionId: null });
  }
  void logEvent(getPlatform(), "info", "eqplan.preview", preview ? "Playing the EQ candidate." : "Playing the current mix.", { mode: preview ? "candidate" : "current" });
}

/** Single-filter A/B in the full mix. The same button again stops the audition. */
export function auditionEq(id: string, side: "bypassed" | "recommended"): void {
  const eq = useAppStore.getState().eq;
  const same = eq.auditionId === id && eq.auditionSide === side;
  useAppStore.getState().setEq(same ? { auditionId: null } : { auditionId: id, auditionSide: side, preview: false });
  if (!same) {
    useAppStore.getState().setBalance({ preview: false, auditionId: null });
    useAppStore.getState().setSpace({ preview: false, auditionId: null });
    useAppStore.getState().setDynamics({ preview: false, auditionId: null });
  }
  void logEvent(getPlatform(), "info", "eqplan.preview", "Auditioned one EQ filter.", { id, side: same ? "off" : side });
}

/** Called when a filter is edited: make sure the edit is heard (see hearSpaceRow). */
export function hearEqRow(id: string): void {
  const eq = useAppStore.getState().eq;
  const change = eq.plan?.changes.find((item) => item.id === id);
  if (!change) return;
  if (eq.preview && eqRecommendationIncluded(change, "preview")) return;
  if (eq.auditionId === id && eq.auditionSide === "recommended") return;
  useAppStore.getState().setEq({ auditionId: id, auditionSide: "recommended", preview: false });
  useAppStore.getState().setBalance({ preview: false, auditionId: null });
  useAppStore.getState().setSpace({ preview: false, auditionId: null });
  useAppStore.getState().setDynamics({ preview: false, auditionId: null });
}

/** What the EQ panel is playing right now, in words. */
export function eqHearing(document: ProjectDocument, eq: EqSession): string {
  if (!eq.plan || eq.phase !== "ready") return "Hearing the saved mix";
  if (eq.auditionId) {
    const change = eq.plan.changes.find((item) => item.id === eq.auditionId);
    const name = document.tracks.find((track) => track.id === change?.trackId)?.name ?? "this stem";
    return eq.auditionSide === "recommended" ? `Hearing ${name} with only this filter` : `Hearing ${name} without this filter`;
  }
  return eq.preview ? "Hearing the EQ Candidate" : "Hearing Current (saved mix)";
}
