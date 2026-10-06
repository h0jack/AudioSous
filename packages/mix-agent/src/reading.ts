import { PLANNERS, Surveyor, detectMixProblems, type MixInputs, type MixStrength } from "@audiosous/mix-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { trackName } from "./references";

/**
 * What the four planners measure on the mix as it is now, in a compact form the agent can quote. It is the
 * evidence behind every diagnosis and every "I'd leave it": nothing the agent says about the mix should go beyond
 * what is in a reading, a plan, or the project.
 */

export interface ProblemSummary {
  id: string;
  type: string;
  title: string;
  scope: string;
  sectionIds: string[];
  trackIds: string[];
  protectedTrackId: string | null;
  yieldingTrackId: string | null;
  severity: number;
  confidence: number;
  evidence: Array<{ source: string; label: string; detail: string }>;
}

export interface InteractionSummary {
  id: string;
  domain: "frequency" | "space" | "dynamics";
  trackIds: [string, string];
  scope: string;
  sectionId: string | null;
  severity: number | null;
  outcome: string;
  /** The measured numbers, named. */
  measures: Record<string, number | string | null>;
  explanation: string;
}

export interface LevelSummary {
  trackId: string;
  scope: string;
  sectionId: string | null;
  currentGainDb: number;
  recommendedGainDb: number;
  deltaDb: number;
  status: string;
  reason: string;
}

export interface StemSummary {
  trackId: string;
  name: string;
  loudnessLufs: number | null;
  peakDbfs: number | null;
  crestDb: number | null;
  correlation: number | null;
  /** Dynamics classification per scope ("steady", "phrased", "level-inconsistency", …). */
  dynamics: Array<{ scope: string; classification: string; spreadDb: number | null; transientDb: number | null }>;
}

export interface MixReading {
  strength: MixStrength;
  problems: ProblemSummary[];
  interactions: InteractionSummary[];
  levels: LevelSummary[];
  stems: StemSummary[];
  mix: { correlation: number | null; monoLossDb: number | null; centerLoad: number | null; renderedPeakDbfs: number | null };
}

const round = (value: number | null | undefined, digits = 2): number | null => (value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits);

/** Runs the four planners as measurement on the document and reads them into a `MixReading`. Deterministic. */
export function readMix(document: ProjectDocument, inputs: MixInputs & { mixPeakDbfs?: number | null }, strength: MixStrength, now: string): MixReading {
  const surveyor = new Surveyor(document, inputs, strength, now);
  const survey = surveyor.survey([], PLANNERS);
  const levels = document.tracks.map((track) => {
    const measurement = inputs.measurements[track.id];
    return { trackId: track.id, peakDbfs: measurement?.levels.peakDbfs ?? null, loudnessDb: measurement?.levels.integratedLufs ?? measurement?.levels.rmsDbfs ?? null };
  });
  const problems = detectMixProblems({ survey, settings: { strength, goal: "balanced" }, levels, mixPeakDbfs: inputs.mixPeakDbfs ?? null });
  const sectionName = (id: string | undefined) => document.sections.find((section) => section.id === id)?.name ?? id ?? "";
  const scopeOf = (scope: { type: string; sectionId?: string }) => (scope.type === "section" ? sectionName(scope.sectionId) : "whole song");
  const sectionOf = (scope: { type: string; sectionId?: string }) => (scope.type === "section" ? (scope.sectionId ?? null) : null);

  const interactions: InteractionSummary[] = [];
  for (const item of survey.eq?.interactions ?? []) {
    const region = item.regions[0];
    interactions.push({
      id: `eq:${item.id}`,
      domain: "frequency",
      trackIds: [item.trackA, item.trackB],
      scope: item.scopeName || scopeOf(item.scope),
      sectionId: sectionOf(item.scope),
      severity: round(item.severity),
      outcome: item.outcome,
      measures: {
        kind: item.kind,
        protected: item.protectedTrackId,
        yielding: item.yieldingTrackId,
        regionLowHz: round(region?.lowHz, 0),
        regionHighHz: round(region?.highHz, 0),
        regionCenterHz: round(region?.centerHz, 0),
        levelDifferenceDb: round(region?.levelDifferenceDb, 1),
        maskedShare: round(region?.maskedShare),
        simultaneousActivity: round(item.simultaneousActivity),
        stereoSeparation: round(item.stereoSeparation),
      },
      explanation: item.explanation,
    });
  }
  for (const item of survey.space?.interactions ?? []) {
    interactions.push({
      id: `space:${item.id}`,
      domain: "space",
      trackIds: [item.trackA, item.trackB],
      scope: item.scopeName || scopeOf(item.scope),
      sectionId: sectionOf(item.scope),
      severity: round(item.severity),
      outcome: item.outcome,
      measures: {
        protected: item.protectedTrackId,
        moving: item.movingTrackId,
        centerCompetition: round(item.centerCompetition),
        stereoOverlap: round(item.stereoOverlap),
        frequencyOverlap: round(item.frequencyOverlap),
        lowHz: round(item.lowHz, 0),
        highHz: round(item.highHz, 0),
        levelGapDb: round(item.levelGapDb, 1),
      },
      explanation: item.explanation,
    });
  }
  for (const item of survey.dynamics?.interactions ?? []) {
    interactions.push({
      id: `dynamics:${item.id}`,
      domain: "dynamics",
      trackIds: [item.trackA, item.trackB],
      scope: item.scopeName || scopeOf(item.scope),
      sectionId: sectionOf(item.scope),
      severity: round(item.levelMasking),
      outcome: item.outcome,
      measures: {
        kind: item.kind,
        onsetOverlap: round(item.onsetOverlap),
        lowBandCompetition: round(item.lowBandCompetition),
        freeShare: round(item.freeShare),
        levelGapDb: round(item.levelGapDb, 1),
        recommendedTool: item.recommendedTool,
      },
      explanation: item.explanation,
    });
  }

  const stems: StemSummary[] = document.tracks.map((track) => {
    const measurement = inputs.measurements[track.id];
    return {
      trackId: track.id,
      name: trackName(track),
      loudnessLufs: round(measurement?.levels.integratedLufs, 1),
      peakDbfs: round(measurement?.levels.peakDbfs, 1),
      crestDb: round(measurement?.levels.crestFactorDb, 1),
      correlation: round(measurement?.stereo.correlation),
      dynamics: (survey.dynamics?.readings ?? [])
        .filter((reading) => reading.trackId === track.id)
        .slice(0, 6)
        .map((reading) => ({ scope: reading.scopeName || scopeOf(reading.scope), classification: reading.classification, spreadDb: round(reading.spreadDb, 1), transientDb: round(reading.transientDb, 1) })),
    };
  });

  const before = survey.space?.mix?.before;
  return {
    strength,
    problems: problems.map((problem) => ({
      id: problem.id,
      type: problem.type,
      title: problem.title,
      scope: scopeOf(problem.scope),
      sectionIds: problem.sectionIds,
      trackIds: problem.trackIds,
      protectedTrackId: problem.protectedTrackId,
      yieldingTrackId: problem.yieldingTrackId,
      severity: round(problem.severity)!,
      confidence: round(problem.confidence)!,
      evidence: problem.evidence.map((item) => ({ source: item.source, label: item.label, detail: item.detail })),
    })),
    interactions,
    levels: (survey.balance?.trackChanges ?? []).map((row) => ({
      trackId: row.trackId,
      scope: scopeOf(row.scope),
      sectionId: sectionOf(row.scope),
      currentGainDb: round(row.currentGainDb, 1)!,
      recommendedGainDb: round(row.recommendedGainDb, 1)!,
      deltaDb: round(row.deltaDb, 1)!,
      status: row.status,
      reason: row.reasons[0] ?? "",
    })),
    stems,
    mix: { correlation: round(before?.correlation ?? null, 3), monoLossDb: round(before?.monoLossDb ?? null), centerLoad: round(before?.centerLoad ?? null), renderedPeakDbfs: round(inputs.mixPeakDbfs ?? null, 1) },
  };
}

/** Names instead of ids in a reading slice, for the model. */
export function trackLabel(document: ProjectDocument, id: string | null): string | null {
  if (!id) return null;
  const track = document.tracks.find((item) => item.id === id);
  return track ? trackName(track) : id;
}
