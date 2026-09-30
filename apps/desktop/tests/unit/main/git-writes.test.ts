/**
 * The writes in `src/main/projects/git.ts` — commit and push — against real
 * repositories: what their failures say, and what they do with the remote.
 */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import * as git from "@main/projects/git";

import { cleanGitTemplates, committedRepository, GIT_ENV } from "./git-fixtures";

const previousEnv = { ...process.env };
const temporary: string[] = [];

beforeEach(() => {
  Object.assign(process.env, GIT_ENV);
});
afterEach(async () => {
  process.env = { ...previousEnv };
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
afterAll(cleanGitTemplates);

async function scratch(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "t2c-git-writes-")));
  temporary.push(directory);
  return directory;
}

async function repository(): Promise<string> {
  const root = path.join(await scratch(), "project");
  await committedRepository(root);
  return root;
}

describe("commitAll's errors", () => {
  it("says what a pre-commit hook printed, not 'git commit failed'", async () => {
    const root = await repository();
    const hook = path.join(root, ".git", "hooks", "pre-commit");
    await writeFile(hook, '#!/bin/sh\necho "no console.log"\nexit 1\n', { mode: 0o755 });
    await writeFile(path.join(root, "a.txt"), "a\n");

    await expect(git.commitAll(root, "add a")).rejects.toThrow(/no console\.log/);
  });

  it("says there was nothing to commit on a clean tree", async () => {
    const root = await repository();

    await expect(git.commitAll(root, "nothing")).rejects.toThrow(/nothing to commit/);
  });
});
