import { z } from "zod";

/**
 * Raw measurements from the analysis sidecar.
 * This schema describes what was measured. It does not interpret or recommend a mix.
 * schemaVersion changes when the JSON shape changes.
 * analysisVersion changes when a number would no longer be comparable with an older cache.
 */
export const ANALYSIS_SCHEMA_VERSION = 3;
export const ANALYSIS_ENGINE_VERSION = "0.4.0";

export const FREQUENCY_BANDS = [
  { id: "sub", name: "Sub", lowHz: 20, highHz: 60 },
  { id: "bass", name: "Bass", lowHz: 60, highHz: 120 },
  { id: "low-mid", name: "Low Mid", lowHz: 120, highHz: 250 },
  { id: "mid", name: "Mid", lowHz: 250, highHz: 500 },
  { id: "upper-mid", name: "Upper Mid", lowHz: 500, highHz: 2_000 },
  { id: "presence", name: "Presence", lowHz: 2_000, highHz: 5_000 },
  { id: "brilliance", name: "Brilliance", lowHz: 5_000, highHz: 10_000 },
  { id: "air", name: "Air", lowHz: 10_000, highHz: 20_000 },
] as const;

export type FrequencyBandId = (typeof FREQUENCY_BANDS)[number]["id"];

const bandIdSchema = z.enum(FREQUENCY_BANDS.map((band) => band.id) as [FrequencyBandId, ...FrequencyBandId[]]);

const finiteDbSchema = z.number().finite().min(-200).max(80).nullable();

export const measurementScopeSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("track") }),
    z.object({
      type: z.literal("section"),
      startSeconds: z.number().finite().nonnegative(),
      endSeconds: z.number().finite().positive(),
    }),
    z.object({
      type: z.literal("time-range"),
      startSeconds: z.number().finite().nonnegative(),
      endSeconds: z.number().finite().positive(),
    }),
    z.object({ type: z.literal("mix") }),
  ])
  .superRefine((scope, ctx) => {
    if ((scope.type === "section" || scope.type === "time-range") && scope.endSeconds <= scope.startSeconds) {
      ctx.addIssue({ code: "custom", path: ["endSeconds"], message: "A measurement window must have a duration." });
    }
  });

export type MeasurementScope = z.infer<typeof measurementScopeSchema>;

const spectrumPointSchema = z.object({
  hz: z.number().finite().positive(),
  magnitudeDb: z.number().finite().min(-200).max(40),
});

const timelinePointSchema = z.object({
  timeSeconds: z.number().finite().nonnegative(),
  rmsDbfs: finiteDbSchema,
});

const spectrogramColumnSchema = z.object({
  timeSeconds: z.number().finite().nonnegative(),
  magnitudesDb: z.array(z.number().finite().min(-200).max(40)).max(32),
});

export const spectrogramSchema = z
  .object({
    hopSeconds: z.number().finite().nonnegative(),
    lowHz: z.number().finite().positive(),
    highHz: z.number().finite().positive(),
    bandCount: z.number().int().min(1).max(32),
    columns: z.array(spectrogramColumnSchema).max(96),
  })
  .superRefine((image, ctx) => {
    if (image.highHz <= image.lowHz) {
      ctx.addIssue({ code: "custom", path: ["highHz"], message: "A spectrogram needs a frequency range." });
    }
    image.columns.forEach((column, index) => {
      if (column.magnitudesDb.length !== image.bandCount) {
        ctx.addIssue({
          code: "custom",
          path: ["columns", index, "magnitudesDb"],
          message: "Each spectrogram column must have one value per band.",
        });
      }
    });
  });

export const bandEnergySchema = z.object({
  id: bandIdSchema,
  name: z.string().min(1),
  lowHz: z.number().finite().nonnegative(),
  highHz: z.number().finite().positive(),
  normalizedEnergy: z.number().finite().min(0).max(1),
});

export type BandEnergy = z.infer<typeof bandEnergySchema>;

export const trackFileMeasurementSchema = z
  .object({
    schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
    analysisVersion: z.literal(ANALYSIS_ENGINE_VERSION),
    scope: measurementScopeSchema,
    source: z.object({
      sampleRate: z.number().int().positive().max(384_000),
      channelCount: z.number().int().positive().max(64),
      durationSeconds: z.number().finite().nonnegative(),
      frameCount: z.number().int().nonnegative(),
    }),
    levels: z.object({
      peakDbfs: finiteDbSchema,
      rmsDbfs: finiteDbSchema,
      integratedLufs: finiteDbSchema,
      crestFactorDb: z.number().finite().min(0).max(120).nullable(),
      integratedLufsStatus: z.enum(["measured", "silent", "too-short"]),
    }),
    stereo: z.object({
      balance: z.number().finite().min(-1).max(1).nullable(),
      correlation: z.number().finite().min(-1).max(1).nullable(),
      width: z.number().finite().min(0).max(1).nullable(),
      midRmsDbfs: finiteDbSchema,
      sideRmsDbfs: finiteDbSchema,
    }),
    dynamics: z.object({
      dynamicRangeDb: z.number().finite().min(0).max(120).nullable(),
      onsetDensityPerSecond: z.number().finite().nonnegative().max(10_000),
      activePercent: z.number().finite().min(0).max(100),
      silentPercent: z.number().finite().min(0).max(100),
    }),
    spectral: z.object({
      centroidHz: z.number().finite().positive().nullable(),
      bandwidthHz: z.number().finite().nonnegative().nullable(),
      rolloffHz: z.number().finite().positive().nullable(),
      flatness: z.number().finite().min(0).max(1).nullable(),
    }),
    bandEnergy: z.array(bandEnergySchema).length(FREQUENCY_BANDS.length),
    spectrum: z.array(spectrumPointSchema).max(64),
    loudnessTimeline: z.array(timelinePointSchema).max(200),
    spectrogram: spectrogramSchema,
  })
  .superRefine((measurement, ctx) => {
    measurement.bandEnergy.forEach((band, index) => {
      const expected = FREQUENCY_BANDS[index];
      if (!expected || band.id !== expected.id || band.lowHz !== expected.lowHz || band.highHz !== expected.highHz) {
        ctx.addIssue({
          code: "custom",
          path: ["bandEnergy", index],
          message: "Frequency bands must use the shared band model.",
        });
      }
    });
  });

export type TrackFileMeasurement = z.infer<typeof trackFileMeasurementSchema>;

export const analysisFileIdentitySchema = z.object({
  relativePath: z.string().min(1),
  fileSizeBytes: z.number().int().nonnegative(),
  modifiedAtNs: z.string().regex(/^\d+$/),
});

export type AnalysisFileIdentity = z.infer<typeof analysisFileIdentitySchema>;

export const analysisIdentitySchema = z.union([
  analysisFileIdentitySchema,
  z.object({
    files: z.array(analysisFileIdentitySchema).min(1).max(64),
  }),
]);

export type AnalysisIdentity = z.infer<typeof analysisIdentitySchema>;

export const analysisCacheEntrySchema = z.object({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  analysisVersion: z.literal(ANALYSIS_ENGINE_VERSION),
  identity: analysisIdentitySchema,
  scope: measurementScopeSchema,
  measuredAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), {
    message: "Expected a timestamp",
  }),
  measurement: trackFileMeasurementSchema,
});

export type AnalysisCacheEntry = z.infer<typeof analysisCacheEntrySchema>;

export function analysisCachePath(trackId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(trackId)) {
    throw new Error("Analysis cache must stay inside cache/analysis.");
  }
  return `cache/analysis/${trackId}.json`;
}

export function sectionAnalysisCacheName(trackId: string, sectionId: string): string {
  return analysisCacheName(`${trackId}__section-${sectionId}`);
}

export function rangeAnalysisCacheName(trackId: string): string {
  return analysisCacheName(`${trackId}__range`);
}

export function mixAnalysisCacheName(): string {
  return "mix";
}

export function analysisCacheIsCurrent(entry: AnalysisCacheEntry, identity: AnalysisIdentity, scope: MeasurementScope): boolean {
  return (
    entry.schemaVersion === ANALYSIS_SCHEMA_VERSION &&
    entry.analysisVersion === ANALYSIS_ENGINE_VERSION &&
    entry.measurement.analysisVersion === ANALYSIS_ENGINE_VERSION &&
    sameIdentity(entry.identity, identity) &&
    sameScope(entry.scope, scope)
  );
}

export function bandOverlap(left: BandEnergy[], right: BandEnergy[]): Array<{ id: FrequencyBandId; name: string; shared: number }> {
  return left.map((band, index) => ({
    id: band.id,
    name: band.name,
    shared: Math.min(band.normalizedEnergy, right[index]?.normalizedEnergy ?? 0),
  }));
}

export function levelDeltaDb(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return Math.round((left - right) * 100) / 100;
}

function analysisCacheName(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error("Analysis cache must stay inside cache/analysis.");
  }
  return name;
}

function sameIdentity(cached: AnalysisIdentity, identity: AnalysisIdentity): boolean {
  if ("files" in identity) {
    if (!("files" in cached) || cached.files.length !== identity.files.length) return false;
    return identity.files.every((file, index) => sameFile(cached.files[index], file));
  }
  if ("files" in cached) return false;
  return sameFile(cached, identity);
}

function sameFile(cached: AnalysisFileIdentity | undefined, identity: AnalysisFileIdentity): boolean {
  return (
    cached !== undefined &&
    cached.relativePath === identity.relativePath &&
    cached.fileSizeBytes === identity.fileSizeBytes &&
    cached.modifiedAtNs === identity.modifiedAtNs
  );
}

function sameScope(cached: MeasurementScope, scope: MeasurementScope): boolean {
  if (cached.type !== scope.type) return false;
  if (cached.type === "section" || cached.type === "time-range") {
    return scope.type === cached.type && cached.startSeconds === scope.startSeconds && cached.endSeconds === scope.endSeconds;
  }
  return true;
}
