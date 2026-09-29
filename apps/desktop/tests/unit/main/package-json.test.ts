/**
 * AGENTS.md: `package.json` stays at version `0.0.0` (the repository's
 * `VERSION` is stamped in at build time), and every dependency is an exact
 * version — the one exception is the workspace links, which npm spells `*`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manifest = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8")) as {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const WORKSPACE_LINKS = new Set(["@text-to-cad/core", "@text-to-cad/ui"]);
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

it("stays at version 0.0.0", () => {
  expect(manifest.version).toBe("0.0.0");
});

it("pins every dependency to an exact version, workspace links aside", () => {
  const offenders = (["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const).flatMap(
    (field) =>
      Object.entries(manifest[field] ?? {}).flatMap(([name, spec]) => {
        if (WORKSPACE_LINKS.has(name)) return spec === "*" ? [] : [`${field} ${name}: ${spec} (a workspace link is "*")`];
        return EXACT.test(spec) ? [] : [`${field} ${name}: ${spec}`];
      }),
  );
  expect(offenders.join("\n"), "dependency specifiers that are not exact versions").toBe("");
});
