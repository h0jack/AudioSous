export type ProjectErrorCode =
  | "invalid-json"
  | "invalid-document"
  | "unsupported-schema"
  | "missing-migration";

export class ProjectFileError extends Error {
  readonly code: ProjectErrorCode;

  constructor(message: string, code: ProjectErrorCode) {
    super(message);
    this.name = "ProjectFileError";
    this.code = code;
  }
}

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSafetyError";
  }
}
