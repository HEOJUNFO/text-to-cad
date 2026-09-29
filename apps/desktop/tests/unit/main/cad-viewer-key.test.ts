/**
 * A session's CAD viewer is launched by `cad.viewerOrigin` (keyed by the
 * tab's root, through `rootOf`) and stopped by `forgetCadSession` (keyed by
 * the session's recorded `worktreePath`). The two keys must be one string,
 * however the worktree is spelled — or the viewer outlives its session.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  root: "",
  project: "",
  sessions: [] as { id: string; projectId: string; cwd: string; worktreePath?: string }[],
  started: [] as string[],
  stopped: [] as string[],
}));

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() }, BrowserWindow: {}, dialog: {}, ipcMain: {}, shell: {} }));
vi.mock("@main/telemetry", () => ({ track: () => {}, fileExtension: () => "none" }));
vi.mock("@main/app-paths", () => ({ appVersion: () => "0.0.0", appRoot: () => "", resourcesDir: () => "" }));
vi.mock("@main/db/repositories", () => ({
  projects: {
    get: (id: string) => id === "project" ? { id, name: "demo", path: fixture.project } : null,
    list: () => [{ id: "project", name: "demo", path: fixture.project }],
  },
  sessions: { list: () => fixture.sessions },
  settings: { get: () => ({ worktreeRoot: path.join(fixture.root, "worktrees") }) },
  explorerTabs: {},
}));
vi.mock("@main/cad/runtime", () => ({
  CadRuntime: class { ready = async () => null; status = async () => ({}); log = async () => {}; processEnv = () => ({}); },
  nodeHost: () => ({}),
  runtimeLogPath: () => "",
}));
vi.mock("@main/cad/daemon", () => ({ DaemonWarmer: class { warm() {} } }));
vi.mock("@main/cad/viewer", () => ({
  ViewerManager: class {
    async originFor(root: string) { fixture.started.push(root); return { origin: "http://127.0.0.1:1" }; }
    stop(root: string) { fixture.stopped.push(root); }
    stopAll() {}
  },
}));

import { forgetCadSession, initCad } from "@main/cad";
import { cadHandlers } from "@main/ipc/cad";

beforeAll(async () => {
  fixture.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cad-viewer-key-")));
  fixture.project = path.join(fixture.root, "demo");
  await fs.mkdir(fixture.project, { recursive: true });
  await initCad();
});
afterAll(async () => { await fs.rm(fixture.root, { recursive: true, force: true }); });

test("a viewer started for a symlinked worktree is stopped by the same key when its session goes", async () => {
  const real = path.join(fixture.root, "legacy-worktree");
  const linked = path.join(fixture.root, "linked-worktree");
  await fs.mkdir(real, { recursive: true });
  await fs.symlink(real, linked);
  fixture.sessions = [{ id: "s1", projectId: "project", cwd: linked, worktreePath: linked }];

  await cadHandlers.cad.viewerOrigin({ projectId: "project", root: linked });
  // The session row is gone by the time its tools are disposed.
  fixture.sessions = [];
  forgetCadSession("s1", linked);

  expect(fixture.started).toEqual([linked]);
  expect(fixture.stopped).toEqual(fixture.started);
});
