export {
  EQ_FILTER_KINDS,
  EQ_FILTER_LABELS,
  EQ_LIMITS,
  MAX_SECTION_EQ_NODES,
  MAX_TRACK_EQ_NODES,
  eqFilterSchema,
  eqNodeSchema,
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  SCHEMA_VERSION,
  SPATIAL_LIMITS,
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
  EqFilter,
  EqFilterKind,
  EqNode,
  ProcessingNode,
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
export {
  eqChainAt,
  eqChainForSection,
  enabledFilters,
  isPassFilter,
  normalizeEqFilter,
  processingIdentity,
  roundFrequency,
  sectionEqNodes,
  setSectionEqNodes,
  setTrackEqNodes,
  trackEqNodes,
} from "./processing";
export {
  NEUTRAL_SPATIAL,
  hasSavedSpatial,
  isMonoTrack,
  normalizePan,
  normalizeWidth,
  sectionSpatialOverride,
  setSectionSpatial,
  setTrackSpatial,
  spatialAt,
  spatialForSection,
  spatialIdentity,
  trackSpatial,
} from "./spatial";
export type { SpatialSetting } from "./spatial";
export { sectionSettingInUse, addManualSection, applyAutomaticSections, clearSuggestedSections, mergeSectionWithNext, moveSectionBoundary, removeSection, sectionAtTime, setTrackSectionState, splitSection, updateSection } from "./sections";
export type { NewSectionInput, SectionEditResult, SuggestedSection } from "./sections";
export type { CreateProjectInput, NewTrackInput } from "./create-project";

export { buildImportReport } from "./import-report";
export type { ImportReport, ImportWarning, ImportWarningCode, ImportedStem } from "./import-report";
