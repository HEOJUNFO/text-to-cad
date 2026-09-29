/**
 * A review scope is renderer input, and its revisions become git argv. A
 * `from` of `--output=/any/file` would be read by `git diff` as an option and
 * write wherever it names, so a scope is checked before git is started at all.
 */
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type * as Execa from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execa = vi.hoisted(() => vi.fn());
vi.mock("execa", async (importOriginal) => {
  const actual = await importOriginal<typeof Execa>();
  execa.mockImplementation(actual.execa);
  return { ...actual, execa };
});

import * as git from "@main/projects/git";
import { diffScopeFor, resolveDiffScope, ReviewScopeSchema } from "@shared/types";

beforeEach(() => {
  execa.mockClear();
});

const run = promisify(execFile);
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A fresh `git init` with one uncommitted file and no commits. */
async function unbornRepo(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "t2c-unborn-")));
  scratch.push(directory);
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: directory });
  await writeFile(path.join(directory, "part.py"), "one\ntwo\n");
  return directory;
}

const hostile = [
  { kind: "range", from: "--output=/tmp/x" },
  { kind: "range", from: "HEAD" },
  { kind: "range", from: "abcdef12", to: "--output=/tmp/x" },
  { kind: "range", from: "abcdef12..HEAD" },
  { kind: "since", since: "--output=/tmp/x" },
  { kind: "since", since: "2 hours ago" },
] as const;

describe("review scopes", () => {
  it.each(hostile)("refuses %o before any git call", async (scope) => {
    await expect(git.status(process.cwd(), scope)).rejects.toThrow(git.GitError);
    await expect(git.fileDiff(process.cwd(), "a.txt", scope)).rejects.toThrow(git.GitError);
    await expect(git.unifiedDiff(process.cwd(), "a.txt", scope)).rejects.toThrow(git.GitError);
    expect(execa).not.toHaveBeenCalled();
  });

  it("refuses an unmarked scope that names neither session scope", async () => {
    const scope = { kind: "unmarked", scope: "--output=/tmp/x" } as unknown as git.DiffScope;
    await expect(git.status(process.cwd(), scope)).rejects.toThrow(git.GitError);
    expect(execa).not.toHaveBeenCalled();
  });

  it("accepts every scope the review header can send, and a recorded mark", () => {
    for (const named of ReviewScopeSchema.options) {
      expect(() => git.assertSafeScope(resolveDiffScope(diffScopeFor(named), null))).not.toThrow();
    }
    expect(() => git.assertSafeScope({ kind: "unmarked", scope: "turn" })).not.toThrow();
    expect(() => git.assertSafeScope({ kind: "unmarked", scope: "session" })).not.toThrow();
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(() => git.assertSafeScope({ kind: "range", from: sha })).not.toThrow();
    expect(() => git.assertSafeScope({ kind: "range", from: sha, to: sha })).not.toThrow();
  });
});

/**
 * A session with no recorded mark has no revision to measure `Last turn` or
 * `This session` from. The answer is an empty review that says why — never the
 * working tree under the scope's name (docs/integrations.md: never silently
 * substitute a different revision).
 */
describe("a session scope with no recorded mark", () => {
  it("resolves to an explicit unmarked scope, not the working tree", () => {
    const marks = { turnHead: null, sessionHead: null };
    expect(resolveDiffScope({ kind: "turn" }, marks)).toEqual({ kind: "unmarked", scope: "turn" });
    expect(resolveDiffScope({ kind: "session" }, marks)).toEqual({ kind: "unmarked", scope: "session" });
    expect(resolveDiffScope({ kind: "turn" }, null)).toEqual({ kind: "unmarked", scope: "turn" });
    expect(resolveDiffScope({ kind: "turn" }, { turnHead: null, sessionHead: "aaa" })).toEqual({
      kind: "unmarked",
      scope: "turn",
    });
    // The other scopes are untouched.
    expect(resolveDiffScope(diffScopeFor("all"), null)).toEqual({ kind: "working-tree" });
    expect(resolveDiffScope(diffScopeFor("1h"), null)).toEqual({ kind: "since", since: "1 hour ago" });
  });

  it("status answers the repository with no files and names the missing mark, without diffing", async () => {
    for (const which of ["turn", "session"] as const) {
      execa.mockClear();
      const answer = await git.status(process.cwd(), { kind: "unmarked", scope: which });
      expect(answer).toMatchObject({ isRepository: true, files: [], insertions: 0, deletions: 0, unmarked: which });
      const diffed = execa.mock.calls.some((call) => (call[1] as string[] | undefined)?.includes("diff"));
      expect(diffed).toBe(false);
    }
  });

  it("the working-tree answer carries no unmarked reason", async () => {
    const answer = await git.status(process.cwd(), { kind: "working-tree" });
    expect(answer.unmarked).toBeUndefined();
  });

  it("every answer carries the working tree's file count, whatever the scope, so a commit button needs no second read", async () => {
    const directory = await unbornRepo();
    await writeFile(path.join(directory, "other.py"), "x\n");
    for (const scope of [{ kind: "working-tree" }, { kind: "unmarked", scope: "turn" }] as const) {
      expect((await git.status(directory, scope)).workingFiles).toBe(2);
    }
    // A repository with a recorded mark: the scope can be empty while the tree is not.
    const marked = await git.status(process.cwd(), { kind: "unmarked", scope: "session" });
    expect(marked.workingFiles).toBe((await git.status(process.cwd(), { kind: "working-tree" })).files.length);
  });

  it("a file's diff in an unmarked scope is refused with the reason, not answered from the working tree", async () => {
    await expect(git.fileDiff(process.cwd(), "package.json", { kind: "unmarked", scope: "turn" })).rejects.toThrow(
      /no turn recorded/i,
    );
    await expect(
      git.unifiedDiff(process.cwd(), "package.json", { kind: "unmarked", scope: "session" }),
    ).rejects.toThrow(/no session start recorded/i);
  });
});

/**
 * A repository with no commits cannot be marked: `rev-parse HEAD` has nothing
 * to name. That is not a missing record — every change in it is new since the
 * repository began, so the working tree is exactly the answer, and the review
 * says it is measuring from the start.
 */
describe("a session scope in a repository with no commits yet", () => {
  it("status answers the working tree, measured from the repository's start", async () => {
    const directory = await unbornRepo();
    for (const which of ["turn", "session"] as const) {
      const answer = await git.status(directory, { kind: "unmarked", scope: which });
      expect(answer.unmarked).toBeUndefined();
      expect(answer).toMatchObject({ unborn: true, fromStart: true, insertions: 2 });
      expect(answer.files.map((file) => file.path)).toEqual(["part.py"]);
    }
    expect((await git.status(directory, { kind: "working-tree" })).fromStart).toBeUndefined();
  });

  it("a file's diff is the file itself, not a refusal", async () => {
    const directory = await unbornRepo();
    const diff = await git.fileDiff(directory, "part.py", { kind: "unmarked", scope: "turn" });
    expect(diff).toMatchObject({ before: "", after: "one\ntwo\n", insertions: 2 });
    expect(await git.unifiedDiff(directory, "part.py", { kind: "unmarked", scope: "session" })).toMatch(/\+two/);
  });
});
