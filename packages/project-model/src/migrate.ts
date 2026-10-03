import { ZodError } from "zod";
import { ProjectFileError } from "./errors";
import { SCHEMA_VERSION, projectDocumentSchema, type ProjectDocument } from "./schema";

export interface SchemaMigration {
  fromVersion: number;
  toVersion: number;
  migrate: (document: unknown) => unknown;
}

export const MIGRATIONS: readonly SchemaMigration[] = [];

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
