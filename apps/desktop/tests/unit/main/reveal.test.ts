/**
 * `shell.showItemInFolder` takes a project, not a path: main resolves the
 * directory and refuses one that is not the project's own.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "", project: "", worktrees: "" }));
const showItemInFolder = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ BrowserWindow: {}, dialog: {}, ipcMain: {}, shell: { showItemInFolder } }));
vi.mock("@main/db/repositories", () => ({
  projects: {
    get: (id: string) => id === "project" ? { id, name: "demo", path: fixture.project } : null,
    list: () => [{ id: "project", name: "demo", path: fixture.project }],
  },
  sessions: { list: () => [] },
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
beforeEach(() => { showItemInFolder.mockClear(); });

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
