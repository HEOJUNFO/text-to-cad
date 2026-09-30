/**
 * A deadline on quitting.
 *
 * By the end of `before-quit` everything this app owns is done: the database is closed,
 * the window has saved its geometry and run its unload, every child has its
 * signal and the probes are dead (`before-quit`, src/main/index.ts). What is
 * left is Chromium's own shutdown — and on macOS 26 with Electron 40, once a
 * window has held a WebGL context, that shutdown was measured at anywhere
 * from twelve seconds to two and a half minutes (the GPU and utility helpers
 * hang for ten to thirty seconds, then the browser process sits in a
 * CoreAnalytics XPC retry loop; `app.exit()` was slower still). Nothing in
 * that time is doing work for the user, and no timer of ours can fire during
 * it: the Node event loop is already stopped.
 *
 * So the deadline is kept by a process of its own — this Electron binary run
 * as Node, detached, which waits and then kills the app and the helpers it
 * still has (a utility process left to notice on its own took over thirty
 * seconds) if they are still there. A graceful exit that finishes first
 * (the common case without WebGL: about half a second) leaves the watchdog
 * nothing to do. Measured with the deadline: the process is gone within a
 * quarter second of the kill landing, and so are its helpers.
 */
import { spawn } from "node:child_process";

import { isQuittingForUpdate } from "./quitting";

/** The quit deadline, including teardown and watchdog startup, within the two-second budget. */
export const QUIT_DEADLINE_MS = 1_200;

/**
 * The watchdog's whole program. Platform-specific in one place: on Windows
 * `taskkill /T` ends the tree; elsewhere the direct children are listed and
 * killed before the parent. Our own children are already gone by then; what
 * `pgrep -P` finds is Chromium's helpers.
 *
 * Only the children in the app's own process group are killed: the shared warm
 * daemon and a reused external viewer are spawned `detached` (their own
 * session, so their own group) and outlive the app by design; Chromium's
 * helpers are spawned into the app's group. If the groups cannot be read,
 * only the app is killed.
 *
 * Except when the quit is an update's (`tree` false): electron-updater has
 * just spawned the NSIS installer, or the new AppImage, as a child of this
 * process, and a tree kill would take it down mid-install. Then only the app
 * itself is killed; its helpers go with the browser process they serve.
 * Not on macOS: Squirrel's ShipIt is launched by launchd, not by the app, so
 * there is no installer in the tree to spare — only helpers to leave behind.
 */
export function watchdogScript(
  pid: number,
  deadlineMs: number,
  platform: NodeJS.Platform = process.platform,
  startedAt = Date.now(),
  tree = true,
): string {
  const kill =
    platform === "win32"
      ? `require("node:child_process").spawnSync("taskkill", ["/PID", "${pid}", ${tree ? `"/T", ` : ""}"/F"], { stdio: "ignore" });`
      : tree
        ? `const cp = require("node:child_process");
let children = [];
try { children = cp.execFileSync("pgrep", ["-P", "${pid}"], { encoding: "utf8" }).trim().split(/\\s+/).filter(Boolean); } catch {}
const groups = new Map();
try {
  const listed = cp.execFileSync("ps", ["-o", "pid=", "-o", "pgid=", "-p", ["${pid}", ...children].join(",")], { encoding: "utf8" });
  for (const line of listed.trim().split("\\n")) {
    const [member, group] = line.trim().split(/\\s+/).map(Number);
    groups.set(member, group);
  }
} catch {}
const own = groups.get(${pid});
for (const child of children) {
  if (Number(child) === process.pid) continue;
  if (own === undefined || groups.get(Number(child)) !== own) continue;
  try { process.kill(Number(child), "SIGKILL"); } catch {}
}
try { process.kill(${pid}, "SIGKILL"); } catch {}`
        : `try { process.kill(${pid}, "SIGKILL"); } catch {}`;
  return `setTimeout(() => {
let alive = true;
try { process.kill(${pid}, 0); } catch { alive = false; }
if (alive) { ${kill} }
}, Math.max(0, ${startedAt + deadlineMs} - Date.now()));`;
}

export function armQuitDeadline(
  startedAt = Date.now(),
  pid: number = process.pid,
  deadlineMs: number = QUIT_DEADLINE_MS,
  platform: NodeJS.Platform = process.platform,
  tree: boolean = !isQuittingForUpdate() || platform === "darwin",
): void {
  try {
    // Armed once state is saved: at the end of before-quit (nothing cancels a
    // quit after its teardown; the database is closed) and again at will-quit.
    // If teardown or launching Electron-as-Node used the budget, the watchdog
    // fires immediately.
    spawn(process.execPath, ["-e", watchdogScript(pid, deadlineMs, platform, startedAt, tree)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    }).unref();
  } catch (error) {
    // Without a watchdog the app still quits, only slowly.
    console.error("[quit] could not arm the deadline", error);
  }
}
