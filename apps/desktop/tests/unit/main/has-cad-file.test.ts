import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { hasCadFile } from "@main/cad/has-cad-file";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "has-cad-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const touch = (...parts: string[]) => {
  const file = path.join(root, ...parts);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
};

it("finds a model in the root or a few folders down, in any case", async () => {
  touch("README.md");
  expect(await hasCadFile(root)).toBe(false);
  touch("models", "examples", "imported", "Bracket.STEP");
  expect(await hasCadFile(root)).toBe(true);
});

it("does not look into dependency folders, hidden folders or past the depth bound", async () => {
  touch("node_modules", "pkg", "a.glb");
  touch("node_modules", "b.step");
  touch(".cache", "c.step");
  touch("a", "b", "c", "d", "deep.step");
  expect(await hasCadFile(root)).toBe(false);
  touch("part.glb");
  expect(await hasCadFile(root)).toBe(true);
});

it("is false for a root that does not exist", async () => {
  expect(await hasCadFile(path.join(root, "missing"))).toBe(false);
});
