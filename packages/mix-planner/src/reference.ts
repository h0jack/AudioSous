import { STEREO_BANDS, type EnvelopeFrames, type EqBandFrames, type StereoFrames, type TrackFileMeasurement } from "@audiosous/analysis-contract";
import { GRID_BANDS, buildSpectralModel, qForOctaves } from "@audiosous/eq-planner";
import { isMonoTrack, trackEqNodes, type EqFilter, type ProjectDocument } from "@audiosous/project-model";
import { buildStereoModel } from "@audiosous/spatial-planner";
import { z } from "zod";
import { applyChanges, describeChange, fnv1a, round2, type ChangeCore } from "./changes";
import { changeCost, costLabel, type CostContext } from "./cost";
import type { MixConstraints } from "./constraints";
import type { CandidateMetrics, FullMixPlan, MixChange, MixIntervention, MixProblem } from "./model";
import { fullMixStateIdentity, refreshFullMix } from "./plan";
import { FULL_MIX_PLAN_VERSION, FULL_MIX_PLANNER_VERSION, type MixStrength } from "./settings";
import type { SourceFingerprint } from "@audiosous/balance-planner";

/**
 * A reference song as a target: how a mix differs from it (tonal shape, width per region, low-end mono-ness,
 * dynamics, loudness), and a plan of stem changes that moves the mix part of the way toward it.
 *
 * Both songs are measured the same way (`crates/audio-engine/src/reference.rs`): the body of the song, loudness
 * removed, on the planners' 24-band grid. A gap is the mix minus the reference in a region, after both shapes are
 * levelled over 100 Hz – 10 kHz, so a louder or quieter reference does not read as a tonal difference.
 *
 * The plan uses the planners' own models to predict a candidate: the EQ planner's spectral model (each stem's band
 * power as heard, with the candidate's EQ and faders written in) and the Space planner's stereo model (each stem's
 * mid and side as heard, with the candidate's width). The predicted change of the mix's shape is added to the gap
 * measured on audio, so the model only has to be right about differences. The desktop renders the candidate and
 * measures it against the reference again. A reference is a direction, not a target to hit exactly: a plan closes
 * at most 70% of a gap, with the strength's EQ limits, and leaves gaps under the strength's threshold alone.
 */

export const songProfileSchema = z.object({
  version: z.number().int(),
  durationSeconds: z.number().finite().nonnegative(),
  loudness: z.object({ integratedLufs: z.number().finite(), loudnessRangeLu: z.number().finite(), samplePeakDbfs: z.number().finite(), truePeakDbtp: z.number().finite(), maxShortTermLufs: z.number().finite() }),
  edgesHz: z.array(z.number().finite().positive()).length(GRID_BANDS + 1),
  midDb: z.array(z.number().finite()).length(GRID_BANDS),
  sideDb: z.array(z.number().finite()).length(GRID_BANDS),
  bodyShare: z.number().finite().min(0).max(1),
  crestDb: z.number().finite(),
  lowCorrelation: z.number().finite().min(-1).max(1),
});
export type SongProfile = z.infer<typeof songProfileSchema>;

export interface ReferenceRegion {
  id: "sub" | "low" | "low-mid" | "mid" | "presence" | "air";
  label: string;
  /** What too much and too little sound like, for plain sentences. */
  more: string;
  less: string;
  lowHz: number;
  highHz: number;
}

export const REFERENCE_REGIONS: ReferenceRegion[] = [
  { id: "sub", label: "sub (20–60 Hz)", more: "more sub weight", less: "less sub weight", lowHz: 20, highHz: 60 },
  { id: "low", label: "bass (60–150 Hz)", more: "heavier", less: "lighter in the bass", lowHz: 60, highHz: 150 },
  { id: "low-mid", label: "low-mids (150–500 Hz)", more: "muddier, thicker", less: "thinner", lowHz: 150, highHz: 500 },
  { id: "mid", label: "mids (500 Hz–2 kHz)", more: "boxier, more forward", less: "more scooped", lowHz: 500, highHz: 2_000 },
  { id: "presence", label: "presence (2–6 kHz)", more: "more forward, edgier", less: "less clear, further back", lowHz: 2_000, highHz: 6_000 },
  { id: "air", label: "air (6–16 kHz)", more: "brighter, airier", less: "duller, darker", lowHz: 6_000, highHz: 16_000 },
];

/** Regions width is compared in: the low end is read as mono-ness instead. */
const WIDTH_REGIONS = REFERENCE_REGIONS.filter((region) => region.lowHz >= 150);

export interface TonalGap {
  region: ReferenceRegion;
  /** Mix minus reference, dB, both levelled. Positive: the mix has more there. */
  gapDb: number;
}

export interface WidthGap {
  region: ReferenceRegion;
  /** Side over mid, mix minus reference, dB. Positive: the mix is wider there. */
  gapDb: number;
  mixSideDb: number;
  referenceSideDb: number;
}

export interface ReferenceComparison {
  /** Per band: the mix's and the reference's levelled shape, dB, for drawing. */
  bands: Array<{ hz: number; mixDb: number; referenceDb: number; gapDb: number }>;
  tonal: TonalGap[];
  width: WidthGap[];
  lowCorrelation: { mix: number; reference: number };
  loudness: { mixLufs: number; referenceLufs: number; mixTruePeakDbtp: number; referenceTruePeakDbtp: number };
  dynamics: { mixPlrDb: number; referencePlrDb: number; mixLraLu: number; referenceLraLu: number; mixCrestDb: number; referenceCrestDb: number };
  /** Plain sentences, largest difference first. Each is a measurement, not a verdict. */
  findings: string[];
}

const LEVEL_LOW_HZ = 100;
const LEVEL_HIGH_HZ = 10_000;

function centers(edges: number[]): number[] {
  return edges.slice(0, -1).map((low, index) => Math.sqrt(low * edges[index + 1]!));
}

function dbToPower(db: number): number {
  return 10 ** (db / 10);
}

function powerToDb(power: number): number {
  return 10 * Math.log10(Math.max(power, 1e-30));
}

/** Total (mid + side) band level, levelled so its mean over 100 Hz – 10 kHz is 0 dB. */
export function levelledShape(totalDb: number[], edges: number[]): number[] {
  const mids = centers(edges);
  const inside = totalDb.filter((_, band) => mids[band]! >= LEVEL_LOW_HZ && mids[band]! <= LEVEL_HIGH_HZ);
  const mean = inside.reduce((sum, value) => sum + value, 0) / Math.max(1, inside.length);
  return totalDb.map((value) => value - mean);
}

function totalDb(profile: SongProfile): number[] {
  return profile.midDb.map((mid, band) => powerToDb(dbToPower(mid) + dbToPower(profile.sideDb[band]!)));
}

function regionMean(values: number[], edges: number[], region: ReferenceRegion): number {
  const mids = centers(edges);
  const inside = values.filter((_, band) => mids[band]! >= region.lowHz && mids[band]! < region.highHz);
  return inside.reduce((sum, value) => sum + value, 0) / Math.max(1, inside.length);
}

function regionSideRatioDb(profile: SongProfile, region: ReferenceRegion): number {
  const mids = centers(profile.edgesHz);
  let mid = 0;
  let side = 0;
  mids.forEach((hz, band) => {
    if (hz < region.lowHz || hz >= region.highHz) return;
    mid += dbToPower(profile.midDb[band]!);
    side += dbToPower(profile.sideDb[band]!);
  });
  return powerToDb(side) - powerToDb(mid);
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
}

export function compareToReference(mix: SongProfile, reference: SongProfile): ReferenceComparison {
  const mixShape = levelledShape(totalDb(mix), mix.edgesHz);
  const refShape = levelledShape(totalDb(reference), reference.edgesHz);
  const hz = centers(mix.edgesHz);
  const bands = hz.map((center, band) => ({ hz: Math.round(center), mixDb: round2(mixShape[band]!), referenceDb: round2(refShape[band]!), gapDb: round2(mixShape[band]! - refShape[band]!) }));
  const gaps = bands.map((band) => band.gapDb);
  const tonal = REFERENCE_REGIONS.map((region) => ({ region, gapDb: round2(regionMean(gaps, mix.edgesHz, region)) }));
  const width = WIDTH_REGIONS.map((region) => {
    const mixSideDb = regionSideRatioDb(mix, region);
    const referenceSideDb = regionSideRatioDb(reference, region);
    return { region, gapDb: round2(mixSideDb - referenceSideDb), mixSideDb: round2(mixSideDb), referenceSideDb: round2(referenceSideDb) };
  });
  const loudness = { mixLufs: mix.loudness.integratedLufs, referenceLufs: reference.loudness.integratedLufs, mixTruePeakDbtp: mix.loudness.truePeakDbtp, referenceTruePeakDbtp: reference.loudness.truePeakDbtp };
  const dynamics = {
    mixPlrDb: round2(mix.loudness.truePeakDbtp - mix.loudness.integratedLufs),
    referencePlrDb: round2(reference.loudness.truePeakDbtp - reference.loudness.integratedLufs),
    mixLraLu: mix.loudness.loudnessRangeLu,
    referenceLraLu: reference.loudness.loudnessRangeLu,
    mixCrestDb: mix.crestDb,
    referenceCrestDb: reference.crestDb,
  };
  const findings: Array<{ size: number; text: string }> = [];
  for (const gap of tonal) {
    if (Math.abs(gap.gapDb) < 1) continue;
    findings.push({ size: Math.abs(gap.gapDb), text: `Your mix has ${signed(gap.gapDb)} dB in the ${gap.region.label} compared with the reference: ${gap.gapDb > 0 ? gap.region.more : gap.region.less}.` });
  }
  for (const gap of width) {
    if (Math.abs(gap.gapDb) < 3) continue;
    findings.push({ size: Math.abs(gap.gapDb) / 2, text: `In the ${gap.region.label} your mix is ${gap.gapDb > 0 ? "wider" : "narrower"} than the reference (sides ${signed(gap.gapDb)} dB relative to the center).` });
  }
  if (reference.lowCorrelation >= 0.9 && mix.lowCorrelation < 0.8) findings.push({ size: 2, text: `The reference's low end is close to mono (correlation ${reference.lowCorrelation.toFixed(2)} under 120 Hz); yours is wider (${mix.lowCorrelation.toFixed(2)}).` });
  const loudnessGap = loudness.mixLufs - loudness.referenceLufs;
  if (Math.abs(loudnessGap) >= 1) findings.push({ size: Math.abs(loudnessGap) / 3, text: `The reference is ${Math.abs(loudnessGap).toFixed(1)} dB ${loudnessGap < 0 ? "louder" : "quieter"} (${loudness.referenceLufs.toFixed(1)} against ${loudness.mixLufs.toFixed(1)} LUFS). Loudness is set at export, not in the mix.` });
  const plrGap = dynamics.mixPlrDb - dynamics.referencePlrDb;
  if (Math.abs(plrGap) >= 2) findings.push({ size: Math.abs(plrGap) / 3, text: `The reference has ${plrGap > 0 ? "less" : "more"} peak-to-loudness range (${dynamics.referencePlrDb.toFixed(1)} against ${dynamics.mixPlrDb.toFixed(1)} dB): it is ${plrGap > 0 ? "denser and more limited" : "more open"}. ${plrGap > 0 ? "Matching its loudness at export would take limiting; how much is shown before the export writes anything." : ""}`.trim() });
  findings.sort((left, right) => right.size - left.size);
  return { bands, tonal, width, lowCorrelation: { mix: mix.lowCorrelation, reference: reference.lowCorrelation }, loudness, dynamics, findings: findings.map((finding) => finding.text) };
}

/* ------------------------------------------------------------------ the mix model */

interface ModelReading {
  /** Total band power of the mix over its body, dB per grid band. */
  bandDb: number[];
  /** Side over mid per width region, dB. */
  sideRatioDb: Map<string, number>;
  /** Each stem's power per region (linear), for contributions. */
  regionPower: Map<string, number[]>;
  /** Each stem's side power per width region (linear). */
  sidePower: Map<string, number[]>;
  edges: number[];
}

export interface ReferenceInputs {
  measurements: Record<string, TrackFileMeasurement | null | undefined>;
  bands?: Record<string, EqBandFrames | null | undefined>;
  stereo?: Record<string, StereoFrames | null | undefined>;
  envelopes?: Record<string, EnvelopeFrames | null | undefined>;
}

/** The planners' models of a project, read the way a profile is: the body of the song, per region. */
function readModel(document: ProjectDocument, inputs: ReferenceInputs, bodySteps?: number[]): { reading: ModelReading; bodySteps: number[] } {
  const spectral = buildSpectralModel({ document, measurements: inputs.measurements, bands: inputs.bands });
  const edges = spectral.grid.edges;
  const stepPower = new Float64Array(spectral.steps);
  for (const [, track] of spectral.tracks) for (let step = 0; step < spectral.steps; step += 1) for (let band = 0; band < GRID_BANDS; band += 1) stepPower[step] += track.power[step * GRID_BANDS + band]!;
  let steps = bodySteps;
  if (!steps) {
    const sorted = [...stepPower].sort((a, b) => a - b);
    const loud = sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0;
    steps = [...stepPower.keys()].filter((step) => stepPower[step]! > 0 && stepPower[step]! >= loud / 100);
    if (steps.length === 0) steps = [...stepPower.keys()];
  }
  const total = new Array<number>(GRID_BANDS).fill(0);
  const regionPower = new Map<string, number[]>();
  const mids = centers(edges);
  for (const [trackId, track] of spectral.tracks) {
    const perBand = new Array<number>(GRID_BANDS).fill(0);
    for (const step of steps) for (let band = 0; band < GRID_BANDS; band += 1) perBand[band] += track.power[step * GRID_BANDS + band]! / steps.length;
    perBand.forEach((value, band) => (total[band] += value));
    regionPower.set(trackId, REFERENCE_REGIONS.map((region) => perBand.reduce((sum, value, band) => (mids[band]! >= region.lowHz && mids[band]! < region.highHz ? sum + value : sum), 0)));
  }
  const stereo = buildStereoModel({ document, spectral, measurements: inputs.measurements, stereo: inputs.stereo });
  const stereoCenters = centers(stereo.edgesHz);
  const midTotal = new Array<number>(STEREO_BANDS).fill(0);
  const sideTotal = new Array<number>(STEREO_BANDS).fill(0);
  const sidePower = new Map<string, number[]>();
  for (const [trackId, track] of stereo.tracks) {
    const side = new Array<number>(STEREO_BANDS).fill(0);
    for (const step of steps) {
      for (let band = 0; band < STEREO_BANDS; band += 1) {
        const stats = track.heard[step * STEREO_BANDS + band];
        if (!stats) continue;
        const mid = Math.max(0, (stats.l + stats.r + 2 * stats.c) / 4) / steps.length;
        const sideValue = Math.max(0, (stats.l + stats.r - 2 * stats.c) / 4) / steps.length;
        midTotal[band] += mid;
        sideTotal[band] += sideValue;
        side[band] += sideValue;
      }
    }
    sidePower.set(trackId, WIDTH_REGIONS.map((region) => side.reduce((sum, value, band) => (stereoCenters[band]! >= region.lowHz && stereoCenters[band]! < region.highHz ? sum + value : sum), 0)));
  }
  const sideRatioDb = new Map<string, number>();
  for (const region of WIDTH_REGIONS) {
    let mid = 0;
    let side = 0;
    stereoCenters.forEach((hz, band) => {
      if (hz < region.lowHz || hz >= region.highHz) return;
      mid += midTotal[band]!;
      side += sideTotal[band]!;
    });
    sideRatioDb.set(region.id, powerToDb(side) - powerToDb(mid));
  }
  return { reading: { bandDb: total.map(powerToDb), sideRatioDb, regionPower, sidePower, edges }, bodySteps: steps };
}

function modelRegionShape(reading: ModelReading): Map<string, number> {
  const shape = levelledShape(reading.bandDb, reading.edges);
  return new Map(REFERENCE_REGIONS.map((region) => [region.id, regionMean(shape, reading.edges, region)]));
}

/* ------------------------------------------------------------------ planning */

export interface PlanReferenceInput extends ReferenceInputs {
  document: ProjectDocument;
  mixProfile: SongProfile;
  referenceProfile: SongProfile;
  referenceName: string;
  strength: MixStrength;
  fingerprints?: SourceFingerprint[];
  constraints?: MixConstraints | null;
  now?: string;
  /** Called with each region's contributors and scored alternatives, for acceptance runs. */
  trace?: (line: string) => void;
}

interface Limits {
  /** Smallest tonal gap acted on, dB. */
  tonalThreshold: number;
  widthThreshold: number;
  maxCut: number;
  maxBoost: number;
  maxWidthChange: number;
  /** Share of a gap a plan aims to close. */
  close: number;
  maxChanges: number;
}

const LIMITS: Record<MixStrength, Limits> = {
  conservative: { tonalThreshold: 2, widthThreshold: 4, maxCut: 3, maxBoost: 2, maxWidthChange: 0.2, close: 0.5, maxChanges: 3 },
  normal: { tonalThreshold: 1.5, widthThreshold: 3, maxCut: 4, maxBoost: 3, maxWidthChange: 0.3, close: 0.7, maxChanges: 6 },
  strong: { tonalThreshold: 1, widthThreshold: 2, maxCut: 6, maxBoost: 4, maxWidthChange: 0.4, close: 0.7, maxChanges: 10 },
};

interface Candidate {
  label: string;
  changes: Array<ChangeCore & { domain: MixChange["domain"]; share: number; current: { pan: number; width: number } | null }>;
}

interface Scored extends Candidate {
  gapsAfter: Map<string, number>;
  widthAfter: Map<string, number>;
  benefit: number;
  cost: number;
  net: number;
  removed: number;
}

/** A filter for a region on one stem: a shelf at the ends of the spectrum, a bell elsewhere. Edits a saved bell in the region. */
function regionFilter(document: ProjectDocument, trackId: string, region: ReferenceRegion, gainDb: number): { filter: EqFilter; replacesNodeId: string | null } {
  const centerHz = Math.sqrt(region.lowHz * region.highHz);
  const octaves = Math.log2(region.highHz / region.lowHz);
  const regionQ = Math.min(2, Math.max(0.5, qForOctaves(octaves)));
  // A saved bell of about the same width in the region is edited; a narrow notch with its own purpose is left alone.
  const saved = trackEqNodes(document, trackId).find((node) => node.enabled && node.filter.kind === "bell" && node.filter.frequencyHz >= region.lowHz && node.filter.frequencyHz < region.highHz && node.filter.q <= regionQ * 2 && node.filter.q >= regionQ / 2);
  if (saved) {
    const next = Math.round((saved.filter.gainDb + gainDb) * 10) / 10;
    return { filter: { ...saved.filter, gainDb: Math.max(-12, Math.min(6, next)) }, replacesNodeId: saved.id };
  }
  if (region.id === "sub") return { filter: { kind: "low-shelf", frequencyHz: 60, gainDb, q: 0.7 }, replacesNodeId: null };
  if (region.id === "air") return { filter: { kind: "high-shelf", frequencyHz: 6_000, gainDb, q: 0.7 }, replacesNodeId: null };
  return { filter: { kind: "bell", frequencyHz: Math.round(centerHz), gainDb, q: Math.round(Math.min(2, Math.max(0.5, qForOctaves(octaves))) * 10) / 10 }, replacesNodeId: null };
}

/** The stem gain (dB) that moves a region by `targetDb` when the stem carries `share` of it; null when it cannot. */
function stemMoveFor(targetDb: number, share: number): number | null {
  if (share <= 0) return null;
  const factor = 10 ** (targetDb / 10);
  const inside = (factor - (1 - share)) / share;
  if (inside <= 0) return null;
  return 10 * Math.log10(inside);
}

export function planReferenceMatch(input: PlanReferenceInput): FullMixPlan {
  const { document, strength } = input;
  const limits = LIMITS[strength];
  const now = input.now ?? new Date().toISOString();
  const constraints = input.constraints ?? null;
  const protectedIds = new Set(constraints?.protectedTrackIds ?? []);
  const excluded = new Set(constraints?.excludedDomains ?? []);
  const comparison = compareToReference(input.mixProfile, input.referenceProfile);
  const names = (id: string) => document.tracks.find((track) => track.id === id)?.customLabel ?? document.tracks.find((track) => track.id === id)?.name ?? id;
  const costCtx: CostContext = { document, goal: "balanced" };
  const { reading: base, bodySteps } = readModel(document, input);
  const baseShape = modelRegionShape(base);
  const measuredGap = new Map<string, number>(comparison.tonal.map((gap) => [gap.region.id, gap.gapDb]));
  const measuredWidth = new Map<string, number>(comparison.width.map((gap) => [gap.region.id, gap.gapDb]));

  /** The gaps a project would leave: measured gap plus the model's change from the saved mix. */
  const predict = (changes: ChangeCore[]): { tonal: Map<string, number>; width: Map<string, number> } => {
    if (changes.length === 0) return { tonal: new Map(measuredGap), width: new Map(measuredWidth) };
    const applied = applyChanges(document, changes).document;
    const { reading } = readModel(applied, input, bodySteps);
    const shape = modelRegionShape(reading);
    const tonal = new Map(REFERENCE_REGIONS.map((region) => [region.id, round2(measuredGap.get(region.id)! + shape.get(region.id)! - baseShape.get(region.id)!)]));
    const width = new Map(WIDTH_REGIONS.map((region) => [region.id, round2(measuredWidth.get(region.id)! + reading.sideRatioDb.get(region.id)! - base.sideRatioDb.get(region.id)!)]));
    return { tonal, width };
  };

  const chosen: Array<Candidate["changes"][number] & { problemId: string }> = [];
  const problems: MixProblem[] = [];
  const interventions: MixIntervention[] = [];
  const eligible = (trackId: string) => !protectedIds.has(trackId) && !document.tracks.find((track) => track.id === trackId)?.muted;

  const score = (candidate: Candidate, gaps: { tonal: Map<string, number>; width: Map<string, number> }, regionId: string, measure: "tonal" | "width"): Scored => {
    const after = predict([...chosen, ...candidate.changes]);
    let benefit = 0;
    for (const region of REFERENCE_REGIONS) {
      const before = Math.abs(gaps.tonal.get(region.id)!);
      const now = Math.abs(after.tonal.get(region.id)!);
      // Every region counts: a cut that fixes the low-mids but hollows out the mids is paid for there.
      benefit += (before - now) * (region.id === regionId && measure === "tonal" ? 0.4 : 0.15);
    }
    for (const region of WIDTH_REGIONS) {
      const before = Math.abs(gaps.width.get(region.id)!);
      const now = Math.abs(after.width.get(region.id)!);
      benefit += (before - now) * (region.id === regionId && measure === "width" ? 0.12 : 0.05);
    }
    const cost = candidate.changes.reduce((sum, change) => sum + changeCost(costCtx, change, change.current ?? undefined), 0);
    const target = measure === "tonal" ? gaps.tonal.get(regionId)! : gaps.width.get(regionId)!;
    const left = measure === "tonal" ? after.tonal.get(regionId)! : after.width.get(regionId)!;
    const removed = Math.abs(target) > 0 ? Math.max(0, (Math.abs(target) - Math.abs(left)) / Math.abs(target)) : 0;
    return { ...candidate, gapsAfter: after.tonal, widthAfter: after.width, benefit: round2(benefit), cost: round2(cost), net: round2(benefit - cost), removed: round2(removed) };
  };

  /**
   * A move sized from a stem's share undershoots (the shape is levelled, and a bell covers part of a region), so a
   * candidate is sized once more from what the model says it did, inside the same limits.
   */
  const resized = (first: Scored, remaining: number, regionId: string): Scored => {
    const achieved = remaining - first.gapsAfter.get(regionId)!;
    const wanted = remaining * limits.close;
    if (Math.abs(achieved) < 0.05 || Math.abs(achieved) >= Math.abs(wanted) * 0.8) return first;
    const factor = Math.min(2.5, wanted / achieved);
    const changes = first.changes.map((change) => {
      if (change.processing.type === "eq") {
        const saved = change.replacesNodeId ? (trackEqNodes(document, change.trackId).find((node) => node.id === change.replacesNodeId)?.filter.gainDb ?? 0) : 0;
        const move = (change.processing.filter.gainDb - saved) * factor;
        const gainDb = Math.round(Math.max(-12, Math.min(6, saved + Math.max(-limits.maxCut, Math.min(limits.maxBoost, move)))) * 10) / 10;
        return { ...change, processing: { type: "eq" as const, filter: { ...change.processing.filter, gainDb } } };
      }
      if (change.processing.type === "gain") {
        const deltaDb = Math.round(Math.max(-3, Math.min(2, change.processing.deltaDb * factor)) * 10) / 10;
        return { ...change, processing: { type: "gain" as const, gainDb: round2(change.processing.gainDb - change.processing.deltaDb + deltaDb), deltaDb } };
      }
      return change;
    });
    if (JSON.stringify(changes) === JSON.stringify(first.changes)) return first;
    const second = score({ label: first.label, changes }, predict(chosen), regionId, "tonal");
    return second.net > first.net ? { ...second, label: relabel(second, names) } : first;
  };

  // Tonal regions: excess first, then shortfall, largest gap first within each.
  // Too much first (a cut), then too little: cutting what is in excess is the gentler move, and on a levelled shape
  // it also lifts the regions that are short, so a boost is often no longer needed.
  const tonalOrder = [...comparison.tonal].filter((gap) => Math.abs(gap.gapDb) >= limits.tonalThreshold).sort((left, right) => Number(right.gapDb > 0) - Number(left.gapDb > 0) || Math.abs(right.gapDb) - Math.abs(left.gapDb));
  for (const gap of tonalOrder) {
    if (chosen.length >= limits.maxChanges || excluded.has("eq")) break;
    const regionIndex = REFERENCE_REGIONS.findIndex((region) => region.id === gap.region.id);
    const current = predict(chosen);
    const remaining = current.tonal.get(gap.region.id)!;
    const problemId = `reference:tonal:${gap.region.id}`;
    const regionTotal = [...base.regionPower.values()].reduce((sum, powers) => sum + powers[regionIndex]!, 0);
    const contributors = [...base.regionPower.entries()]
      .map(([trackId, powers]) => ({ trackId, share: regionTotal > 0 ? powers[regionIndex]! / regionTotal : 0 }))
      .filter((item) => eligible(item.trackId) && item.share >= 0.12)
      .sort((left, right) => right.share - left.share)
      .slice(0, 3);
    const candidates: Candidate[] = [];
    if (Math.abs(remaining) >= limits.tonalThreshold * 0.6) {
      const target = -remaining * limits.close;
      for (const contributor of contributors.slice(0, 2)) {
        const raw = stemMoveFor(target, contributor.share);
        const gainDb = raw === null ? -limits.maxCut : Math.round(Math.max(-limits.maxCut, Math.min(limits.maxBoost, raw)) * 10) / 10;
        if (Math.abs(gainDb) < 0.5) continue;
        const { filter, replacesNodeId } = regionFilter(document, contributor.trackId, gap.region, gainDb);
        candidates.push({ label: `${names(contributor.trackId)} EQ ${describeChange({ type: "eq", filter }, names).toLowerCase()}`, changes: [{ id: `ref-eq-${gap.region.id}-${contributor.trackId}`, trackId: contributor.trackId, scope: { type: "global" }, processing: { type: "eq", filter }, replacesNodeId, reasons: [reasonFor(gap, contributor.share, names(contributor.trackId), input.referenceName)], domain: "eq", share: contributor.share, current: null }] });
      }
      if (contributors.length >= 2) {
        const pair = contributors.slice(0, 2);
        const both = pair.reduce((sum, item) => sum + item.share, 0);
        const raw = stemMoveFor(target, both);
        const gainDb = raw === null ? -limits.maxCut : Math.round(Math.max(-limits.maxCut, Math.min(limits.maxBoost, raw)) * 10) / 10;
        if (Math.abs(gainDb) >= 0.5) {
          candidates.push({
            label: `${pair.map((item) => names(item.trackId)).join(" and ")} EQ ${signed(gainDb)} dB in the ${gap.region.label}`,
            changes: pair.map((item) => {
              const { filter, replacesNodeId } = regionFilter(document, item.trackId, gap.region, gainDb);
              return { id: `ref-eq-${gap.region.id}-${item.trackId}`, trackId: item.trackId, scope: { type: "global" as const }, processing: { type: "eq" as const, filter }, replacesNodeId, reasons: [reasonFor(gap, item.share, names(item.trackId), input.referenceName)], domain: "eq" as const, share: item.share, current: null };
            }),
          });
        }
      }
      // A fader move only on a stem that lives in this region.
      if (!excluded.has("gain")) {
        for (const contributor of contributors.slice(0, 1)) {
          const own = base.regionPower.get(contributor.trackId)!;
          const ownTotal = own.reduce((sum, value) => sum + value, 0);
          if (ownTotal <= 0 || own[regionIndex]! / ownTotal < 0.6) continue;
          const raw = stemMoveFor(target, contributor.share);
          const deltaDb = raw === null ? -3 : Math.round(Math.max(-3, Math.min(2, raw)) * 10) / 10;
          if (Math.abs(deltaDb) < 0.5) continue;
          const track = document.tracks.find((item) => item.id === contributor.trackId)!;
          candidates.push({ label: `${names(contributor.trackId)} ${signed(deltaDb)} dB`, changes: [{ id: `ref-gain-${gap.region.id}-${contributor.trackId}`, trackId: contributor.trackId, scope: { type: "global" }, processing: { type: "gain", gainDb: round2(track.gainDb + deltaDb), deltaDb }, replacesNodeId: null, reasons: [reasonFor(gap, contributor.share, names(contributor.trackId), input.referenceName)], domain: "gain", share: contributor.share, current: null }] });
        }
      }
    }
    const scored = candidates.map((candidate) => resized(score(candidate, current, gap.region.id, "tonal"), remaining, gap.region.id)).sort((left, right) => right.net - left.net);
    input.trace?.(`tonal ${gap.region.id}: measured ${gap.gapDb}, now ${remaining}; contributors ${contributors.map((item) => `${names(item.trackId)} ${Math.round(item.share * 100)}%`).join(", ")}`);
    for (const item of scored) input.trace?.(`  ${item.label}: removed ${item.removed}, benefit ${item.benefit}, cost ${item.cost}, net ${item.net}; after ${[...item.gapsAfter.entries()].map(([id, value]) => `${id} ${value}`).join(" ")}`);
    const best = scored.find((item) => item.net > 0.02 && item.removed >= 0.25 && chosen.length + item.changes.length <= limits.maxChanges) ?? null;
    if (best) for (const change of best.changes) chosen.push({ ...change, problemId });
    const afterGap = best ? best.gapsAfter.get(gap.region.id)! : remaining;
    problems.push(problemFor(problemId, "reference-tonal", gap.region, gap.gapDb, afterGap, limits.tonalThreshold, contributors.map((item) => item.trackId), best, input.referenceName, `${signed(gap.gapDb)} dB in the ${gap.region.label}: ${gap.gapDb > 0 ? gap.region.more : gap.region.less} than the reference.`));
    interventions.push(...interventionsFor(problemId, scored, best, names));
  }

  // Width regions (150 Hz and up), largest gap first; the low end is reported as mono-ness only.
  const widthOrder = [...comparison.width].filter((gap) => Math.abs(gap.gapDb) >= limits.widthThreshold).sort((left, right) => Math.abs(right.gapDb) - Math.abs(left.gapDb));
  for (const gap of widthOrder) {
    if (chosen.length >= limits.maxChanges || excluded.has("space")) break;
    const index = WIDTH_REGIONS.findIndex((region) => region.id === gap.region.id);
    const current = predict(chosen);
    const remaining = current.width.get(gap.region.id)!;
    const problemId = `reference:width:${gap.region.id}`;
    const sideTotal = [...base.sidePower.values()].reduce((sum, powers) => sum + powers[index]!, 0);
    const contributors = [...base.sidePower.entries()]
      .map(([trackId, powers]) => ({ trackId, share: sideTotal > 0 ? powers[index]! / sideTotal : 0 }))
      .filter((item) => {
        const track = document.tracks.find((entry) => entry.id === item.trackId);
        return track && eligible(item.trackId) && !isMonoTrack(track) && item.share >= 0.15;
      })
      .sort((left, right) => right.share - left.share)
      .slice(0, 2);
    const candidates: Candidate[] = [];
    if (Math.abs(remaining) >= limits.widthThreshold * 0.6) {
      for (const contributor of contributors) {
        const track = document.tracks.find((entry) => entry.id === contributor.trackId)!;
        // Side power scales with width squared; aim for the share of the gap the strength closes.
        const factor = stemMoveFor(-remaining * limits.close, contributor.share);
        let width = factor === null ? track.width - limits.maxWidthChange : track.width * Math.sqrt(10 ** (factor / 10));
        width = Math.round(Math.max(track.width - limits.maxWidthChange, Math.min(track.width + limits.maxWidthChange, Math.min(1.6, Math.max(0.3, width)))) * 100) / 100;
        if (Math.abs(width - track.width) < 0.05) continue;
        candidates.push({ label: `${names(contributor.trackId)} width ${Math.round(track.width * 100)}% → ${Math.round(width * 100)}%`, changes: [{ id: `ref-width-${gap.region.id}-${contributor.trackId}`, trackId: contributor.trackId, scope: { type: "global" }, processing: { type: "spatial", pan: null, width }, replacesNodeId: null, reasons: [`The reference is ${gap.gapDb > 0 ? "narrower" : "wider"} in the ${gap.region.label} (sides ${signed(gap.gapDb)} dB against the center); ${names(contributor.trackId)} carries ${Math.round(contributor.share * 100)}% of the mix's sides there.`], domain: "space", share: contributor.share, current: { pan: track.pan, width: track.width } }] });
      }
    }
    const scored = candidates.map((candidate) => score(candidate, current, gap.region.id, "width")).sort((left, right) => right.net - left.net);
    const best = scored.find((item) => item.net > 0.01 && item.removed >= 0.2 && chosen.length + item.changes.length <= limits.maxChanges) ?? null;
    if (best) for (const change of best.changes) chosen.push({ ...change, problemId });
    const afterGap = best ? best.widthAfter.get(gap.region.id)! : remaining;
    problems.push(problemFor(problemId, "reference-width", gap.region, gap.gapDb, afterGap, limits.widthThreshold, contributors.map((item) => item.trackId), best, input.referenceName, `${gap.gapDb > 0 ? "Wider" : "Narrower"} than the reference in the ${gap.region.label} (sides ${signed(gap.gapDb)} dB).`));
    interventions.push(...interventionsFor(problemId, scored, best, names));
  }

  const final = predict(chosen);
  const changes: MixChange[] = chosen.map((change) => {
    const measure = change.domain === "space" ? "width" : "tonal";
    const regionId = change.problemId.split(":")[2]! as ReferenceRegion["id"];
    const region = REFERENCE_REGIONS.find((item) => item.id === regionId)!;
    const before = measure === "tonal" ? measuredGap.get(regionId)! : measuredWidth.get(regionId)!;
    const after = measure === "tonal" ? final.tonal.get(regionId)! : final.width.get(regionId)!;
    const cost = changeCost(costCtx, change, change.current ?? undefined);
    const boost = change.processing.type === "eq" && change.processing.filter.kind !== "high-pass" && change.processing.filter.kind !== "low-pass" ? Math.max(0, change.processing.filter.gainDb) : 0;
    const level = change.processing.type === "gain" ? change.processing.deltaDb : 0;
    return {
      id: change.id,
      problemIds: [change.problemId],
      trackId: change.trackId,
      scope: change.scope,
      domain: change.domain,
      source: "reference",
      processing: change.processing,
      planned: change.processing,
      replacesNodeId: change.replacesNodeId,
      current: currentWords(document, change),
      cost,
      confidence: 0.7,
      confidenceLabel: "medium",
      status: "proposed",
      edited: false,
      reasons: change.reasons,
      warnings: [],
      evaluation: {
        summary: `The ${region.label} gap ${signed(before)} → ${signed(after)} dB against the reference (predicted; checked again on the rendered candidate).`,
        reduction: Math.abs(before) > 0 ? round2(Math.max(0, Math.min(1, (Math.abs(before) - Math.abs(after)) / Math.abs(before)))) : 0,
        levelChangeDb: level,
        peakChangeDb: round2(Math.max(0, level) + boost * 0.5),
        reductionMaxDb: 0,
        outsideChangeDb: null,
        collateral: 0,
        eq: null,
        space: null,
        dynamics: null,
      },
      evidence: { kind: "reference", measure, region: region.label, share: round2(Math.min(1, change.share)), gapBeforeDb: before, gapAfterDb: after, current: change.current },
    };
  });

  const score0 = (map: Map<string, number>, threshold: number) => [...map.values()].reduce((sum, value) => sum + Math.max(0, Math.abs(value) - threshold * 0.5), 0);
  const metrics = (tonal: Map<string, number>, width: Map<string, number>, count: number, cost: number): CandidateMetrics => ({
    problemScore: round2(score0(tonal, limits.tonalThreshold) + 0.5 * score0(width, limits.widthThreshold)),
    openProblems: [...tonal.values()].filter((value) => Math.abs(value) >= limits.tonalThreshold).length + [...width.values()].filter((value) => Math.abs(value) >= limits.widthThreshold).length,
    estimatedPeakDbfs: null,
    loudnessDb: null,
    correlation: null,
    monoLossDb: null,
    centerLoad: null,
    maxReductionDb: 0,
    maxSideShiftDb: 0,
    processingCost: round2(cost),
    changeCount: count,
  });
  const totalCost = changes.reduce((sum, change) => sum + change.cost, 0);
  const regions = comparison.tonal.map((gap) => ({ id: gap.region.id, label: gap.region.label, lowHz: gap.region.lowHz, highHz: gap.region.highHz, gapBeforeDb: gap.gapDb, gapAfterDb: final.tonal.get(gap.region.id)! }));
  const width = comparison.width.map((gap) => ({ id: gap.region.id, label: gap.region.label, gapBeforeDb: gap.gapDb, gapAfterDb: final.width.get(gap.region.id)! }));
  const notes = comparison.findings.filter((line) => line.includes("louder") || line.includes("quieter") || line.includes("peak-to-loudness") || line.includes("mono"));
  const processing = { gain: 0, eq: 0, space: 0, compressor: 0, ducking: 0, transient: 0, dynamicEq: 0, trim: 0 };
  for (const change of changes) processing[change.processing.type === "eq" ? "eq" : change.processing.type === "spatial" ? "space" : "gain"] += 1;
  const largest = regions.filter((region) => Math.abs(region.gapBeforeDb) >= limits.tonalThreshold).sort((a, b) => Math.abs(b.gapBeforeDb) - Math.abs(a.gapBeforeDb))[0];
  const headline =
    changes.length === 0
      ? problems.length === 0
        ? `Your mix's tonal balance and width are within ${limits.tonalThreshold} dB of “${input.referenceName}” everywhere; no stem change is needed. ${notes[0] ?? ""}`.trim()
        : `The gaps from “${input.referenceName}” are measured, but no stem change closes enough of them for its cost at ${strength} strength.`
      : `Toward “${input.referenceName}”: ${changes.length} ${changes.length === 1 ? "change" : "changes"}${largest ? `; the ${largest.label} gap ${signed(largest.gapBeforeDb)} → ${signed(largest.gapAfterDb)} dB` : ""} (predicted; the rendered candidate is measured again).`;
  const settings = { strength, goal: "balanced" as const };
  const plan: FullMixPlan = {
    planVersion: FULL_MIX_PLAN_VERSION,
    plannerVersion: FULL_MIX_PLANNER_VERSION,
    kind: "full-mix",
    createdAt: now,
    projectId: document.project.id,
    sourceAnalysisVersion: "reference-1",
    settings,
    reference: { name: input.referenceName.slice(0, 120), regions, width, loudness: { mixLufs: comparison.loudness.mixLufs, referenceLufs: comparison.loudness.referenceLufs, mixPlrDb: comparison.dynamics.mixPlrDb, referencePlrDb: comparison.dynamics.referencePlrDb, mixLraLu: comparison.dynamics.mixLraLu, referenceLraLu: comparison.dynamics.referenceLraLu }, notes: notes.slice(0, 8) },
    ...(constraints ? { constraints } : {}),
    stateIdentity: fullMixStateIdentity(document, settings, input.fingerprints ?? [], constraints),
    summary: {
      headline: headline.slice(0, 300),
      lines: [`Planned toward a reference song, measured on the body of both songs with loudness removed. A reference is a direction: the plan closes at most ${Math.round(limits.close * 100)}% of a gap.`],
      notes: notes.slice(0, 12),
      confidence: 0.7,
      confidenceLabel: "medium",
      problemCount: problems.length,
      changeCount: changes.length,
      rejectedCount: interventions.filter((item) => item.outcome === "rejected").length,
      reviewCount: 0,
      processing,
      costLabel: costLabel(totalCost),
    },
    problems: problems.slice(0, 64),
    interventions: interventions.slice(0, 256),
    changes,
    evaluation: {
      method: "re-measured",
      before: metrics(measuredGap, measuredWidth, 0, 0),
      after: metrics(final.tonal, final.width, changes.length, totalCost),
      candidates: [],
      passes: [{ pass: 1, problems: problems.length, selected: changes.length, scoreBefore: 0, scoreAfter: 0, kept: changes.length > 0, note: "One pass toward the reference, region by region, largest gap first." }],
      stopReason: changes.length >= limits.maxChanges ? "The strength's change limit was reached." : "Every gap past the threshold was weighed.",
      regressions: regressionsOf(regions, width, limits),
      independent: { level: 0, eq: 0, space: 0, dynamics: 0, total: 0 },
      surveys: 0,
    },
    candidateTrim: { gainDb: 0, reason: null, renderedDb: null },
    levels: document.tracks.map((track) => ({ trackId: track.id, loudnessDb: input.measurements[track.id]?.levels.integratedLufs ?? input.measurements[track.id]?.levels.rmsDbfs ?? null, peakDbfs: input.measurements[track.id]?.levels.peakDbfs ?? null, gainDb: track.gainDb, muted: track.muted })),
  };
  return refreshFullMix(plan);
}

function relabel(candidate: Candidate, names: (id: string) => string): string {
  return candidate.changes.map((change) => `${names(change.trackId)} ${describeChange(change.processing, names, change.current ?? undefined).toLowerCase()}`).join(" + ");
}

function reasonFor(gap: TonalGap, share: number, name: string, reference: string): string {
  return `The mix has ${signed(gap.gapDb)} dB in the ${gap.region.label} against “${reference}” (${gap.gapDb > 0 ? gap.region.more : gap.region.less}); ${name} carries ${Math.round(share * 100)}% of the mix there.`;
}

function currentWords(document: ProjectDocument, change: ChangeCore & { current: { pan: number; width: number } | null }): string {
  const track = document.tracks.find((item) => item.id === change.trackId);
  if (!track) return "";
  if (change.processing.type === "gain") return `${track.gainDb.toFixed(1)} dB`;
  if (change.processing.type === "spatial") return `width ${Math.round(track.width * 100)}%`;
  if (change.replacesNodeId) {
    const node = trackEqNodes(document, track.id).find((item) => item.id === change.replacesNodeId);
    if (node) return `${node.filter.gainDb >= 0 ? "+" : ""}${node.filter.gainDb.toFixed(1)} dB at ${Math.round(node.filter.frequencyHz)} Hz`;
  }
  return "no EQ here";
}

function problemFor(id: string, type: "reference-tonal" | "reference-width", region: ReferenceRegion, before: number, after: number, threshold: number, trackIds: string[], best: Scored | null, reference: string, title: string): MixProblem {
  const severity = (gap: number) => round2(Math.min(1, Math.abs(gap) / (threshold * 3)));
  const outcome = !best ? "left-alone" : Math.abs(after) < threshold ? "solved" : Math.abs(after) < Math.abs(before) - 0.2 ? "improved" : "unchanged";
  return {
    id,
    type,
    title: title.slice(0, 160),
    scope: { type: "global" },
    sectionIds: [],
    trackIds: trackIds.slice(0, 8),
    protectedTrackId: null,
    yieldingTrackId: trackIds[0] ?? null,
    severity: severity(before),
    confidence: 0.7,
    group: type === "reference-tonal" ? 2 : 4,
    references: [],
    evidence: [{ source: "reference", label: region.label, detail: `Mix minus “${reference}”, both measured over the body of the song with loudness removed: ${signed(before)} dB.`.slice(0, 600), value: before, unit: "dB" }],
    severityAfter: severity(after),
    outcome,
    interventionId: best ? `${id}:${fnv1a(best.label)}` : null,
    explanation: (best ? `${best.label}: predicted ${signed(before)} → ${signed(after)} dB.` : trackIds.length === 0 ? "No stem that may change carries enough of this region." : "No change closed enough of this gap for its cost; left as it is.").slice(0, 800),
    pass: 1,
  };
}

function interventionsFor(problemId: string, scored: Scored[], best: Scored | null, names: (id: string) => string): MixIntervention[] {
  return scored.slice(0, 4).map((item) => ({
    id: `${problemId}:${fnv1a(item.label)}`,
    problemIds: [problemId],
    label: item.label.slice(0, 240),
    kind: item.changes.length > 1 ? ("combined" as const) : ("single" as const),
    items: item.changes.slice(0, 4).map((change) => ({ trackId: change.trackId, domain: change.domain, description: describeChange(change.processing, names, change.current ?? undefined).slice(0, 200) })),
    changeIds: item === best ? item.changes.map((change) => change.id) : [],
    cost: item.cost,
    confidence: 0.7,
    expectedReduction: Math.min(1, item.removed),
    net: item.net,
    outcome: item === best ? ("selected" as const) : ("rejected" as const),
    reason: (item === best ? `Closes about ${Math.round(item.removed * 100)}% of the gap for cost ${item.cost.toFixed(2)}.` : `Rejected: ${item.removed < 0.25 ? `closes only ${Math.round(item.removed * 100)}%` : "a better net result was available"} (net ${item.net.toFixed(2)}).`).slice(0, 600),
  }));
}

function regressionsOf(regions: Array<{ label: string; gapBeforeDb: number; gapAfterDb: number }>, width: Array<{ label: string; gapBeforeDb: number; gapAfterDb: number }>, limits: Limits): FullMixPlan["evaluation"]["regressions"] {
  const out: FullMixPlan["evaluation"]["regressions"] = [];
  for (const region of regions) {
    if (Math.abs(region.gapAfterDb) > Math.abs(region.gapBeforeDb) + 0.75 && Math.abs(region.gapAfterDb) >= limits.tonalThreshold) out.push({ kind: "problem", trackIds: [], description: `The ${region.label} moves away from the reference (${signed(region.gapBeforeDb)} → ${signed(region.gapAfterDb)} dB) as a side effect.`, resolution: "reported" });
  }
  for (const region of width) {
    if (Math.abs(region.gapAfterDb) > Math.abs(region.gapBeforeDb) + 1.5 && Math.abs(region.gapAfterDb) >= limits.widthThreshold) out.push({ kind: "problem", trackIds: [], description: `Width in the ${region.label} moves away from the reference as a side effect.`, resolution: "reported" });
  }
  return out.slice(0, 24);
}
