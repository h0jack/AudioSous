import { describe, expect, it } from "vitest";
import { createProject, updateTrack, withUpdatedAt } from "./create-project";
import { ProjectFileError } from "./errors";
import { buildImportReport } from "./import-report";
import { applyMigrations, deserializeProject, serializeProject } from "./migrate";
import { mediaRelativePath } from "./paths";
import { guessTrackRole, trackNameFromFilename } from "./roles";
import { formatClock } from "./format";
import { projectDocumentSchema, type ProjectDocument } from "./schema";

const NOW = new Date("2026-10-03T14:00:00.000Z");

function stem(overrides?: Partial<Parameters<typeof createProject>[0]["tracks"][number]>) {
  return {
    id: "track-kick",
    name: "Kick Main",
    role: "kick" as const,
    filename: "kick_main.wav",
    relativePath: "media/track-kick__kick_main.wav",
    metadata: {
      format: "wav" as const,
      sampleRate: 48_000,
      channelCount: 2,
      bitDepth: 24,
      durationSeconds: 241.72,
      fileSizeBytes: 40_000_000,
    },
    ...overrides,
  };
}

function project(tracks = [stem()]): ProjectDocument {
  return createProject({
    id: "project-night",
    name: "Night Drive",
    tracks,
    now: NOW,
    originalVariantId: "variant-original",
    workingVariantId: "variant-working",
  });
}

describe("project file", () => {
  it("creates a versioned project and round-trips it", () => {
    const document = project([
      stem(),
      stem({
        id: "track-brass",
        name: "Jp8 Brass Hook",
        role: "brass",
        filename: "jp8_brass_hook.wav",
        relativePath: "media/track-brass__jp8_brass_hook.wav",
      }),
    ]);

    expect(document.schemaVersion).toBe(1);
    expect(document.project.sampleRate).toBe(48_000);
    expect(document.project.durationSeconds).toBe(241.72);
    expect(document.mixVariants.map((variant) => variant.name)).toEqual(["Original", "Working Mix"]);
    expect(document.activeMixVariantId).toBe("variant-working");
    expect(document.comparison.scope).toBe("entire-mix");
    expect(document.tracks[0]?.gainDb).toBe(0);
    expect(document.tracks[0]?.pan).toBe(0);

    const text = serializeProject(document);
    expect(text).not.toMatch(/\/(home|Users|tmp)\//);
    expect(deserializeProject(text)).toEqual(document);
  });

  it("rejects a newer schema and invalid JSON", () => {
    expect(() => deserializeProject("{")).toThrow(ProjectFileError);
    expect(() => deserializeProject(JSON.stringify({ schemaVersion: 2 }))).toThrow(ProjectFileError);
    try {
      deserializeProject(JSON.stringify({ schemaVersion: 2 }));
    } catch (error) {
      expect(error).toMatchObject({ code: "unsupported-schema" });
    }
    try {
      deserializeProject(JSON.stringify({ project: {} }));
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid-document" });
    }
  });

  it("rejects overlapping, unordered, and zero-length sections", () => {
    const document = project();
    document.sections = [
      {
        id: "section-drop",
        name: "Drop",
        type: "drop",
        startTime: 10,
        endTime: 10,
        userIntent: null,
        source: "manual",
        confidence: null,
        structuralGroupId: null,
      },
    ];
    expect(projectDocumentSchema.safeParse(document).success).toBe(false);

    document.sections[0]!.endTime = 20;
    document.sections.push({
      ...document.sections[0]!,
      id: "section-build",
      name: "Build",
      startTime: 0,
      endTime: 10,
    });
    expect(projectDocumentSchema.safeParse(document).success).toBe(false);

    document.sections = [
      { ...document.sections[1]!, startTime: 0, endTime: 10 },
      { ...document.sections[0]!, id: "section-drop", startTime: 10, endTime: 20 },
    ];
    expect(projectDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("rejects media paths that leave the project folder", () => {
    const document = project();
    document.tracks[0]!.file.relativePath = "media/../secret.wav";
    expect(projectDocumentSchema.safeParse(document).success).toBe(false);
    document.tracks[0]!.file.relativePath = "/tmp/kick.wav";
    expect(projectDocumentSchema.safeParse(document).success).toBe(false);
    expect(mediaRelativePath("track-1", "../secret.wav")).toBe("media/track-1__secret.wav");
    expect(mediaRelativePath("track-1", "C:\\stems\\kick.wav")).toBe("media/track-1__kick.wav");
  });

  it("keeps gain and pan inside the persisted range", () => {
    const document = project();
    document.tracks[0]!.gainDb = 12.5;
    expect(projectDocumentSchema.safeParse(document).success).toBe(false);
    document.tracks[0]!.gainDb = -96;
    document.tracks[0]!.pan = -1;
    expect(projectDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("updates a track without touching the source path", () => {
    const document = project();
    const next = updateTrack(withUpdatedAt(document, new Date("2026-10-03T15:00:00.000Z")), "track-kick", {
      name: "Kick",
      role: "drums",
    });
    expect(next.tracks[0]?.role).toBe("drums");
    expect(next.tracks[0]?.file.relativePath).toBe(document.tracks[0]?.file.relativePath);
    expect(next.project.updatedAt).not.toBe(document.project.updatedAt);
  });
});

describe("migrations", () => {
  it("applies a chain and stops on a missing step", () => {
    const migrations = [
      {
        fromVersion: 1,
        toVersion: 2,
        migrate: (document: unknown) => ({ ...(document as object), schemaVersion: 2, note: "v2" }),
      },
      {
        fromVersion: 2,
        toVersion: 3,
        migrate: (document: unknown) => ({ ...(document as object), schemaVersion: 3 }),
      },
    ];
    const migrated = applyMigrations({ schemaVersion: 1 }, migrations, 3) as { schemaVersion: number; note: string };
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.note).toBe("v2");
    expect(() => applyMigrations({ schemaVersion: 1 }, [], 2)).toThrow(ProjectFileError);
    expect(applyMigrations({ schemaVersion: 1, keep: true }, [], 1)).toEqual({ schemaVersion: 1, keep: true });
  });
});

describe("roles and import warnings", () => {
  it("guesses roles from filenames", () => {
    expect(guessTrackRole("kick_main.wav")).toBe("kick");
    expect(guessTrackRole("sub_bass.wav")).toBe("bass");
    expect(guessTrackRole("vox_chorus.wav")).toBe("vocal");
    expect(guessTrackRole("brass-hook.wav")).toBe("brass");
    expect(guessTrackRole("synth-pad.wav")).toBe("pad");
    expect(guessTrackRole("backing_vox.wav")).toBe("backing-vocal");
    expect(guessTrackRole("hi-hat.wav")).toBe("hi-hat");
    expect(guessTrackRole("room-tone.wav")).toBe("other");
    expect(trackNameFromFilename("jp8_brass_hook.wav")).toBe("Jp8 Brass Hook");
  });

  it("warns without rejecting mismatched stems", () => {
    const report = buildImportReport([
      {
        ok: true,
        filename: "kick.wav",
        format: "wav",
        sampleRate: 48_000,
        channelCount: 2,
        bitDepth: 24,
        durationSeconds: 240,
        fileSizeBytes: 10,
        truncated: false,
      },
      {
        ok: true,
        filename: "hats.wav",
        format: "wav",
        sampleRate: 44_100,
        channelCount: 1,
        bitDepth: 16,
        durationSeconds: 20,
        fileSizeBytes: 10,
        truncated: false,
      },
      {
        ok: false,
        filename: "loop.mp3",
        code: "unsupported",
        message: "MP3 stems are not supported.",
        fileSizeBytes: 10,
      },
    ]);

    expect(report.readableCount).toBe(2);
    expect(report.sampleRate).toBe(48_000);
    expect(report.warnings.map((warning) => warning.code)).toEqual([
      "duration-mismatch",
      "mixed-bit-depth",
      "mixed-channel-count",
      "sample-rate-mismatch",
      "unsupported-format",
    ]);
  });

  it("formats musical time", () => {
    expect(formatClock(241.72)).toBe("4:01.720");
    expect(formatClock(0)).toBe("0:00.000");
  });
});
