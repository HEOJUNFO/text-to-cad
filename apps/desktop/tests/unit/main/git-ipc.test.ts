/**
 * `git.*` handlers: which directory a request is answered in, and which
 * worktrees a project may delete. A session id that matches nothing must not
 * quietly become the project's main checkout, and a worktree folder shared by
 * two same-named projects must not let one delete the other's work.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

type Row = { id: string; projectId: string; cwd: string; worktreePath?: string; archived: boolean };
const state = vi.hoisted(() => ({
  projects: [] as { id: string; name: string; path: string; createdAt: number }[],
  sessions: [] as Row[],
  worktreeRoot: "",
  settings: {} as Record<string, unknown>,
}));
vi.mock("@main/telemetry", () => ({ track: () => {}, fileExtension: () => "none" }));
vi.mock("electron", () => ({ BrowserWindow: {}, dialog: {}, ipcMain: {}, shell: {} }));
vi.mock("@main/db/repositories", async () => {
  const { defaultSettings } = await import("@shared/types");
  return {
    projects: {
      get: (id: string) => state.projects.find((project) => project.id === id) ?? null,
      list: () => state.projects,
    },
    sessions: {
      get: (id: string) => state.sessions.find((session) => session.id === id) ?? null,
      list: (projectId?: string) => state.sessions.filter((session) => !projectId || session.projectId === projectId),
    },
    settings: { get: () => ({ ...defaultSettings(), worktreeRoot: state.worktreeRoot, ...state.settings }) },
    explorerTabs: {},
  };
});

import { gitHandlers, pruneProjectWorktrees } from "@main/ipc/git";
import * as git from "@main/projects/git";
import { legacyProjectWorktreeDir, projectWorktreeDir } from "@main/projects/workspace";

const run = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "text-to-cad Tests",
  GIT_AUTHOR_EMAIL: "tests@example.invalid",
  GIT_COMMITTER_NAME: "text-to-cad Tests",
  GIT_COMMITTER_EMAIL: "tests@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
// `git.commit` runs through the app's own git, which reads the identity from the environment.
const previousEnv = { ...process.env };

let base = "";
beforeEach(async () => {
  Object.assign(process.env, GIT_ENV);
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "t2c-git-ipc-")));
  state.worktreeRoot = path.join(base, "worktrees");
  state.projects = [];
  state.sessions = [];
  state.settings = {};
});
afterEach(async () => {
  process.env = { ...previousEnv };
  await rm(base, { recursive: true, force: true });
});

async function repository(id: string, directory: string) {
  await mkdir(directory, { recursive: true });
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: directory, env: GIT_ENV });
  await writeFile(path.join(directory, "README.md"), "one\n");
  await run("git", ["add", "-A"], { cwd: directory, env: GIT_ENV });
  await run("git", ["commit", "--quiet", "-m", "first"], { cwd: directory, env: GIT_ENV });
  const project = { id, name: path.basename(directory), path: directory, createdAt: 0 };
  state.projects.push(project);
  return project;
}

const exists = (target: string) => stat(target).then(() => true, () => false);

test("a session id that matches no session of the project is refused, not answered in the main checkout", async () => {
  const project = await repository("a", path.join(base, "robot-arm"));
  const other = await repository("b", path.join(base, "other"));
  state.sessions.push({ id: "elsewhere", projectId: other.id, cwd: other.path, archived: false });
  await writeFile(path.join(project.path, "wip.txt"), "not for main\n");
  const before = await git.head(project.path);

  for (const sessionId of ["deleted", "elsewhere"]) {
    const refused = { name: "IpcError", message: "that session is no longer open" };
    await expect(gitHandlers.git.commit({ projectId: project.id, sessionId, message: "x", push: true })).rejects.toMatchObject(refused);
    await expect(gitHandlers.git.status({ projectId: project.id, sessionId })).rejects.toMatchObject(refused);
  }
  expect(await git.head(project.path)).toBe(before);

  // No session at all is the project's checkout, as before.
  await expect(gitHandlers.git.status({ projectId: project.id })).resolves.toMatchObject({ isRepository: true });
});

test("a project cannot delete a same-named project's worktree from the shared legacy folder", async () => {
  const mine = await repository("mine", path.join(base, "work", "robot-arm"));
  const theirs = await repository("theirs", path.join(base, "forks", "robot-arm"));
  const settings = { worktreeRoot: state.worktreeRoot };
  expect(legacyProjectWorktreeDir(settings, mine)).toBe(legacyProjectWorktreeDir(settings, theirs));

  const created = await git.createWorktree({
    repoPath: mine.path,
    parentDir: legacyProjectWorktreeDir(settings, mine),
    name: "wrist",
  });

  await expect(gitHandlers.git.removeWorktree({ projectId: theirs.id, path: created.path })).rejects.toMatchObject({
    name: "IpcError",
    message: "that worktree does not belong to this project",
  });
  expect(await exists(created.path)).toBe(true);
  // Its own project still lists and removes it: old folders keep working.
  expect((await gitHandlers.git.worktrees({ projectId: mine.id })).map((row) => row.path)).toEqual([created.path]);
  expect(await gitHandlers.git.worktrees({ projectId: theirs.id })).toEqual([]);
  await gitHandlers.git.removeWorktree({ projectId: mine.id, path: created.path });
  expect(await exists(created.path)).toBe(false);
});

test("a worktree a session is using is not removed, even forced", async () => {
  const project = await repository("a", path.join(base, "robot-arm"));
  const created = await git.createWorktree({
    repoPath: project.path,
    parentDir: path.join(state.worktreeRoot, "unused"),
    name: "wrist",
  });
  state.sessions.push({ id: "s", projectId: project.id, cwd: created.path, worktreePath: created.path, archived: false });

  await expect(gitHandlers.git.removeWorktree({ projectId: project.id, path: created.path, force: true })).rejects.toMatchObject({
    name: "IpcError",
    message: "1 session is still using that worktree",
  });
  expect(await exists(created.path)).toBe(true);
});

test("the keep-limit sweep spares a worktree another project's session belongs to, or runs inside", async () => {
  const project = await repository("a", path.join(base, "robot-arm"));
  state.settings = { autoDeleteWorktrees: true, worktreeKeepLimit: 1 };
  const parentDir = projectWorktreeDir({ worktreeRoot: state.worktreeRoot }, project);
  const opened = await git.createWorktree({ repoPath: project.path, parentDir, name: "opened as a project" });
  const inside = await git.createWorktree({ repoPath: project.path, parentDir, name: "session in a subfolder" });
  const spare = await git.createWorktree({ repoPath: project.path, parentDir, name: "spare" });
  const newest = await git.createWorktree({ repoPath: project.path, parentDir, name: "newest" });
  const hourAgo = new Date(Date.now() - 3_600_000);
  await utimes(path.join(spare.path, "README.md"), hourAgo, hourAgo);
  await utimes(spare.path, hourAgo, hourAgo);
  await mkdir(path.join(inside.path, "parts"));
  // The worktree folder chosen as a project of its own, and a session of this
  // project running in a folder inside another worktree.
  state.sessions.push(
    { id: "s1", projectId: opened.path, cwd: opened.path, archived: false },
    { id: "s2", projectId: project.id, cwd: path.join(inside.path, "parts"), archived: false },
  );

  await pruneProjectWorktrees(project);
  expect(await exists(opened.path)).toBe(true);
  expect(await exists(inside.path)).toBe(true);
  // Of the two nobody uses, the older was past the limit and went.
  expect(await exists(newest.path)).toBe(true);
  expect(await exists(spare.path)).toBe(false);
});
