import { z } from "zod";

/**
 * Raw measurements from the analysis sidecar.
 * This schema describes what was measured. It does not interpret or recommend a mix.
 * schemaVersion changes when the JSON shape changes.
 * analysisVersion changes when a number would no longer be comparable with an older cache.
 */
export const ANALYSIS_SCHEMA_VERSION = 1;
export const ANALYSIS_ENGINE_VERSION = "0.2.0";

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

const finiteDbSchema = z.number().finite().min(-200).max(40).nullable();

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
    scope: z.object({
      type: z.literal("track"),
    }),
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
    bandEnergy: z.array(bandEnergySchema).length(FREQUENCY_BANDS.length),
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

export const analysisCacheEntrySchema = z.object({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  analysisVersion: z.literal(ANALYSIS_ENGINE_VERSION),
  identity: analysisFileIdentitySchema,
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

export function analysisCacheIsCurrent(entry: AnalysisCacheEntry, identity: AnalysisFileIdentity): boolean {
  return (
    entry.schemaVersion === ANALYSIS_SCHEMA_VERSION &&
    entry.analysisVersion === ANALYSIS_ENGINE_VERSION &&
    entry.measurement.analysisVersion === ANALYSIS_ENGINE_VERSION &&
    entry.identity.relativePath === identity.relativePath &&
    entry.identity.fileSizeBytes === identity.fileSizeBytes &&
    entry.identity.modifiedAtNs === identity.modifiedAtNs
  );
}
