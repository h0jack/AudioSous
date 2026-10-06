import type { EnvelopeFrames, EqBandFrames, StereoFrames, TrackFileMeasurement } from "@audiosous/analysis-contract";
import { planBalance, planStateIdentity, type MixPlan, type TrackMeasurements } from "@audiosous/balance-planner";
import { dynamicsPlanStateIdentity, planDynamics, type DynamicsPlan } from "@audiosous/dynamics-planner";
import { eqPlanStateIdentity, planEq, type EqPlan } from "@audiosous/eq-planner";
import { MAX_SECTION_EQ_NODES, MAX_TRACK_EQ_NODES, normalizeEqFilter, sectionEqNodes, setSectionEqNodes, setTrackEqNodes, trackEqNodes, type ProjectDocument } from "@audiosous/project-model";
import { planSpace, spatialPlanStateIdentity, type SpatialPlan } from "@audiosous/spatial-planner";
import { addGain, applyChanges, fnv1a, nodeIdFor, type ChangeCore } from "./changes";
import type { MixChange } from "./model";
import type { MixStrength } from "./settings";

/** Everything the four planners read. Only `measurements` is required; without envelopes there is no dynamics reading. */
export interface MixInputs {
  measurements: Record<string, TrackFileMeasurement | null | undefined>;
  /** Per-section measurements for AutoBalance, when the desktop has them. */
  sectionMeasurements?: Record<string, Record<string, TrackFileMeasurement | null>>;
  bands?: Record<string, EqBandFrames | null | undefined>;
  stereo?: Record<string, StereoFrames | null | undefined>;
  envelopes?: Record<string, EnvelopeFrames | null | undefined>;
}

export const PLANNERS = ["level", "eq", "space", "dynamics"] as const;
export type Planner = (typeof PLANNERS)[number];

/** The four planners' readings of one (candidate) mix. A planner that was not asked for is undefined. */
export interface Survey {
  key: string;
  /** The project with the candidate's changes written in, as the engine would play it. */
  document: ProjectDocument;
  balance?: MixPlan;
  eq?: EqPlan;
  space?: SpatialPlan;
  /** Null when no stem has envelope frames. */
  dynamics?: DynamicsPlan | null;
}

type Candidate = ChangeCore & Pick<MixChange, "evaluation">;

/**
 * Runs the existing planners on a candidate mix and caches each reading by the candidate's content, so whole-mix
 * candidates that share a choice share its measurement. The planners are measurement here: the full-mix planner
 * reads their interactions, readings, and rows, never applies them blindly.
 *
 * Each planner sees what it can measure. A planner that cannot model another domain's processing is given a
 * measurement view with that processing folded in, so a fix in one domain is not read as a remaining problem in
 * another:
 * - Dynamics reads the candidate as written (it simulates compressors and ducks itself, and saved EQ's level change).
 * - EQ and Space do not see dynamics. A dynamic EQ keyed from a stem acts while that stem plays, which is exactly
 *   when the two compete, so it is folded in as a static bell of its full depth; a phrase duck (smooth key) as most
 *   of its range; a hit duck, compressor, or transient shaper as its predicted average level change.
 * - AutoBalance sees gain only, so every other change is folded in as its predicted average level change.
 * The folds are views for measuring, never written to the project.
 */
export class Surveyor {
  private readonly cache = new Map<string, unknown>();
  runs = 0;

  constructor(
    readonly base: ProjectDocument,
    readonly inputs: MixInputs,
    readonly strength: MixStrength,
    readonly now: string,
  ) {}

  survey(changes: readonly Candidate[], planners: readonly Planner[]): Survey {
    const key = candidateKey(changes);
    const actual = this.memo(`doc:${key}`, () => applyChanges(this.base, changes).document);
    const survey: Survey = { key, document: actual };
    // Each planner's reading is cached by its own state identity of the view it sees, so two candidates that differ
    // only in what a planner does not read (a pan move, for Dynamics) share that planner's run.
    const strength = { strength: this.strength };
    for (const planner of planners) {
      if (planner === "level") {
        const view = balanceView(actual, changes);
        survey.balance = this.memo(`level:${planStateIdentity(view, { style: "balanced", strength: this.strength })}`, () => this.runBalance(view));
      }
      if (planner === "eq" || planner === "space") {
        const view = this.memo(`eqview:${key}`, () => eqView(actual, changes));
        if (planner === "eq") survey.eq = this.memo(`eq:${eqPlanStateIdentity(view, strength)}`, () => this.runEq(view));
        else survey.space = this.memo(`space:${spatialPlanStateIdentity(view, strength)}`, () => this.runSpace(view));
      }
      if (planner === "dynamics") survey.dynamics = this.memo(`dynamics:${dynamicsPlanStateIdentity(actual, strength)}`, () => this.runDynamics(actual));
    }
    return survey;
  }

  /** The planners on a view of the base project that is not a candidate (rewritten notes), cached by `key`. */
  surveyView(key: string, document: ProjectDocument, planners: readonly Planner[]): Survey {
    const survey: Survey = { key, document };
    for (const planner of planners) {
      if (planner === "level") survey.balance = this.memo(`level:view:${key}`, () => this.runBalance(document));
      if (planner === "eq") survey.eq = this.memo(`eq:view:${key}`, () => this.runEq(document));
      if (planner === "space") survey.space = this.memo(`space:view:${key}`, () => this.runSpace(document));
      if (planner === "dynamics") survey.dynamics = this.memo(`dynamics:view:${key}`, () => this.runDynamics(document));
    }
    return survey;
  }

  private memo<T>(key: string, run: () => T): T {
    if (this.cache.has(key)) return this.cache.get(key) as T;
    const value = run();
    this.cache.set(key, value);
    return value;
  }

  private runBalance(document: ProjectDocument): MixPlan {
    this.runs += 1;
    const measurements: Record<string, TrackMeasurements> = {};
    for (const track of document.tracks) measurements[track.id] = { track: this.inputs.measurements[track.id] ?? null, sections: this.inputs.sectionMeasurements?.[track.id] };
    return planBalance({ document, measurements, settings: { strength: this.strength }, now: this.now });
  }

  private runEq(document: ProjectDocument): EqPlan {
    this.runs += 1;
    return planEq({ document, measurements: this.inputs.measurements, bands: this.inputs.bands, settings: { strength: this.strength }, now: this.now });
  }

  private runSpace(document: ProjectDocument): SpatialPlan {
    this.runs += 1;
    return planSpace({ document, measurements: this.inputs.measurements, bands: this.inputs.bands, stereo: this.inputs.stereo, settings: { strength: this.strength }, now: this.now });
  }

  private runDynamics(document: ProjectDocument): DynamicsPlan | null {
    const envelopes = this.inputs.envelopes;
    if (!envelopes || !Object.values(envelopes).some(Boolean)) return null;
    this.runs += 1;
    return planDynamics({ document, measurements: this.inputs.measurements, envelopes, bands: this.inputs.bands, settings: { strength: this.strength }, now: this.now });
  }
}

/** Order-independent identity of a candidate's content. */
export function candidateKey(changes: readonly ChangeCore[]): string {
  if (changes.length === 0) return "current";
  const items = changes.map((change) => JSON.stringify([change.id, change.trackId, change.scope, change.processing, change.replacesNodeId])).sort();
  return fnv1a(items.join("|")) + `:${changes.length}`;
}

/** The candidate as EQ and Space measure it: dynamics folded in (see `Surveyor`). */
export function eqView(actual: ProjectDocument, changes: readonly Candidate[]): ProjectDocument {
  let view = actual;
  for (const change of changes) {
    if (change.processing.type !== "dynamics") continue;
    const node = change.processing.processing;
    if (node.type === "dynamic-eq") {
      view = addStaticBell(view, change, node.filter.frequencyHz, node.filter.q, node.rangeDb);
    } else if (node.type === "ducking" && node.keyDetector === "smooth") {
      view = addGain(view, change.trackId, change.scope, 0.8 * node.rangeDb);
    } else {
      view = addGain(view, change.trackId, change.scope, change.evaluation.levelChangeDb);
    }
  }
  return view;
}

/** The candidate as AutoBalance measures it: every non-gain change folded in as its predicted level change. */
export function balanceView(actual: ProjectDocument, changes: readonly Candidate[]): ProjectDocument {
  let view = actual;
  for (const change of changes) {
    if (change.processing.type === "gain" || change.processing.type === "trim") continue;
    view = addGain(view, change.trackId, change.scope, change.evaluation.levelChangeDb);
  }
  return view;
}

function addStaticBell(document: ProjectDocument, change: Candidate, frequencyHz: number, q: number, gainDb: number): ProjectDocument {
  const node = { id: `${nodeIdFor(change)}-view`, type: "eq" as const, enabled: true, filter: normalizeEqFilter({ kind: "bell", frequencyHz, gainDb, q }), origin: "eq-plan" as const, note: "measurement view" };
  if (change.scope.type === "global") {
    const nodes = trackEqNodes(document, change.trackId);
    if (nodes.length >= MAX_TRACK_EQ_NODES) return addGain(document, change.trackId, change.scope, change.evaluation?.levelChangeDb ?? 0);
    const result = setTrackEqNodes(document, change.trackId, [...nodes, node]);
    return result.ok ? result.document : document;
  }
  const nodes = sectionEqNodes(document, change.trackId, change.scope.sectionId);
  if (nodes.length >= MAX_SECTION_EQ_NODES) return document;
  const result = setSectionEqNodes(document, change.trackId, change.scope.sectionId, [...nodes, node]);
  return result.ok ? result.document : document;
}
