/**
 * The application menu.
 *
 * Menu items that change the UI do not reach into the renderer's state; they
 * send a `ui.command` event and let the renderer decide what that means. The
 * menu and the keyboard shortcut and the command palette then all take the
 * same path, and only one of them can be wrong.
 */
import { Menu, app, dialog, shell, type BrowserWindow, type MenuItemConstructorOptions } from "electron";

import type { IpcEventPayload } from "../shared/ipc";
import { browserService } from "./browser/service";
import { emit } from "./ipc/register";

type UiCommand = IpcEventPayload<"ui.command">["command"];

const REPOSITORY_URL = "https://github.com/earthtojake/text-to-cad";

export function buildMenu(focusedWindow: () => BrowserWindow | null, packaged = app.isPackaged) {
  const send = (command: UiCommand) => () => {
    const window = focusedWindow();
    if (window) {
      emit([window.webContents], "ui.command", { command });
    }
  };

  const isMac = process.platform === "darwin";

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { label: "Settings…", accelerator: "Cmd+,", click: send("open-settings") },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: "File",
      submenu: [
        { label: "New Session", accelerator: "CmdOrCtrl+N", click: send("new-session") },
        { type: "separator" },
        ...(isMac
          ? ([{ role: "close" }] as MenuItemConstructorOptions[])
          : ([
              { label: "Settings…", accelerator: "Ctrl+,", click: send("open-settings") },
              { type: "separator" },
              { role: "quit" },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+B",
          click: send("toggle-sidebar"),
        },
        {
          label: "Toggle Explorer",
          accelerator: "CmdOrCtrl+Alt+B",
          click: send("toggle-explorer"),
        },
        { type: "separator" },
        // The top level's history — the threads and new-session screens the
        // session pane has shown. Declared here as well as in the renderer
        // because this accelerator is the one that fires with focus inside a
        // webview or a terminal.
        {
          label: "Back",
          accelerator: "CmdOrCtrl+[",
          click: send("navigate-back"),
        },
        {
          label: "Forward",
          accelerator: "CmdOrCtrl+]",
          click: send("navigate-forward"),
        },
        { type: "separator" },
        {
          label: "Command Palette…",
          accelerator: "CmdOrCtrl+K",
          click: send("command-palette"),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        // Cmd+R belongs to the embedded browser page that has focus, and to
        // nothing else: `role: "reload"` reloaded the app's own renderer from
        // inside a browser page, dropping unsaved drafts and leaving the
        // native pages painted over the new document.
        {
          label: "Reload Page",
          accelerator: "CmdOrCtrl+R",
          click: () => { browserService.reloadFocused(focusedWindow()); },
        },
        ...(packaged
          ? []
          : ([{
              // Development only, on a chord nothing else uses (Mod+Shift+R
              // opens a review tab). Unsaved drafts still ask first.
              label: "Reload App",
              accelerator: "CmdOrCtrl+Alt+R",
              click: () => { focusedWindow()?.webContents.reload(); },
            }] as MenuItemConstructorOptions[])),
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Window",
      submenu: isMac
        ? [
            { role: "minimize" },
            { role: "zoom" },
            { type: "separator" },
            { role: "front" },
          ]
        : [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
    {
      role: "help",
      submenu: [
        {
          label: "text-to-cad on GitHub",
          click: () => {
            void shell.openExternal(REPOSITORY_URL);
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

export function installMenu(focusedWindow: () => BrowserWindow | null) {
  Menu.setApplicationMenu(buildMenu(focusedWindow));
  // Registered here, before the first window: the menu's reload is what the
  // renderer's unsaved-draft guard exists for.
  app.on("before-quit", () => { quitting = true; });
  app.on("browser-window-created", (_event, window) => guardRendererUnload(window));
}

let quitting = false;

/**
 * The renderer refuses to unload while a document has unsaved text
 * (`src/renderer/state/live-documents.ts`). Electron would otherwise cancel
 * the reload or close silently. While quitting, teardown has already run
 * (`before-quit` in index.ts), so the unload always proceeds; otherwise the
 * person decides.
 */
export function guardRendererUnload(window: BrowserWindow, isQuitting = () => quitting) {
  window.webContents.on("will-prevent-unload", (event) => {
    if (isQuitting()) {
      event.preventDefault();
      return;
    }
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      buttons: ["Discard Changes", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Discard unsaved changes?",
      detail: "A document open in this window has changes that are not saved.",
    });
    // preventDefault on this event ignores the page's refusal: the unload goes ahead.
    if (choice === 0) {
      event.preventDefault();
    }
  });
}
