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

  it("accepts every scope the review header can send, and a recorded mark", () => {
    for (const named of ReviewScopeSchema.options) {
      expect(() => git.assertSafeScope(resolveDiffScope(diffScopeFor(named), null))).not.toThrow();
    }
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(() => git.assertSafeScope({ kind: "range", from: sha })).not.toThrow();
    expect(() => git.assertSafeScope({ kind: "range", from: sha, to: sha })).not.toThrow();
  });
});
