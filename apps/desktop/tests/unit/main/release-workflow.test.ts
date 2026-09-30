/**
 * `.github/workflows/release-publish.yml`, read as data: the release is the one
 * thing that cannot be run to see whether it works, so what it hands each
 * build is checked against what the build reads.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const require = createRequire(import.meta.url);
const { load } = require("js-yaml") as { load: (text: string) => Workflow };

interface Step {
  name?: string;
  env?: Record<string, string>;
  run?: string;
}
interface Workflow {
  jobs: Record<string, { steps: Step[]; strategy?: { matrix: { include: { name: string }[] } } }>;
}

const workflow = load(readFileSync(path.join(repo, ".github", "workflows", "release-publish.yml"), "utf8"));

function job(name: string) {
  const found = workflow.jobs[name];
  if (found === undefined) throw new Error(`release-publish.yml has no ${name} job`);
  return found;
}

it("hands every signing secret to the leg whose os reads it, and to no other", async () => {
  const { SIGNING_SECRETS } = await import("../../../scripts/package.mjs");
  const legs: Record<string, string> = { mac: "macOS", win: "Windows" };
  const desktop = job("desktop");
  const env = desktop.steps.find((step) => step.name === "Build and package")?.env ?? {};
  // `${{ matrix.name == 'X' && secrets.NAME || '' }}`, evaluated for one leg.
  const handed = (leg: string, name: string) => {
    const expression = /^\$\{\{ matrix\.name == '(\w+)' && secrets\.(\w+) \|\| '' \}\}$/.exec(env[name] ?? "");
    return expression !== null && expression[2] === name && expression[1] === leg;
  };
  const missing: string[] = [];
  for (const { name: leg } of desktop.strategy?.matrix.include ?? []) {
    for (const [os, names] of Object.entries(SIGNING_SECRETS as Record<string, string[]>)) {
      for (const name of names) {
        if (handed(leg, name) !== (legs[os] === leg)) missing.push(`${leg}: ${name}`);
      }
    }
  }
  expect(missing, "legs whose signing secrets are mapped wrongly").toEqual([]);
});
