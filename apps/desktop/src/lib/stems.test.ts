import { describe, expect, it } from "vitest";
import { serializeProject } from "@audiosous/project-model";
import { demoStems, documentFromStems, pendingFromInspection } from "./stems";

describe("documentFromStems", () => {
  it("stores only bundle-relative copies and guessed roles", () => {
    let n = 0;
    const stems = demoStems().map((stem, index) => ({
      ...stem,
      sourcePath: index === 0 ? "/sessions/night/kick.wav" : `/sessions/night/${stem.filename}`,
    }));
    const { document, copies } = documentFromStems({
      name: "Night Drive",
      stems,
      now: new Date("2026-10-03T14:00:00.000Z"),
      createId: () => `track-${(n += 1)}`,
    });

    expect(document.tracks.map((track) => track.role)).toEqual(["kick", "bass", "brass", "pad", "percussion", "fx"]);
    expect(document.tracks.every((track) => track.file.relativePath.startsWith("media/"))).toBe(true);
    expect(copies).toHaveLength(6);
    expect(serializeProject(document)).not.toContain("/sessions/");
    expect(document.project.durationSeconds).toBe(241.72);
  });

  it("leaves unreadable files out of the project", () => {
    const broken = pendingFromInspection("loop.mp3", "/tmp/loop.mp3", {
      ok: false,
      code: "unsupported",
      message: "MP3 stems are not supported.",
      fileSizeBytes: 10,
    });
    expect(() => documentFromStems({ name: "Empty", stems: [broken] })).toThrow(/readable/);
  });
});
