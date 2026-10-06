import type { SourceFingerprint } from "@audiosous/balance-planner";
import type { FullMixApplyMode, FullMixPlan, MixInputs, MixStrength, PlanFullMixInput, SimplifyResult } from "@audiosous/mix-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import type { UiFocus } from "./contract";
import type { MixReading } from "./reading";

/**
 * Everything the agent's tools need from the application, and nothing more. The desktop implements it with the
 * store, the planning worker, the native render check, and the existing apply and undo paths; tests implement it
 * in memory with the real planners. No tool reaches the file system, the network, or a shell.
 */

export interface LoadedInputs extends MixInputs {
  fingerprints: SourceFingerprint[];
  /** Rendered peak of the current mix, when a render was possible. */
  mixPeakDbfs: number | null;
  /** What could not be loaded, per stem, so answers can say what is not known. */
  missing: Array<{ trackId: string; what: "analysis" | "bands" | "stereo" | "envelopes" }>;
}

export type PreviewRequest =
  | { kind: "candidate" }
  | { kind: "current" }
  | { kind: "problem"; problemId: string; side: "only" | "without" }
  | { kind: "change"; changeId: string; side: "only" | "without" };

export type EnvApplyResult = { ok: true; document: ProjectDocument; applied: number } | { ok: false; message: string };

export interface DirectEditRequest {
  trackId: string;
  control: "gain" | "pan" | "width";
  /** dB for gain, −1…1 for pan, 0…2 for width (absolute values, already validated). */
  value: number;
  sectionId: string | null;
}

export interface AgentEnvironment {
  /** The project as it is now (saved state; selection and playhead included). */
  document(): ProjectDocument;
  /** Analysis, band, stereo, and envelope frames and the current mix's rendered peak. May throw with a reason. */
  loadInputs(): Promise<LoadedInputs>;
  /** The four planners as measurement on the current mix: problems, interactions, readings. */
  readMix(document: ProjectDocument, inputs: LoadedInputs, strength: MixStrength): Promise<MixReading>;
  /** Full Mix planning (and, on the desktop, the render check). */
  planFullMix(input: PlanFullMixInput): Promise<FullMixPlan>;
  simplify(input: PlanFullMixInput, plan: FullMixPlan, options: { keep: number }): Promise<SimplifyResult>;
  /** The candidate as it is now, including edits and accept/reject made in the plan UI. */
  candidate(): FullMixPlan | null;
  /** Puts a candidate in the Full Mix review (or clears it). Never writes the project. */
  showCandidate(plan: FullMixPlan | null, options?: { problemId?: string | null }): void;
  candidateStale(plan: FullMixPlan): boolean;
  preview(request: PreviewRequest): { ok: true; hearing: string } | { ok: false; message: string };
  /** The existing Full Mix apply: one project update, one undo step, nothing written if anything cannot be stored. */
  apply(plan: FullMixPlan, mode: FullMixApplyMode): EnvApplyResult;
  /** The existing undo history, one step. */
  undo(): { ok: boolean; document: ProjectDocument };
  /** One explicit control edit as one undo step. */
  directEdit(edit: DirectEditRequest): { ok: true; document: ProjectDocument } | { ok: false; message: string };
  focusUi(focus: UiFocus): void;
  /** A short progress line for the panel ("Checking Chorus…"). */
  activity(label: string): void;
  /** Structured, metadata-only events. Never message text, prompts, audio, or plan bodies. */
  log(event: string, data: Record<string, unknown>): void;
  now(): string;
}
