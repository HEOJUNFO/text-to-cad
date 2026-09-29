/** A deleted session's browser storage and artifacts go with it; archive keeps them; older builds' partitions migrate; orphans are swept. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {}, session: {} }));
import {
  browserArtifactsRoot, browserPartition, browserPartitionName, browserSessionKey, clearBrowserSessionStorage, legacyPartitionName, sweepBrowserStorage,
} from "@main/browser/storage";

let userData: string, workspace: string;
beforeEach(async () => {
  userData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "browser-storage-")));
  workspace = path.join(userData, "workspace"); await fs.mkdir(workspace);
});
afterEach(async () => { await fs.rm(userData, { recursive: true, force: true }); });
const exists = (directory: string) => fs.stat(directory).then(() => true, () => false);
const scopeOf = (sessionId: string) => ({ sessionId, projectId: "project", root: workspace });
const live = (...ids: string[]) => () => ids.map(id => ({ id, projectId: "project", cwd: workspace }));
const partitions = () => path.join(userData, "Partitions");
async function onDisk(name: string) {
  await fs.mkdir(path.join(partitions(), name), { recursive: true });
  await fs.writeFile(path.join(partitions(), name, "Cookies"), name);
  return name;
}
const partitionOnDisk = (sessionId: string) => onDisk(browserPartitionName(scopeOf(sessionId)).slice("persist:".length));
async function artifacts(sessionId: string) {
  const directory = path.join(browserArtifactsRoot(userData), browserSessionKey(sessionId));
  await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, "page.png"), "png");
  return directory;
}

it("clears every partition of a deleted session, and its artifacts, and nothing of another session", async () => {
  const doomed = await partitionOnDisk("deleted");
  await partitionOnDisk("kept");
  const doomedArtifacts = await artifacts("deleted");
  const keptArtifacts = await artifacts("kept");
  const clearStorageData = vi.fn().mockResolvedValue(undefined);
  const clearCache = vi.fn().mockResolvedValue(undefined);
  const fromPartition = vi.fn((_partition: string) => ({ clearStorageData, clearCache }));
  await clearBrowserSessionStorage("deleted", { userData, fromPartition });
  expect(fromPartition.mock.calls.map(([partition]) => partition)).toEqual([`persist:${doomed}`]);
  expect(clearStorageData).toHaveBeenCalledTimes(1);
  expect(clearCache).toHaveBeenCalledTimes(1);
  expect(await exists(doomedArtifacts)).toBe(false);
  expect(await exists(keptArtifacts)).toBe(true);
});

it("sweeps partitions and artifacts whose session no longer exists, and nothing else", async () => {
  const kept = await partitionOnDisk("live");
  const orphan = await partitionOnDisk("orphan");
  await onDisk("unrelated");
  const liveArtifacts = await artifacts("live");
  const orphanArtifacts = await artifacts("orphan");
  await sweepBrowserStorage(live("live", "archived-but-kept"), userData);
  expect((await fs.readdir(partitions())).sort()).toEqual([kept, "unrelated"].sort());
  expect(orphan).not.toBe(kept);
  expect(await exists(liveArtifacts)).toBe(true);
  expect(await exists(orphanArtifacts)).toBe(false);
});

it("never sweeps a partition or artifacts this run opened, even for a session the snapshot missed", async () => {
  const name = browserPartition(scopeOf("opened-mid-sweep"), userData).slice("persist:".length);
  await onDisk(name);
  const outputs = await artifacts("opened-mid-sweep");
  await sweepBrowserStorage(live(), userData);
  expect(await exists(path.join(partitions(), name))).toBe(true);
  expect(await exists(outputs)).toBe(true);
});

it("reads the sessions after listing the directories, so a session created mid-sweep keeps its storage", async () => {
  const outputs = await artifacts("created-mid-sweep");
  const partition = await partitionOnDisk("created-mid-sweep");
  const sessions = vi.fn(live("created-mid-sweep"));
  await sweepBrowserStorage(sessions, userData);
  expect(sessions).toHaveBeenCalledTimes(1);
  expect(await exists(outputs)).toBe(true);
  expect(await exists(path.join(partitions(), partition))).toBe(true);
});

it("renames an older build's partition for a live session instead of deleting its logins", async () => {
  const legacy = await onDisk(legacyPartitionName(scopeOf("migrated")));
  const orphanLegacy = await onDisk(`browser-${"a".repeat(64)}`);
  await sweepBrowserStorage(live("migrated"), userData);
  const current = browserPartitionName(scopeOf("migrated")).slice("persist:".length);
  expect((await fs.readdir(partitions())).sort()).toEqual([current]);
  expect(await fs.readFile(path.join(partitions(), current, "Cookies"), "utf8")).toBe(legacy);
  expect(orphanLegacy).not.toBe(legacy);
});

it("keeps an unmatched older partition while any live session's workspace cannot be resolved", async () => {
  const legacy = await onDisk(`browser-${"b".repeat(64)}`);
  await sweepBrowserStorage(() => [{ id: "gone-worktree", projectId: "project", cwd: path.join(userData, "missing") }], userData);
  expect(await exists(path.join(partitions(), legacy))).toBe(true);
});

it("migrates an older partition on first use, before Chromium creates the new one", async () => {
  const legacy = await onDisk(legacyPartitionName(scopeOf("first-use")));
  const partition = browserPartition(scopeOf("first-use"), userData);
  const current = path.join(partitions(), partition.slice("persist:".length));
  expect(await fs.readFile(path.join(current, "Cookies"), "utf8")).toBe(legacy);
  expect(await exists(path.join(partitions(), legacy))).toBe(false);
});

it("sweeps nothing when there is no browser storage yet", async () => {
  await expect(sweepBrowserStorage(live(), userData)).resolves.toEqual([]);
});
