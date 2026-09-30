/**
 * The writes in `src/main/projects/git.ts` — commit and push — against real
 * repositories: what their failures say, and what they do with the remote.
 */
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { endTrackedChildren, killTrackedChildren } from "@main/children";
import * as git from "@main/projects/git";

import { cleanGitTemplates, committedRepository, GIT_ENV, gitIn } from "./git-fixtures";

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

describe("a commit in flight at quit", () => {
  it("is asked to stop, so it drops its index.lock instead of leaving one", async () => {
    const root = await repository();
    const pidFile = path.join(root, "..", "filter.pid");
    const script = path.join(root, "..", "slow-clean.sh");
    // `git add -A` holds .git/index.lock while it runs a clean filter, so a
    // filter that never finishes is a commit caught with the lock in hand.
    await writeFile(script, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`, { mode: 0o755 });
    await gitIn(root, "config", "filter.slow.clean", script);
    await writeFile(path.join(root, ".gitattributes"), "*.txt filter=slow\n");
    await writeFile(path.join(root, "a.txt"), "a\n");
    const lock = path.join(root, ".git", "index.lock");

    const committing = git.commitAll(root, "add a").catch((error: unknown) => error);
    try {
      await vi.waitFor(async () => {
        await readFile(pidFile, "utf8");
        await stat(lock);
      }, { timeout: 15_000 });

      endTrackedChildren();
      await committing;

      await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
      if (pid > 0) process.kill(pid, "SIGKILL");
      killTrackedChildren();
    }
  });
});
