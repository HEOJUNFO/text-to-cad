/**
 * The built renderer carries each module once. Two copies of one library
 * resolved from two places (`@streamdown/code`'s nested shiki 3 beside this
 * app's shiki 4 was ~230 grammars and themes, ~6 MB) come out as chunk pairs
 * with the same name and the same bytes under different hashes — nothing
 * fails, the app is just that much larger. `electron.vite.config.ts`'s
 * `dedupe` is what keeps them one.
 *
 * It reads `out/renderer`, so it has something to say only after
 * `npm run build`; without a build it logs why and passes.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "out", "renderer", "assets");

/** `abap-B7h4dtBh.js` → `abap.js`: Rollup's eight-character hash dropped. */
const baseName = (file: string) => file.replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/, "$1");

it("emits no two chunks with one name and one size", () => {
  if (!existsSync(assets)) {
    console.info(`renderer-bundle: no ${assets}; run \`npm run build\` to check the bundle`);
    return;
  }
  const seen = new Map<string, string[]>();
  for (const file of readdirSync(assets)) {
    if (!/\.(js|css|wasm)$/.test(file)) continue;
    const key = `${baseName(file)} ${statSync(path.join(assets, file)).size}`;
    seen.set(key, [...(seen.get(key) ?? []), file]);
  }
  const twins = [...seen.values()].filter((files) => files.length > 1).map((files) => files.join(" = "));
  expect(twins, `${twins.length} chunk(s) emitted more than once`).toEqual([]);
});
