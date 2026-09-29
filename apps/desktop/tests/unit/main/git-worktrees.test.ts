/**
 * P7's half of `src/main/projects/git.ts`, against real repositories.
 *
 * Real `git`, not a mock. Every function here is a `git` invocation and a
 * parser, so a fake `git` would only be testing the fake: whether `git
 * worktree add -b` refuses a branch that already exists, whether `git worktree
 * remove` needs `--force` for a dirty tree, and what `--porcelain -z` actually
 * prints are the facts under test.
 *
 * The repositories are temporary directories built in `beforeEach`, and
 * `realpath`ed: on macOS `os.tmpdir()` is `/var/…`, git answers with
 * `/private/var/…`, and a path comparison between the two is a false negative
 * that looks like a bug in the code under test.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import * as git from "@main/projects/git";

const run = promisify(execFile);

/** A fixed identity: a fresh CI runner has no `user.name` and `git commit` fails without one. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "text-to-cad Tests",
  GIT_AUTHOR_EMAIL: "tests@example.invalid",
  GIT_COMMITTER_NAME: "text-to-cad Tests",
  GIT_COMMITTER_EMAIL: "tests@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function scratch(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  temporary.push(directory);
  return directory;
}

/** A repository with one commit, and a directory beside it for its worktrees. */
async function repository(): Promise<{ root: string; worktrees: string }> {
  const base = await scratch("text-to-cad-git-");
  const root = path.join(base, "project");
  const worktrees = path.join(base, "worktrees");
  await mkdir(root, { recursive: true });
  await git_(root, "init", "--quiet", "--initial-branch=main");
  await writeFile(path.join(root, "README.md"), "one\ntwo\n");
  await git_(root, "add", "-A");
  await git_(root, "commit", "--quiet", "-m", "first");
  return { root, worktrees };
}

function git_(cwd: string, ...args: string[]) {
  return run("git", args, { cwd, env: GIT_ENV });
}

/* -------------------------------------------------------------------------- */
/* Slugs                                                                       */
/* -------------------------------------------------------------------------- */

describe("slugify", () => {
  it("makes a name that is legal as both a path component and a git ref", () => {
    expect(git.slugify("Model the wrist path")).toBe("model-the-wrist-path");
    // Everything a ref may not contain, and everything Windows may not: gone.
    expect(git.slugify("fix: a~b^c:d?e*f[g]h\\i/j|k<l>m\"n")).toBe("fix-a-b-c-d-e-f-g-h-i-j-k-l-m-n");
    expect(git.slugify("Modèle du poignet")).toBe("modele-du-poignet");
    expect(git.slugify("  ...  ")).toBe("");
    expect(git.slugify("")).toBe("");
  });

  it("truncates at a word boundary and never ends on a hyphen", () => {
    const long = git.slugify("model the forearm to hand wrist path with a tendon route", 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-")).toBe(false);
    // The cut lands on a word, not mid-word.
    expect(long).toBe("model-the-forearm-to-hand-wrist-path");
    // A single word longer than the limit has no boundary to cut at, so it is
    // cut where the limit falls rather than answering an empty string.
    expect(git.slugify("x".repeat(80), 10)).toBe("x".repeat(10));
  });
});

/* -------------------------------------------------------------------------- */
/* Parsers                                                                     */
/* -------------------------------------------------------------------------- */

describe("parseWorktreeList", () => {
  it("reads the newline form and the NUL form the same way", () => {
    const lines = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /wt/feature",
      "HEAD def456",
      "branch refs/heads/text-to-cad/feature",
      "locked",
      "",
      "worktree /wt/loose",
      "HEAD 999",
      "detached",
      "",
    ].join("\n");

    const fromLines = git.parseWorktreeList(lines);
    const fromNuls = git.parseWorktreeList(lines.replace(/\n/g, "\0"));
    expect(fromNuls).toEqual(fromLines);

    expect(fromLines).toHaveLength(3);
    expect(fromLines[0]).toMatchObject({ path: "/repo", branch: "main", primary: true });
    expect(fromLines[1]).toMatchObject({
      branch: "text-to-cad/feature",
      locked: true,
      primary: false,
    });
    expect(fromLines[2]).toMatchObject({ branch: null, detached: true });
  });
});

describe("findUrl", () => {
  it("takes gh's URL out of either stream, without trailing punctuation", () => {
    expect(git.findUrl("https://github.com/o/r/pull/12\n")).toBe("https://github.com/o/r/pull/12");
    expect(
      git.findUrl("a pull request for branch x already exists: https://github.com/o/r/pull/9."),
    ).toBe("https://github.com/o/r/pull/9");
    expect(git.findUrl("no url here")).toBeNull();
  });
});

describe("createPullRequest", () => {
  /** A `gh` on PATH that reports an existing pull request by `author` at `head`. */
  async function fakeGh(author: string, headOid: string) {
    const bin = await scratch("text-to-cad-gh-");
    const script = [
      "#!/bin/sh",
      'case "$1 $2" in',
      '  "pr create") echo \'a pull request for branch "text-to-cad/wrist" into branch "main" already exists:\' >&2;'
        + ' echo "https://github.com/o/r/pull/7" >&2; exit 1 ;;',
      `  "pr view") echo '{"author":{"login":"${author}"},"headRefOid":"${headOid}"}' ;;`,
      '  "api user") echo "me" ;;',
      "esac",
    ].join("\n");
    await writeFile(path.join(bin, "gh"), `${script}\n`, { mode: 0o755 });
    return { ...GIT_ENV, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
  }

  async function pushed() {
    const { root, worktrees } = await repository();
    const remote = path.join(path.dirname(root), "remote.git");
    await git_(path.dirname(root), "init", "--quiet", "--bare", "--initial-branch=main", remote);
    await git_(root, "remote", "add", "origin", remote);
    await git_(root, "push", "--quiet", "-u", "origin", "main");
    const created = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "wrist" });
    return { cwd: created.path, head: (await git.head(created.path))! };
  }

  it("does not take someone else's pull request from a branch of the same name as this one", async () => {
    const { cwd, head } = await pushed();
    const env = await fakeGh("someone-else", head);
    await git.ghAvailable(env, true);
    await expect(git.createPullRequest(cwd, { title: "Wrist", env })).rejects.toThrow(
      "already exists, and it is not this one: https://github.com/o/r/pull/7",
    );
  });

  it("answers the existing pull request when it is the person's own, at the commit just pushed", async () => {
    const { cwd, head } = await pushed();
    const env = await fakeGh("me", head);
    await git.ghAvailable(env, true);
    await expect(git.createPullRequest(cwd, { title: "Wrist", env })).resolves.toEqual({
      url: "https://github.com/o/r/pull/7",
    });
  });
});

describe("isUnder and samePath", () => {
  it("keeps the sweep inside its own root", () => {
    expect(git.isUnder("/a/b", "/a/b/c")).toBe(true);
    expect(git.isUnder("/a/b", "/a/b")).toBe(false);
    expect(git.isUnder("/a/b", "/a/bc")).toBe(false);
    expect(git.isUnder("/a/b", "/a")).toBe(false);
    expect(git.samePath("/a/b/", "/a/b")).toBe(true);
    expect(git.samePath("/a/b", "/a/c")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Repository detection                                                        */
/* -------------------------------------------------------------------------- */

describe("repoInfo", () => {
  it("answers empty for a directory that is not a repository", async () => {
    const plain = await scratch("text-to-cad-plain-");
    expect(await git.repoInfo(plain)).toEqual(git.emptyRepoInfo());
  });

  it("reports the branch, cleanliness and the absence of a remote", async () => {
    const { root } = await repository();
    expect(await git.repoInfo(root)).toMatchObject({
      isRepository: true,
      branch: "main",
      upstream: null,
      dirty: false,
      detached: false,
      unborn: false,
      hasRemote: false,
    });

    await writeFile(path.join(root, "new.txt"), "x");
    expect((await git.repoInfo(root)).dirty).toBe(true);
  });

  it("reports a repository with no commits as unborn", async () => {
    const base = await scratch("text-to-cad-unborn-");
    await git_(base, "init", "--quiet", "--initial-branch=main");
    const info = await git.repoInfo(base);
    expect(info).toMatchObject({ isRepository: true, unborn: true, branch: "main" });
    expect(await git.head(base)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Worktrees                                                                   */
/* -------------------------------------------------------------------------- */

describe("createWorktree", () => {
  it("puts the worktree under the parent directory and names the branch with the prefix", async () => {
    const { root, worktrees } = await repository();

    const created = await git.createWorktree({
      repoPath: root,
      parentDir: worktrees,
      name: "Model the wrist",
      branchPrefix: "text-to-cad/",
    });

    expect(created.path).toBe(path.join(worktrees, "model-the-wrist"));
    expect(created.branch).toBe("text-to-cad/model-the-wrist");
    expect(created.base).toBe(await git.head(root));
    // It is a real checkout of the repository, not an empty folder.
    expect(await readdir(created.path)).toContain("README.md");

    const listed = await git.listWorktrees(root);
    expect(listed).toHaveLength(2);
    expect(listed[0]?.primary).toBe(true);
    expect(listed[1]).toMatchObject({
      path: created.path,
      branch: "text-to-cad/model-the-wrist",
      primary: false,
    });
  });

  it("generates a name when there is nothing to slugify", async () => {
    const { root, worktrees } = await repository();
    const created = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "…" });
    expect(path.basename(created.path)).toMatch(/^session-[0-9a-f]{1,4}$/);
    expect(created.branch).toBe(`text-to-cad/${path.basename(created.path)}`);
  });

  it("suffixes a name whose directory or branch is taken", async () => {
    const { root, worktrees } = await repository();
    const first = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "wrist" });
    const second = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "wrist" });
    expect(path.basename(first.path)).toBe("wrist");
    expect(path.basename(second.path)).toBe("wrist-2");
    expect(second.branch).toBe("text-to-cad/wrist-2");

    // A branch that exists without a worktree also has to be stepped over:
    // `git worktree add -b` would fail on it.
    await git_(root, "branch", "text-to-cad/wrist-3");
    const third = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "wrist" });
    expect(third.branch).toBe("text-to-cad/wrist-4");
  });

  it("steps over a branch name someone else already has on the remote", async () => {
    const { root, worktrees } = await repository();
    const remote = path.join(path.dirname(root), "remote.git");
    await git_(path.dirname(root), "init", "--quiet", "--bare", "--initial-branch=main", remote);
    await git_(root, "remote", "add", "origin", remote);
    await git_(root, "push", "--quiet", "-u", "origin", "main");
    // Another machine pushed `text-to-cad/wrist`; only the fetch tells this checkout.
    await git_(root, "push", "--quiet", "origin", "main:refs/heads/text-to-cad/wrist");
    await git_(root, "update-ref", "-d", "refs/remotes/origin/text-to-cad/wrist");

    const fetched = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "wrist", fetch: true });
    expect(fetched.branch).toBe("text-to-cad/wrist-2");
    // Without a fetch, what the checkout already knows of the remote still counts.
    const known = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "wrist" });
    expect(known.branch).toBe("text-to-cad/wrist-3");
  });

  it("with fetch, starts from the fetched upstream rather than local HEAD, and tracks nothing", async () => {
    const { root, worktrees } = await repository();
    const remote = path.join(path.dirname(root), "remote.git");
    // The bare remote's HEAD is git's compiled-in default branch unless said
    // otherwise (CI has no `init.defaultBranch`); a clone of it would then
    // sit on an unborn `master` and the push below would have no `main`.
    await git_(path.dirname(root), "init", "--quiet", "--bare", "--initial-branch=main", remote);
    await git_(root, "remote", "add", "origin", remote);
    await git_(root, "push", "--quiet", "-u", "origin", "main");
    // Someone else pushes a commit the checkout has not seen.
    const other = path.join(path.dirname(root), "other");
    await git_(path.dirname(root), "clone", "--quiet", "--branch", "main", remote, other);
    await writeFile(path.join(other, "theirs.txt"), "new\n");
    await git_(other, "add", "-A");
    await git_(other, "commit", "--quiet", "-m", "theirs");
    await git_(other, "push", "--quiet", "origin", "main");
    const serverTip = (await git_(other, "rev-parse", "HEAD")).stdout.trim();

    const created = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "fresh", fetch: true });
    expect(created.base).toBe(serverTip);
    expect(await readdir(created.path)).toContain("theirs.txt");
    // Local HEAD is untouched, and the new branch does not track main.
    expect(await git.head(root)).not.toBe(serverTip);
    await expect(git_(created.path, "rev-parse", "--abbrev-ref", "@{upstream}")).rejects.toThrow();

    // Without fetch it is still local HEAD.
    const local = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "local" });
    expect(local.base).toBe(await git.head(root));
  });

  it("refuses a directory that is not a repository, in words a person can act on", async () => {
    const plain = await scratch("text-to-cad-plain-");
    await expect(
      git.createWorktree({ repoPath: plain, parentDir: path.join(plain, "wt") }),
    ).rejects.toThrow("Project is not a git repository, worktree mode unavailable");
  });

  it("refuses a repository with nothing to branch from", async () => {
    const base = await scratch("text-to-cad-unborn-");
    await git_(base, "init", "--quiet", "--initial-branch=main");
    await expect(
      git.createWorktree({ repoPath: base, parentDir: path.join(base, "wt") }),
    ).rejects.toThrow(/no commits yet/i);
  });
});

describe("removeWorktree", () => {
  it("removes a clean worktree and leaves its branch behind", async () => {
    const { root, worktrees } = await repository();
    const created = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "gone" });

    await git.removeWorktree(created.path);

    expect(await git.listWorktrees(root)).toHaveLength(1);
    // The checkout is recreatable; the commits on the branch are not, so the
    // branch stays.
    const branches = await git_(root, "branch", "--list", created.branch);
    expect(branches.stdout).toContain(created.branch);
  });

  it("refuses a dirty worktree unless it is forced", async () => {
    const { root, worktrees } = await repository();
    const created = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "busy" });
    await writeFile(path.join(created.path, "README.md"), "edited\n");

    await expect(git.removeWorktree(created.path)).rejects.toThrow("uncommitted changes");
    expect(await git.listWorktrees(root)).toHaveLength(2);

    await git.removeWorktree(created.path, { force: true });
    expect(await git.listWorktrees(root)).toHaveLength(1);
  });

  it("refuses ignored files it would delete unless forced, but not disposable caches", async () => {
    const { root, worktrees } = await repository();
    await writeFile(path.join(root, ".gitignore"), ".env\n*.step\nnode_modules/\n__pycache__/\n");
    await git_(root, "add", "-A");
    await git_(root, "commit", "--quiet", "-m", "ignore");

    const caches = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "caches" });
    await mkdir(path.join(caches.path, "node_modules", "left-pad"), { recursive: true });
    await writeFile(path.join(caches.path, "node_modules", "left-pad", "index.js"), "x\n");
    await mkdir(path.join(caches.path, "__pycache__"));
    await writeFile(path.join(caches.path, "__pycache__", "a.pyc"), "x");
    await git.removeWorktree(caches.path);

    const work = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "work" });
    await writeFile(path.join(work.path, ".env"), "TOKEN=1\n");
    await writeFile(path.join(work.path, "arm.step"), "ISO-10303-21;\n");
    expect(await git.isDirty(work.path)).toBe(false);
    expect(await git.hasUnsavedWork(work.path)).toBe(true);
    await expect(git.removeWorktree(work.path)).rejects.toThrow(/ignored files.*\.env/);
    expect(await readdir(work.path)).toContain(".env");

    await git.removeWorktree(work.path, { force: true });
    expect(await git.listWorktrees(root)).toHaveLength(1);
  });

  it("refuses the repository's own working tree", async () => {
    const { root } = await repository();
    await expect(git.removeWorktree(root)).rejects.toThrow("the repository itself");
  });
});

describe("pruneWorktrees", () => {
  it("keeps the newest, and never touches what it did not create", async () => {
    const { root, worktrees } = await repository();
    const elsewhere = path.join(path.dirname(worktrees), "mine");

    const made: string[] = [];
    for (const name of ["one", "two", "three"]) {
      const created = await git.createWorktree({ repoPath: root, parentDir: worktrees, name });
      made.push(created.path);
      // `git worktree add` for three worktrees in the same millisecond gives
      // them the same mtime, and the sweep's order would then be arbitrary.
      await touch(created.path, Date.now() - (3 - made.length) * 60_000);
    }
    const outside = await git.createWorktree({
      repoPath: root,
      parentDir: elsewhere,
      name: "handmade",
    });

    const { removed } = await git.pruneWorktrees({
      repoPath: root,
      parentDir: worktrees,
      keep: 1,
    });

    // "three" is newest and survives; "one" and "two" go; the worktree in
    // another directory is not the sweep's business at all.
    expect(removed.sort()).toEqual([made[0], made[1]].sort());
    const left = (await git.listWorktrees(root)).filter((worktree) => !worktree.primary);
    expect(left.map((worktree) => worktree.path).sort()).toEqual([made[2], outside.path].sort());
  });

  it("never removes one with an open session or uncommitted work", async () => {
    const { root, worktrees } = await repository();
    const busy = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "busy" });
    const held = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "held" });
    const spare = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "spare" });
    await writeFile(path.join(busy.path, "wip.txt"), "not committed\n");

    const { removed } = await git.pruneWorktrees({
      repoPath: root,
      parentDir: worktrees,
      keep: 0,
      protectedPaths: [held.path],
    });

    expect(removed).toEqual([spare.path]);
    const left = (await git.listWorktrees(root)).filter((worktree) => !worktree.primary);
    expect(left.map((worktree) => worktree.path).sort()).toEqual([busy.path, held.path].sort());
  });

  it("never sweeps a worktree whose ignored files it would delete", async () => {
    const { root, worktrees } = await repository();
    await writeFile(path.join(root, ".gitignore"), ".env\n");
    await git_(root, "add", "-A");
    await git_(root, "commit", "--quiet", "-m", "ignore");
    const secrets = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "secrets" });
    await writeFile(path.join(secrets.path, ".env"), "TOKEN=1\n");

    const { removed } = await git.pruneWorktrees({ repoPath: root, parentDir: worktrees, keep: 0 });
    expect(removed).toEqual([]);
    expect(await readdir(secrets.path)).toContain(".env");
  });
});

describe("a check git could not answer", () => {
  /**
   * A `git` first on PATH that fails the ignored-files read the way a lock or
   * a timeout would, and passes everything else to the real one.
   */
  async function failingIgnoredCheck(): Promise<() => void> {
    const real = (await run("sh", ["-c", "command -v git"])).stdout.trim();
    const bin = await scratch("text-to-cad-git-wrapper-");
    await writeFile(
      path.join(bin, "git"),
      `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = "--ignored=matching" ] && { echo "fatal: unable to read index" >&2; exit 128; }; done\nexec "${real}" "$@"\n`,
      { mode: 0o755 },
    );
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`;
    return () => {
      process.env.PATH = previous;
    };
  }

  it("is unknown, not clean, and nothing is removed on it", async () => {
    const { root, worktrees } = await repository();
    await writeFile(path.join(root, ".gitignore"), ".env\n");
    await git_(root, "add", "-A");
    await git_(root, "commit", "--quiet", "-m", "ignore");
    const secrets = await git.createWorktree({ repoPath: root, parentDir: worktrees, name: "secrets" });
    await writeFile(path.join(secrets.path, ".env"), "TOKEN=1\n");

    const restore = await failingIgnoredCheck();
    try {
      const { removed } = await git.pruneWorktrees({ repoPath: root, parentDir: worktrees, keep: 0 });
      expect(removed).toEqual([]);
      await expect(git.removeWorktree(secrets.path)).rejects.toThrow(/could not check that worktree/);
      // What Settings is told: not clean, not dirty — unknown.
      expect(await git.hasUnsavedWork(secrets.path)).toBeNull();
    } finally {
      restore();
    }
    expect(await readdir(secrets.path)).toContain(".env");
  });
});

/* -------------------------------------------------------------------------- */
/* Scopes                                                                      */
/* -------------------------------------------------------------------------- */

describe("status against a recorded revision", () => {
  it("includes files git has never seen, which is what a turn's output is", async () => {
    const { root } = await repository();
    const mark = (await git.head(root))!;

    // A turn: one commit, one edit on top of it, one brand new file.
    await writeFile(path.join(root, "README.md"), "one\ntwo\nthree\n");
    await git_(root, "commit", "--quiet", "-am", "the turn's commit");
    await writeFile(path.join(root, "README.md"), "one\ntwo\nthree\nfour\n");
    await writeFile(path.join(root, "made.txt"), "a\nb\nc\n");

    const scoped = await git.status(root, { kind: "range", from: mark });
    expect(scoped.files.map((file) => file.path).sort()).toEqual(["README.md", "made.txt"]);
    // The new file counts its lines rather than reporting +0, and the edit is
    // measured from the mark, not from the commit made since.
    expect(scoped.files.find((file) => file.path === "made.txt")).toMatchObject({
      status: "untracked",
      insertions: 3,
    });
    expect(scoped.files.find((file) => file.path === "README.md")?.insertions).toBe(2);
    expect(scoped.insertions).toBe(5);
  });

  it("shows the working copy as the second side, not the last commit", async () => {
    const { root } = await repository();
    const mark = (await git.head(root))!;
    await writeFile(path.join(root, "README.md"), "one\ntwo\ncommitted\n");
    await git_(root, "commit", "--quiet", "-am", "a commit after the mark");
    await writeFile(path.join(root, "README.md"), "one\ntwo\ncommitted\nuncommitted\n");

    const diff = await git.fileDiff(root, "README.md", { kind: "range", from: mark });
    expect(diff.before).toBe("one\ntwo\n");
    expect(diff.after).toContain("uncommitted");
  });
});

describe("a renamed file", () => {
  it("diffs against its old path, not as a new file", async () => {
    const { root } = await repository();
    const mark = (await git.head(root))!;
    await git_(root, "mv", "README.md", "NOTES.md");
    await writeFile(path.join(root, "NOTES.md"), "one\ntwo\nthree\n");

    for (const scope of [{ kind: "working-tree" as const }, { kind: "range" as const, from: mark }]) {
      const diff = await git.fileDiff(root, "NOTES.md", scope);
      expect(diff).toMatchObject({ status: "renamed", oldPath: "README.md", insertions: 1, deletions: 0 });
      expect(diff.before).toBe("one\ntwo\n");
      const patch = await git.unifiedDiff(root, "NOTES.md", scope);
      expect(patch).toContain("rename from README.md");
      expect(patch).toContain("+three");
    }
  });
});

/** Set a directory's mtime, so the sweep's ordering is deterministic. */
async function touch(directory: string, at: number): Promise<void> {
  const { utimes } = await import("node:fs/promises");
  await utimes(directory, new Date(at), new Date(at));
}
