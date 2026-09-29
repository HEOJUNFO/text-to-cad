import * as childProcess from "node:child_process";
import { once } from "node:events";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { armQuitDeadline, watchdogScript } from "@main/quit-deadline";
import { markQuittingForUpdate } from "@main/quitting";

// The real spawn, observable: `armQuitDeadline` is checked by the script it
// hands the watchdog, and those two calls are answered by a stub.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const { spawn } = childProcess;

/**
 * The watchdog is a script handed to `node -e`; the only way to know it does
 * what its comment says is to run it against a process and watch. A
 * process that exits on its own is left alone, one that is still there at
 * the deadline is killed along with its children.
 */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const runWatchdog = (pid: number, deadlineMs: number) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    spawn(process.execPath, ["-e", watchdogScript(pid, deadlineMs)], { stdio: "ignore" }).once("exit", (code, signal) =>
      resolve({ code, signal }),
    ),
  );

describe("the quit deadline's watchdog", () => {
  it("counts teardown and process startup against the original deadline", () => {
    const startedAt = 1_000;
    const script = watchdogScript(123, 1_200, "darwin", startedAt);
    const remaining: number[] = [];
    for (const now of [1_000, 1_700, 2_500]) {
      runInNewContext(script, {
        Date: { now: () => now },
        setTimeout: (_callback: () => void, delay: number) => remaining.push(delay),
      });
    }
    expect(remaining).toEqual([1_200, 500, 0]);
  });

  it("never signals itself while ending the target's remaining helpers", () => {
    const signaled: number[] = [];
    runInNewContext(watchdogScript(123, 0, "darwin"), {
      Date,
      process: { pid: 321, kill: (pid: number, signal?: string) => { if (signal) { signaled.push(pid); } } },
      require: () => ({ execFileSync: () => "200\n321\n201\n" }),
      setTimeout: (callback: () => void) => callback(),
    });
    expect(signaled).toEqual([200, 201, 123]);
  });

  it("a target-owned watchdog kills the target and helpers without killing itself first", async () => {
    const target = spawn(process.execPath, ["-e", `
const { spawn } = require("node:child_process");
const launch = () => new Promise((resolve) => {
  const child = spawn(process.execPath, ["-e", "process.send(process.pid); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.once("message", resolve);
});
Promise.all([launch(), launch()]).then((children) => process.send({ children }));
process.once("message", (script) => {
  const watchdog = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  watchdog.unref();
  process.send({ watchdog: watchdog.pid });
});
setInterval(() => {}, 1000);
`], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const children: number[] = [];
    let watchdog: number | undefined;
    try {
      const [ready] = await once(target, "message");
      children.push(...(ready as { children: number[] }).children);
      expect(children).toHaveLength(2);
      const armed = once(target, "message");
      target.send(watchdogScript(target.pid!, 100));
      const [launched] = await armed;
      watchdog = (launched as { watchdog: number }).watchdog;
      await expect.poll(() => [target.pid!, ...children].filter(alive), { timeout: 5_000 }).toEqual([]);
    } finally {
      for (const pid of [target.pid, watchdog, ...children]) {
        if (pid) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        }
      }
    }
  });

  it("leaves a process that exited on its own alone", async () => {
    const target = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise((resolve) => target.once("exit", resolve));
    // The watchdog must not throw at a pid that is gone (or reused).
    await expect(runWatchdog(target.pid!, 50)).resolves.toEqual({ code: 0, signal: null });
    // And it sends nothing: the liveness probe fails, so no kill and no child scan.
    const signaled: [number, string][] = [];
    const scanned = vi.fn(() => "");
    runInNewContext(watchdogScript(target.pid!, 0, "darwin"), {
      Date,
      process: {
        pid: 321,
        kill: (pid: number, signal?: string | number) => {
          if (signal === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
          signaled.push([pid, String(signal)]);
        },
      },
      require: () => ({ execFileSync: scanned }),
      setTimeout: (callback: () => void) => callback(),
    });
    expect(signaled).toEqual([]);
    expect(scanned).not.toHaveBeenCalled();
  });

  it("after before-quit-for-update, kills only the app, never the installer it spawned", () => {
    // posix: no `pgrep -P` scan, so the relaunched AppImage (a child) lives.
    const signaled: number[] = [];
    const scanned = vi.fn(() => "200\n");
    runInNewContext(watchdogScript(123, 0, "linux", Date.now(), false), {
      Date,
      process: { pid: 321, kill: (pid: number, signal?: string) => { if (signal) { signaled.push(pid); } } },
      require: () => ({ execFileSync: scanned }),
      setTimeout: (callback: () => void) => callback(),
    });
    expect(scanned).not.toHaveBeenCalled();
    expect(signaled).toEqual([123]);

    // win32: `taskkill` without `/T`, so the NSIS installer (a child) lives.
    const taskkill = (tree: boolean) => {
      const calls: string[][] = [];
      runInNewContext(watchdogScript(123, 0, "win32", Date.now(), tree), {
        Date,
        process: { pid: 321, kill: () => true },
        require: () => ({ spawnSync: (_file: string, args: string[]) => calls.push(args) }),
        setTimeout: (callback: () => void) => callback(),
      });
      return calls;
    };
    expect(taskkill(true)).toEqual([["/PID", "123", "/T", "/F"]]);
    expect(taskkill(false)).toEqual([["/PID", "123", "/F"]]);

    // And the quit an update starts is what arms that script.
    const spawned = vi.mocked(spawn);
    const armed = () => {
      spawned.mockImplementationOnce((() => ({ unref: () => undefined })) as never);
      armQuitDeadline(0, 4242, 0);
      return String(spawned.mock.calls.at(-1)![1]![1]);
    };
    const tree = process.platform === "win32" ? '"/T"' : "pgrep";
    expect(armed()).toContain(tree);
    markQuittingForUpdate();
    expect(armed()).not.toContain(tree);
  });
});
