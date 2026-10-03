export {
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  SCHEMA_VERSION,
  SECTION_TYPE_LABELS,
  SECTION_TYPES,
  TRACK_ROLE_IDS,
  TRACK_ROLE_LABELS,
  comparisonSchema,
  defaultUiState,
  emptyProcessingGraph,
  mixVariantSchema,
  processingGraphSchema,
  projectDocumentSchema,
  sectionSchema,
  trackSchema,
  trackSectionStateSchema,
  uiStateSchema,
} from "./schema";
export type {
  MixComparison,
  MixVariant,
  ProcessingGraph,
  ProjectDocument,
  SectionType,
  SongSection,
  Track,
  TrackRole,
  TrackSectionState,
  UiState,
} from "./schema";

export { PathSafetyError, ProjectFileError } from "./errors";
export type { ProjectErrorCode } from "./errors";

export { assertSafeRelativePath, mediaRelativePath, sanitizeBundleName, sanitizeFilename } from "./paths";

export { guessTrackRole, trackNameFromFilename } from "./roles";

export { channelLabel, formatBitDepth, formatBytes, formatClock, formatSampleRate } from "./format";

export { MIGRATIONS, applyMigrations, deserializeProject, migrateProject, readSchemaVersion, serializeProject } from "./migrate";
export type { SchemaMigration } from "./migrate";

export { createProject, projectTiming, updateTrack, withUpdatedAt } from "./create-project";
export { addManualSection, removeSection, updateSection } from "./sections";
export type { NewSectionInput, SectionEditResult } from "./sections";
export type { CreateProjectInput, NewTrackInput } from "./create-project";

export { buildImportReport } from "./import-report";
export type { ImportReport, ImportWarning, ImportWarningCode, ImportedStem } from "./import-report";
