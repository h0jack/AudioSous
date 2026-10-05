import { ZodError } from "zod";
import { ProjectFileError } from "./errors";
import { SCHEMA_VERSION, projectDocumentSchema, type ProjectDocument } from "./schema";

export interface SchemaMigration {
  fromVersion: number;
  toVersion: number;
  migrate: (document: unknown) => unknown;
}

/**
 * v1 → v2: tracks gain a track-wide processing graph, and processing nodes become typed EQ nodes.
 * Version 1 never wrote a processing node, so any v1 node is unreadable and is dropped rather than guessed.
 */
function migrateV1ToV2(document: unknown): unknown {
  const source = document as Record<string, unknown>;
  const empty = () => ({ schemaVersion: 1, nodes: [] });
  const tracks = Array.isArray(source.tracks)
    ? source.tracks.map((track) => (isRecord(track) ? { ...track, processing: empty() } : track))
    : source.tracks;
  const settings = Array.isArray(source.sectionTrackSettings)
    ? source.sectionTrackSettings.map((row) => (isRecord(row) ? { ...row, processing: empty() } : row))
    : source.sectionTrackSettings;
  return { ...source, schemaVersion: 2, tracks, sectionTrackSettings: settings };
}

/**
 * v2 → v3: tracks gain a stereo width (1 = as recorded) and Track × Section overrides gain a width override.
 * Pan and the section pan override keep their meaning, so nothing a v2 file stored changes how it sounds.
 */
function migrateV2ToV3(document: unknown): unknown {
  const source = document as Record<string, unknown>;
  const tracks = Array.isArray(source.tracks)
    ? source.tracks.map((track) => (isRecord(track) ? { ...track, width: 1 } : track))
    : source.tracks;
  const settings = Array.isArray(source.sectionTrackSettings)
    ? source.sectionTrackSettings.map((row) =>
        isRecord(row) && isRecord(row.overrides) ? { ...row, overrides: { ...row.overrides, width: null } } : row,
      )
    : source.sectionTrackSettings;
  return { ...source, schemaVersion: 3, tracks, sectionTrackSettings: settings };
}

/**
 * v3 → v4: every processing graph (track and Track × Section) becomes graph v2, which keeps its EQ nodes and gains
 * an empty list of dynamics processors. Nothing a v3 file stored changes how it sounds.
 */
function migrateV3ToV4(document: unknown): unknown {
  const source = document as Record<string, unknown>;
  const graph = (value: unknown) => {
    const nodes = isRecord(value) && Array.isArray(value.nodes) ? value.nodes : [];
    return { schemaVersion: 2, nodes, dynamics: [] };
  };
  const tracks = Array.isArray(source.tracks)
    ? source.tracks.map((track) => (isRecord(track) ? { ...track, processing: graph(track.processing) } : track))
    : source.tracks;
  const settings = Array.isArray(source.sectionTrackSettings)
    ? source.sectionTrackSettings.map((row) => (isRecord(row) ? { ...row, processing: graph(row.processing) } : row))
    : source.sectionTrackSettings;
  return { ...source, schemaVersion: 4, tracks, sectionTrackSettings: settings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const MIGRATIONS: readonly SchemaMigration[] = [
  { fromVersion: 1, toVersion: 2, migrate: migrateV1ToV2 },
  { fromVersion: 2, toVersion: 3, migrate: migrateV2ToV3 },
  { fromVersion: 3, toVersion: 4, migrate: migrateV3ToV4 },
];

export function readSchemaVersion(document: unknown): number {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new ProjectFileError("This project file is not a JSON object.", "invalid-document");
  }
  if (!("schemaVersion" in document)) {
    throw new ProjectFileError("This project file has no schemaVersion.", "invalid-document");
  }
  const version = document.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ProjectFileError("schemaVersion must be a positive integer.", "invalid-document");
  }
  return version;
}

export function applyMigrations(
  document: unknown,
  migrations: readonly SchemaMigration[],
  targetVersion: number,
): unknown {
  let current = document;
  let version = readSchemaVersion(current);
  if (version > targetVersion) {
    throw new ProjectFileError(
      `This project uses schema v${version}. Update Audiosous to open it.`,
      "unsupported-schema",
    );
  }

  while (version < targetVersion) {
    const step = migrations.find((migration) => migration.fromVersion === version);
    if (!step || step.toVersion <= version) {
      throw new ProjectFileError(`No migration is registered from schema v${version}.`, "missing-migration");
    }
    current = step.migrate(current);
    const next = readSchemaVersion(current);
    if (next !== step.toVersion) {
      throw new ProjectFileError(
        `The migration from v${version} did not produce schema v${step.toVersion}.`,
        "missing-migration",
      );
    }
    version = next;
  }

  return current;
}

export function migrateProject(document: unknown): ProjectDocument {
  const migrated = applyMigrations(document, MIGRATIONS, SCHEMA_VERSION);
  try {
    return projectDocumentSchema.parse(migrated);
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .slice(0, 6)
        .map((item) => `${item.path.join(".") || "project"}: ${item.message}`)
        .join(" ");
      throw new ProjectFileError(`This project file does not match schema v${SCHEMA_VERSION}. ${details}`, "invalid-document");
    }
    throw error;
  }
}

export function serializeProject(document: ProjectDocument): string {
  const parsed = projectDocumentSchema.parse(document);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function deserializeProject(text: string): ProjectDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProjectFileError("This file is not valid JSON.", "invalid-json");
  }
  return migrateProject(parsed);
}
