import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePcm16Wav, renderTestStem, TEST_STEMS } from "./synthesize.ts";

const here = dirname(fileURLToPath(import.meta.url));
const destination = resolve(here, "../../../test-assets/night-drive");

await mkdir(destination, { recursive: true });
for (const kind of TEST_STEMS) {
  const bytes = encodePcm16Wav(renderTestStem(kind, 48_000, 80), 48_000);
  const filename = `${kind}.wav`;
  await writeFile(resolve(destination, filename), bytes);
  console.info(`Wrote ${filename} (${bytes.byteLength} bytes)`);
}
console.info(destination);
