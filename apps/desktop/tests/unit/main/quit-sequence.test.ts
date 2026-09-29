import type { EventEmitter } from "node:events";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as Children from "@main/children";
import { AgentDetector } from "@main/agents/detect";
import { AGENT_PROVIDERS } from "@main/agents/registry";
import { spawnProcessTerminal } from "@main/acp/process-backend";
import { SessionManager, type SessionRepository } from "@main/acp/sessions";
import { db } from "@main/db/index";
import type { AgentProvider } from "@shared/agents";
import type { Session } from "@shared/types";

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
  manager: null as { closeAll(): void } | null,
  cadFails: false,
  teardown: [] as string[],
  electron: null as unknown as { dialog: { showErrorBox: ReturnType<typeof vi.fn> }; app: { exit: ReturnType<typeof vi.fn> } },
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
    exit: vi.fn(() => h.teardown.push("exit")),
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
  const dialog = { showErrorBox: vi.fn() };
  h.electron = { dialog, app };
  return {
    app,
    BrowserWindow,
    dialog,
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
vi.mock("@main/ipc/acp", () => {
  return {
    prewarmAgents: () => undefined,
    // `SessionManager.closeAll()`: every adapter closed, then the pending
    // snapshots written through the database.
    shutdownAcp: () => {
      h.manager?.closeAll();
    },
  };
});
vi.mock("@main/integrations", () => ({
  initIntegrations: async () => undefined,
  shutdownIntegrations: async () => void h.teardown.push("integrations"),
}));
vi.mock("@main/cad", () => ({
  initCad: async () => {
    if (h.cadFails) {
      throw new Error("the CAD runtime could not start");
    }
  },
  shutdownCad: async () => void h.teardown.push("cad"),
}));
vi.mock("@main/browser/service", () => ({ browserService: { dispose: () => undefined } }));
vi.mock("@main/children", async (importOriginal) => ({
  ...(await importOriginal<typeof Children>()),
  endTrackedChildren: () => undefined,
  killTrackedChildren: () => void h.teardown.push("children"),
}));
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

/** The fake ACP agent (`tests/fake-agent`), in the registry's claude-code slot. */
const FAKE_AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fake-agent", "index.mjs");
const claude = AGENT_PROVIDERS.find((provider) => provider.id === "claude-code")!;
(claude as { launch: AgentProvider["launch"] }).launch = { command: process.execPath, args: [FAKE_AGENT], env: {} };

/**
 * A session index and snapshot store that, like the app's, go through `db()`
 * on every call — so a write after `closeDb()` is the real error.
 */
function databaseBacked() {
  const rows = new Map<string, Session>();
  const late: string[] = [];
  const touch = (what: string) => {
    try {
      db();
    } catch (error) {
      late.push(what);
      throw error;
    }
  };
  const repo: SessionRepository = {
    list: () => (touch("list"), [...rows.values()]),
    get: (id) => (touch("get"), rows.get(id) ?? null),
    upsert: (session) => (touch("upsert"), rows.set(session.id, session), session),
    remove: (id) => (touch("remove"), void rows.delete(id)),
  };
  const snapshots = {
    read: () => (touch("snapshot.read"), null),
    write: () => {
      touch("snapshot.write");
      if (!h.order.includes("acpSnapshots")) {
        h.order.push("acpSnapshots");
      }
    },
    remove: () => touch("snapshot.remove"),
  };
  return { repo, snapshots, late };
}

async function managerWithSlowTurn() {
  const provider = { ...claude, launchWithoutBinary: true } as AgentProvider;
  const detector = new AgentDetector([provider], {
    env: async () => ({ PATH: process.env.PATH ?? "" }),
    isExecutable: async () => false,
    exists: async () => false,
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    homeDir: () => os.homedir(),
    platform: process.platform,
  });
  await detector.refresh();
  const store = databaseBacked();
  const manager = new SessionManager({
    repo: store.repo,
    snapshots: store.snapshots,
    detector,
    spawnTerminal: spawnProcessTerminal,
    broadcast: () => undefined,
    newId: () => "session-1",
  });
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "text-to-cad-quit-")));
  const session = await manager.create({ projectId: "p1", agentId: "claude-code", cwd, gitMode: "none" });
  // "slow" holds the turn open until cancelled: a prompt in flight at quit.
  const turn = manager.prompt(session.id, [{ type: "text", text: "slow" }]);
  await vi.waitFor(() => expect(manager.state(session.id)?.state.status).toBe("running"));
  return { manager, turn, late: store.late };
}

describe("quit sequence", () => {
  it("with a turn in flight: flushes ACP snapshots, then window state, then closes the database — and nothing touches it after", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { manager, turn, late } = await managerWithSlowTurn();
    h.manager = manager;
    const settled = turn.then(
      () => null,
      (error: unknown) => error,
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
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

    // The killed adapter's in-flight prompt rejects after the database closed;
    // its `prompt/error` must not try to write a status through it.
    vi.useRealTimers();
    const outcome = await settled;
    expect(String(outcome)).not.toMatch(/closeDb/);
    expect(late).toEqual([]);

    // And a straggler that does reach for it gets a clear error, not a new connection.
    expect(() => db()).toThrow(/used after closeDb\(\)/);
    info.mockRestore();
    warn.mockRestore();
  });

  it("a startup failure outside the database tears down what started, says why without a database line, and exits", async () => {
    vi.resetModules();
    h.windows.length = 0;
    h.teardown.length = 0;
    h.cadFails = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await import("@main/index");
    await vi.waitFor(() => expect(h.teardown).toContain("exit"));

    expect(h.electron.dialog.showErrorBox).toHaveBeenCalledWith("text-to-cad could not start", "the CAD runtime could not start");
    expect(h.electron.app.exit).toHaveBeenCalledWith(1);
    // app.exit skips before-quit and will-quit: their teardown ran first.
    expect(h.teardown.indexOf("exit")).toBe(h.teardown.length - 1);
    expect(h.teardown).toEqual(expect.arrayContaining(["cad", "integrations", "children"]));
    expect(h.windows).toHaveLength(0);
    error.mockRestore();
    info.mockRestore();
  });
});
