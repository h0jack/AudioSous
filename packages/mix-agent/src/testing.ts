import {
  applyFullMixPlan,
  fullMixPlanIsStale,
  planFullMix,
  simplifyFullMix,
  type FullMixApplyMode,
  type FullMixPlan,
  type MixInputs,
  type MixStrength,
  type PlanFullMixInput,
} from "@audiosous/mix-planner";
import { setSectionSpatial, setTrackSpatial, type ProjectDocument } from "@audiosous/project-model";
import type { UiFocus } from "./contract";
import type { AgentEnvironment, DirectEditRequest, LoadedInputs, PreviewRequest } from "./environment";
import type { AgentModel, AgentRequest, AgentResponse } from "./model";
import { readMix, type MixReading } from "./reading";

/**
 * Test doubles: a scripted model (deterministic "model output" for routing, permission, and conversation tests)
 * and an in-memory environment that runs the real planners and the real apply on a fixture project.
 */

export const TEST_NOW = "2026-10-06T00:00:00.000Z";

export type ScriptStep = AgentResponse | ((request: AgentRequest, index: number) => AgentResponse);

/** Returns the scripted responses in order and records every request it was sent. */
export class ScriptedModel implements AgentModel {
  info = { provider: "scripted", model: "test", label: "Scripted test model", remote: false };
  readonly requests: AgentRequest[] = [];
  private index = 0;
  constructor(private readonly steps: ScriptStep[]) {}
  async complete(request: AgentRequest): Promise<AgentResponse> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    const step = this.steps[this.index];
    this.index += 1;
    if (!step) return respond("(script exhausted)");
    return typeof step === "function" ? step(request, this.index - 1) : step;
  }
  /** The tool results the model was sent before step `index`, parsed. */
  resultsBefore(index: number): Array<{ name: string | null; isError: boolean; body: Record<string, unknown> }> {
    const request = this.requests[index];
    if (!request) return [];
    const last = request.messages.at(-1)!;
    const calls = new Map<string, string>();
    for (const message of request.messages) for (const item of message.content) if (item.type === "tool-call") calls.set(item.callId, item.name);
    return last.content
      .filter((item): item is Extract<typeof item, { type: "tool-result" }> => item.type === "tool-result")
      .map((item) => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(item.content) as Record<string, unknown>;
        } catch {
          body = { text: item.content };
        }
        return { name: calls.get(item.callId) ?? null, isError: item.isError, body };
      });
  }
}

let calls = 0;
export function call(name: string, args: Record<string, unknown> = {}): AgentResponse {
  calls += 1;
  return { content: [{ type: "tool-call", callId: `call-${calls}`, name, arguments: args }], stop: "tool" };
}

export function calls_(...items: Array<[string, Record<string, unknown>]>): AgentResponse {
  return { content: items.map(([name, args]) => ({ type: "tool-call" as const, callId: `call-${(calls += 1)}`, name, arguments: args })), stop: "tool" };
}

export function respond(message: string, extra: Record<string, unknown> = {}): AgentResponse {
  return call("respond", { message, ...extra });
}

export function clarify(question: string, options: string[]): AgentResponse {
  return call("ask_clarification", { question, options });
}

export interface Song extends MixInputs {
  document: ProjectDocument;
}

/** The real planners, the real apply, and an undo stack, on an in-memory project. */
export class MemoryEnvironment implements AgentEnvironment {
  doc: ProjectDocument;
  history: ProjectDocument[] = [];
  plan: FullMixPlan | null = null;
  previews: PreviewRequest[] = [];
  focuses: UiFocus[] = [];
  activities: string[] = [];
  events: Array<{ event: string; data: Record<string, unknown> }> = [];
  /** Set to make a tool's environment call fail. */
  failInputs: string | null = null;
  failPlan: string | null = null;
  missing: LoadedInputs["missing"] = [];
  plans = 0;
  /** Runs before planning returns, to simulate the person editing the mix while a plan is built. */
  duringPlan: (() => void) | null = null;

  constructor(private readonly song: Song) {
    this.doc = song.document;
  }

  document(): ProjectDocument {
    return this.doc;
  }
  async loadInputs(): Promise<LoadedInputs> {
    if (this.failInputs) throw new Error(this.failInputs);
    return { measurements: this.song.measurements, ...(this.song.bands ? { bands: this.song.bands } : {}), ...(this.song.stereo ? { stereo: this.song.stereo } : {}), ...(this.song.envelopes ? { envelopes: this.song.envelopes } : {}), fingerprints: [], mixPeakDbfs: null, missing: this.missing };
  }
  async readMix(document: ProjectDocument, inputs: LoadedInputs, strength: MixStrength): Promise<MixReading> {
    return readMix(document, inputs, strength, TEST_NOW);
  }
  async planFullMix(input: PlanFullMixInput): Promise<FullMixPlan> {
    if (this.failPlan) throw new Error(this.failPlan);
    this.plans += 1;
    const plan = planFullMix({ ...input, now: `${TEST_NOW.slice(0, -5)}${String(this.plans).padStart(3, "0")}Z` });
    this.duringPlan?.();
    return plan;
  }
  async simplify(input: PlanFullMixInput, plan: FullMixPlan, options: { keep: number }) {
    return simplifyFullMix(input, plan, options);
  }
  candidate(): FullMixPlan | null {
    return this.plan;
  }
  showCandidate(plan: FullMixPlan | null): void {
    this.plan = plan;
  }
  candidateStale(plan: FullMixPlan): boolean {
    return fullMixPlanIsStale(plan, this.doc, [], plan.settings);
  }
  preview(request: PreviewRequest) {
    this.previews.push(request);
    return { ok: true as const, hearing: request.kind === "current" ? "Hearing Current (saved mix)" : request.kind === "candidate" ? "Hearing the Full Mix Candidate, loudness-matched" : `Hearing ${request.side} ${request.kind}` };
  }
  apply(plan: FullMixPlan, mode: FullMixApplyMode) {
    const result = applyFullMixPlan(this.doc, plan, mode);
    if (!result.ok) return { ok: false as const, message: result.failures.map((item) => item.message).join(" ") };
    this.history.push(this.doc);
    this.doc = result.document;
    this.plan = null;
    return { ok: true as const, document: result.document, applied: result.applied };
  }
  undo() {
    const previous = this.history.pop();
    if (!previous) return { ok: false, document: this.doc };
    this.doc = previous;
    return { ok: true, document: previous };
  }
  directEdit(edit: DirectEditRequest) {
    let next: ProjectDocument;
    if (edit.control === "gain") {
      next = edit.sectionId
        ? { ...this.doc, sectionTrackSettings: [...this.doc.sectionTrackSettings.filter((row) => row.trackId !== edit.trackId || row.sectionId !== edit.sectionId), { trackId: edit.trackId, sectionId: edit.sectionId, userIntent: null, prominence: null, overrides: { gainDb: edit.value, pan: null, width: null }, processing: { schemaVersion: 2, nodes: [], dynamics: [] } }] }
        : { ...this.doc, tracks: this.doc.tracks.map((track) => (track.id === edit.trackId ? { ...track, gainDb: edit.value } : track)) };
    } else {
      const patch = edit.control === "pan" ? { pan: edit.value } : { width: edit.value };
      const result = edit.sectionId ? setSectionSpatial(this.doc, edit.trackId, edit.sectionId, patch) : setTrackSpatial(this.doc, edit.trackId, patch);
      if (!result.ok) return { ok: false as const, message: result.message };
      next = result.document;
    }
    this.history.push(this.doc);
    this.doc = next;
    return { ok: true as const, document: next };
  }
  focusUi(focus: UiFocus): void {
    this.focuses.push(focus);
  }
  activity(label: string): void {
    this.activities.push(label);
  }
  log(event: string, data: Record<string, unknown>): void {
    this.events.push({ event, data });
  }
  now(): string {
    return TEST_NOW;
  }
  /** A manual edit (fader move, selection) made in the UI, recorded in history like the store does. */
  edit(next: ProjectDocument, record = true): void {
    if (record) this.history.push(this.doc);
    this.doc = next;
  }
}
