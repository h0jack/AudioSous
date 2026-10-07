/**
 * Writes the engine settings of a project's saved mix, and of the same stems untouched (every fader at 0 dB, centered,
 * no EQ, space, or dynamics), for `compare_mix`:
 *
 *   npx vite-node apps/desktop/scripts/mix-variants.ts -- PROJECT_DIR OUT.json
 *   cargo run --release -p audiosous-audio --example compare_mix -- OUT.json [EXPORTED_FILE]
 *
 * The saved mix is exactly what Play plays and what Export renders (`engineVariant`, the same function both use).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deserializeProject, type ProjectDocument } from "@audiosous/project-model";
import { engineVariant } from "../src/lib/full-mix";

const [dirArg, outArg] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!dirArg || !outArg) throw new Error("Pass a project folder and an output path.");
const dir = resolve(dirArg);
const saved = deserializeProject(readFileSync(join(dir, "project.amix"), "utf8"));
const untouched: ProjectDocument = {
  ...saved,
  tracks: saved.tracks.map((track) => ({ ...track, gainDb: 0, pan: 0, width: 1, muted: false, solo: false, processing: { ...track.processing, nodes: [], dynamics: [] } })),
  sectionTrackSettings: [],
};
writeFileSync(
  resolve(outArg),
  JSON.stringify(
    {
      project: dir,
      durationSeconds: saved.project.durationSeconds,
      projectRate: saved.project.sampleRate,
      sources: saved.tracks.map((track) => ({ trackId: track.id, path: join(dir, track.file.relativePath) })),
      variants: { untouched: engineVariant("untouched", untouched), saved: engineVariant("saved", saved) },
    },
    null,
    2,
  ),
);
console.log(`Wrote ${outArg}: ${saved.tracks.length} stems, ${saved.project.durationSeconds.toFixed(1)} s at ${saved.project.sampleRate} Hz`);
