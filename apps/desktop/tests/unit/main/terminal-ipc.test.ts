/**
 * `terminal.*` after `create`: a pty belongs to the session that opened it,
 * and a request naming another session is refused — sharing a directory
 * grants no access to another session's shell. And `create` runs the login
 * shell, never a binary the renderer names.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "" }));
const spawn = vi.hoisted(() => vi.fn());
const pty = vi.hoisted(() => ({ write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn() }));
vi.mock("node-pty", () => ({ spawn }));
vi.mock("@main/telemetry", () => ({ track: () => {}, fileExtension: () => "none" }));
vi.mock("electron", () => ({ BrowserWindow: {}, dialog: {}, ipcMain: {}, shell: {} }));
vi.mock("@main/db/repositories", () => {
  const session = (id: string) => ({ id, projectId: "project", cwd: fixture.root, archived: false });
  return {
    projects: {
      get: (id: string) => id === "project" ? { id, name: "demo", path: fixture.root } : null,
      list: () => [{ id: "project", name: "demo", path: fixture.root }],
    },
    sessions: { get: session, list: () => [session("owner"), session("intruder")] },
    settings: { get: () => ({}) },
    explorerTabs: {},
  };
});
// The real `realDirectory`: `explorer/fs` resolves new paths through it, and an
// identity stub would quietly turn that containment check back into a lexical one.
vi.mock("@main/projects/workspace", async (importOriginal) => ({ ...(await importOriginal<object>()), resolveProjectRoot: () => fixture.root, projectWorktreeDir: () => fixture.root }));
import { disposeExplorerServices, explorerHandlers, initExplorerServices } from "@main/ipc/explorer";

beforeAll(async () => {
  fixture.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "terminal-ipc-")));
  initExplorerServices(() => {});
});
afterAll(async () => {
  disposeExplorerServices();
  await fs.rm(fixture.root, { recursive: true, force: true });
});
beforeEach(() => {
  spawn.mockReset().mockReturnValue(pty);
  for (const fn of Object.values(pty)) fn.mockClear();
});

const { terminal } = explorerHandlers;

test("a pty refuses every request from a session that does not own it", async () => {
  const { id } = await terminal.create({ projectId: "project", sessionId: "owner" });
  const intruder = { id, sessionId: "intruder" };
  expect(() => terminal.write({ ...intruder, data: "rm -rf ~\r" })).toThrow();
  expect(() => terminal.resize({ ...intruder, cols: 10, rows: 10 })).toThrow();
  expect(() => terminal.attach(intruder)).toThrow();
  expect(() => terminal.kill(intruder)).toThrow();
  expect(pty.write).not.toHaveBeenCalled();
  expect(pty.kill).not.toHaveBeenCalled();

  terminal.write({ id, sessionId: "owner", data: "ls\r" });
  expect(pty.write).toHaveBeenCalledWith("ls\r");
  expect(terminal.attach({ id, sessionId: "owner" })).toMatchObject({ info: { id } });
  terminal.kill({ id, sessionId: "owner" });
  expect(pty.kill).toHaveBeenCalledOnce();
});

test("create ignores a shell or arguments the renderer names", async () => {
  await terminal.create({ projectId: "project", sessionId: "owner", shell: "/bin/evil", args: ["-c", "x"] } as never);
  expect(spawn).toHaveBeenCalledOnce();
  const [shell, args] = spawn.mock.calls[0] as [string, string[]];
  expect(shell).not.toBe("/bin/evil");
  expect(args).not.toEqual(["-c", "x"]);
});
