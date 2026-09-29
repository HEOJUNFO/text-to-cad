/**
 * A review scope is renderer input, and its revisions become git argv. A
 * `from` of `--output=/any/file` would be read by `git diff` as an option and
 * write wherever it names, so a scope is checked before git is started at all.
 */
import type * as Execa from "execa";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("a file's diff in an unmarked scope is refused with the reason, not answered from the working tree", async () => {
    await expect(git.fileDiff(process.cwd(), "package.json", { kind: "unmarked", scope: "turn" })).rejects.toThrow(
      /no turn recorded/i,
    );
    await expect(
      git.unifiedDiff(process.cwd(), "package.json", { kind: "unmarked", scope: "session" }),
    ).rejects.toThrow(/no session start recorded/i);
  });
});
