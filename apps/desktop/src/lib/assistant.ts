import {
  ProviderError,
  applyFromPanel,
  emptySession,
  runAgentTurn,
  type AgentEnvironment,
  type AgentModel,
  type AgentSession,
  type DirectEditRequest,
  type LoadedInputs,
  type MixReading,
  type PreviewRequest,
  type UiFocus,
} from "@audiosous/mix-agent";
import { applyChanges, fullMixPlanIsStale, withRenderedCheck, type FullMixPlan, type MixStrength, type PlanFullMixInput, type SimplifyResult } from "@audiosous/mix-planner";
import { setSectionSpatial, setTrackSpatial, type ProjectDocument } from "@audiosous/project-model";
import { getPlatform } from "../platform";
import type { SaveAgentSettings } from "../platform/types";
import { useAppStore, type FullMixCheck } from "../state/app-store";
import { applyFullMix, auditionFullMix, finalCheck, fullMixHearing, loadMixInputs, runOffThread, setFullMixPreview, type LoadedMixInputs } from "./full-mix";
import { logEvent, type LogEvent } from "./log";

/**
 * The assistant in the desktop app. The agent's tools reach the project only through this environment, and this
 * environment only uses what the Full Mix review already uses: the same input loading, the same worker, the same
 * render check, the same candidate slot, the same A/B, the same apply, and the same undo history.
 */

/* ------------------------------------------------------------------ inputs cache */

/** Analysis and frames per project and source files; the rendered peak per mix state. */
let inputsCache: { key: string; inputs: LoadedMixInputs } | null = null;
let lastCheck: { createdAt: string; check: Omit<FullMixCheck, "notes"> } | null = null;

function sourcesKey(document: ProjectDocument): string {
  return `${document.project.id}|${document.tracks.map((track) => `${track.id}:${track.file.relativePath}:${track.metadata.fileSizeBytes}`).join(",")}`;
}

function missingOf(document: ProjectDocument, inputs: LoadedMixInputs): LoadedInputs["missing"] {
  const out: LoadedInputs["missing"] = [];
  for (const track of document.tracks) {
    if (!inputs.measurements[track.id]) out.push({ trackId: track.id, what: "analysis" });
    if (!inputs.bands?.[track.id]) out.push({ trackId: track.id, what: "bands" });
    if (!inputs.stereo?.[track.id]) out.push({ trackId: track.id, what: "stereo" });
    if (!inputs.envelopes?.[track.id]) out.push({ trackId: track.id, what: "envelopes" });
  }
  return out;
}

/* ------------------------------------------------------------------ environment */

export function desktopEnvironment(isCurrent: () => boolean): AgentEnvironment {
  const platform = getPlatform();
  const store = () => useAppStore.getState();
  const fingerprints = () => inputsCache?.inputs.fingerprints ?? store().fullMix.fingerprints;
  return {
    document: () => {
      const document = store().document;
      if (!document) throw new Error("No project is open.");
      return document;
    },
    async loadInputs() {
      const document = store().document;
      const projectFile = store().projectFilePath;
      if (!document || !projectFile) throw new Error("No project is open.");
      const key = sourcesKey(document);
      if (!inputsCache || inputsCache.key !== key) {
        const loaded = await loadMixInputs(platform, projectFile, document, { current: isCurrent, progress: (label) => store().setAssistant({ activity: label }) });
        if (!loaded) throw new Error("Cancelled.");
        inputsCache = { key, inputs: loaded };
      }
      const inputs = inputsCache.inputs;
      return { ...inputs, missing: missingOf(document, inputs) };
    },
    readMix(document: ProjectDocument, inputs: LoadedInputs, strength: MixStrength) {
      return runOffThread<MixReading>({ kind: "read", document, inputs: { measurements: inputs.measurements, bands: inputs.bands, stereo: inputs.stereo, envelopes: inputs.envelopes, mixPeakDbfs: inputs.mixPeakDbfs }, strength, now: new Date().toISOString() });
    },
    async planFullMix(input: PlanFullMixInput) {
      const projectFile = store().projectFilePath;
      let plan = await runOffThread<FullMixPlan>({ kind: "plan", input: { ...input, fingerprints: fingerprints() } });
      if (!isCurrent()) return plan;
      store().setAssistant({ activity: "Rendering Current and the candidate through the native DSP…" });
      if (projectFile && platform.kind === "tauri") {
        const check = await finalCheck(platform, projectFile, input.document, plan);
        if (check) {
          plan = withRenderedCheck(plan, check);
          lastCheck = { createdAt: plan.createdAt, check };
        }
      }
      return plan;
    },
    simplify(input: PlanFullMixInput, plan: FullMixPlan, options: { keep: number }) {
      return runOffThread<SimplifyResult>({ kind: "simplify", input, plan, keep: options.keep });
    },
    candidate() {
      const full = store().fullMix;
      return full.phase === "ready" ? full.plan : null;
    },
    showCandidate(plan: FullMixPlan | null, options?: { problemId?: string | null }) {
      const full = store().fullMix;
      if (!plan) {
        store().setFullMix({ generation: full.generation + 1, phase: "idle", plan: null, preview: false, focus: null, selectedProblemId: null, selectedChangeId: null, progress: null, error: null, open: false, check: null });
        return;
      }
      const same = full.plan?.createdAt === plan.createdAt;
      const check = lastCheck?.createdAt === plan.createdAt ? { ...lastCheck.check, notes: [] } : same ? full.check : null;
      store().setFullMix({
        open: true,
        generation: same ? full.generation : full.generation + 1,
        phase: "ready",
        progress: null,
        error: null,
        plan,
        settings: plan.settings,
        fingerprints: fingerprints(),
        check,
        ...(same ? {} : { preview: false, focus: null, selectedChangeId: null, selectedProblemId: options?.problemId ?? plan.problems[0]?.id ?? null }),
      });
      store().setPlanTab("full");
    },
    candidateStale(plan: FullMixPlan) {
      const document = store().document;
      return !document || fullMixPlanIsStale(plan, document, fingerprints(), plan.settings);
    },
    preview(request: PreviewRequest) {
      const full = store().fullMix;
      if (request.kind !== "current" && (!full.plan || full.phase !== "ready")) return { ok: false as const, message: "The candidate is not in the review." };
      if (request.kind === "candidate" || request.kind === "current") setFullMixPreview(request.kind === "candidate");
      else {
        const id = request.kind === "problem" ? request.problemId : request.changeId;
        const exists = request.kind === "problem" ? full.plan!.problems.some((item) => item.id === id) : full.plan!.changes.some((item) => item.id === id);
        if (!exists) return { ok: false as const, message: `No such ${request.kind} in the candidate.` };
        const focus = { kind: request.kind, id, side: request.side } as const;
        const already = full.focus?.kind === focus.kind && full.focus.id === focus.id && full.focus.side === focus.side;
        if (!already) auditionFullMix(focus);
      }
      return { ok: true as const, hearing: fullMixHearing(store().document!, store().fullMix) };
    },
    apply(plan: FullMixPlan, mode: "all" | "accepted") {
      const full = store().fullMix;
      if (full.plan !== plan) store().setFullMix({ plan, phase: "ready", settings: plan.settings });
      const ok = applyFullMix(mode);
      if (!ok) return { ok: false as const, message: store().fullMix.error ?? "The plan is out of date or could not be stored." };
      return { ok: true as const, document: store().document!, applied: plan.changes.length };
    },
    undo() {
      const before = store().document;
      store().undo();
      const after = store().document!;
      return { ok: after !== before, document: after };
    },
    directEdit(edit: DirectEditRequest) {
      const document = store().document;
      if (!document) return { ok: false as const, message: "No project is open." };
      let next: ProjectDocument;
      if (edit.control === "gain") {
        const scope = edit.sectionId ? { type: "section" as const, sectionId: edit.sectionId } : { type: "global" as const };
        const result = applyChanges(document, [{ id: `assistant-${edit.trackId}`, trackId: edit.trackId, scope, processing: { type: "gain", gainDb: edit.value, deltaDb: 0 }, replacesNodeId: null, reasons: ["Set from the assistant."] }]);
        if (result.failures.length) return { ok: false as const, message: result.failures[0]!.message };
        next = result.document;
      } else {
        const patch = edit.control === "pan" ? { pan: edit.value } : { width: edit.value };
        const result = edit.sectionId ? setSectionSpatial(document, edit.trackId, edit.sectionId, patch) : setTrackSpatial(document, edit.trackId, patch);
        if (!result.ok) return { ok: false as const, message: result.message };
        next = result.document;
      }
      store().replaceDocument(next, true, { mode: "record" });
      return { ok: true as const, document: store().document! };
    },
    focusUi(focus: UiFocus) {
      applyFocus(focus);
    },
    activity(label: string) {
      if (isCurrent()) store().setAssistant({ activity: label });
    },
    log(event: string, data: Record<string, unknown>) {
      void logEvent(platform, event === "agent.error" ? "warn" : "info", event as LogEvent, "Assistant event.", data);
    },
    now: () => new Date().toISOString(),
  };
}

/** Points the interface at what the assistant is talking about: stems, a section, a problem, a change, a plan tab. */
export function applyFocus(focus: UiFocus): void {
  const state = useAppStore.getState();
  const document = state.document;
  if (!document) return;
  const patch: Partial<ProjectDocument["uiState"]> = {};
  const track = focus.trackIds?.find((id) => document.tracks.some((item) => item.id === id));
  if (track) patch.selectedTrackId = track;
  if (focus.sectionId && document.sections.some((section) => section.id === focus.sectionId)) patch.selectedSectionId = focus.sectionId;
  if (Object.keys(patch).length > 0) state.replaceDocument({ ...document, uiState: { ...document.uiState, ...patch } }, state.dirty, { mode: "skip" });
  if (state.workspace !== "mix") state.setWorkspace("mix");
  const plan = state.fullMix.plan;
  if (focus.problemId && plan?.problems.some((problem) => problem.id === focus.problemId)) state.setFullMix({ selectedProblemId: focus.problemId });
  if (focus.changeId && plan?.changes.some((change) => change.id === focus.changeId)) {
    const change = plan.changes.find((item) => item.id === focus.changeId)!;
    state.setFullMix({ selectedChangeId: focus.changeId, selectedProblemId: change.problemIds[0] ?? state.fullMix.selectedProblemId });
  }
  if (focus.tab) state.setPlanTab(focus.tab);
  else if (focus.problemId || focus.changeId) state.setPlanTab("full");
}

/* ------------------------------------------------------------------ model */

/** The configured provider, or null when none is set up. */
export async function assistantModel(): Promise<AgentModel | null> {
  const platform = getPlatform();
  const settings = useAppStore.getState().assistant.settings ?? (await refreshAssistantSettings());
  if (!settings || settings.provider === "none" || !settings.keySource) return null;
  const fetchThroughShell = platform.agentFetch();
  if (!fetchThroughShell) return null;
  // Loaded on first use, so the app does not carry the provider SDK until the assistant is used.
  const { anthropicModel } = await import("@audiosous/mix-agent/anthropic");
  return anthropicModel({ model: settings.model, effort: settings.effort, fetch: fetchThroughShell });
}

export async function refreshAssistantSettings() {
  try {
    const settings = await getPlatform().agentSettings();
    useAppStore.getState().setAssistant({ settings });
    return settings;
  } catch {
    return null;
  }
}

export async function saveAssistantSettings(input: SaveAgentSettings): Promise<string | null> {
  try {
    const settings = await getPlatform().saveAgentSettings(input);
    useAppStore.getState().setAssistant({ settings, error: null });
    void logEvent(getPlatform(), "info", "agent.settings", "Saved assistant settings.", { provider: settings.provider, model: settings.model, effort: settings.effort, key: settings.keySource !== null });
    return null;
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
}

/* ------------------------------------------------------------------ conversation */

let controller: AbortController | null = null;

function sessionFor(document: ProjectDocument): AgentSession {
  const current = useAppStore.getState().assistant.session;
  return current && current.projectId === document.project.id ? current : emptySession(document.project.id);
}

/**
 * Sends one message. A newer message replaces an unfinished one: the old request's results never reach the
 * session, the review, or the project.
 */
export async function sendAssistantMessage(text: string): Promise<void> {
  const message = text.trim();
  const state = useAppStore.getState();
  const document = state.document;
  if (!message || !document) return;
  if (state.assistant.busy) cancelAssistant(false);
  const generation = useAppStore.getState().assistant.generation + 1;
  const projectId = document.project.id;
  const session = sessionFor(document);
  useAppStore.getState().setAssistant({ generation, busy: true, pending: message, activity: "Reading the request…", error: null, session });
  const current = () => useAppStore.getState().assistant.generation === generation && useAppStore.getState().document?.project.id === projectId;
  const model = await assistantModel();
  if (!current()) return;
  if (!model) {
    useAppStore.getState().setAssistant({ busy: false, pending: null, activity: null, error: "Connect an AI provider to use the assistant (Settings, above). Level, EQ, Space, Dynamics, and Full Mix work without it." });
    return;
  }
  controller = new AbortController();
  try {
    const outcome = await runAgentTurn({ model, env: desktopEnvironment(current), session, message, isCurrent: current, signal: controller.signal });
    if (!current() || outcome.status !== "done") return;
    useAppStore.getState().setAssistant({ session: outcome.session, busy: false, pending: null, activity: null, error: null });
  } catch (caught) {
    if (!current()) return;
    const reason = caught instanceof ProviderError ? caught.message : caught instanceof Error ? caught.message : "The assistant failed.";
    useAppStore.getState().setAssistant({ busy: false, pending: null, activity: null, error: `${reason} The saved mix was not changed.` });
  }
}

/** Cancels the request in flight. Nothing it was doing reaches the session or the project. */
export function cancelAssistant(log = true): void {
  const state = useAppStore.getState();
  controller?.abort();
  controller = null;
  state.setAssistant({ generation: state.assistant.generation + 1, busy: false, pending: null, activity: null });
  if (log) void logEvent(getPlatform(), "info", "agent.cancel", "Cancelled an assistant request.", {});
}

/** The candidate card's Apply: the same apply path, approved by the click. */
export function applyAssistantCandidate(mode: "all" | "accepted"): void {
  const state = useAppStore.getState();
  const document = state.document;
  if (!document) return;
  const session = sessionFor(document);
  const result = applyFromPanel(desktopEnvironment(() => true), session, mode);
  useAppStore.getState().setAssistant({ session: result.session, error: result.ok ? null : result.message });
}

export function resetAssistantConversation(): void {
  cancelAssistant(false);
  const document = useAppStore.getState().document;
  useAppStore.getState().setAssistant({ session: document ? emptySession(document.project.id) : null, error: null });
}

/** For tests: forget cached inputs. */
export function clearAssistantCache(): void {
  inputsCache = null;
  lastCheck = null;
}
