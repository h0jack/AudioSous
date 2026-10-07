/**
 * Predicted against measured: the gaps to a reference before planning, as the plan predicted them, and as the
 * rendered candidate measures (`reference-project.ts`, then `profile_audio -- mix OUT.json candidate after.json`).
 *
 *   npx vite-node apps/desktop/scripts/reference-compare.ts -- mix.json after.json ref.json OUT.json
 */
import { readFileSync } from "node:fs";
import { compareToReference, songProfileSchema } from "@audiosous/mix-planner";
const [mixPath, candPath, refPath, outPath] = process.argv.slice(2).filter((arg) => arg !== "--");
const load = (path: string) => songProfileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
const ref = load(refPath!);
const before = compareToReference(load(mixPath!), ref);
const after = compareToReference(load(candPath!), ref);
const predicted = JSON.parse(readFileSync(outPath!, "utf8")).predicted as Record<string, number>;
console.log("region                    before   predicted   measured after");
for (const gap of before.tonal) {
  const measured = after.tonal.find((item) => item.region.id === gap.region.id)!.gapDb;
  console.log(`${gap.region.label.padEnd(24)} ${gap.gapDb.toFixed(2).padStart(7)} ${predicted[gap.region.id]!.toFixed(2).padStart(10)} ${measured.toFixed(2).padStart(14)}`);
}
for (const gap of before.width) console.log(`sides ${gap.region.label.padEnd(18)} ${gap.gapDb.toFixed(2).padStart(7)} ${"".padStart(10)} ${after.width.find((item) => item.region.id === gap.region.id)!.gapDb.toFixed(2).padStart(14)}`);
console.log(`loudness ${before.loudness.mixLufs.toFixed(2)} -> ${after.loudness.mixLufs.toFixed(2)} LUFS; true peak ${before.loudness.mixTruePeakDbtp.toFixed(2)} -> ${after.loudness.mixTruePeakDbtp.toFixed(2)}`);
