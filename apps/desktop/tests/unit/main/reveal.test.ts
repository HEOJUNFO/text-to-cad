/**
 * `shell.showItemInFolder` takes a project, not a path: main resolves the
 * directory and refuses one that is not the project's own.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  root: "",
  project: "",
  worktrees: "",
  sessions: [] as { projectId: string; cwd: string; worktreePath?: string }[],
}));
const showItemInFolder = vi.hoisted(() => vi.fn());
vi.mock("@main/telemetry", () => ({ track: () => {}, fileExtension: () => "none" }));
vi.mock("electron", () => ({ BrowserWindow: {}, dialog: {}, ipcMain: {}, shell: { showItemInFolder } }));
vi.mock("@main/db/repositories", () => ({
  projects: {
    get: (id: string) => id === "project" ? { id, name: "demo", path: fixture.project } : null,
    list: () => [{ id: "project", name: "demo", path: fixture.project }],
  },
  sessions: { list: () => fixture.sessions },
  settings: { get: () => ({ worktreeRoot: fixture.worktrees }) },
  explorerTabs: {},
}));
import { revealProjectDirectory } from "@main/ipc/explorer";

beforeAll(async () => {
  fixture.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reveal-")));
  fixture.project = path.join(fixture.root, "demo");
  fixture.worktrees = path.join(fixture.root, "worktrees");
  await fs.mkdir(path.join(fixture.worktrees, "demo", "feature"), { recursive: true });
  await fs.mkdir(path.join(fixture.root, "elsewhere"), { recursive: true });
  await fs.mkdir(fixture.project, { recursive: true });
});
afterAll(async () => { await fs.rm(fixture.root, { recursive: true, force: true }); });
beforeEach(() => { showItemInFolder.mockClear(); fixture.sessions = []; });

test("reveals the project, its worktree and its worktree folder", () => {
  revealProjectDirectory({ projectId: "project" });
  revealProjectDirectory({ projectId: "project", root: path.join(fixture.worktrees, "demo", "feature") });
  revealProjectDirectory({ projectId: "project", worktrees: true });
  expect(showItemInFolder.mock.calls.map(([target]) => target)).toEqual([
    fixture.project,
    path.join(fixture.worktrees, "demo", "feature"),
    path.join(fixture.worktrees, "demo"),
  ]);
});

test("refuses a directory outside the project, and an unknown project", () => {
  expect(() => revealProjectDirectory({ projectId: "project", root: path.join(fixture.root, "elsewhere") })).toThrow();
  expect(() => revealProjectDirectory({ projectId: "project", root: "/etc" })).toThrow();
  expect(() => revealProjectDirectory({ projectId: "other", worktrees: true })).toThrow();
  expect(showItemInFolder).not.toHaveBeenCalled();
});

test("a session's recorded worktree is handed on as the session recorded it, not as the caller spelled it", async () => {
  // A worktree an older layout made outside the worktree root, recorded
  // through a link (a dotfile-managed ~/.text-to-cad, /tmp on macOS). The
  // record keeps access, and the root that leaves main is the recorded
  // spelling: watchers, `files.changed` and the CAD viewer are keyed by it,
  // and the renderer compares it with the session's worktreePath by `===`.
  const real = path.join(fixture.root, "legacy-worktree");
  const linked = path.join(fixture.root, "linked-worktree");
  await fs.mkdir(real, { recursive: true });
  await fs.symlink(real, linked);
  fixture.sessions = [{ projectId: "project", cwd: linked, worktreePath: linked }];
  revealProjectDirectory({ projectId: "project", root: linked });
  // The caller's spelling differs (a trailing slash, the real path): the
  // recorded one is still what is handed on.
  revealProjectDirectory({ projectId: "project", root: `${linked}/` });
  revealProjectDirectory({ projectId: "project", root: real });
  expect(showItemInFolder.mock.calls.map(([target]) => target)).toEqual([linked, linked, linked]);
});
