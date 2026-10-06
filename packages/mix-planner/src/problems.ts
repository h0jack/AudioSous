import { estimateSumPeakDbfs, formatSignedDb, type GainRecommendation } from "@audiosous/balance-planner";
import { SPREAD_THRESHOLD_DB, type DynamicsInteraction, type DynamicsRecommendation } from "@audiosous/dynamics-planner";
import { formatHz, type EqEvidence, type EqRecommendation, type TrackInteraction } from "@audiosous/eq-planner";
import type { ProjectDocument, Track } from "@audiosous/project-model";
import type { SpatialInteraction, SpatialRecommendation } from "@audiosous/spatial-planner";
import { clamp, round2, round3, scopeKey } from "./changes";
import { readContrast, type ContrastReading } from "./contrast";
import { PROBLEM_GROUP, type MixProblemType, type MixScope, type ProblemEvidence } from "./model";
import { MIX_LIMITS_BY_STRENGTH, SAFETY, type FullMixSettings } from "./settings";
import type { Survey } from "./survey";

/**
 * The quantity a problem is judged on, read again from every candidate's survey. Gaps are dB of one stem over
 * another where they meet (masker minus protected); `targetDb` is where the subsystem that measures it aims, and
 * `capDb` how much of the gap one plan may be asked to close, so a deliberately extreme mix is not "unsolvable".
 */
export type ProblemMetric =
  | { kind: "gap"; gapDb: number; targetDb: number; capDb: number; spatial: number | null; regionHz: [number, number] | null }
  | { kind: "level"; deltaDb: number }
  | { kind: "spread"; spreadDb: number; thresholdDb: number; scopes: string[] }
  | { kind: "transient"; transientDb: number; excess: boolean }
  | { kind: "conflict"; value: number }
  | { kind: "image"; monoLossDb: number; correlation: number }
  | { kind: "peak"; peakDbfs: number; estimateDbfs: number }
  | { kind: "contrast"; reading: ContrastReading }
  | { kind: "rows"; count: number };

/** Subsystem rows that could solve the problem, kept by reference to the survey they came from. */
export interface ProblemRows {
  balance: GainRecommendation[];
  eq: EqRecommendation[];
  space: SpatialRecommendation[];
  dynamics: DynamicsRecommendation[];
}

export interface DetectedProblem {
  id: string;
  type: MixProblemType;
  title: string;
  scope: MixScope;
  sectionIds: string[];
  trackIds: string[];
  protectedTrackId: string | null;
  yieldingTrackId: string | null;
  severity: number;
  confidence: number;
  group: number;
  references: string[];
  evidence: ProblemEvidence[];
  metric: ProblemMetric;
  rows: ProblemRows;
  /** Share of the yielding stem's playing time the protected stem rests (event vs persistent), when known. */
  freeShare: number | null;
  /** Co-active share of the pair, when known: how much of the time a static change is actually needed. */
  coactive: number | null;
  /** Stated by a person: prominence or a note on one of its stems or its section. */
  intended: boolean;
  /** A planner judged the pair a level problem (the competitor is too loud for EQ or space to fix): a fader move is an alternative. */
  levelProblem?: boolean;
  /**
   * The pair's band levels while both play (the EQ planner's interaction evidence: target = the yielding stem, as
   * heard), so every alternative that changes the yielding stem's spectrum is judged on the same numbers.
   */
  eqEvidence: EqEvidence | null;
}

export interface DetectInput {
  survey: Survey;
  settings: FullMixSettings;
  /** Stem loudness and peaks (from the measurements) for the headroom estimate. */
  levels: Array<{ trackId: string; peakDbfs: number | null; loudnessDb: number | null }>;
  /**
   * The current mix's sample peak measured on a render (the proxies through the native DSP), when there is one.
   * The power-sum estimate from stem peaks reads several dB high, so it never raises a headroom problem alone.
   */
  mixPeakDbfs?: number | null;
}

const SIGNIFICANT = new Set(["recommendation", "review"]);
/** EQ found the conflict but cannot fix it alone ("no-benefit"), or calls it a level problem: still a problem for the whole mix. */
const EQ_PROBLEM = new Set(["recommendation", "review", "no-benefit", "level"]);

/**
 * Reads the four planners' measurements of one mix into problems: what is wrong, where, how badly, how sure, and
 * on what evidence. One problem per stem pair or per stem, whatever number of planners saw it; the planners'
 * rows are kept as the candidate interventions for it.
 */
export function detectMixProblems(input: DetectInput): DetectedProblem[] {
  const { survey, settings } = input;
  const limits = MIX_LIMITS_BY_STRENGTH[settings.strength];
  const document = survey.document;
  const names = (id: string) => document.tracks.find((track) => track.id === id)?.customLabel ?? document.tracks.find((track) => track.id === id)?.name ?? id;
  const problems: DetectedProblem[] = [];
  const claimedSpatial = new Set<string>();
  const claimedEqRows = new Set<string>();

  /* --------------------------------------------------- pairs: low end */
  const lowEnd = new Map<string, { kick: string; bass: string; dyn: DynamicsInteraction[]; eq: TrackInteraction[] }>();
  for (const item of survey.dynamics?.interactions ?? []) {
    if (item.kind !== "low-end") continue;
    const key = `${item.trackA}|${item.trackB}`;
    const entry = lowEnd.get(key) ?? { kick: item.trackA, bass: item.trackB, dyn: [], eq: [] };
    entry.dyn.push(item);
    lowEnd.set(key, entry);
  }
  for (const item of survey.eq?.interactions ?? []) {
    if (item.kind !== "kick-bass") continue;
    const kick = role(document, item.trackA) === "kick" ? item.trackA : item.trackB;
    const bass = kick === item.trackA ? item.trackB : item.trackA;
    const key = `${kick}|${bass}`;
    const entry = lowEnd.get(key) ?? { kick, bass, dyn: [], eq: [] };
    entry.eq.push(item);
    lowEnd.set(key, entry);
  }
  for (const entry of lowEnd.values()) {
    const measured = survey.dynamics !== null && survey.dynamics !== undefined;
    const dynSignificant = entry.dyn.filter((item) => SIGNIFICANT.has(item.outcome));
    const eqSignificant = entry.eq.filter((item) => (SIGNIFICANT.has(item.outcome) || item.outcome === "ambiguous") && item.severity >= limits.minSeverity);
    const significant = measured ? dynSignificant.length > 0 : eqSignificant.length > 0;
    const reading = [...entry.dyn].sort((left, right) => Number(right.scope.type === "global") - Number(left.scope.type === "global") || right.lowBandCompetition - left.lowBandCompetition)[0];
    const eqTop = [...entry.eq].sort((left, right) => right.severity - left.severity)[0];
    const gap = reading?.levelGapDb ?? (eqTop?.regions[0]?.levelDifferenceDb ?? null);
    if (gap === null) continue;
    const share = reading?.lowBandCompetition ?? 0;
    const severity = measured ? clamp((gap + 6) / 7, 0, 1) * clamp(0.6 + share, 0.6, 1) : clamp(eqTop?.severity ?? 0, 0, 1) * 0.8;
    const rows = rowsFor(survey, [entry.bass], (row) => {
      if ("problem" in row) return row.problem === "low-end-collision" && row.processing.type === "ducking" && row.processing.keyTrackId === entry.kick;
      if ("purpose" in row && "protectedTrackIds" in row) return row.protectedTrackIds.includes(entry.kick);
      return false;
    });
    for (const row of rows.eq) claimedEqRows.add(row.id);
    const evidence: ProblemEvidence[] = [];
    if (reading) {
      evidence.push({
        source: "dynamics",
        label: "Low end on the kick's hits",
        detail: `${names(entry.bass)}'s low end sits ${formatSignedDb(gap)} dB against ${names(entry.kick)}'s on ${names(entry.kick)}'s hits; ${Math.round(share * 100)}% of hits collide (within 3 dB).`,
        value: round2(gap),
        unit: "dB",
      });
    }
    if (eqTop) {
      evidence.push({
        source: "eq",
        label: "Static overlap",
        detail: `${names(entry.kick)} and ${names(entry.bass)} overlap ${eqTop.regions[0] ? `at ${formatHz(eqTop.regions[0].lowHz)}–${formatHz(eqTop.regions[0].highHz)}` : "in the low end"} (severity ${eqTop.severity.toFixed(2)}, ${eqTop.outcome}).`,
        value: round3(eqTop.severity),
        unit: null,
      });
    }
    problems.push({
      id: `low-end:${entry.kick}|${entry.bass}`,
      type: "low-end-collision",
      title: `${names(entry.kick)}/${names(entry.bass)} low-end collision`,
      scope: { type: "global" },
      sectionIds: sectionsOf(dynSignificant.map((item) => item.scope)),
      trackIds: [entry.kick, entry.bass],
      protectedTrackId: entry.kick,
      yieldingTrackId: entry.bass,
      severity: significant ? round3(severity) : 0,
      confidence: round3(clamp(reading?.confidence ?? eqTop?.confidence ?? 0.5, 0, 1)),
      group: PROBLEM_GROUP["low-end-collision"],
      references: [...entry.dyn.map((item) => item.id), ...entry.eq.map((item) => item.id)].slice(0, 32),
      evidence: evidence.length > 0 ? evidence : [{ source: "eq", label: "Low end", detail: "Low-end overlap measured.", value: null, unit: null }],
      metric: { kind: "gap", gapDb: round2(gap), targetDb: -3, capDb: { conservative: 3, normal: 4, strong: 6 }[settings.strength], spatial: null, regionHz: [40, 150] },
      rows,
      freeShare: null,
      coactive: null,
      intended: intended(document, [entry.kick, entry.bass]),
      eqEvidence: null,
    });
  }

  /* --------------------------------------------------- pairs: masking and space */
  interface PairEntry {
    a: string;
    b: string;
    eq: TrackInteraction[];
    dyn: DynamicsInteraction[];
    space: SpatialInteraction[];
  }
  const pairs = new Map<string, PairEntry>();
  const entryFor = (a: string, b: string) => {
    const key = [a, b].sort().join("|");
    const entry = pairs.get(key) ?? { a: [a, b].sort()[0]!, b: [a, b].sort()[1]!, eq: [], dyn: [], space: [] };
    pairs.set(key, entry);
    return entry;
  };
  for (const item of survey.eq?.interactions ?? []) if (item.kind !== "kick-bass") entryFor(item.trackA, item.trackB).eq.push(item);
  for (const item of survey.dynamics?.interactions ?? []) if (item.kind !== "low-end") entryFor(item.trackA, item.trackB).dyn.push(item);
  for (const item of survey.space?.interactions ?? []) entryFor(item.trackA, item.trackB).space.push(item);
  for (const entry of [...pairs.values()].sort((left, right) => `${left.a}|${left.b}`.localeCompare(`${right.a}|${right.b}`))) {
    if (lowEnd.has(`${entry.a}|${entry.b}`) || lowEnd.has(`${entry.b}|${entry.a}`)) continue;
    const eqSig = entry.eq.filter((item) => EQ_PROBLEM.has(item.outcome) && item.severity >= limits.minSeverity);
    const dynSig = entry.dyn.filter((item) => SIGNIFICANT.has(item.outcome));
    const spaceSig = entry.space.filter((item) => SIGNIFICANT.has(item.outcome));
    const eqTop = pickTop(entry.eq);
    const spaceTop = pickTop(entry.space);
    const dynTop = [...entry.dyn].sort((left, right) => right.levelMasking - left.levelMasking)[0];
    const frequencyProblem = eqSig.length > 0 || dynSig.length > 0;
    if (!frequencyProblem && spaceSig.length === 0) continue;
    if (frequencyProblem && eqTop) {
      // Who yields: the subsystem that decided, else the role hierarchy.
      const protectedId = eqTop.protectedTrackId ?? dynTop?.trackA ?? spaceTop?.protectedTrackId ?? higherTier(eqTop);
      const yieldingId = protectedId === entry.a ? entry.b : entry.a;
      const event = entry.dyn.some((item) => item.kind === "event-masking" && SIGNIFICANT.has(item.outcome) && (item.recommendedTool === "dynamic-eq" || item.recommendedTool === "ducking"));
      const region = eqTop.regions[0];
      const severity = Math.max(...eqSig.map((item) => item.severity), ...dynSig.map((item) => item.levelMasking), ...spaceSig.map((item) => 0.85 * item.severity), 0);
      const confidence = Math.max(eqTop.confidence, dynTop?.confidence ?? 0);
      const focal = tierOf(eqTop, protectedId) === "focal" || ["lead", "vocal"].includes(role(document, protectedId) ?? "");
      const free = dynTop?.freeShare ?? null;
      const rows = rowsFor(survey, [yieldingId, protectedId], (row) => {
        if (row.trackId === protectedId && !("purpose" in row && row.purpose === "presence")) return false;
        if ("problem" in row) return row.problem === "event-masking" && (row.relatedTrackIds.includes(protectedId) || keyOf(row) === protectedId);
        if ("protectedTrackIds" in row) return row.protectedTrackIds.includes(protectedId) && !claimedEqRows.has(row.id) && (row.trackId === yieldingId || row.purpose === "presence");
        if ("relatedTrackIds" in row) return row.relatedTrackIds.includes(protectedId) && row.purpose === "separation";
        return false;
      });
      for (const row of rows.eq) claimedEqRows.add(row.id);
      for (const item of entry.space) claimedSpatial.add(item.id);
      const evidence: ProblemEvidence[] = [];
      if (region) {
        evidence.push({
          source: "eq",
          label: "Masking where they meet",
          detail: `${names(yieldingId)} sits ${formatSignedDb(region.levelDifferenceDb)} dB against ${names(protectedId)} at ${formatHz(region.lowHz)}–${formatHz(region.highHz)} while both play (${eqTop.scopeName}, severity ${eqTop.severity.toFixed(2)}).`,
          value: round2(region.levelDifferenceDb),
          unit: "dB",
        });
      }
      if (dynTop) {
        evidence.push({
          source: "dynamics",
          label: event ? "Only while it plays" : "Time pattern",
          detail: `${names(protectedId)} rests during ${Math.round(dynTop.freeShare * 100)}% of ${names(yieldingId)}'s playing time; ${dynTop.explanation}`.slice(0, 600),
          value: round3(dynTop.freeShare),
          unit: "share",
        });
      }
      if (spaceTop) {
        evidence.push({
          source: "space",
          label: "Stereo field",
          detail: `They share the field with severity ${spaceTop.severity.toFixed(2)} (${spaceTop.scopeName}): ${spaceTop.explanation}`.slice(0, 600),
          value: round3(spaceTop.severity),
          unit: null,
        });
      }
      const sectionScopes = [...eqSig.map((item) => item.scope), ...dynSig.map((item) => item.scope), ...spaceSig.map((item) => item.scope)];
      const scope = scopeFrom(sectionScopes);
      problems.push({
        id: `masking:${[protectedId, yieldingId].sort().join("|")}`,
        type: event ? "event-masking" : "frequency-conflict",
        title: `${names(yieldingId)} masks ${names(protectedId)}${region ? ` around ${formatHz(region.centerHz)}` : ""}`,
        scope,
        sectionIds: sectionsOf(sectionScopes),
        trackIds: [protectedId, yieldingId],
        protectedTrackId: protectedId,
        yieldingTrackId: yieldingId,
        severity: round3(clamp(severity, 0, 1)),
        confidence: round3(clamp(confidence, 0, 1)),
        group: PROBLEM_GROUP[event ? "event-masking" : "frequency-conflict"],
        references: [...entry.eq, ...entry.dyn, ...entry.space].map((item) => item.id).slice(0, 32),
        evidence: evidence.length > 0 ? evidence : [{ source: "eq", label: "Masking", detail: eqTop.explanation.slice(0, 600), value: null, unit: null }],
        metric: { kind: "gap", gapDb: round2(gapOf(entry.eq, eqTop, region ? [region.lowHz, region.highHz] : null)), targetDb: focal ? -6 : -4, capDb: { conservative: 4, normal: 6, strong: 8 }[settings.strength], spatial: spaceTop ? round3(spaceTop.severity) : null, regionHz: region ? [round2(region.lowHz), round2(region.highHz)] : null },
        rows,
        freeShare: free,
        coactive: eqTop.simultaneousActivity,
        intended: intended(document, [protectedId, yieldingId]),
        levelProblem: entry.eq.some((item) => item.outcome === "level") || entry.space.some((item) => item.outcome === "level"),
        eqEvidence: (entry.eq.find((item) => item.scope.type === "global" && item.regions[0]) ?? eqTop).evidence,
      });
      continue;
    }
    if (spaceSig.length === 0 || !spaceTop) continue;
    // Space alone: two stems crowd the same place in the field.
    const protectedId = spaceTop.protectedTrackId ?? spaceTop.trackA;
    const movingId = spaceTop.movingTrackId ?? (protectedId === entry.a ? entry.b : entry.a);
    for (const item of entry.space) claimedSpatial.add(item.id);
    const rows = rowsFor(survey, [movingId, protectedId], (row) => "relatedTrackIds" in row && !("problem" in row) && (row.interactionIds.some((id) => entry.space.some((item) => item.id === id)) || row.relatedTrackIds.some((id) => id === protectedId || id === movingId)));
    const scope = scopeFrom(spaceSig.map((item) => item.scope));
    problems.push({
      id: `space:${[protectedId, movingId].sort().join("|")}`,
      type: "center-congestion",
      title: `${names(movingId)} crowds ${names(protectedId)} in the stereo field`,
      scope,
      sectionIds: sectionsOf(spaceSig.map((item) => item.scope)),
      trackIds: [protectedId, movingId],
      protectedTrackId: protectedId,
      yieldingTrackId: movingId,
      severity: round3(Math.max(...spaceSig.map((item) => item.severity))),
      confidence: round3(spaceTop.confidence),
      group: PROBLEM_GROUP["center-congestion"],
      references: entry.space.map((item) => item.id).slice(0, 32),
      evidence: [
        {
          source: "space",
          label: "Same place, same range",
          detail: `Center competition ${spaceTop.centerCompetition.toFixed(2)}, field overlap ${spaceTop.stereoOverlap.toFixed(2)}, frequency overlap ${spaceTop.frequencyOverlap.toFixed(2)} at ${formatHz(spaceTop.lowHz)}–${formatHz(spaceTop.highHz)} (${spaceTop.scopeName}).`,
          value: round3(spaceTop.severity),
          unit: null,
        },
      ],
      metric: { kind: "conflict", value: round3(spaceTop.severity) },
      rows,
      freeShare: null,
      coactive: spaceTop.simultaneousActivity,
      intended: intended(document, [protectedId, movingId]),
      eqEvidence: null,
    });
  }

  /* --------------------------------------------------- stems: level */
  const byTrack = new Map<string, GainRecommendation[]>();
  for (const row of survey.balance?.trackChanges ?? []) {
    if (Math.abs(row.deltaDb) < 0.3 && Math.abs(row.offsetFromGlobalDb) < 0.3) continue;
    byTrack.set(row.trackId, [...(byTrack.get(row.trackId) ?? []), row]);
  }
  for (const [trackId, rows] of byTrack) {
    const top = [...rows].sort((left, right) => Math.abs(right.deltaDb) - Math.abs(left.deltaDb))[0]!;
    const scope: MixScope = rows.some((row) => row.scope.type === "global") ? { type: "global" } : rows.length === 1 ? top.scope : { type: "global" };
    problems.push({
      id: `level-hierarchy:${trackId}`,
      type: "level-hierarchy",
      title: `${names(trackId)} ${top.deltaDb < 0 ? "is too loud" : "is too quiet"} for its role${rows.length === 1 && top.scope.type === "section" ? ` in ${sectionName(document, top.scope.sectionId)}` : ""}`,
      scope,
      sectionIds: rows.filter((row) => row.scope.type === "section").map((row) => (row.scope as { sectionId: string }).sectionId),
      trackIds: [trackId],
      protectedTrackId: null,
      yieldingTrackId: trackId,
      severity: round3(clamp(Math.abs(top.deltaDb) / 3, 0, 1)),
      confidence: round3(top.confidence),
      group: PROBLEM_GROUP["level-hierarchy"],
      references: rows.map((row) => row.id),
      evidence: [
        {
          source: "level",
          label: "Against its reference",
          detail: top.reasons.slice(0, 2).join(" ").slice(0, 600),
          value: round2(top.deltaDb),
          unit: "dB",
        },
      ],
      metric: { kind: "level", deltaDb: round2(top.deltaDb) },
      // A stem that is too loud and also unstable may be served by one compressor instead of a fader move and a compressor.
      rows: { balance: rows, eq: [], space: [], dynamics: top.deltaDb < 0 ? (survey.dynamics?.changes ?? []).filter((row) => row.trackId === trackId && row.processing.type === "compressor" && row.status !== "needs-review") : [] },
      freeShare: null,
      coactive: null,
      intended: rows.some((row) => /note|prominence|focal/i.test(row.reasons.join(" "))),
      eqEvidence: null,
    });
  }

  /* --------------------------------------------------- stems: dynamics */
  for (const row of survey.dynamics?.changes ?? []) {
    if (row.problem !== "level-inconsistency" && row.problem !== "transient-excess" && row.problem !== "transient-weakness") continue;
    const trackId = row.trackId;
    const readings = (survey.dynamics?.readings ?? []).filter((reading) => reading.trackId === trackId);
    if (row.problem === "level-inconsistency") {
      const unstable = readings.filter((reading) => reading.classification === "level-inconsistency" && reading.spreadDb !== null);
      const spread = Math.max(row.evaluation?.spreadBeforeDb ?? 0, ...unstable.map((reading) => reading.spreadDb ?? 0));
      const threshold = SPREAD_THRESHOLD_DB[role(document, trackId) ?? "other"] ?? 7;
      const id = `dynamic-instability:${trackId}`;
      if (problems.some((item) => item.id === id)) continue;
      problems.push({
        id,
        type: "dynamic-instability",
        title: `${names(trackId)}'s level is unstable`,
        scope: row.scope,
        sectionIds: unstable.filter((reading) => reading.scope.type === "section").map((reading) => (reading.scope as { sectionId: string }).sectionId),
        trackIds: [trackId],
        protectedTrackId: null,
        yieldingTrackId: trackId,
        severity: round3(clamp(0.4 + (spread - threshold) / 6, 0, 1)),
        confidence: round3(row.confidence),
        group: PROBLEM_GROUP["dynamic-instability"],
        references: [row.id],
        evidence: [{ source: "dynamics", label: "Sustained level spread", detail: `${names(trackId)}'s sustained level swings ${spread.toFixed(1)} dB (its role's line is ${threshold} dB) without repeating with the music.`, value: round2(spread), unit: "dB" }],
        metric: { kind: "spread", spreadDb: round2(spread), thresholdDb: threshold, scopes: unstable.map((reading) => scopeKey(reading.scope)) },
        rows: { balance: [], eq: [], space: [], dynamics: [row] },
        freeShare: null,
        coactive: null,
        intended: false,
        eqEvidence: null,
      });
      continue;
    }
    const excess = row.problem === "transient-excess";
    const value = row.evaluation?.transientBeforeDb ?? readings.find((reading) => reading.transientDb !== null)?.transientDb ?? 0;
    problems.push({
      id: `transient-problem:${trackId}`,
      type: "transient-problem",
      title: `${names(trackId)}'s attacks are ${excess ? "too spiky" : "too soft"}`,
      scope: row.scope,
      sectionIds: [],
      trackIds: [trackId],
      protectedTrackId: null,
      yieldingTrackId: trackId,
      severity: round3(clamp(0.4 + Math.abs(value - (excess ? 12 : 8)) / 12, 0, 1)),
      confidence: round3(row.confidence),
      group: PROBLEM_GROUP["transient-problem"],
      references: [row.id],
      evidence: [{ source: "dynamics", label: "Attack over body", detail: row.reasons[0]!, value: round2(value), unit: "dB" }],
      metric: { kind: "transient", transientDb: round2(value), excess },
      rows: { balance: [], eq: [], space: [], dynamics: [row] },
      freeShare: null,
      coactive: null,
      intended: row.reasons.some((reason) => reason.includes('"')),
      eqEvidence: null,
    });
  }

  /* --------------------------------------------------- stems: space */
  for (const row of survey.space?.changes ?? []) {
    if (row.purpose === "separation") {
      if (problems.some((problem) => problem.rows.space.includes(row))) continue;
      // A separation row whose pair was not claimed above still names a crowding problem.
      const related = row.relatedTrackIds[0];
      if (!related) continue;
      const id = `space:${[related, row.trackId].sort().join("|")}`;
      if (problems.some((problem) => problem.id === id)) continue;
      const before = row.evaluation?.conflictBefore ?? 0.3;
      problems.push({
        id,
        type: "center-congestion",
        title: `${names(row.trackId)} crowds ${names(related)} in the stereo field`,
        scope: row.scope,
        sectionIds: row.scope.type === "section" ? [row.scope.sectionId] : [],
        trackIds: [related, row.trackId],
        protectedTrackId: related,
        yieldingTrackId: row.trackId,
        severity: round3(clamp(before * 2, 0, 1)),
        confidence: round3(row.confidence),
        group: PROBLEM_GROUP["center-congestion"],
        references: [row.id, ...row.interactionIds].slice(0, 32),
        evidence: [{ source: "space", label: "Stereo field", detail: row.reasons[0]!, value: round3(before), unit: null }],
        metric: { kind: "conflict", value: round3(before) },
        rows: { balance: [], eq: [], space: [row], dynamics: [] },
        freeShare: null,
        coactive: null,
        intended: false,
        eqEvidence: null,
      });
      continue;
    }
    if (row.purpose === "narrow" || row.purpose === "mono-safety") {
      const image = songImage(survey, row.trackId);
      const id = `excessive-width:${row.trackId}`;
      if (problems.some((problem) => problem.id === id)) continue;
      const monoLoss = image?.monoLossDb ?? row.evaluation?.monoLossBeforeDb ?? 0;
      const correlation = image?.correlation ?? row.evaluation?.correlationBefore ?? 1;
      problems.push({
        id,
        type: "excessive-width",
        title: `${names(row.trackId)} is too wide for mono`,
        scope: row.scope,
        sectionIds: row.scope.type === "section" ? [row.scope.sectionId] : [],
        trackIds: [row.trackId],
        protectedTrackId: null,
        yieldingTrackId: row.trackId,
        severity: round3(widthSeverity(monoLoss, correlation)),
        confidence: round3(row.confidence),
        group: PROBLEM_GROUP["excessive-width"],
        references: [row.id],
        evidence: [{ source: "space", label: "Mono fold-down", detail: `${names(row.trackId)} loses ${monoLoss.toFixed(1)} dB in mono (correlation ${correlation.toFixed(2)}). ${row.reasons[0]}`.slice(0, 600), value: round2(monoLoss), unit: "dB" }],
        metric: { kind: "image", monoLossDb: round2(monoLoss), correlation: round3(correlation) },
        rows: { balance: [], eq: [], space: [row], dynamics: [] },
        freeShare: null,
        coactive: null,
        intended: false,
        eqEvidence: null,
      });
      continue;
    }
    if (row.purpose === "widen") {
      const id = `center-congestion:mix:${row.trackId}:${scopeKey(row.scope)}`;
      const load = survey.space?.mix.before.centerLoad ?? 0.7;
      problems.push({
        id,
        type: "center-congestion",
        title: `The center is crowded; ${names(row.trackId)} could surround it`,
        scope: row.scope,
        sectionIds: row.scope.type === "section" ? [row.scope.sectionId] : [],
        trackIds: [row.trackId],
        protectedTrackId: null,
        yieldingTrackId: row.trackId,
        severity: round3(clamp((load - 0.55) * 2.5, 0, 1) * 0.8),
        confidence: round3(row.confidence),
        group: PROBLEM_GROUP["center-congestion"],
        references: [row.id],
        evidence: [{ source: "space", label: "Center load", detail: `${Math.round(load * 100)}% of the mix sits in the center of the field. ${row.reasons[0]}`.slice(0, 600), value: round3(load), unit: "share" }],
        metric: { kind: "rows", count: 1 },
        rows: { balance: [], eq: [], space: [row], dynamics: [] },
        freeShare: null,
        coactive: null,
        intended: false,
        eqEvidence: null,
      });
    }
  }

  /* --------------------------------------------------- intent and contrast */
  const contrast = readContrast(survey);
  for (const reading of contrast) {
    if (reading.shortfall <= 0) continue;
    const rows = contrastRows(survey, reading.sectionId);
    problems.push({
      id: `section-contrast:${reading.sectionId}`,
      type: "section-contrast",
      title: `${sectionName(document, reading.sectionId)} lacks the ${reading.asked.join(" and ")} its note asks for`,
      scope: { type: "section", sectionId: reading.sectionId },
      sectionIds: [reading.sectionId],
      trackIds: [...new Set([...rows.space, ...rows.dynamics, ...rows.balance].map((row) => row.trackId))].slice(0, 8),
      protectedTrackId: null,
      yieldingTrackId: null,
      severity: round3(clamp(0.35 + reading.shortfall, 0, 1)),
      confidence: round3(clamp(0.55 + 0.1 * reading.asked.length, 0, 0.85)),
      group: PROBLEM_GROUP["section-contrast"],
      references: [...rows.space, ...rows.dynamics, ...rows.balance, ...rows.eq].map((row) => row.id).slice(0, 32),
      evidence: reading.evidence.map((line) => ({ source: "full-mix" as const, label: line.label, detail: line.detail, value: line.value, unit: line.unit })).slice(0, 8),
      metric: { kind: "contrast", reading },
      rows,
      freeShare: null,
      coactive: null,
      intended: true,
      eqEvidence: null,
    });
  }
  const contrastIds = new Set(problems.filter((problem) => problem.type === "section-contrast").flatMap((problem) => [...problem.rows.space, ...problem.rows.dynamics, ...problem.rows.balance, ...problem.rows.eq].map((row) => row.id)));
  const intentRows = [...(survey.eq?.changes ?? []).filter((row) => row.purpose === "intent" && !claimedEqRows.has(row.id)), ...(survey.space?.changes ?? []).filter((row) => row.purpose === "intent")].filter((row) => !contrastIds.has(row.id));
  for (const row of intentRows) {
    const id = `intent:${row.trackId}:${scopeKey(row.scope)}:${"filter" in row.processing ? "eq" : "space"}`;
    if (problems.some((problem) => problem.id === id)) continue;
    const eqRow = "filter" in row.processing ? (row as EqRecommendation) : null;
    problems.push({
      id,
      type: "intent",
      title: `A note asks for a change on ${names(row.trackId)}${row.scope.type === "section" ? ` in ${sectionName(document, row.scope.sectionId)}` : ""}`,
      scope: row.scope,
      sectionIds: row.scope.type === "section" ? [row.scope.sectionId] : [],
      trackIds: [row.trackId],
      protectedTrackId: null,
      yieldingTrackId: row.trackId,
      severity: round3(clamp(0.45 + 0.3 * row.confidence, 0, 0.8)),
      confidence: round3(row.confidence),
      group: PROBLEM_GROUP.intent,
      references: [row.id],
      evidence: [{ source: eqRow ? "eq" : "space", label: "Note, measured", detail: row.reasons.slice(0, 2).join(" ").slice(0, 600), value: null, unit: null }],
      metric: { kind: "rows", count: 1 },
      rows: { balance: [], eq: eqRow ? [eqRow] : [], space: eqRow ? [] : [row as SpatialRecommendation], dynamics: [] },
      freeShare: null,
      coactive: null,
      intended: true,
      eqEvidence: null,
    });
  }

  /* --------------------------------------------------- headroom */
  const estimate = estimatePeak(document, input.levels);
  const measuredPeak = input.mixPeakDbfs ?? null;
  if (measuredPeak !== null && estimate !== null && measuredPeak > HEADROOM_PROBLEM_DBFS) {
    problems.push({
      id: "headroom:mix",
      type: "headroom",
      title: "The mix clips",
      scope: { type: "global" },
      sectionIds: [],
      trackIds: [],
      protectedTrackId: null,
      yieldingTrackId: null,
      severity: round3(clamp(0.4 + (measuredPeak - HEADROOM_PROBLEM_DBFS) / 3, 0, 1)),
      confidence: 0.8,
      group: PROBLEM_GROUP.headroom,
      references: [],
      evidence: [{ source: "full-mix", label: "Rendered peak", detail: `The current mix peaks at ${formatSignedDb(measuredPeak)} dBFS when rendered from the playback proxies through the native DSP.`, value: round2(measuredPeak), unit: "dBFS" }],
      metric: { kind: "peak", peakDbfs: round2(measuredPeak), estimateDbfs: round2(estimate) },
      rows: { balance: [], eq: [], space: [], dynamics: [] },
      freeShare: null,
      coactive: null,
      intended: false,
      eqEvidence: null,
    });
  }

  return problems.sort((left, right) => left.group - right.group || right.severity - left.severity || left.id.localeCompare(right.id));
}

/** Over this rendered peak the plan offers a safety trim on every fader. */
export const HEADROOM_PROBLEM_DBFS = -0.3;

export function estimatePeak(document: ProjectDocument, levels: DetectInput["levels"], extra: Map<string, number> = new Map()): number | null {
  return estimateSumPeakDbfs(
    document.tracks.map((track) => {
      const level = levels.find((item) => item.trackId === track.id);
      const sections = document.sectionTrackSettings.filter((row) => row.trackId === track.id && row.overrides.gainDb !== null).map((row) => row.overrides.gainDb!);
      const gain = Math.max(track.gainDb, ...sections);
      return { peakDbfs: level?.peakDbfs ?? null, gainDb: gain + (extra.get(track.id) ?? 0), muted: track.muted };
    }),
  );
}

/** Mono risk of one stem, 0–1, smooth so that a narrower setting always reads as less risk. */
export function widthSeverity(monoLossDb: number, correlation: number): number {
  const excess = Math.max(0, monoLossDb - 0.5) / 4 + Math.max(0, 0.3 - correlation);
  return clamp(1 - Math.exp(-1.2 * excess), 0, 1);
}

export function songImage(survey: Survey, trackId: string): { monoLossDb: number; correlation: number } | null {
  const field = survey.space?.fields.find((item) => item.sectionId === null) ?? survey.space?.fields[0];
  const track = field?.tracks.find((item) => item.trackId === trackId);
  return track ? { monoLossDb: track.image.monoLossDb, correlation: track.image.correlation } : null;
}

/** Rows of the four plans on these tracks that pass `keep`. */
function rowsFor(
  survey: Survey,
  trackIds: string[],
  keep: (row: GainRecommendation | EqRecommendation | SpatialRecommendation | DynamicsRecommendation) => boolean,
): ProblemRows {
  const on = (row: { trackId: string }) => trackIds.includes(row.trackId);
  return {
    balance: (survey.balance?.trackChanges ?? []).filter(on),
    eq: (survey.eq?.changes ?? []).filter((row) => on(row) && keep(row)),
    space: (survey.space?.changes ?? []).filter((row) => on(row) && keep(row)),
    dynamics: (survey.dynamics?.changes ?? []).filter((row) => on(row) && keep(row)),
  };
}

function contrastRows(survey: Survey, sectionId: string): ProblemRows {
  const inSection = (row: { scope: MixScope }) => row.scope.type === "section" && row.scope.sectionId === sectionId;
  return {
    balance: (survey.balance?.trackChanges ?? []).filter((row) => inSection(row) && row.deltaDb > 0),
    eq: [],
    space: (survey.space?.changes ?? []).filter((row) => inSection(row) && (row.purpose === "intent" || row.purpose === "widen")),
    dynamics: (survey.dynamics?.changes ?? []).filter((row) => inSection(row) && row.problem === "transient-weakness"),
  };
}

function keyOf(row: DynamicsRecommendation): string | null {
  const processing = row.processing;
  return processing.type === "ducking" || processing.type === "dynamic-eq" ? processing.keyTrackId : null;
}

function pickTop<T extends { severity: number; scope: MixScope }>(items: T[]): T | undefined {
  return [...items].sort((left, right) => Number(right.scope.type === "global") - Number(left.scope.type === "global") || right.severity - left.severity)[0];
}

/**
 * The gap of a pair inside a fixed region: the whole-song reading where there is one, else the most severe
 * section's. Read from the band levels, so a candidate is measured over the same frequencies as the baseline.
 */
export function gapOf(items: TrackInteraction[], top: TrackInteraction, regionHz: [number, number] | null): number {
  const song = items.find((item) => item.scope.type === "global" && item.regions[0]);
  const chosen = song ?? top;
  const region = regionHz ?? (chosen.regions[0] ? [chosen.regions[0].lowHz, chosen.regions[0].highHz] as [number, number] : null);
  return region ? gapInRegion(chosen.evidence, region) : (chosen.regions[0]?.levelDifferenceDb ?? 0);
}

/** Masker (target) over victim (reference) power inside a band range, dB. */
export function gapInRegion(evidence: EqEvidence, regionHz: [number, number]): number {
  let masker = 0;
  let victim = 0;
  evidence.bandsHz.forEach((hz, band) => {
    if (hz < regionHz[0] || hz > regionHz[1]) return;
    masker += 10 ** (evidence.targetDb[band]! / 10);
    victim += 10 ** (evidence.referenceDb[band]! / 10);
  });
  if (masker <= 0 || victim <= 0) return 0;
  return round2(10 * Math.log10(masker / victim));
}

function tierOf(item: TrackInteraction, trackId: string): string {
  return item.trackA === trackId ? item.tierA : item.tierB;
}

const TIER_RANK: Record<string, number> = { focal: 4, primary: 3, supporting: 2, background: 1 };

function higherTier(item: TrackInteraction): string {
  return (TIER_RANK[item.tierA] ?? 0) >= (TIER_RANK[item.tierB] ?? 0) ? item.trackA : item.trackB;
}

function scopeFrom(scopes: MixScope[]): MixScope {
  if (scopes.some((scope) => scope.type === "global")) return { type: "global" };
  const sections = sectionsOf(scopes);
  return sections.length === 1 ? { type: "section", sectionId: sections[0]! } : { type: "global" };
}

function sectionsOf(scopes: MixScope[]): string[] {
  return [...new Set(scopes.filter((scope): scope is { type: "section"; sectionId: string } => scope.type === "section").map((scope) => scope.sectionId))];
}

function role(document: ProjectDocument, trackId: string): Track["role"] | null {
  return document.tracks.find((track) => track.id === trackId)?.role ?? null;
}

function sectionName(document: ProjectDocument, sectionId: string): string {
  return document.sections.find((section) => section.id === sectionId)?.name ?? "a section";
}

function intended(document: ProjectDocument, trackIds: string[]): boolean {
  return document.sectionTrackSettings.some((row) => trackIds.includes(row.trackId) && (row.prominence !== null || row.userIntent !== null));
}

export { SAFETY };
