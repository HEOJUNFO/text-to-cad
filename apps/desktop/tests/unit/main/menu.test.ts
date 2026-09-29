/** Cmd+R reloads the focused embedded page, never the app's renderer in a packaged build; unsaved drafts ask first. */
import { EventEmitter } from "node:events";
import type { MenuItemConstructorOptions } from "electron";
import { beforeEach, expect, it, vi } from "vitest";

const showMessageBoxSync = vi.hoisted(() => vi.fn());
const reloadFocused = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
  Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: vi.fn() },
  app: { name: "text-to-cad", isPackaged: false, on: vi.fn() },
  dialog: { showMessageBoxSync },
  shell: {},
}));
vi.mock("@main/ipc/register", () => ({ emit: vi.fn() }));
vi.mock("@main/browser/service", () => ({ browserService: { reloadFocused } }));
import { buildMenu, guardRendererUnload } from "@main/menu";

beforeEach(() => { vi.clearAllMocks(); });
const flatten = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  items.flatMap(item => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
const window = { webContents: Object.assign(new EventEmitter(), { reload: vi.fn() }) };
const items = (packaged: boolean) => flatten(buildMenu(() => window as unknown as Electron.BrowserWindow, packaged) as unknown as MenuItemConstructorOptions[]);

it("has no renderer reload in a packaged build; Cmd+R goes to the focused browser page", () => {
  const packaged = items(true);
  expect(packaged.filter(item => item.role === "reload" || item.role === "forceReload")).toEqual([]);
  const reload = packaged.filter(item => item.accelerator === "CmdOrCtrl+R");
  expect(reload).toHaveLength(1);
  (reload[0]!.click as () => void)();
  expect(reloadFocused).toHaveBeenCalledWith(window);
  expect(window.webContents.reload).not.toHaveBeenCalled();
  expect(packaged.some(item => item.label === "Reload App")).toBe(false);
});

it("keeps an app reload in development under a chord of its own", () => {
  const development = items(false);
  expect(development.filter(item => item.role === "reload")).toEqual([]);
  const app = development.find(item => item.label === "Reload App")!;
  expect(app.accelerator).not.toMatch(/^CmdOrCtrl\+(Shift\+)?R$/);
  (app.click as () => void)();
  expect(window.webContents.reload).toHaveBeenCalledTimes(1);
  // Every accelerator is bound once.
  const accelerators = development.map(item => item.accelerator).filter(Boolean);
  expect(new Set(accelerators).size).toBe(accelerators.length);
});

it("asks before an unload the renderer refused, and never blocks a quit", () => {
  let quitting = false;
  const guarded = { webContents: new EventEmitter() } as unknown as Electron.BrowserWindow;
  guardRendererUnload(guarded, () => quitting);
  const refuse = () => { const event = { preventDefault: vi.fn() }; guarded.webContents.emit("will-prevent-unload", event); return event.preventDefault.mock.calls.length > 0; };
  showMessageBoxSync.mockReturnValue(1);
  expect(refuse()).toBe(false); // Cancel: stays.
  showMessageBoxSync.mockReturnValue(0);
  expect(refuse()).toBe(true); // Discard: unloads.
  quitting = true; showMessageBoxSync.mockClear();
  expect(refuse()).toBe(true);
  expect(showMessageBoxSync).not.toHaveBeenCalled();
});
