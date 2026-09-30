/**
 * `.github/workflows/release-publish.yml`, read as data: the release is the one
 * thing that cannot be run to see whether it works, so what it hands each
 * build is checked against what the build reads.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const require = createRequire(import.meta.url);
const { load } = require("js-yaml") as { load: (text: string) => Workflow };

interface Step {
  name?: string;
  env?: Record<string, string>;
  run?: string;
}
interface Workflow {
  jobs: Record<string, { if?: string; steps: Step[]; strategy?: { matrix: { include: { name: string }[] } } }>;
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

describe("the release gate", () => {
  const gate = job("publish").steps.find((step) => step.name === "Evaluate release gate")?.run ?? "";

  /**
   * The gate's own script, run in a throwaway repository whose only release
   * is the current version, tagged. `release` is what `gh release view
   * --json isDraft --jq .isDraft` prints, or `absent` when it fails.
   */
  function shouldPublish(release: "false" | "true" | "absent"): string {
    const dir = mkdtempSync(path.join(tmpdir(), "release-gate-"));
    try {
      cpSync(path.join(repo, "scripts", "release"), path.join(dir, "scripts", "release"), { recursive: true });
      mkdirSync(path.join(dir, "skills"));
      mkdirSync(path.join(dir, "bin"));
      writeFileSync(path.join(dir, "VERSION"), "0.5.0\n");
      const stub = release === "absent" ? "exit 1" : `echo ${release}`;
      writeFileSync(path.join(dir, "bin", "gh"), `#!/bin/sh\n${stub}\n`, { mode: 0o755 });
      const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
      git("init", "-q");
      git("add", "-A");
      git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "release");
      git("tag", "v0.5.0");
      const output = path.join(dir, "out");
      writeFileSync(output, "");
      execFileSync("bash", ["-c", gate], {
        cwd: dir,
        stdio: "pipe",
        env: { PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main", HOME: dir },
      });
      return /^should_publish=(\w+)$/m.exec(readFileSync(output, "utf8"))?.[1] ?? "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("resumes a tag whose Release was never created or is still a draft", () => {
    expect(shouldPublish("absent"), "tag, no Release").toBe("true");
    expect(shouldPublish("true"), "tag, draft Release").toBe("true");
  });

  it("stops at a tag whose Release is published", () => {
    expect(shouldPublish("false"), "tag, published Release").toBe("false");
  });
});

it("does not tag or create a Release in a cancelled run", () => {
  const condition = String(job("tag-release").if ?? "");
  expect(condition, "tag-release if").not.toMatch(/\balways\(\)/);
  expect(condition, "tag-release if").toMatch(/!cancelled\(\)/);
  expect(condition, "tag-release if").toMatch(/needs\.desktop\.result != 'cancelled'/);
});
