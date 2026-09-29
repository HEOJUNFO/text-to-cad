import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import type * as Telemetry from "@main/telemetry";

const fixture = vi.hoisted(() => {
  // Compiled in by electron-vite; the real `fileExtension` is under test, so
  // the module is loaded with its key blank and Aptabase stubbed.
  (globalThis as { __APTABASE_KEY__?: string }).__APTABASE_KEY__ = "";
  return { root: "", track: vi.fn() };
});
vi.mock("@aptabase/electron/main", () => ({ initialize: vi.fn(), trackEvent: vi.fn() }));
vi.mock("@main/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof Telemetry>()),
  track: fixture.track,
}));
vi.mock("electron", () => ({ BrowserWindow: {}, dialog: {}, ipcMain: {}, shell: {} }));
vi.mock("@main/db/repositories", () => ({
  projects: {
    get: (id: string) => id === "project" ? { id, path: fixture.root } : null,
    list: () => [{ id: "project", path: fixture.root }],
  },
  sessions: { list: () => [{ id: "session", projectId: "project", cwd: fixture.root }] },
  settings: { get: () => ({}) }, explorerTabs: {},
}));
vi.mock("@main/projects/workspace", () => ({ resolveProjectRoot: () => fixture.root, projectWorktreeDir: () => fixture.root, realDirectory: (directory: string) => directory }));
import { explorerHandlers, initExplorerServices, disposeExplorerServices } from "@main/ipc/explorer";
import { FileWatchers } from "@main/explorer/fs";
import { fileExtension } from "@main/telemetry";
import { FileMutationResultSchema, TextWriteResultSchema } from "@shared/ipc/explorer";

beforeAll(async () => { fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "file-mutations-")); });
afterAll(async () => { await fs.rm(fixture.root, { recursive: true, force: true }); });
const at = { projectId: "project" };

test("IPC returns validated typed conflicts and never overwrites their contents", async () => {
  await fs.writeFile(path.join(fixture.root, "note.txt"), "external");
  const conflict = TextWriteResultSchema.parse(await explorerHandlers.explorer.writeText({ ...at, path: "note.txt", content: "stale", expectedRevision: "before" }));
  expect(conflict).toMatchObject({ status: "conflict", actualRevision: expect.any(String) });
  expect(await fs.readFile(path.join(fixture.root, "note.txt"), "utf8")).toBe("external");
  const denied = TextWriteResultSchema.parse(await explorerHandlers.explorer.writeText({ ...at, path: "../outside.txt", content: "refused" }));
  expect(denied).toMatchObject({ status: "error", code: "denied" });
});

test("IPC commits create/move receipts with exact identities and reports failures by code", async () => {
  const created = FileMutationResultSchema.parse(await explorerHandlers.explorer.createFile({ ...at, path: "", name: "created.txt" }));
  expect(created).toMatchObject({ status: "committed", path: "created.txt", change: { kind: "added", directory: false, mutationId: expect.any(String) } });
  const moved = FileMutationResultSchema.parse(await explorerHandlers.explorer.rename({ ...at, path: "created.txt", name: "moved.txt" }));
  expect(moved).toMatchObject({ status: "committed", path: "moved.txt", change: { kind: "moved", previousPath: "created.txt", path: "moved.txt" } });
  const conflict = FileMutationResultSchema.parse(await explorerHandlers.explorer.createFile({ ...at, path: "", name: "moved.txt" }));
  expect(conflict).toMatchObject({ status: "failed", code: "already-exists" });
  const missing = FileMutationResultSchema.parse(await explorerHandlers.explorer.rename({ ...at, path: "missing", name: "another" }));
  expect(missing).toMatchObject({ status: "failed", code: "not-found" });
});

test("a notification failure cannot turn a committed save or move into failure", async () => {
  initExplorerServices(() => { throw new Error("window disappeared"); });
  try {
    const saved = TextWriteResultSchema.parse(await explorerHandlers.explorer.writeText({ ...at, path: "receipt.txt", content: "committed" }));
    expect(saved).toMatchObject({ status: "saved", document: { content: "committed" } });
    const moved = FileMutationResultSchema.parse(await explorerHandlers.explorer.rename({ ...at, path: "receipt.txt", name: "receipt-moved.txt" }));
    expect(moved).toMatchObject({ status: "committed", path: "receipt-moved.txt" });
    expect(await fs.readFile(path.join(fixture.root, "receipt-moved.txt"), "utf8")).toBe("committed");
  } finally { disposeExplorerServices(); }
});

test("opening a file counts its extension and nothing else; a directory or a failed stat counts nothing", async () => {
  await fs.mkdir(path.join(fixture.root, "Secret Project"), { recursive: true });
  await fs.writeFile(path.join(fixture.root, "Secret Project", "Gripper.STL"), "solid");
  fixture.track.mockClear();
  await explorerHandlers.explorer.stat({ ...at, path: "Secret Project/Gripper.STL", intent: "open" });
  await explorerHandlers.explorer.stat({ ...at, path: "Secret Project", intent: "open" });
  await expect(explorerHandlers.explorer.stat({ ...at, path: "missing.step", intent: "open" })).rejects.toThrow();
  expect(fixture.track.mock.calls).toEqual([[{ name: "file_opened", extension: "stl" }]]);
});

test("a stat that is not a tab opening — an attachment check, an integration lookup — neither counts nor watches", async () => {
  await fs.mkdir(path.join(fixture.root, "attach"), { recursive: true });
  await fs.writeFile(path.join(fixture.root, "attach", "part.step"), "ISO-10303-21;");
  fixture.track.mockClear();
  const watchEntry = vi.spyOn(FileWatchers.prototype, "watchEntry").mockResolvedValue();
  initExplorerServices(() => {});
  try {
    await explorerHandlers.explorer.stat({ ...at, path: "attach/part.step" });
    expect(fixture.track).not.toHaveBeenCalled();
    expect(watchEntry).not.toHaveBeenCalled();
    await explorerHandlers.explorer.stat({ ...at, path: "attach/part.step", intent: "open" });
    expect(fixture.track).toHaveBeenCalledOnce();
    expect(watchEntry).toHaveBeenCalledOnce();
  } finally { disposeExplorerServices(); watchEntry.mockRestore(); }
});

test("file_opened's extension is a short alphanumeric suffix or \"other\", never a fragment of a name", () => {
  expect(fileExtension("a/Gripper.STL")).toBe("stl");
  expect(fileExtension("a/model.step")).toBe("step");
  expect(fileExtension("README")).toBe("none");
  expect(fileExtension(".env")).toBe("none");
  expect(fileExtension("plan.acme-q3-layoffs")).toBe("other");
  expect(fileExtension("notes.confidential")).toBe("other");
  expect(fileExtension("photo.jpg ")).toBe("other");
  expect(fileExtension("archive.tar.gz")).toBe("gz");
});
