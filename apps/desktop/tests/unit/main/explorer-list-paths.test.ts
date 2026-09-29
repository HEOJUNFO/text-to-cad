/**
 * `listPaths` reads directories ahead of the one it is taking apart, and
 * still answers exactly what the one-`readdir`-per-await walk it replaced did
 * — including which paths a capped walk keeps. That walk is kept below, as it
 * was, so both the answer and the speed are measured against it on the same
 * disk in the same run: a ratio, never a wall-clock bound, because a loaded CI
 * runner makes every absolute number a lie.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";

import { listPaths, toRelative } from "@main/explorer/fs";
import { cleanTempDirs, tempDir } from "./temp-dirs";

/** Named exactly as in `src/main/explorer/fs.ts`: the directories walked last. */
const DEFERRED = new Set([
  ".git", ".hg", ".svn", ".DS_Store", "node_modules", "__pycache__", ".venv",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", ".turbo", ".next", ".vite", ".gradle",
]);
const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** The walk before read-ahead: one `readdir` per await, `shift()` off the queue. */
async function serialListPaths(root: string, limit = 20_000) {
  const realRoot = await fs.realpath(root);
  const paths: string[] = [];
  const queue: string[] = [realRoot];
  const deferred: string[] = [];
  let truncated = false;
  while ((queue.length > 0 || deferred.length > 0) && !truncated) {
    const current = (queue.length > 0 ? queue : deferred).shift() as string;
    const dirents = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      const child = path.join(current, dirent.name);
      const relative = toRelative(realRoot, child);
      if (dirent.isDirectory()) {
        (relative.split("/").some((segment) => DEFERRED.has(segment)) ? deferred : queue).push(child);
      } else if (dirent.isFile()) {
        if (paths.length >= limit) {
          truncated = true;
          break;
        }
        paths.push(relative);
      }
    }
  }
  paths.sort(COLLATOR.compare);
  return { paths, truncated };
}

let root: string;

// 300 directories, three deep, with a dependency cache the walk must leave for
// last: ~5,000 paths, the size of project the measurement pass timed.
beforeAll(async () => {
  root = await tempDir("text-to-cad-list-paths-");
  const writes: Promise<void>[] = [];
  for (let a = 0; a < 10; a += 1) {
    for (let b = 0; b < 5; b += 1) {
      for (let c = 0; c < 5; c += 1) {
        const dir = path.join(root, `part-${a}`, `v${b}`, `s${c}`);
        await fs.mkdir(dir, { recursive: true });
        for (let f = 0; f < 16; f += 1) writes.push(fs.writeFile(path.join(dir, `f${f}.step`), ""));
      }
    }
  }
  for (let p = 0; p < 20; p += 1) {
    const dir = path.join(root, "node_modules", `pkg-${p}`);
    await fs.mkdir(dir, { recursive: true });
    for (let f = 0; f < 10; f += 1) writes.push(fs.writeFile(path.join(dir, `m${f}.js`), ""));
  }
  await Promise.all(writes);
});

afterAll(() => cleanTempDirs());

it("answers what the serial walk answered, whole and capped", async () => {
  const whole = await listPaths(root);
  expect(whole.paths.length).toBe(250 * 16 + 20 * 10);
  expect(whole).toEqual(await serialListPaths(root));

  // A cap inside the project content, and one inside the dependency cache:
  // the same paths are kept, because directories are still consumed in the
  // order they were found.
  for (const limit of [1_234, 4_100]) {
    const capped = await listPaths(root, "", { limit });
    expect(capped.truncated).toBe(true);
    expect(capped).toEqual(await serialListPaths(root, limit));
  }
});

it("walks the tree in well under the serial walk's time", async () => {
  // Warm both, then alternate so neither is always the one on a cold cache.
  await serialListPaths(root);
  await listPaths(root);
  const serial: number[] = [];
  const ahead: number[] = [];
  for (let run = 0; run < 7; run += 1) {
    let started = performance.now();
    await serialListPaths(root);
    serial.push(performance.now() - started);
    started = performance.now();
    await listPaths(root);
    ahead.push(performance.now() - started);
  }
  const median = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] as number;
  const ratio = median(ahead) / median(serial);
  console.info(`listPaths: serial ${median(serial).toFixed(1)} ms, read-ahead ${median(ahead).toFixed(1)} ms, ratio ${ratio.toFixed(2)}`);
  expect(ratio).toBeLessThan(RATIO);
});

/** Measured at 0.34 on an M-series Mac (the serial walk, 1.10 against itself); 0.75 leaves room for a busy runner. */
const RATIO = 0.75;
