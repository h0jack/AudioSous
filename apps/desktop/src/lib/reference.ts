import { applyFullMixPlan, compareToReference, withRenderedCheck, type FullMixPlan, type MixStrength, type ReferenceComparison, type SongProfile } from "@audiosous/mix-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { getPlatform } from "../platform";
import type { DesktopPlatform } from "../platform/types";
import { useAppStore, type ReferenceSession } from "../state/app-store";
import { engineVariant, finalCheck, loadMixInputs, runOffThread } from "./full-mix";
import { logEvent } from "./log";
import { registerTaskActions } from "./tasks";

/**
 * Reference songs: import one into the project, measure the saved mix the same way, compare, A/B at matched
 * loudness on the playback clock, and plan stem changes toward it as a Full Mix candidate (reviewed, previewed, and
 * applied like any other). The candidate is rendered and measured against the reference again, so "closer" is a
 * measurement, not only a prediction.
 */

function context() {
  const state = useAppStore.getState();
  return { document: state.document, projectFile: state.projectFilePath, reference: state.reference };
}

export function selectedReference(reference: ReferenceSession) {
  return reference.references.find((item) => item.name === reference.selected) ?? null;
}

/** The comparison shown in the Reference tab: the saved mix (or the measured candidate) against the selected reference. */
export function referenceComparison(reference: ReferenceSession, which: "mix" | "candidate" = "mix"): ReferenceComparison | null {
  const info = selectedReference(reference);
  const profile = which === "mix" ? reference.mixProfile : reference.candidateProfile;
  return info && profile ? compareToReference(profile, info.profile) : null;
}

/** The key a mix profile is measured for: the saved mix as the engine plays it. */
export function mixKeyOf(document: ProjectDocument): string {
  return JSON.stringify(engineVariant("current", document));
}

export async function loadReferences(platform: DesktopPlatform = getPlatform()): Promise<void> {
  const { projectFile } = context();
  if (!projectFile || platform.kind !== "tauri") return;
  useAppStore.getState().setReference({ phase: "loading", error: null });
  try {
    const references = await platform.listReferences(projectFile);
    const state = useAppStore.getState().reference;
    const selected = state.selected && references.some((item) => item.name === state.selected) ? state.selected : (references[0]?.name ?? null);
    useAppStore.getState().setReference({ references, selected, phase: "idle" });
    if (selected) void measureMix(platform);
  } catch (caught) {
    useAppStore.getState().setReference({ phase: "failed", error: message(caught) });
  }
}

export async function importReference(platform: DesktopPlatform = getPlatform()): Promise<void> {
  const { projectFile } = context();
  if (!projectFile) return;
  const source = await platform.pickReferenceFile();
  if (!source) return;
  useAppStore.getState().setReference({ phase: "importing", progress: "Decoding and measuring the reference…", error: null });
  useAppStore.getState().setTask({ id: "reference", kind: "reference", label: "Reference", status: "running", detail: "Decoding and measuring the reference song", blocks: [], major: true });
  try {
    const info = await platform.importReference(projectFile, source);
    const references = [...useAppStore.getState().reference.references.filter((item) => item.name !== info.name), info].sort((a, b) => a.name.localeCompare(b.name));
    useAppStore.getState().setReference({ references, selected: info.name, phase: "idle", progress: null, candidateProfile: null, planCreatedAt: null });
    useAppStore.getState().setTask({ id: "reference", kind: "reference", label: "Reference", status: "complete", completionNote: `Reference added — ${info.name}`, blocks: [] });
    void logEvent(platform, "info", "reference.import", "Added a reference song.", { durationSeconds: info.durationSeconds, lufs: info.profile.loudness.integratedLufs });
    await measureMix(platform);
  } catch (caught) {
    useAppStore.getState().setReference({ phase: "failed", progress: null, error: message(caught) });
    useAppStore.getState().setTask({ id: "reference", kind: "reference", label: "Reference could not be added", status: "failed", error: message(caught), blocks: [] });
  }
}

export function selectReference(name: string | null): void {
  useAppStore.getState().setReference({ selected: name, listening: false, candidateProfile: null, planCreatedAt: null });
  if (name) void measureMix();
}

export async function deleteReference(name: string, platform: DesktopPlatform = getPlatform()): Promise<void> {
  const { projectFile, reference } = context();
  if (!projectFile) return;
  if (reference.selected === name) useAppStore.getState().setReference({ selected: null, listening: false });
  await platform.deleteReference(projectFile, name);
  await loadReferences(platform);
}

/** Measures the saved mix the way references are measured, unless the mix has not changed since the last time. */
export async function measureMix(platform: DesktopPlatform = getPlatform()): Promise<SongProfile | null> {
  const { document, projectFile, reference } = context();
  if (!document || !projectFile || platform.kind !== "tauri") return null;
  const key = mixKeyOf(document);
  if (reference.mixProfile && reference.mixKey === key) return reference.mixProfile;
  useAppStore.getState().setReference({ phase: "measuring", progress: "Rendering and measuring your mix…", error: null });
  try {
    const profile = await platform.mixProfile(projectFile, { tracks: document.tracks.map((track) => ({ trackId: track.id, relativePath: track.file.relativePath })), variant: engineVariant("current", document), durationSeconds: document.project.durationSeconds });
    if (useAppStore.getState().document?.project.id !== document.project.id) return null;
    useAppStore.getState().setReference({ mixProfile: profile, mixKey: key, phase: "idle", progress: null });
    return profile;
  } catch (caught) {
    useAppStore.getState().setReference({ phase: "failed", progress: null, error: message(caught) });
    return null;
  }
}

/** Plays the reference (at the mix's loudness) instead of the mix, or the mix again. */
export function setReferenceListening(listening: boolean): void {
  useAppStore.getState().setReference({ listening });
  void logEvent(getPlatform(), "info", "reference.listen", listening ? "Playing the reference." : "Playing the mix.", {});
}

export function cancelReferencePlan(): void {
  const state = useAppStore.getState();
  state.setReference({ generation: state.reference.generation + 1, phase: "idle", progress: null });
  state.setTask({ id: "reference", kind: "reference", label: "Plan toward reference cancelled", status: "cancelled", blocks: [] });
}

/**
 * Plans stem changes toward the selected reference: the planners' inputs (shared cache), the saved mix's profile,
 * the reference planner in the worker, the render check, then the candidate rendered and measured against the
 * reference. The candidate opens in Full Mix; nothing is written until it is applied.
 */
export async function planTowardReference(
  strength: MixStrength,
  platform: DesktopPlatform = getPlatform(),
  loadInputs: typeof loadMixInputs = loadMixInputs,
): Promise<void> {
  const { document, projectFile, reference } = context();
  const info = selectedReference(reference);
  if (!document || !projectFile || !info) return;
  const generation = reference.generation + 1;
  const projectId = document.project.id;
  const current = () => useAppStore.getState().reference.generation === generation && useAppStore.getState().document?.project.id === projectId;
  const step = (phase: ReferenceSession["phase"], detail: string, index: number) => {
    useAppStore.getState().setReference({ phase, progress: detail });
    useAppStore.getState().setTask({ id: "reference", kind: "reference", label: `Toward “${info.name}”`, status: "running", detail, stage: { index, count: 4 }, progress: null, cancellable: true, blocks: ["export"], major: true });
  };
  registerTaskActions("reference", { cancel: cancelReferencePlan });
  useAppStore.getState().setReference({ generation, error: null, candidateProfile: null, planCreatedAt: null });
  const started = performance.now();
  try {
    step("measuring", "Measuring your mix like the reference", 1);
    const mixProfile = await measureMix(platform);
    if (!current() || !mixProfile) return;
    step("measuring", "Reading the stems' analysis", 2);
    const inputs = await loadInputs(platform, projectFile, document, { current, progress: (label) => current() && useAppStore.getState().setReference({ progress: label }) });
    if (!current() || !inputs) return;
    step("planning", "Planning stem changes toward the reference", 3);
    let plan = await runOffThread<FullMixPlan>({ kind: "reference", input: { document, measurements: inputs.measurements, bands: inputs.bands, stereo: inputs.stereo, envelopes: inputs.envelopes, fingerprints: inputs.fingerprints, mixProfile, referenceProfile: info.profile, referenceName: info.name, strength } });
    if (!current()) return;
    step("checking", "Rendering the candidate and measuring it against the reference", 4);
    const check = await finalCheck(platform, projectFile, document, plan);
    if (check) plan = withRenderedCheck(plan, check);
    const applied = applyFullMixPlan(document, plan, "all");
    const candidateProfile = applied.ok && plan.changes.length > 0 ? await platform.mixProfile(projectFile, { tracks: document.tracks.map((track) => ({ trackId: track.id, relativePath: track.file.relativePath })), variant: engineVariant("candidate", applied.document), durationSeconds: document.project.durationSeconds }) : null;
    if (!current()) return;
    if (useAppStore.getState().document !== document) {
      useAppStore.getState().setReference({ phase: "failed", progress: null, error: "The mix changed while the plan was built. Plan again." });
      useAppStore.getState().setTask({ id: "reference", kind: "reference", label: "Plan toward reference out of date", status: "failed", error: "The mix changed while the plan was built.", blocks: [] });
      return;
    }
    const full = useAppStore.getState().fullMix;
    useAppStore.getState().setFullMix({ open: true, generation: full.generation + 1, phase: "ready", progress: null, plan, fingerprints: inputs.fingerprints, settings: plan.settings, error: null, preview: false, focus: null, selectedProblemId: plan.problems[0]?.id ?? null, selectedChangeId: null, check: check ? { ...check, notes: [] } : null, mixPeakDbfs: inputs.mixPeakDbfs });
    useAppStore.getState().setReference({ phase: "ready", progress: null, candidateProfile, planCreatedAt: plan.createdAt });
    useAppStore.getState().setTask({ id: "reference", kind: "reference", label: `Toward “${info.name}”`, status: "complete", stage: null, blocks: [], completionNote: plan.changes.length === 0 ? `Already close to “${info.name}” — no change planned` : `Candidate toward “${info.name}” — ${plan.changes.length} ${plan.changes.length === 1 ? "change" : "changes"} to preview` });
    void logEvent(platform, "info", "reference.plan", "Planned toward a reference.", { projectId, strength, changes: plan.changes.length, problems: plan.problems.length, durationMs: Math.round(performance.now() - started) });
  } catch (caught) {
    if (!current()) return;
    useAppStore.getState().setReference({ phase: "failed", progress: null, error: message(caught) });
    useAppStore.getState().setTask({ id: "reference", kind: "reference", label: "Plan toward reference failed", status: "failed", error: message(caught), blocks: [] });
  }
}

function message(caught: unknown): string {
  return caught instanceof Error && caught.message ? caught.message : String(caught);
}
