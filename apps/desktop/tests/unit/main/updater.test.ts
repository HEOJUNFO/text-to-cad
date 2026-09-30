import type { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  check: vi.fn(async (): Promise<unknown> => ({})),
  quitAndInstall: vi.fn(),
  downloadUpdate: vi.fn(async () => undefined),
  settings: { checkUpdatesOnLaunch: true },
  native: null as unknown as EventEmitter,
}));

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  mocks.native = new Emitter();
  return { app: { isPackaged: true }, autoUpdater: mocks.native };
});
type FakeUpdater = EventEmitter & { autoDownload: boolean; autoInstallOnAppQuit: boolean; logger: unknown };
let autoUpdater: FakeUpdater;
vi.mock("electron-updater", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  autoUpdater = Object.assign(new Emitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    logger: undefined as unknown,
    checkForUpdates: () => mocks.check(),
    downloadUpdate: () => mocks.downloadUpdate(),
    quitAndInstall: (...args: unknown[]) => mocks.quitAndInstall(...args),
  });
  return { default: { autoUpdater } };
});
vi.mock("@main/ipc", () => ({ broadcast: mocks.broadcast }));
vi.mock("@main/db/repositories", () => ({ settings: { get: () => mocks.settings } }));

async function load() {
  // The fake updaters outlive `resetModules`: without this, an earlier test's
  // module would still be listening to them.
  autoUpdater?.removeAllListeners();
  mocks.native?.removeAllListeners();
  vi.resetModules();
  const updater = await import("@main/updater");
  updater.initUpdater();
  return updater;
}

/** A check whose feed announces `version` (electron-updater's event order). */
function feedAnnounces(version: string) {
  mocks.check.mockImplementation(async () => {
    autoUpdater.emit("checking-for-update");
    autoUpdater.emit("update-available", { version });
    return { updateInfo: { version } };
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.check.mockReset();
  mocks.quitAndInstall.mockReset();
  mocks.broadcast.mockReset();
});

describe("updater", () => {
  it("keeps a staged download staged through a manual check, so Restart still installs", async () => {
    const updater = await load();
    feedAnnounces("2.0.0");
    await updater.checkForUpdates();
    expect(updater.updateStatus()).toEqual({ state: "available", version: "2.0.0" });
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });

    const answer = await updater.checkForUpdates();
    expect(answer).toEqual({ state: "downloaded", version: "2.0.0" });
    expect(mocks.check).toHaveBeenCalledTimes(1);
    const { isQuitting } = await import("@main/quitting");
    mocks.quitAndInstall.mockImplementation(() => {
      // What Electron does when the install really quits: announce it, then
      // close the windows before `before-quit`. The unload guard must already
      // know this is a quit.
      mocks.native.emit("before-quit-for-update");
      expect(isQuitting()).toBe(true);
    });
    updater.installUpdate();
    expect(mocks.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(isQuitting()).toBe(true);
    updater.stopUpdater();
  });

  it("an install that does not quit leaves the unsaved-draft ask in place", async () => {
    const updater = await load();
    const { isQuitting } = await import("@main/quitting");
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    // MacUpdater with Squirrel still fetching, or BaseUpdater's failed
    // install(): quitAndInstall returns and nothing quits.
    mocks.quitAndInstall.mockImplementation(() => undefined);
    updater.installUpdate();
    expect(mocks.quitAndInstall).toHaveBeenCalled();
    expect(isQuitting()).toBe(false);
    updater.stopUpdater();
  });

  it("a second Restart while the first install is under way does not quit and install again", async () => {
    const updater = await load();
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    // MacUpdater with Squirrel still fetching: quitAndInstall returns, nothing quits.
    mocks.quitAndInstall.mockImplementation(() => undefined);
    updater.installUpdate();
    updater.installUpdate();
    expect(mocks.quitAndInstall).toHaveBeenCalledTimes(1);
    updater.stopUpdater();
  });

  it("an install that is refused puts the scheduled checks back", async () => {
    const updater = await load();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    // MacUpdater refusing an unsigned update: `error`, and no quit.
    mocks.quitAndInstall.mockImplementation(() => {
      autoUpdater.emit("error", new Error("Could not get code signature for running application"));
    });
    updater.installUpdate();
    expect(updater.updateStatus()).toEqual({ state: "error", message: "Could not get code signature for running application" });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(mocks.check).toHaveBeenCalledTimes(3);
    updater.stopUpdater();
  });

  it("skips the six-hourly check while downloaded or downloading", async () => {
    const updater = await load();
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + 10_000);
    expect(mocks.check).not.toHaveBeenCalled();

    autoUpdater.emit("download-progress", { percent: 40 });
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(updater.updateStatus().state).toBe("downloading");
    updater.stopUpdater();
  });

  it("ignores a re-announcement of the version already downloaded", async () => {
    const updater = await load();
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    autoUpdater.emit("checking-for-update");
    autoUpdater.emit("update-available", { version: "2.0.0" });
    expect(updater.updateStatus()).toEqual({ state: "downloaded", version: "2.0.0" });
    updater.stopUpdater();
  });

  it("treats a release without latest-*.yml as idle, not an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const updater = await load();
    mocks.check.mockImplementation(async () => {
      const error = Object.assign(new Error("Cannot find latest-mac.yml in the latest release artifacts (https://…): 404"), {
        code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
      });
      autoUpdater.emit("error", error);
      throw error;
    });
    expect(await updater.checkForUpdates()).toEqual({ state: "idle" });
    expect(warn).toHaveBeenCalled();

    mocks.check.mockRejectedValue(new Error("net::ERR_INTERNET_DISCONNECTED"));
    expect(await updater.checkForUpdates()).toEqual({ state: "error", message: "net::ERR_INTERNET_DISCONNECTED" });
    warn.mockRestore();
    updater.stopUpdater();
  });
});
