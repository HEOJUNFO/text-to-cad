/** A deleted session's browser storage and artifacts go with it; archive keeps them; orphans are swept. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {}, session: {} }));
import { browserArtifactsRoot, browserPartition, browserSessionKey, clearBrowserSessionStorage, sweepBrowserStorage } from "@main/browser/storage";

let userData: string;
beforeEach(async () => { userData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "browser-storage-"))); });
afterEach(async () => { await fs.rm(userData, { recursive: true, force: true }); });
const exists = (directory: string) => fs.stat(directory).then(() => true, () => false);
async function partitionOnDisk(sessionId: string) {
  const name = browserPartition({ sessionId, projectId: "project", root: `/work/${sessionId}` }).slice("persist:".length);
  await fs.mkdir(path.join(userData, "Partitions", name), { recursive: true });
  return name;
}
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

it("sweeps partitions and artifacts whose session no longer exists, and pre-prefix partitions", async () => {
  const live = await partitionOnDisk("live");
  const orphan = await partitionOnDisk("orphan");
  const legacy = `browser-${"a".repeat(64)}`;
  await fs.mkdir(path.join(userData, "Partitions", legacy), { recursive: true });
  await fs.mkdir(path.join(userData, "Partitions", "unrelated"), { recursive: true });
  const liveArtifacts = await artifacts("live");
  const orphanArtifacts = await artifacts("orphan");
  await sweepBrowserStorage(["live", "archived-but-kept"], userData);
  const left = await fs.readdir(path.join(userData, "Partitions"));
  expect(left.sort()).toEqual([live, "unrelated"].sort());
  expect(left).not.toContain(orphan);
  expect(await exists(liveArtifacts)).toBe(true);
  expect(await exists(orphanArtifacts)).toBe(false);
});

it("sweeps nothing when there is no browser storage yet", async () => {
  await expect(sweepBrowserStorage([], userData)).resolves.toEqual([]);
});
