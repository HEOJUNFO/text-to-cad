/**
 * What a session's browser leaves on disk: its storage partitions (cookies,
 * logins, cache) and the Playwright MCP artifacts directory. Both are named
 * from a hash of the session ID, so a deleted session's leftovers can be
 * found without the session row.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app, session } from "electron";

export type BrowserScope = { sessionId: string; projectId: string; root: string };
type PartitionSession = { clearStorageData(): Promise<void>; clearCache(): Promise<void> };
export type BrowserStorageHost = { userData: string; fromPartition: (partition: string) => PartitionSession };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const defaultHost = (): BrowserStorageHost => ({ userData: app.getPath("userData"), fromPartition: partition => session.fromPartition(partition) });
/** Partitions opened this run, per session: a new one may not be on disk yet. */
const opened = new Map<string, Set<string>>();
/** Partitions whose session was deleted this run: loaded, so left for the next launch's sweep. */
const cleared = new Set<string>();

export function browserScopeKey(scope: BrowserScope) { return JSON.stringify([scope.sessionId, scope.projectId, scope.root]); }
export function browserSessionKey(sessionId: string) { return sha256(sessionId); }
export function browserArtifactsRoot(userData: string) { return path.join(userData, "browser-artifacts"); }

/**
 * `persist:browser-<sha256(session)>-<sha256(scope)[:32]>`: pages in one
 * session and workspace share storage, separate sessions never do, and the
 * prefix names the owning session. (Before the session prefix a partition was
 * `browser-<sha256(scope)>`; nothing opens those any more and the sweep
 * removes them.)
 */
export function browserPartition(scope: BrowserScope) {
  const partition = `persist:browser-${browserSessionKey(scope.sessionId)}-${sha256(browserScopeKey(scope)).slice(0, 32)}`;
  const names = opened.get(scope.sessionId) ?? new Set<string>();
  names.add(partition); opened.set(scope.sessionId, names);
  return partition;
}

async function entries(directory: string) {
  try { return await fs.readdir(directory); } catch { return []; }
}

/** A deleted session's logins, cookies, cache and MCP artifacts go with it. Archive keeps them. */
export async function clearBrowserSessionStorage(sessionId: string, host: BrowserStorageHost = defaultHost()) {
  const key = browserSessionKey(sessionId);
  const partitions = new Set(opened.get(sessionId));
  opened.delete(sessionId);
  for (const entry of await entries(path.join(host.userData, "Partitions"))) {
    if (entry.startsWith(`browser-${key}-`)) partitions.add(`persist:${entry}`);
  }
  const results = await Promise.allSettled([
    ...[...partitions].map(async partition => {
      cleared.add(partition.slice("persist:".length));
      const storage = host.fromPartition(partition);
      await storage.clearStorageData();
      await storage.clearCache();
    }),
    fs.rm(path.join(browserArtifactsRoot(host.userData), key), { recursive: true, force: true }),
  ]);
  for (const result of results) if (result.status === "rejected") console.warn(`[browser] could not clear a deleted session's storage: ${String(result.reason)}`);
}

/**
 * Remove partitions and artifact directories whose session no longer exists
 * (deleted while the app was not running, or by a build without this cleanup),
 * and every pre-prefix partition. Only directories never loaded this run are
 * touched: a live session's are kept by `liveSessionIds`.
 */
export async function sweepBrowserStorage(liveSessionIds: Iterable<string>, userData = app.getPath("userData")) {
  const live = new Set([...liveSessionIds].map(browserSessionKey));
  const doomed: string[] = [];
  const partitions = path.join(userData, "Partitions");
  for (const entry of await entries(partitions)) {
    const match = /^browser-([0-9a-f]{64})(-[0-9a-f]{32})?$/.exec(entry);
    if (!match || cleared.has(entry)) continue;
    if (!match[2] || !live.has(match[1]!)) doomed.push(path.join(partitions, entry));
  }
  const artifacts = browserArtifactsRoot(userData);
  for (const entry of await entries(artifacts)) {
    if (/^[0-9a-f]{64}$/.test(entry) && !live.has(entry)) doomed.push(path.join(artifacts, entry));
  }
  await Promise.all(doomed.map(directory => fs.rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
    console.warn(`[browser] could not remove orphaned browser storage ${directory}: ${String(error)}`);
  })));
  return doomed;
}
