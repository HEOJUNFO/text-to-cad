/**
 * Git, as the review tab needs it: what changed, by how much, and the diff.
 *
 * The `git` CLI, not a library. Every answer here is one `git` invocation and
 * a parser, which means the app agrees with what the person sees in their own
 * terminal — including their `.gitattributes`, their `diff.external`, their
 * submodules and their line-ending config. A reimplementation of git's diff
 * that disagreed with git in one of those cases would be worse than no diff.
 *
 * Two halves, in order: what the review tab reads (status, diffs, commit,
 * push) and what the git modes need (plan §9) — repository detection,
 * worktree creation, listing, removal and the keep-limit sweep, and
 * `Create pull request` through `gh`. Which mode a session gets and where its
 * worktree goes is `projects/workspace.ts`; this file has no opinion about
 * settings, sessions or the app's directories.
 *
 * The parsers are exported and pure: `git`'s porcelain formats are stable and
 * fiddly, and they are the part worth a unit test.
 */
import fsp from "node:fs/promises";
import path from "node:path";

import { execa, type Options } from "execa";

import { diffScopeFor, ReviewScopeSchema } from "../../shared/types";
import { trackChild, type ChildKind, type Trackable } from "../children";
import { resolveInRoot } from "../explorer/fs";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** Git's own status letters, narrowed to the ones the badge shows. */
export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export type ChangedFile = {
  /** Repository-relative, POSIX separators. */
  path: string;
  /** Set for a rename: where the file came from. */
  oldPath?: string;
  status: ChangeStatus;
  insertions: number;
  deletions: number;
  /** True when git will not diff it — the review tab says so rather than lying. */
  binary: boolean;
};

export type GitStatus = {
  /** False for a directory that is not a repository. Everything else is empty. */
  isRepository: boolean;
  branch: string | null;
  /** True when HEAD has no commits yet. */
  unborn: boolean;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  insertions: number;
  deletions: number;
  /**
   * Files in the working tree — what `Commit` takes — whatever the scope. The
   * same porcelain read every scope makes anyway, so the review's commit
   * button needs no second, full status.
   */
  workingFiles: number;
  /** The session scope that had no recorded revision; `files` is then empty. */
  unmarked?: "turn" | "session";
  /**
   * A session scope in a repository with no commits yet: no mark could be
   * taken, and every change is new since the repository began, so `files` is
   * the working tree, measured from the start.
   */
  fromStart?: true;
};

/** What a review is taken against. */
export type DiffScope =
  | { kind: "working-tree" }
  /** Everything since a point in time, e.g. "Since 1 hour ago". */
  | { kind: "since"; since: string }
  /** An explicit revision range, `<from>..<to>`. */
  | { kind: "range"; from: string; to?: string }
  /**
   * `Last turn` / `This session` for a session with no recorded mark. There
   * is no revision to measure from, so there is no diff — and substituting
   * the working tree would answer a different question under the same name.
   * The one exception is a repository with no commits yet, where no mark can
   * exist and the working tree *is* everything since the start (`fromStart`).
   */
  | { kind: "unmarked"; scope: "turn" | "session" };

export type FileDiff = {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
  /** The two sides, for a diff editor. Null when git cannot produce one. */
  before: string | null;
  after: string | null;
};

/* -------------------------------------------------------------------------- */
/* Running git                                                                 */
/* -------------------------------------------------------------------------- */

export class GitError extends Error {
  override readonly name = "GitError";
}

const GIT_OPTIONS: Options = {
  // A pager waiting on a TTY that does not exist hangs the call forever, and
  // an editor prompt in a commit does the same. Both are turned off here
  // rather than trusted to the user's config.
  env: { GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  extendEnv: true,
  reject: false,
  stripFinalNewline: false,
  // A `git log` over a large repository can be megabytes; the default 100 MB
  // cap is fine, but a hang is not — a slow network remote must not wedge a
  // pane the user is looking at.
  timeout: 60_000,
};

/**
 * Every process this module starts goes through the child registry
 * (`../children`): a read or a commit in flight is not worth waiting for at
 * quit, and a `fetch` against a slow remote would otherwise hold the exit
 * open. execa's subprocess is a promise with `pid` and `kill` mixed in,
 * which is the shape the registry tracks. `gh pr create` is the one call
 * worth finishing, so it is a service — left alone until `will-quit`.
 */
function tracked<T extends Trackable>(subprocess: T, kind: ChildKind = "probe"): T {
  return trackChild(subprocess, kind);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await tracked(execa("git", args, { ...GIT_OPTIONS, cwd }));
  if (result.failed || result.exitCode !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new GitError(stderr || `git ${args[0]} failed`);
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}

/** Run git, answering `null` instead of throwing. For the optional reads. */
async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  return git(cwd, args).catch(() => null);
}

/**
 * `git diff --no-index <null> <path>`, which is how an untracked file gets a
 * diff at all.
 *
 * It needs its own runner because it reports "the files differ" as **exit code
 * 1** — the same code every other git command uses for failure. Through
 * `tryGit` that becomes `null`, and a new file in a review shows no diff and
 * `+0 −0`, which is wrong in exactly the place the number matters.
 */
async function gitNoIndex(
  cwd: string,
  extra: string[],
  filePath: string,
): Promise<string | null> {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const result = await tracked(execa(
    "git",
    ["diff", "--no-index", ...extra, "--", nullDevice, filePath],
    { ...GIT_OPTIONS, cwd },
  )).catch(() => null);
  if (!result || (result.exitCode !== 0 && result.exitCode !== 1)) {
    return null;
  }
  return typeof result.stdout === "string" ? result.stdout : null;
}

/**
 * A review path is renderer input: repository-relative, never absolute, never
 * climbing. Refused lexically, before git or the file system is asked
 * anything about it.
 */
function assertRepositoryPath(filePath: string): void {
  if (
    filePath === "" ||
    filePath.includes("\0") ||
    path.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    filePath.split(/[\\/]/).includes("..")
  ) {
    throw new GitError("that path is outside the repository");
  }
}

/**
 * Where a repository-relative file is on disk, refused when any directory on
 * the way resolves outside the repository (`resolveInRoot`, after realpath).
 *
 * The file itself is not followed: a symlink is shown as its link text, the
 * way git stores and diffs it, so an untracked `creds -> ~/.aws/credentials`
 * reviews as a one-line path rather than as the credentials.
 */
async function pathInRepository(root: string, filePath: string): Promise<string> {
  assertRepositoryPath(filePath);
  const directory = await resolveInRoot(root, path.dirname(filePath)).catch(() => {
    throw new GitError("that path is outside the repository");
  });
  return path.join(directory, path.basename(filePath));
}

/** A working-tree file's bytes, or a symlink's link text; null when it is gone. */
async function readWorkingBytes(absolute: string): Promise<Buffer | null> {
  const stat = await fsp.lstat(absolute).catch(() => null);
  if (!stat) {
    return null;
  }
  if (stat.isSymbolicLink()) {
    return Buffer.from(await fsp.readlink(absolute).catch(() => ""));
  }
  return stat.isFile() ? fsp.readFile(absolute).catch(() => null) : null;
}

/** The repository root containing `cwd`, or null when there is none. */
export async function repositoryRoot(cwd: string): Promise<string | null> {
  const root = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  return root ? path.normalize(root.trim()) : null;
}

/* -------------------------------------------------------------------------- */
/* Parsers                                                                     */
/* -------------------------------------------------------------------------- */

const STATUS_LETTERS: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added",
  T: "modified",
  U: "modified",
  "?": "untracked",
};

/**
 * `git status --porcelain=v1 -z --branch --untracked-files=all`.
 *
 * NUL-separated because a path with a newline in it is legal and a
 * line-oriented parser silently drops the rest of the list when it meets one.
 * A rename record is two NUL-terminated entries in a row: the new path, then
 * the old one.
 */
export function parsePorcelainStatus(output: string): {
  branch: string | null;
  unborn: boolean;
  ahead: number;
  behind: number;
  files: Omit<ChangedFile, "insertions" | "deletions" | "binary">[];
} {
  const records = output.split("\0");
  let branch: string | null = null;
  let unborn = false;
  let ahead = 0;
  let behind = 0;
  const files: Omit<ChangedFile, "insertions" | "deletions" | "binary">[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }

    if (record.startsWith("## ")) {
      const header = record.slice(3);
      // `## main...origin/main [ahead 2, behind 1]`, or
      // `## No commits yet on main`.
      if (header.startsWith("No commits yet on ")) {
        unborn = true;
        branch = header.slice("No commits yet on ".length).trim();
        continue;
      }
      // `git status -z --branch` writes `## HEAD (no branch)` when HEAD is
      // detached. Testing the whole header rather than the parsed name: the
      // space in it is what the split below would otherwise eat, leaving a
      // branch called "HEAD".
      if (header.startsWith("HEAD (no branch)")) {
        continue;
      }
      const [names, tracking] = splitOnce(header, " ");
      branch = splitOnce(names, "...")[0] || null;
      ahead = Number(/ahead (\d+)/.exec(tracking ?? "")?.[1] ?? 0);
      behind = Number(/behind (\d+)/.exec(tracking ?? "")?.[1] ?? 0);
      continue;
    }

    // `XY path`, where X is the index status and Y the worktree's.
    const codes = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!filePath) {
      continue;
    }
    const staged = codes[0] ?? " ";
    const unstaged = codes[1] ?? " ";
    const letter = staged !== " " && staged !== "?" ? staged : unstaged;
    const status = STATUS_LETTERS[letter] ?? "modified";

    // Either side: `git add -N` on a moved file gives a worktree-side rename,
    // ` R new\0old\0`, whose old path is a record of its own all the same.
    if (staged === "R" || staged === "C" || unstaged === "R" || unstaged === "C") {
      // The old path is the next NUL-terminated record.
      const oldPath = records[index + 1];
      index += 1;
      files.push({ path: filePath, status, ...(oldPath ? { oldPath } : {}) });
      continue;
    }
    files.push({ path: filePath, status });
  }

  return { branch, unborn, ahead, behind, files };
}

/**
 * `git diff --numstat -z`: `<insertions>\t<deletions>\t<path>`, with `-` for
 * both counts when the file is binary. A rename is three NUL-separated fields
 * instead of one path: an empty path, then old, then new.
 */
export function parseNumstat(output: string): Map<
  string,
  { insertions: number; deletions: number; binary: boolean; oldPath?: string }
> {
  const counts = new Map<
    string,
    { insertions: number; deletions: number; binary: boolean; oldPath?: string }
  >();
  const records = output.split("\0");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const parts = record.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const [rawInsertions, rawDeletions, rawPath] = parts as [string, string, string];
    const binary = rawInsertions === "-" || rawDeletions === "-";
    const entry = {
      insertions: binary ? 0 : Number(rawInsertions) || 0,
      deletions: binary ? 0 : Number(rawDeletions) || 0,
      binary,
    };

    if (rawPath === "") {
      // Rename: the old and new paths are the next two records.
      const oldPath = records[index + 1] ?? "";
      const newPath = records[index + 2] ?? "";
      index += 2;
      if (newPath) {
        counts.set(newPath, { ...entry, oldPath });
      }
      continue;
    }
    counts.set(rawPath, entry);
  }

  return counts;
}

/** `a...b` -> `["a", "b"]`; no separator -> `["a...b", ""]`. */
function splitOnce(value: string, separator: string): [string, string] {
  const at = value.indexOf(separator);
  return at < 0 ? [value, ""] : [value.slice(0, at), value.slice(at + separator.length)];
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

/** The empty answer, for a directory that is not a repository. */
export function emptyStatus(): GitStatus {
  return {
    isRepository: false,
    branch: null,
    unborn: false,
    ahead: 0,
    behind: 0,
    files: [],
    insertions: 0,
    deletions: 0,
    workingFiles: 0,
  };
}

/**
 * What has changed, with per-file counts.
 *
 * Untracked files get counts too, by diffing them against the empty blob —
 * `git diff --numstat` says nothing about a file git has never seen, and a
 * review that shows a new 400-line file as `+0 −0` is wrong in the one place
 * the number matters.
 */
export async function status(cwd: string, scope: DiffScope = { kind: "working-tree" }): Promise<GitStatus> {
  assertSafeScope(scope);
  const root = await repositoryRoot(cwd);
  if (!root) {
    return emptyStatus();
  }

  const porcelain = parsePorcelainStatus(
    await git(root, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]),
  );

  if (scope.kind === "unmarked" && !porcelain.unborn) {
    return {
      isRepository: true,
      branch: porcelain.branch,
      unborn: porcelain.unborn,
      ahead: porcelain.ahead,
      behind: porcelain.behind,
      files: [],
      insertions: 0,
      deletions: 0,
      workingFiles: porcelain.files.length,
      unmarked: scope.scope,
    };
  }

  // An unmarked scope that got here is in a repository with no commits: the
  // working tree is everything since the start.
  const files =
    scope.kind === "working-tree" || scope.kind === "unmarked"
      ? await workingTreeFiles(root, porcelain)
      : await rangeFiles(root, scope, porcelain);

  return {
    isRepository: true,
    branch: porcelain.branch,
    unborn: porcelain.unborn,
    ahead: porcelain.ahead,
    behind: porcelain.behind,
    files,
    insertions: files.reduce((total, file) => total + file.insertions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    workingFiles: porcelain.files.length,
    ...(scope.kind === "unmarked" ? { fromStart: true as const } : {}),
  };
}

async function workingTreeFiles(
  root: string,
  porcelain: ReturnType<typeof parsePorcelainStatus>,
): Promise<ChangedFile[]> {
  // Tracked changes, staged and unstaged in one number: the review shows the
  // working tree against HEAD, which is what "22 files changed" means. With
  // no commits yet there is no HEAD, and the staged files are measured from
  // the empty tree — otherwise every one of them reads +0 −0.
  const from = porcelain.unborn ? await emptyTree(root) : "HEAD";
  const numstat = from
    ? parseNumstat(await git(root, ["diff", "--numstat", "-z", "-M", "--end-of-options", from]))
    : new Map() as ReturnType<typeof parseNumstat>;

  const files: ChangedFile[] = [];
  for (const file of porcelain.files) {
    const counted = numstat.get(file.path);
    if (counted) {
      files.push({ ...file, ...counted, oldPath: counted.oldPath ?? file.oldPath });
      continue;
    }
    if (file.status === "untracked") {
      files.push({ ...file, ...(await countUntracked(root, file.path)) });
      continue;
    }
    files.push({ ...file, insertions: 0, deletions: 0, binary: false });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * An untracked file's counts, read off the file rather than out of git.
 *
 * `git diff --no-index /dev/null <file>` gives the same answer, and for a
 * checkout with sixty new files that is sixty process spawns before the review
 * can draw its header — the difference between "instant" and "three seconds".
 * A file git has never seen is entirely insertions, so the answer is its line
 * count, and "binary" is the same NUL-byte test git itself uses.
 */
async function countUntracked(root: string, filePath: string) {
  const absolute = await pathInRepository(root, filePath).catch(() => null);
  const buffer = absolute ? await readWorkingBytes(absolute) : null;
  if (!buffer) {
    return { insertions: 0, deletions: 0, binary: false };
  }
  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 8000));
  if (sample.includes(0)) {
    return { insertions: 0, deletions: 0, binary: true };
  }
  let lines = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) {
      lines += 1;
    }
  }
  // A file with no trailing newline still has a last line.
  if (buffer.byteLength > 0 && buffer[buffer.byteLength - 1] !== 0x0a) {
    lines += 1;
  }
  return { insertions: lines, deletions: 0, binary: false };
}

async function rangeFiles(
  root: string,
  scope: DiffScope,
  porcelain: ReturnType<typeof parsePorcelainStatus>,
): Promise<ChangedFile[]> {
  const base = await baseRevision(root, scope);
  if (!base) {
    return [];
  }
  const numstat = parseNumstat(await git(root, ["diff", "--numstat", "-z", "-M", "--end-of-options", base]));
  const nameStatus = await git(root, ["diff", "--name-status", "-z", "-M", "--end-of-options", base]);
  const statuses = parseNameStatus(nameStatus);

  const files: ChangedFile[] = [...numstat.entries()].map(([filePath, counted]) => ({
    path: filePath,
    status: statuses.get(filePath) ?? "modified",
    insertions: counted.insertions,
    deletions: counted.deletions,
    binary: counted.binary,
    ...(counted.oldPath ? { oldPath: counted.oldPath } : {}),
  }));

  // An open-ended range — `git diff <base>` with no second revision — is
  // measured against the working tree, and `git diff` says nothing about a
  // file git has never seen. Without this a "since this turn began" review of
  // a turn whose whole output was new files shows nothing at all, which is the
  // one case the scope exists for.
  if (openEnded(scope)) {
    for (const file of porcelain.files) {
      if (file.status === "untracked" && !numstat.has(file.path)) {
        files.push({ ...file, ...(await countUntracked(root, file.path)) });
      }
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * A scope's revisions are renderer input and become bare git argv, where
 * `--output=/any/file` is an option, not a revision. The only revisions a
 * review is taken against are the session's recorded marks — full SHAs from
 * `rev-parse HEAD` — and the only `since` values are the review header's
 * presets, so anything else is refused before git starts. `--end-of-options`
 * at each call site is the second lock on the same door.
 */
const REVISION = /^[0-9a-f]{4,64}$/;
const SINCE_PRESETS: ReadonlySet<string> = new Set(
  ReviewScopeSchema.options.flatMap((named) => {
    const scope = diffScopeFor(named);
    return scope.kind === "since" ? [scope.since] : [];
  }),
);

export function assertSafeScope(scope: DiffScope): void {
  if (scope.kind === "unmarked") {
    if (scope.scope !== "turn" && scope.scope !== "session") {
      throw new GitError("an unmarked review scope must be turn or session");
    }
  } else if (scope.kind === "range") {
    if (!REVISION.test(scope.from) || (scope.to !== undefined && !REVISION.test(scope.to))) {
      throw new GitError("a review range must be between two commit ids");
    }
  } else if (scope.kind === "since" && !SINCE_PRESETS.has(scope.since)) {
    throw new GitError(`unknown review period: ${scope.since}`);
  }
}

/**
 * A single file's diff in an unmarked scope has no base revision. The review
 * never asks (its status lists no files), so a request is refused with the
 * reason rather than answered against the working tree — except in a
 * repository with no commits, where the working tree is the answer
 * (`status`'s `fromStart`).
 */
async function unmarkedOrRefuse(root: string, scope: DiffScope): Promise<DiffScope> {
  if (scope.kind !== "unmarked") {
    return scope;
  }
  if ((await tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"])) === null) {
    return { kind: "working-tree" };
  }
  throw new GitError(
    scope.scope === "turn"
      ? "no turn recorded yet: Last turn starts with the next prompt"
      : "no session start recorded: This session has no revision to measure from",
  );
}

/** True when the scope's second side is the working tree rather than a revision. */
function openEnded(scope: DiffScope): boolean {
  return scope.kind === "since" || (scope.kind === "range" && !scope.to);
}

/** `git diff --name-status -z`: a status letter and a path per record. */
export function parseNameStatus(output: string): Map<string, ChangeStatus> {
  const statuses = new Map<string, ChangeStatus>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const code = records[index];
    if (!code) {
      continue;
    }
    const letter = code[0] as string;
    const status = STATUS_LETTERS[letter] ?? "modified";
    if (letter === "R" || letter === "C") {
      const newPath = records[index + 2];
      index += 2;
      if (newPath) {
        statuses.set(newPath, status);
      }
      continue;
    }
    const filePath = records[index + 1];
    index += 1;
    if (filePath) {
      statuses.set(filePath, status);
    }
  }
  return statuses;
}

/** The revision a scope is measured from. */
async function baseRevision(root: string, scope: DiffScope): Promise<string | null> {
  if (scope.kind === "range") {
    return scope.to ? `${scope.from}..${scope.to}` : scope.from;
  }
  if (scope.kind === "since") {
    // The newest commit at or before that time. Nothing there means the whole
    // history is newer, so the range starts before the first commit — the
    // empty tree. The root commit would leave its own changes out.
    const revision = await tryGit(root, ["rev-list", "-1", `--before=${scope.since}`, "--end-of-options", "HEAD"]);
    const trimmed = revision?.trim();
    return trimmed || (await emptyTree(root));
  }
  return "HEAD";
}

/* -------------------------------------------------------------------------- */
/* Diffs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The two sides of one file, for the diff editor.
 *
 * Monaco's diff editor renders from two texts, not from a unified patch, so
 * that is what is fetched: the blob at the base revision and the file as it is
 * now. Doing the same thing by parsing a unified patch would mean
 * reconstructing the unchanged context lines the patch omits.
 */
export async function fileDiff(
  cwd: string,
  filePath: string,
  requested: DiffScope = { kind: "working-tree" },
): Promise<FileDiff> {
  assertSafeScope(requested);
  assertRepositoryPath(filePath);
  const root = await repositoryRoot(cwd);
  if (!root) {
    throw new GitError("not a git repository");
  }
  const absolute = await pathInRepository(root, filePath);
  const scope = await unmarkedOrRefuse(root, requested);

  // Scoped to the one path. Asking `status()` for the metadata instead would
  // walk the whole working tree once per open section, and a review of forty
  // files opens three sections before it has drawn.
  const meta = await fileMeta(root, filePath, scope);
  if (meta.binary) {
    return { ...meta, before: null, after: null };
  }

  const base = await baseRevision(root, scope);
  const beforePath = meta.oldPath ?? filePath;

  const before =
    meta.status === "added" || meta.status === "untracked" || !base
      ? ""
      : ((await tryGit(root, ["show", "--end-of-options", `${base.split("..")[0] ?? base}:${beforePath}`])) ?? "");

  const after =
    meta.status === "deleted"
      ? ""
      : // An open-ended scope's second side is the working tree, not a
        // revision: "since this turn began" has to show the edit the agent
        // has not committed, which is every edit it just made.
        scope.kind === "working-tree" || openEnded(scope)
        ? await readWorkingCopy(absolute)
        : ((await tryGit(root, ["show", "--end-of-options", `${scopeTip(scope)}:${filePath}`])) ?? "");

  return { ...meta, before, after };
}

/** One file's status and counts, without walking the tree. */
async function fileMeta(
  root: string,
  filePath: string,
  scope: DiffScope,
): Promise<Omit<FileDiff, "before" | "after">> {
  const base = (await baseRevision(root, scope)) ?? "HEAD";
  // A rename is only seen with both sides in the pathspec: limited to the
  // new path, git sees an added file, and the diff's before side is empty.
  const oldPath = await renamedFrom(root, base, filePath);
  const paths = oldPath ? [filePath, oldPath] : [filePath];
  const numstat = parseNumstat(
    (await tryGit(root, ["diff", "--numstat", "-z", "-M", "--end-of-options", base, "--", ...paths])) ?? "",
  );
  const statuses = parseNameStatus(
    (await tryGit(root, ["diff", "--name-status", "-z", "-M", "--end-of-options", base, "--", ...paths])) ?? "",
  );
  const counted = numstat.get(filePath);

  if (counted) {
    return {
      path: filePath,
      status: statuses.get(filePath) ?? "modified",
      insertions: counted.insertions,
      deletions: counted.deletions,
      binary: counted.binary,
      ...(counted.oldPath ? { oldPath: counted.oldPath } : {}),
    };
  }

  // Nothing against the base means git has never seen it: it is untracked.
  return { path: filePath, status: "untracked", ...(await countUntracked(root, filePath)) };
}

/**
 * Where `filePath` was renamed from since `base`, or undefined. The
 * candidates are the paths deleted since then — usually none, so this is one
 * cheap `git diff --diff-filter=D` — and git pairs them up as it would over
 * the whole tree.
 */
async function renamedFrom(root: string, base: string, filePath: string): Promise<string | undefined> {
  const deleted = ((await tryGit(root, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=D", "--end-of-options", base])) ?? "")
    .split("\0")
    .filter((deletedPath) => deletedPath !== "" && deletedPath !== filePath);
  if (deleted.length === 0) {
    return undefined;
  }
  const records = ((await tryGit(root, ["diff", "--name-status", "-z", "-M", "--end-of-options", base, "--", filePath, ...deleted])) ?? "").split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const code = records[index] ?? "";
    if (code.startsWith("R")) {
      if (records[index + 2] === filePath) {
        return records[index + 1];
      }
      index += 2;
    } else if (code !== "") {
      index += 1;
    }
  }
  return undefined;
}

function scopeTip(scope: DiffScope): string {
  return scope.kind === "range" && scope.to ? scope.to : "HEAD";
}

async function readWorkingCopy(absolute: string): Promise<string> {
  return (await readWorkingBytes(absolute))?.toString("utf8") ?? "";
}

/**
 * The unified patch for one file — what a person copies out of a review, and
 * what `Commit or push` is describing.
 */
export async function unifiedDiff(
  cwd: string,
  filePath: string,
  requested: DiffScope = { kind: "working-tree" },
): Promise<string> {
  assertSafeScope(requested);
  assertRepositoryPath(filePath);
  const root = await repositoryRoot(cwd);
  if (!root) {
    throw new GitError("not a git repository");
  }
  await pathInRepository(root, filePath);
  const scope = await unmarkedOrRefuse(root, requested);
  const base = await baseRevision(root, scope);
  const args = ["diff", "-M", "--patch", "--end-of-options"];
  const from = scope.kind === "working-tree" ? "HEAD" : base;
  if (from) {
    args.push(from);
  }
  const oldPath = from ? await renamedFrom(root, from, filePath) : undefined;
  args.push("--", filePath, ...(oldPath ? [oldPath] : []));
  const patch = await tryGit(root, args);
  if (patch && patch.trim() !== "") {
    return patch;
  }
  // An untracked file has no patch against HEAD; `--no-index` produces one.
  return (await gitNoIndex(root, ["--patch"], filePath)) ?? "";
}

/* -------------------------------------------------------------------------- */
/* Committing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Stage everything and commit. The review tab's `Commit`.
 *
 * `--no-verify` is deliberately *not* passed: a repository's hooks are part of
 * how it wants to be committed to, and skipping them from a GUI is how a
 * broken commit gets made without anyone deciding to make one.
 */
export async function commitAll(cwd: string, message: string): Promise<{ sha: string }> {
  const root = await repositoryRoot(cwd);
  if (!root) {
    throw new GitError("not a git repository");
  }
  if (message.trim() === "") {
    throw new GitError("a commit needs a message");
  }
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", message]);
  const sha = (await git(root, ["rev-parse", "HEAD"])).trim();
  return { sha };
}

/** Push the current branch, setting upstream when it has none. */
export async function push(cwd: string): Promise<void> {
  const root = await repositoryRoot(cwd);
  if (!root) {
    throw new GitError("not a git repository");
  }
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (branch === "HEAD") {
    throw new GitError("cannot push a detached HEAD");
  }
  const upstream = await tryGit(root, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  await git(root, upstream ? ["push"] : ["push", "--set-upstream", "origin", branch]);
}

/* -------------------------------------------------------------------------- */
/* Repository detection (P7)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What the composer's git-mode chip needs to know before it offers a mode,
 * and what the settings page prints beside a project.
 *
 * One call, because every field is cheap and the caller wants all of them:
 * asking four channels whether a directory is a repository, on what branch,
 * tracking what, and whether it is dirty, is four round trips to answer one
 * question.
 */
export type RepoInfo = {
  isRepository: boolean;
  /** The repository root, which is not necessarily the directory asked about. */
  root: string | null;
  branch: string | null;
  /** `origin/main`, or null when the branch tracks nothing. */
  upstream: string | null;
  /** The remote's default branch, for a pull request's base. */
  defaultBranch: string | null;
  /** Any staged, unstaged or untracked change. */
  dirty: boolean;
  detached: boolean;
  /** HEAD points at a branch with no commits: nothing can be branched from it. */
  unborn: boolean;
  hasRemote: boolean;
};

export function emptyRepoInfo(): RepoInfo {
  return {
    isRepository: false,
    root: null,
    branch: null,
    upstream: null,
    defaultBranch: null,
    dirty: false,
    detached: false,
    unborn: false,
    hasRemote: false,
  };
}

export async function repoInfo(cwd: string): Promise<RepoInfo> {
  const root = await repositoryRoot(cwd);
  if (!root) {
    return emptyRepoInfo();
  }

  const [branchName, symbolic, porcelain, remotes, verified] = await Promise.all([
    tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    // `rev-parse --abbrev-ref HEAD` fails outright in a repository with no
    // commits, so the branch git *would* create comes from `symbolic-ref`.
    // Without it a fresh `git init` reads as detached, and the mode chip would
    // say a repository has no branch when the person is standing on one.
    tryGit(root, ["symbolic-ref", "--short", "HEAD"]),
    // `-z` and `--untracked-files=all`: the same read `status()` makes, so
    // "dirty" here and "there are changes to review" there cannot disagree.
    tryGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    tryGit(root, ["remote"]),
    // No commits yet: `rev-parse HEAD` fails while `--abbrev-ref HEAD` still
    // names the branch git would create on the first commit.
    tryGit(root, ["rev-parse", "--verify", "HEAD"]),
  ]);

  const branch = (branchName?.trim() || symbolic?.trim()) ?? "";
  const detached = branch === "HEAD" || branch === "";

  const upstream = detached
    ? null
    : (await tryGit(root, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]))?.trim() || null;

  return {
    isRepository: true,
    root,
    branch: detached ? null : branch,
    upstream,
    defaultBranch: await defaultBranchOf(root),
    dirty: (porcelain ?? "").split("\0").some((record) => record !== ""),
    detached,
    unborn: verified === null,
    hasRemote: (remotes ?? "").trim() !== "",
  };
}

/**
 * The branch a pull request should target.
 *
 * `origin/HEAD` is the remote's own answer and what `gh` uses; a checkout
 * cloned before the default was renamed may not have it, so the fallback is
 * whichever of the usual two exists on the remote, and then nothing — a null
 * base lets `gh` pick, which is better than guessing `master` at a repository
 * that has not had one for five years.
 */
async function defaultBranchOf(root: string): Promise<string | null> {
  const symbolic = await tryGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const named = symbolic?.trim().replace(/^origin\//, "");
  if (named) {
    return named;
  }
  for (const candidate of ["main", "master"]) {
    if (await tryGit(root, ["rev-parse", "--verify", `refs/remotes/origin/${candidate}`])) {
      return candidate;
    }
  }
  return null;
}

/** The commit HEAD is at, or null in a repository with no commits. */
export async function head(cwd: string): Promise<string | null> {
  const sha = await tryGit(cwd, ["rev-parse", "HEAD"]);
  return sha?.trim() || null;
}

/** How a git run ended: the exit code is undefined when git was killed or never started. */
export type GitRunResult = { exitCode: number | undefined; stdout: string; stderr: string; timedOut: boolean };
export type GitRunner = (cwd: string, args: string[], input?: string) => Promise<GitRunResult>;

/**
 * Run git on the tracked spawn and report how it ended, never throwing — for
 * the callers that must tell "git said no" (an exit code) from "git could not
 * say" (a timeout, a spawn error), which `tryGit` folds together.
 */
export const runGit: GitRunner = async (cwd, args, input) => {
  const result = await tracked(execa("git", args, { ...GIT_OPTIONS, cwd, ...(input === undefined ? {} : { input }) })).catch(() => null);
  if (!result) return { exitCode: undefined, stdout: "", stderr: "", timedOut: false };
  return {
    exitCode: typeof result.exitCode === "number" ? result.exitCode : undefined,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    timedOut: Boolean(result.timedOut),
  };
};

/** The empty tree's id, asked of git so a SHA-256 repository answers in its own format. */
async function emptyTree(cwd: string): Promise<string | null> {
  const tree = await runGit(cwd, ["hash-object", "-t", "tree", "--stdin"], "");
  const id = tree.exitCode === 0 && !tree.timedOut ? tree.stdout.trim() : "";
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id) ? id : null;
}

/**
 * The empty tree's id when `cwd` is a repository with no commits yet, and
 * null otherwise — including whenever git cannot answer.
 *
 * `head()` answers null on any failure (a timeout, a spawn error, a ref
 * mid-update), so its null alone does not mean "unborn": marking the empty
 * tree in a repository that has commits would make `Last turn` the whole
 * repository. Unborn is proved instead, in two steps: `symbolic-ref -q HEAD`
 * exits 0 (HEAD names a branch), and then `rev-parse --verify -q HEAD` exits
 * exactly 1 with nothing on stderr — git's quiet "that ref does not resolve".
 * Any other ending (exit 128, a timeout, a spawn error, exit 1 with a message)
 * is git failing to answer, and answers null, never the empty tree. The id is
 * asked of git (`hash-object` without `-w` writes nothing) so a SHA-256
 * repository answers in its own format.
 */
export async function emptyTreeIfUnborn(cwd: string, run: GitRunner = runGit): Promise<string | null> {
  const symbolic = await run(cwd, ["symbolic-ref", "-q", "HEAD"]);
  if (symbolic.exitCode !== 0 || symbolic.timedOut) {
    return null;
  }
  const verified = await run(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (verified.exitCode !== 1 || verified.timedOut || verified.stderr.trim() !== "") {
    return null;
  }
  const tree = await run(cwd, ["hash-object", "-t", "tree", "--stdin"], "");
  const id = tree.exitCode === 0 && !tree.timedOut ? tree.stdout.trim() : "";
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id) ? id : null;
}

/**
 * Whether anything is uncommitted — the check `removeWorktree` refuses on.
 *
 * Throws when git cannot answer (a timeout, a lock, a broken repository):
 * "could not look" read as "clean" is how a sweep deletes somebody's work.
 */
export async function isDirty(cwd: string): Promise<boolean> {
  const porcelain = await git(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return porcelain.split("\0").some((record) => record !== "");
}

/**
 * Ignored paths that are only ever a rebuild away, so removing a worktree
 * with them in it loses nothing: dependency installs, virtualenvs and
 * interpreter/tool caches. Anything else ignored — `.env`, generated STEP and
 * GLB files, local config — is somebody's work, and `git worktree remove`
 * deletes it without a word. Kept short on purpose: a name missing from here
 * only means a worktree is kept that could have gone.
 */
export const DISPOSABLE_IGNORED = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".DS_Store",
]);

function disposable(ignoredPath: string): boolean {
  return (
    ignoredPath.replace(/\/$/, "").split("/").some((segment) => DISPOSABLE_IGNORED.has(segment)) ||
    ignoredPath.endsWith(".pyc")
  );
}

/**
 * Ignored files in `cwd` that removing the worktree would delete, minus the
 * disposable caches above. `--ignored=matching` names an ignored directory
 * once rather than every file in it. Throws when git cannot answer, as
 * `isDirty` does.
 */
export async function ignoredFiles(cwd: string): Promise<string[]> {
  const porcelain = await git(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--ignored=matching",
    "--untracked-files=all",
  ]);
  return porcelain
    .split("\0")
    .filter((record) => record.startsWith("!! "))
    .map((record) => record.slice(3))
    .filter((ignoredPath) => ignoredPath !== "" && !disposable(ignoredPath));
}

/**
 * Anything removing a worktree would lose: uncommitted changes, or ignored
 * files that are not a disposable cache. What the sweep and a non-forced
 * `removeWorktree` refuse on, and what Settings shows as "dirty".
 *
 * Null when git could not say — which every caller treats as "keep it",
 * never as clean.
 */
export async function hasUnsavedWork(cwd: string): Promise<boolean | null> {
  try {
    return (await isDirty(cwd)) || (await ignoredFiles(cwd)).length > 0;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Slugs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A directory and branch name made from a session's first prompt.
 *
 * Lowercase ASCII words joined by hyphens, because the name becomes both a
 * path component and a git ref: a ref may not contain a space, `~^:?*[\`, two
 * consecutive dots or a trailing dot, and a path on Windows may not contain
 * `<>:"|?*`. Restricting to `[a-z0-9-]` satisfies both without a table of
 * per-platform exceptions.
 *
 * Input with nothing left after the filter answers `""`: what a nameless
 * session is called is a product decision, and this is a string function.
 */
export function slugify(name: string, max = 40): string {
  const slug = name
    .normalize("NFKD")
    // Strip the combining marks NFKD just separated, so "Modèle" becomes
    // "modele" rather than "mod-le". `\p{M}` and not `\p{Diacritic}`: the
    // latter also matches the ASCII `^`, `~`, `` ` `` and `"`, which are
    // separators here and would be deleted, gluing two words together.
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= max) {
    return slug;
  }
  // Cut at a word boundary when there is one near the limit, so the name stays
  // readable instead of ending mid-word.
  const cut = slug.slice(0, max);
  const boundary = cut.lastIndexOf("-");
  return (boundary > max / 2 ? cut.slice(0, boundary) : cut).replace(/-+$/, "");
}

/* -------------------------------------------------------------------------- */
/* Worktrees                                                                   */
/* -------------------------------------------------------------------------- */

export type WorktreeInfo = {
  /** Absolute path, normalised. */
  path: string;
  /** Short branch name, or null when the worktree is detached. */
  branch: string | null;
  head: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  /**
   * git could not find the folder (`prunable`). Not proof it was deleted: git
   * says the same of a folder it cannot read, so `folderGone` is asked too.
   */
  prunable: boolean;
  /** The repository's own working tree — the one that cannot be removed. */
  primary: boolean;
};

/**
 * `git worktree list --porcelain [-z]`.
 *
 * Both forms parse here. With `-z` every attribute is NUL-terminated and a
 * record ends with an extra NUL; without it they are newline-terminated. The
 * only difference is the terminator, so the NULs are folded to newlines and
 * one parser reads both — and `-z` is what is asked for, so a path with a
 * newline in it does not silently end the record.
 *
 * The first record is always the main working tree.
 */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;

  for (const line of output.replace(/\0/g, "\n").split("\n")) {
    if (line === "") {
      continue;
    }
    const [key, value] = splitOnce(line, " ");
    if (key === "worktree") {
      current = {
        path: path.normalize(value),
        branch: null,
        head: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        primary: worktrees.length === 0,
      };
      worktrees.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (key === "HEAD") {
      current.head = value;
    } else if (key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (key === "bare") {
      current.bare = true;
    } else if (key === "detached") {
      current.detached = true;
    } else if (key === "locked") {
      current.locked = true;
    } else if (key === "prunable") {
      current.prunable = true;
    }
  }

  return worktrees;
}

/** Every worktree of the repository containing `cwd`, the main one first. */
export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const root = await repositoryRoot(cwd);
  if (!root) {
    return [];
  }
  // `-z` first; a git too old for it fails, and the plain form parses the same.
  const zero = await tryGit(root, ["worktree", "list", "--porcelain", "-z"]);
  const output = zero ?? (await tryGit(root, ["worktree", "list", "--porcelain"])) ?? "";
  return parseWorktreeList(output);
}

export type CreateWorktreeOptions = {
  /** Any directory inside the repository to branch from. */
  repoPath: string;
  /** Where the worktree directory goes: `<worktreeRoot>/<project>`. */
  parentDir: string;
  /** The name to slugify — a session's first prompt, usually. */
  name?: string;
  /** From settings; `text-to-cad/` by default. */
  branchPrefix?: string;
  /**
   * From settings: fetch the remote first, and branch from the current
   * branch's upstream (or the remote's default branch when it has none) so
   * the worktree starts from the server. HEAD when neither exists or the
   * fetch fails.
   */
  fetch?: boolean;
  /** What to branch from. Defaults to HEAD, or the fetched remote branch with `fetch`. */
  base?: string;
};

export type CreatedWorktree = {
  path: string;
  branch: string;
  /** The revision the branch was cut from, for the record. */
  base: string;
};

/**
 * A new branch in a new worktree under `parentDir` (plan §9).
 *
 * Worktrees live outside the project on purpose: one inside the checkout is a
 * directory the project's own tools index, test and lint, and every agent
 * working in one would see all the others' trees.
 *
 * The name is made unique against both the filesystem and the ref namespace
 * before `git worktree add` runs. Letting git fail on the collision instead
 * would be one error message for two different problems — a directory in the
 * way, and a branch someone else is already on.
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<CreatedWorktree> {
  const root = await repositoryRoot(options.repoPath);
  if (!root) {
    throw new GitError("Project is not a git repository, worktree mode unavailable");
  }
  if ((await head(root)) === null) {
    throw new GitError("This repository has no commits yet, so there is nothing to branch from");
  }

  let fetched: string | null = null;
  if (options.fetch && options.base === undefined) {
    // Best-effort: a laptop on a plane must still get a worktree. The branch
    // then starts from what the checkout already has, which is what the user
    // would get by hand.
    if ((await tryGit(root, ["fetch", "--quiet", "--prune"])) !== null) {
      fetched = await remoteBase(root);
    }
  }

  const prefix = options.branchPrefix ?? "text-to-cad/";
  const stem = slugify(options.name ?? "") || generatedName();
  const base = options.base ?? fetched ?? "HEAD";

  await assertPrefixUsable(root, prefix);
  const { directory, branch } = await uniqueName(root, options.parentDir, prefix, stem);

  await fsp.mkdir(options.parentDir, { recursive: true });
  // `--no-track`: a branch cut from `origin/main` would otherwise track it,
  // and the review's `Push` would then aim at main instead of its own name.
  await git(root, ["worktree", "add", "--no-track", "-b", branch, directory, base]);

  return {
    path: path.normalize(directory),
    branch,
    base: (await head(directory)) ?? base,
  };
}

/**
 * What a fetched worktree branches from: the current branch's upstream, else
 * the remote's default branch, as a commit id — or null to use HEAD.
 */
async function remoteBase(root: string): Promise<string | null> {
  const upstream = await tryGit(root, ["rev-parse", "--verify", "--quiet", "@{upstream}^{commit}"]);
  if (upstream?.trim()) {
    return upstream.trim();
  }
  const fallback = await defaultBranchOf(root);
  if (!fallback) {
    return null;
  }
  const remote = await tryGit(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${fallback}^{commit}`]);
  return remote?.trim() || null;
}

/**
 * A ref is a file under `.git/refs`, so a branch `amy` and a branch `amy/x`
 * cannot both exist: with the prefix `amy/` and a branch called `amy`, every
 * `git worktree add -b amy/…` fails with "cannot lock ref", whatever the
 * name after it. No suffix helps, so it is refused once, naming the branch in
 * the way.
 */
async function assertPrefixUsable(root: string, prefix: string): Promise<void> {
  const segments = prefix.split("/").filter((segment) => segment !== "");
  // `amy/` names a folder of branches; `amy-` (no slash) names none.
  const folders = prefix.endsWith("/") ? segments.length : segments.length - 1;
  for (let depth = 1; depth <= folders; depth += 1) {
    const blocking = segments.slice(0, depth).join("/");
    if (await tryGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${blocking}`])) {
      throw new GitError(
        `The branch prefix "${prefix}" cannot be used here: this repository already has a branch called "${blocking}", and git cannot keep both "${blocking}" and "${blocking}/…". Change the prefix in Settings › Git and worktrees, or rename that branch.`,
      );
    }
  }
}

/** `session-4f2c`: enough to tell two nameless threads apart, short enough to read. */
function generatedName(): string {
  return `session-${Math.random().toString(16).slice(2, 6)}`;
}

/**
 * The first of `<stem>`, `<stem>-2`, `<stem>-3`… whose directory does not
 * exist and whose branch is not taken.
 *
 * Taken means locally *or on a remote*, as far as this checkout knows (after
 * the fetch, when `fetchBeforeCreate` asked for one): an `origin/<prefix>/<slug>`
 * someone else pushed is a branch the review's `Push` would be rejected by —
 * or, when theirs is behind, would silently advance.
 */
async function uniqueName(
  root: string,
  parentDir: string,
  prefix: string,
  stem: string,
): Promise<{ directory: string; branch: string }> {
  const remote = ((await tryGit(root, ["for-each-ref", "--format=%(refname)", "refs/remotes/"])) ?? "")
    .split("\n")
    .filter((ref) => ref !== "");
  const onRemote = (branch: string) => remote.some((ref) => ref.endsWith(`/${branch}`));
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const name = attempt === 1 ? stem : `${stem}-${attempt}`;
    const directory = path.join(parentDir, name);
    const branch = `${prefix}${name}`;
    const exists = await fsp.stat(directory).then(
      () => true,
      () => false,
    );
    if (exists) {
      continue;
    }
    if (onRemote(branch) || await tryGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
      continue;
    }
    // `<branch>/…` existing blocks `<branch>` the same way, from below.
    if ((await tryGit(root, ["for-each-ref", "--count=1", "--format=%(refname)", `refs/heads/${branch}/`]))?.trim()) {
      continue;
    }
    return { directory, branch };
  }
  throw new GitError(`a hundred worktrees are already called ${stem}`);
}

/**
 * Remove a worktree's directory and git's registration of it.
 *
 * Uncommitted work is refused rather than discarded — and so are ignored
 * files outside the disposable caches (`.env`, generated STEP/GLB), which
 * `git worktree remove` deletes even unforced. `--force` deletes both, and a button in a settings page is not
 * where someone decides to lose an afternoon. The branch is left behind —
 * deleting a checkout is reversible, deleting the commits on it is not.
 *
 * A folder deleted by hand is still registered (`prunable`), and git cannot
 * be asked about it from inside. With `repoPath` the registration is removed
 * from the repository instead — there is nothing left on disk to lose, and
 * without this Delete errors on it and the sweep skips it forever.
 */
export async function removeWorktree(
  worktreePath: string,
  options: { force?: boolean; repoPath?: string } = {},
): Promise<void> {
  const gone = await folderGone(worktreePath);
  const root = gone && options.repoPath
    ? await repositoryRoot(options.repoPath)
    : await repositoryRoot(worktreePath);
  if (!root) {
    throw new GitError("that worktree is no longer a git repository");
  }
  const target = (await listWorktrees(root)).find((candidate) =>
    samePath(candidate.path, worktreePath),
  );
  if (!target) {
    throw new GitError("git does not know that worktree");
  }
  if (target.primary) {
    throw new GitError("that is the repository itself, not a worktree");
  }
  // Both have to agree. git's `prunable` alone is any folder it cannot see,
  // an unreadable one included; our own ENOENT alone could be a folder that
  // reappeared between the two reads.
  const missing = gone && target.prunable;
  if (missing) {
    await git(root, ["worktree", "remove", target.path]);
    return;
  }
  const unchecked = (error: unknown) => {
    throw new GitError(`could not check that worktree for unsaved work, so it was kept: ${error instanceof Error ? error.message : String(error)}`);
  };
  if (!options.force && (await isDirty(worktreePath).catch(unchecked))) {
    throw new GitError("that worktree has uncommitted changes");
  }
  if (!options.force) {
    const ignored = await ignoredFiles(worktreePath).catch(unchecked);
    if (ignored.length > 0) {
      const named = ignored.slice(0, 3).join(", ") + (ignored.length > 3 ? `, and ${ignored.length - 3} more` : "");
      throw new GitError(`that worktree has ignored files that removing it would delete: ${named}`);
    }
  }
  await git(root, ["worktree", "remove", ...(options.force ? ["--force"] : []), worktreePath]);
}

/**
 * True when a worktree's folder is not there — ENOENT, or a path through a
 * file. Any other failure (EACCES, EIO, a volume that is not mounted) is a
 * folder that may still hold work, and throws: reading "could not look" as
 * "deleted by hand" is how a removal unregisters somebody's checkout.
 */
async function folderGone(folder: string): Promise<boolean> {
  try {
    await fsp.stat(folder);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return true;
    }
    throw new GitError(`could not read that worktree's folder (${code ?? String(error)}), so it was kept`);
  }
}

/**
 * `git branch -d`: delete a branch only when its commits are reachable from
 * HEAD, so nothing on it is lost. Answers whether it went.
 */
export async function deleteMergedBranch(repoPath: string, branch: string): Promise<boolean> {
  return (await tryGit(repoPath, ["branch", "-d", "--end-of-options", branch])) !== null;
}

/**
 * Delete a branch only while it still points at `base`, the commit it was cut
 * from — so it holds nothing of its own, wherever HEAD is. For a create that
 * failed: its branch may start at a fetched remote tip the checkout is
 * behind, which `git branch -d` refuses as unmerged. `update-ref -d` with the
 * old value is that check and the delete in one step, so a commit landing in
 * between is kept rather than raced. Answers whether it went.
 */
export async function deleteBranchAtBase(repoPath: string, branch: string, base: string): Promise<boolean> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base)) {
    return false;
  }
  return (await tryGit(repoPath, ["update-ref", "-d", `refs/heads/${branch}`, base])) !== null;
}

/** Path comparison that survives a trailing separator and Windows' case rules. */
export function samePath(left: string, right: string): boolean {
  const normalise = (value: string) => path.normalize(value).replace(/[\\/]+$/, "");
  const a = normalise(left);
  const b = normalise(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export type PruneOptions = {
  repoPath: string;
  /** Only worktrees under here (or any of these) are considered: never one the user made. */
  parentDir: string | readonly string[];
  /** How many survive. */
  keep: number;
  /**
   * Directories sessions run in or belong to — never swept, and neither is a
   * worktree that has one of them inside it. A function is asked again right
   * before each removal: the sweep runs beside session creation rather than
   * in front of it, and a session opened while it ran is protected too.
   */
  protectedPaths?: readonly string[] | (() => readonly string[]);
};

/**
 * Sweep the oldest worktrees past the keep limit (Settings › Git and worktrees).
 *
 * Three things are never removed, and each is a separate promise to the user:
 * a worktree text-to-cad did not create (outside `parentDir`), one a session is
 * still open on, and one with uncommitted changes or ignored files that are
 * not a disposable cache (`hasUnsavedWork`). An automatic sweep that
 * could throw work away would make the setting unusable, so it is only ever
 * allowed to remove what the branch can recreate.
 */
export async function pruneWorktrees(options: PruneOptions): Promise<{ removed: string[] }> {
  const worktrees = await listWorktrees(options.repoPath);
  const protectedNow = () =>
    typeof options.protectedPaths === "function" ? options.protectedPaths() : (options.protectedPaths ?? []);
  const parents = typeof options.parentDir === "string" ? [options.parentDir] : options.parentDir;
  // Inside counts too: a session opened on a folder in the worktree is
  // running in it just as much as one at its root.
  const held = (worktreePath: string) => protectedNow().some((protectedPath) =>
    samePath(protectedPath, worktreePath) || isUnder(worktreePath, protectedPath));

  const eligible = worktrees.filter((worktree) =>
    !worktree.primary && !worktree.locked && parents.some((parent) => isUnder(parent, worktree.path)) &&
    !held(worktree.path));
  // Within the limit nothing goes, so nothing needs dating — the usual case,
  // and the one every create would otherwise pay for.
  if (eligible.length <= Math.max(0, options.keep)) {
    return { removed: [] };
  }
  const candidates: { path: string; usedAt: number }[] = [];
  for (const worktree of eligible) {
    candidates.push({ path: worktree.path, usedAt: (await lastWrittenAt(worktree.path)) ?? 0 });
  }

  // Newest first, so the tail is what falls off the end of the limit.
  candidates.sort((left, right) => right.usedAt - left.usedAt);

  const removed: string[] = [];
  for (const candidate of candidates.slice(Math.max(0, options.keep))) {
    // Asked again: dating took a while, and a session may have opened on it since.
    if (held(candidate.path)) {
      continue;
    }
    // Ignored files count as work here: `git worktree remove` deletes them.
    // So does a check that failed: only a proved-clean worktree goes — or a
    // folder deleted by hand, which has nothing left to lose. A folder that
    // could not be read is neither, and stays.
    const gone = await folderGone(candidate.path).catch(() => null);
    if (gone === null || (!gone && (await hasUnsavedWork(candidate.path)) !== false)) {
      continue;
    }
    await removeWorktree(candidate.path, { repoPath: options.repoPath }).then(
      () => removed.push(candidate.path),
      // One worktree that will not go must not stop the sweep: the next launch
      // would meet the same one and the limit would never be enforced.
      () => undefined,
    );
  }
  return { removed };
}

/** How many of a worktree's changed paths `lastWrittenAt` stats, at most. */
const DATED_CHANGES = 200;

/**
 * When anything in a worktree was last written. Null when the folder is gone.
 *
 * Not the folder's own mtime alone, which moves only when an entry directly
 * in it is added or removed — an afternoon of edits in `src/` leaves it where
 * the checkout put it, and the sweep would take the worktree being worked in
 * for the oldest. And not a stat of every file: that was an `ls-files` and
 * an lstat per file per worktree — a million stats for ten worktrees of a
 * large repository, on every create and every Settings visit. Work is either
 * committed or it differs from the commit, so the newest of:
 *
 * - the last commit's time (`log -1 --format=%ct`), and the worktree's own
 *   index file, which every commit, add and checkout rewrites — the commit
 *   time is in whole seconds, the index's mtime is not;
 * - the paths `git status` says differ — git compares each tracked file to
 *   the index's cached stat, in C and without a second listing, and only
 *   what it names is stat'ed here, at most `DATED_CHANGES` of them.
 */
export async function lastWrittenAt(worktreePath: string): Promise<number | null> {
  const folder = await fsp.stat(worktreePath).catch(() => null);
  if (!folder) {
    return null;
  }
  const [committed, indexPath, changed] = await Promise.all([
    tryGit(worktreePath, ["log", "-1", "--format=%ct"]),
    tryGit(worktreePath, ["rev-parse", "--git-path", "index"]),
    tryGit(worktreePath, ["status", "--porcelain=v1", "-z"]),
  ]);
  const seconds = Number(committed?.trim());
  const paths = [
    ...(indexPath?.trim() ? [path.resolve(worktreePath, indexPath.trim())] : []),
    ...parsePorcelainStatus(changed ?? "").files.slice(0, DATED_CHANGES).map((file) => path.join(worktreePath, file.path)),
  ];
  const stats = await Promise.all(paths.map((target) => fsp.lstat(target).catch(() => null)));
  return Math.max(
    folder.mtimeMs,
    Number.isFinite(seconds) ? seconds * 1000 : 0,
    ...stats.map((stat) => stat?.mtimeMs ?? 0),
  );
}

/** True when `child` is inside `parent` — the test that keeps the sweep in its own root. */
export function isUnder(parent: string, child: string): boolean {
  const relative = path.relative(path.normalize(parent), path.normalize(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/* -------------------------------------------------------------------------- */
/* Pull requests                                                               */
/* -------------------------------------------------------------------------- */

let ghPath: Promise<string | null> | null = null;

/**
 * Where `gh` is, or null. Cached: the answer does not change while the app
 * runs, and the review header asks on every render.
 *
 * `env` matters. An app launched from the Dock inherits launchd's PATH, which
 * has never heard of Homebrew — the same reason `agents/shell-env.ts` exists.
 */
export function ghAvailable(env?: NodeJS.ProcessEnv, force = false): Promise<string | null> {
  if (!ghPath || force) {
    const command = process.platform === "win32" ? "where" : "which";
    ghPath = tracked(execa(command, ["gh"], {
      ...GIT_OPTIONS,
      ...(env ? { env, extendEnv: false } : {}),
    }))
      .then((result) =>
        result.exitCode === 0 && typeof result.stdout === "string"
          ? (result.stdout.split(/\r?\n/)[0]?.trim() ?? null) || null
          : null,
      )
      .catch(() => null);
  }
  return ghPath;
}

export type PullRequestOptions = {
  title: string;
  body?: string;
  /** From settings. */
  draft?: boolean;
  /** Defaults to the remote's default branch, and then to gh's own guess. */
  base?: string | null;
  env?: NodeJS.ProcessEnv;
};

/**
 * Open a pull request with `gh`, pushing the branch first when it has no
 * upstream — `gh` would offer to do that interactively, and there is no
 * terminal here to answer it in.
 *
 * The URL comes back rather than being opened: whether a link opens in a
 * browser is the renderer's decision, and a main process that opened one as a
 * side effect would do it in the tests too.
 */
export async function createPullRequest(
  cwd: string,
  options: PullRequestOptions,
): Promise<{ url: string }> {
  const root = await repositoryRoot(cwd);
  if (!root) {
    throw new GitError("not a git repository");
  }
  if (!(await ghAvailable(options.env))) {
    throw new GitError("the GitHub CLI (gh) is not installed");
  }

  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (branch === "HEAD") {
    throw new GitError("cannot open a pull request from a detached HEAD");
  }
  await push(root);

  const base = options.base ?? (await defaultBranchOf(root));
  const result = await tracked(execa(
    "gh",
    [
      "pr",
      "create",
      "--head",
      branch,
      ...(base ? ["--base", base] : []),
      ...(options.draft ? ["--draft"] : []),
      "--title",
      options.title,
      "--body",
      options.body ?? "",
    ],
    {
      ...GIT_OPTIONS,
      cwd: root,
      ...(options.env ? { env: options.env, extendEnv: false } : {}),
    },
  ), "service");

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (result.exitCode === 0) {
    const url = findUrl(stdout) ?? findUrl(stderr);
    if (url) {
      return { url };
    }
    throw new GitError(stderr.trim() || "gh did not print a pull request URL");
  }
  // `already exists: <url>` names *a* pull request from a branch of this name,
  // not necessarily this session's: it is the answer only when it is the
  // person's own and its head is the commit just pushed.
  const existing = /already exists/i.test(stderr) ? findUrl(stderr) : null;
  if (existing && (await ownPullRequest(root, existing, options.env))) {
    return { url: existing };
  }
  throw new GitError(
    existing
      ? `a pull request from a branch called ${branch} already exists, and it is not this one: ${existing}`
      : stderr.trim() || "gh did not print a pull request URL",
  );
}

/** True when the pull request at `url` is the signed-in user's, at this checkout's HEAD. */
async function ownPullRequest(root: string, url: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const gh = (args: string[]) =>
    tracked(execa("gh", args, { ...GIT_OPTIONS, cwd: root, ...(env ? { env, extendEnv: false } : {}) }))
      .then((result) => (result.exitCode === 0 && typeof result.stdout === "string" ? result.stdout.trim() : null))
      .catch(() => null);
  const [viewed, login, local] = await Promise.all([
    gh(["pr", "view", url, "--json", "author,headRefOid"]),
    gh(["api", "user", "--jq", ".login"]),
    head(root),
  ]);
  if (!viewed || !login || !local) {
    return false;
  }
  try {
    const pr = JSON.parse(viewed) as { author?: { login?: string }; headRefOid?: string };
    return pr.author?.login === login && pr.headRefOid === local;
  } catch {
    return false;
  }
}

/** The URL in `gh`'s output. */
export function findUrl(output: string): string | null {
  return /https:\/\/\S+/.exec(output)?.[0]?.replace(/[.,)]+$/, "") ?? null;
}
