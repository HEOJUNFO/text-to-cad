/**
 * git's children run under the login shell's environment once `loginEnv` has
 * captured it (README, "Git modes and worktrees"): a Dock launch's PATH has no
 * Homebrew, and a hook that calls node or git-lfs fails under it.
 *
 * Real git and a real hook: the fact under test is what a hook sees.
 */
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import * as git from "@main/projects/git";

import { cleanGitTemplates, committedRepository } from "./git-fixtures";

const temporary: string[] = [];
afterEach(async () => {
  git.setLoginEnvForGit(null);
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});
afterAll(cleanGitTemplates);

describe("the environment git runs under", () => {
  it("is the login shell's once it has been captured, and the process's until then", async () => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "text-to-cad-login-env-")));
    temporary.push(base);
    const root = path.join(base, "project");
    await committedRepository(root, "one\n");
    const seen = path.join(base, "hook-path.txt");
    const hook = path.join(root, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/bin/sh\nprintf '%s' "$PATH" > '${seen}'\n`);
    await chmod(hook, 0o755);

    // Before the capture lands: the process environment, and no waiting.
    await git.createWorktree({ repoPath: root, parentDir: path.join(base, "wt"), name: "before" });
    expect(await readFile(seen, "utf8")).not.toContain("login-shell-marker");

    git.setLoginEnvForGit({ ...(process.env as Record<string, string>), PATH: `/login-shell-marker/bin:${process.env.PATH}` });
    await git.createWorktree({ repoPath: root, parentDir: path.join(base, "wt"), name: "after" });
    expect(await readFile(seen, "utf8")).toContain("/login-shell-marker/bin");
  });
});
