import {
  applyMixPlan,
  auditionGainAt,
  auditionMix,
  planBalance,
  planIsStale,
  type ApplyMode,
  type AuditionMix,
  type TrackMeasurements,
} from "@audiosous/balance-planner";
import type { AudioEngine } from "@audiosous/audio-engine";
import type { ProjectDocument } from "@audiosous/project-model";
import { loadTrackAnalysis } from "./track-analysis";
import { logEvent } from "./log";
import { getPlatform } from "../platform";
import { useAppStore, type BalanceSession } from "../state/app-store";

export function currentAudition(document: ProjectDocument, balance: BalanceSession): AuditionMix | null {
  if (!balance.plan || balance.phase !== "ready") return null;
  if (!balance.preview && !balance.auditionId) return null;
  if (planIsStale(balance.plan, document, balance.fingerprints, balance.settings)) return null;
  return auditionMix(document, balance.plan, {
    mode: balance.preview ? "candidate" : "current",
    focusId: balance.auditionId,
    focusSide: balance.auditionSide,
  });
}

export function publishMonitorMix(engine: AudioEngine, document: ProjectDocument, native: boolean): void {
  const mix = currentAudition(document, useAppStore.getState().balance);
  const time = engine.getCurrentTime();
  for (const track of document.tracks) {
    const base = mix?.tracks.find((item) => item.trackId === track.id)?.gainDb ?? track.gainDb;
    const gain = mix && !native ? auditionGainAt(mix, track.id, time) : base;
    engine.setTrackGain(track.id, gain);
    engine.setTrackPan(track.id, track.pan);
    engine.setMute(track.id, track.muted);
    engine.setSolo(track.id, track.solo);
  }
  engine.setGainRegions?.(
    native && mix
      ? mix.regions.map((region) => ({
          trackId: region.trackId,
          startSeconds: region.startSeconds,
          endSeconds: region.endSeconds,
          gainDb: region.gainDb,
        }))
      : [],
  );
}

export function refreshLegacyMonitor(engine: AudioEngine, document: ProjectDocument): void {
  const mix = currentAudition(document, useAppStore.getState().balance);
  if (!mix || mix.regions.length === 0) return;
  const time = engine.getCurrentTime();
  for (const track of document.tracks) {
    engine.setTrackGain(track.id, auditionGainAt(mix, track.id, time));
  }
}

export async function runAutoBalance(): Promise<void> {
  const store = useAppStore.getState();
  const document = store.document;
  const projectFile = store.projectFilePath;
  if (!document || !projectFile) return;
  const generation = store.balance.generation + 1;
  const projectId = document.project.id;
  store.setBalance({
    open: true,
    generation,
    phase: "analyzing",
    progress: "Analyzing…",
    error: null,
    plan: null,
    preview: false,
    auditionId: null,
  });
  const platform = getPlatform();
  await logEvent(platform, "info", "autobalance.start", "Started AutoBalance.", {
    projectId,
    tracks: document.tracks.length,
    strength: store.balance.settings.strength,
  });
  const current = () => useAppStore.getState().balance.generation === generation && useAppStore.getState().document?.project.id === projectId;
  try {
    if (platform.kind !== "tauri") {
      throw new Error("AutoBalance reads the desktop analysis cache. Open this project in the desktop app.");
    }
    const measurements: Record<string, TrackMeasurements> = {};
    const fingerprints: BalanceSession["fingerprints"] = [];
    for (const [index, track] of document.tracks.entries()) {
      if (!current()) return;
      useAppStore.getState().setBalance({
        phase: "analyzing",
        progress: `Analyzing ${index + 1} of ${document.tracks.length}: ${track.name}`,
      });
      const loaded = await loadTrackAnalysis(
        platform,
        projectFile,
        { id: track.id, filename: track.file.filename, relativePath: track.file.relativePath },
        (status) => {
          if (!current()) return;
          if (status === "analyzing" || status === "queued") {
            useAppStore.getState().setBalance({ progress: `Analyzing ${index + 1} of ${document.tracks.length}: ${track.name}` });
          }
        },
        15,
      );
      if (!current()) return;
      measurements[track.id] = { track: loaded.measurement };
      const [status] = await platform.projectMediaStatus(projectFile, [track.file.relativePath]);
      if (status) fingerprints.push({ trackId: track.id, fileSizeBytes: status.fileSizeBytes, modifiedAtNs: status.modifiedAtNs });
    }
    if (!current()) return;
    useAppStore.getState().setBalance({ phase: "planning", progress: "Planning…" });
    const latest = useAppStore.getState().document;
    if (!latest || latest.project.id !== projectId) return;
    const started = performance.now();
    const plan = planBalance({
      document: latest,
      measurements,
      fingerprints,
      settings: useAppStore.getState().balance.settings,
    });
    const durationMs = Math.round(performance.now() - started);
    if (!current()) return;
    const after = useAppStore.getState().document;
    if (!after || planIsStale(plan, after, fingerprints, useAppStore.getState().balance.settings)) {
      await logEvent(platform, "info", "autobalance.stale", "Discarded an AutoBalance plan because the project changed.", { projectId });
      useAppStore.getState().setBalance({ phase: "failed", progress: null, error: "The project changed while AutoBalance was planning." });
      return;
    }
    useAppStore.getState().setBalance({ phase: "ready", progress: null, plan, fingerprints, error: null });
    await logEvent(platform, "info", "autobalance.complete", "Finished an AutoBalance plan.", {
      projectId,
      changes: plan.trackChanges.length,
      confidence: plan.summary.confidence,
      durationMs,
    });
  } catch (caught) {
    if (!current()) return;
    const message = caught instanceof Error && caught.message ? caught.message : "AutoBalance could not finish.";
    useAppStore.getState().setBalance({ phase: "failed", progress: null, error: message, plan: null });
  }
}

export function cancelAutoBalance(): void {
  const state = useAppStore.getState();
  state.setBalance({
    generation: state.balance.generation + 1,
    phase: "idle",
    plan: null,
    preview: false,
    auditionId: null,
    progress: null,
    error: null,
    open: false,
  });
  const projectId = state.document?.project.id;
  void logEvent(getPlatform(), "info", "autobalance.cancel", "Cancelled AutoBalance.", { projectId: projectId ?? null });
}

export function applyAutoBalance(mode: ApplyMode): void {
  const state = useAppStore.getState();
  const document = state.document;
  const plan = state.balance.plan;
  if (!document || !plan) return;
  if (planIsStale(plan, document, state.balance.fingerprints, state.balance.settings)) {
    void logEvent(getPlatform(), "info", "autobalance.stale", "Refused to apply an out-of-date AutoBalance plan.", {
      projectId: document.project.id,
    });
    return;
  }
  const next = applyMixPlan(document, plan, mode);
  useAppStore.getState().replaceDocument(next, true, { mode: "record" });
  useAppStore.getState().setBalance({
    generation: state.balance.generation + 1,
    phase: "idle",
    plan: null,
    preview: false,
    auditionId: null,
    progress: null,
    error: null,
  });
  useAppStore.getState().setNotice("AutoBalance applied. Undo restores the previous mix.");
  void logEvent(getPlatform(), "info", "autobalance.apply", "Applied an AutoBalance plan.", {
    projectId: document.project.id,
    mode,
    changes: plan.trackChanges.length,
  });
}
