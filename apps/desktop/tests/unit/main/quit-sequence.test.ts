import type { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The quit path of `src/main/index.ts`, with Electron's app and window modelled
 * as event emitters and the real `db()` / `closeDb()` / window-state tracking.
 * Every quit-time database write — the ACP snapshot flush in `shutdownAcp`
 * (`SessionManager.closeAll` → `flushAll`) and the window's geometry — has to
 * land before `closeDb()`, and nothing after it may reach for the database.
 */
const h = vi.hoisted(() => ({
  order: [] as string[],
  windows: [] as EventEmitter[],
  app: null as unknown as EventEmitter,
}));

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  const app = Object.assign(new Emitter(), {
    setName: () => undefined,
    commandLine: { hasSwitch: () => true },
    setPath: () => undefined,
    getPath: () => "/nonexistent-userdata",
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    isReady: () => false,
    isPackaged: true,
    quit: () => undefined,
    exit: vi.fn(),
  });
  h.app = app;
  class BrowserWindow extends Emitter {
    static getAllWindows = () => h.windows;
    static getFocusedWindow = () => null;
    webContents = { setWindowOpenHandler: () => undefined, on: () => undefined, getURL: () => "" };
    constructor() {
      super();
      h.windows.push(this);
    }
    isDestroyed = () => false;
    isMaximized = () => false;
    maximize = () => undefined;
    getNormalBounds = () => ({ x: 0, y: 0, width: 900, height: 600 });
    loadFile = async () => undefined;
    loadURL = async () => undefined;
  }
  return {
    app,
    BrowserWindow,
    dialog: { showErrorBox: vi.fn() },
    nativeImage: { createFromPath: () => ({}) },
    nativeTheme: { shouldUseDarkColors: false },
    shell: { openExternal: async () => undefined },
    screen: { getAllDisplays: () => [] },
  };
});

vi.mock("better-sqlite3", () => ({
  default: class {
    pragma(source: string) {
      return source === "user_version" ? 0 : undefined;
    }
    close() {
      h.order.push("closeDb");
    }
  },
}));
vi.mock("@main/db/migrations", () => ({ MIGRATIONS: [{ version: 1 }], runMigrations: () => 1 }));
vi.mock("@main/db/repositories", async () => {
  const { db } = await import("@main/db/index");
  return {
    settings: {
      get: () => ({ theme: "system" }),
      windowState: () => ({ width: 900, height: 600 }),
      setWindowState: () => {
        db();
        h.order.push("windowState");
      },
    },
  };
});
vi.mock("@main/ipc/acp", async () => {
  const { db } = await import("@main/db/index");
  return {
    prewarmAgents: () => undefined,
    // `SessionManager.closeAll()`: every adapter closed, then the pending
    // snapshots written through the database.
    shutdownAcp: () => {
      db();
      h.order.push("acpSnapshots");
    },
  };
});
vi.mock("@main/integrations", () => ({ initIntegrations: async () => undefined, shutdownIntegrations: async () => undefined }));
vi.mock("@main/cad", () => ({ initCad: async () => undefined, shutdownCad: async () => undefined }));
vi.mock("@main/browser/service", () => ({ browserService: { dispose: () => undefined } }));
vi.mock("@main/children", () => ({ endTrackedChildren: () => undefined, killTrackedChildren: () => undefined }));
vi.mock("@main/ipc", () => ({ broadcast: () => undefined, registerIpcHandlers: () => undefined }));
vi.mock("@main/ipc/agents", () => ({ shutdownAgents: () => undefined }));
vi.mock("@main/ipc/explorer", () => ({ disposeExplorerServices: () => undefined }));
vi.mock("@main/menu", () => ({ installMenu: () => undefined }));
vi.mock("@main/quit-deadline", () => ({ armQuitDeadline: () => undefined }));
vi.mock("@main/settings-effects", () => ({ disposeSettingsEffects: () => undefined }));
vi.mock("@main/telemetry", () => ({ initTelemetry: () => undefined, track: () => undefined }));
vi.mock("@main/updater", () => ({ initUpdater: () => undefined, stopUpdater: () => undefined }));

afterEach(() => {
  vi.useRealTimers();
});

describe("quit sequence", () => {
  it("flushes ACP snapshots, then window state, then closes the database — and nothing touches it after", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await import("@main/index");
    await vi.waitFor(() => expect(h.windows).toHaveLength(1));
    const [window] = h.windows;

    // A resize just before quit leaves a debounced save pending.
    window!.emit("resize");
    expect(() => h.app.emit("before-quit")).not.toThrow();
    expect(h.order).toEqual(["acpSnapshots", "windowState", "closeDb"]);

    // What Electron does next: the window closes (and may still move), the
    // debounce would have fired, will-quit runs. None of it reopens the file.
    expect(() => {
      window!.emit("move");
      window!.emit("close");
      vi.advanceTimersByTime(1_000);
      h.app.emit("will-quit");
    }).not.toThrow();
    expect(h.order).toEqual(["acpSnapshots", "windowState", "closeDb"]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("[window-state]"), expect.anything());

    // And a straggler that does reach for it gets a clear error, not a new connection.
    const { db } = await import("@main/db/index");
    expect(() => db()).toThrow(/used after closeDb\(\)/);
    info.mockRestore();
    warn.mockRestore();
  });
});
