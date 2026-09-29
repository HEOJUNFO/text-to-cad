/**
 * Window geometry that survives a quit.
 *
 * Saves are debounced because resizing fires continuously, and the position is
 * checked against the displays that exist *now* — an app that reopens
 * off-screen after a monitor is unplugged looks like it failed to launch.
 */
import { screen, type BrowserWindow, type Rectangle } from "electron";

import type { WindowState } from "../shared/types";
import { settings } from "./db/repositories";

const SAVE_DEBOUNCE_MS = 400;

/** Every tracked window's final save, run once by `flushWindowStates`. */
const flushers = new Set<() => void>();

/** The stored geometry, dropped back to defaults if it lands off-screen. */
export function restoreWindowState(): WindowState {
  const state = settings.windowState();
  if (state.x === undefined || state.y === undefined) {
    return state;
  }
  const visible = screen.getAllDisplays().some((display) => overlaps(display.workArea, state));
  return visible ? state : { ...state, x: undefined, y: undefined };
}

/** Track a window and persist its geometry. Returns a detach function. */
export function trackWindowState(window: BrowserWindow) {
  let timer: NodeJS.Timeout | undefined;

  const save = () => {
    if (window.isDestroyed()) {
      return;
    }
    // getNormalBounds is the un-maximised, un-fullscreened rectangle: the one
    // to restore to when the user un-maximises later.
    const bounds = window.getNormalBounds();
    // Also reached from a timer, where a throw is an uncaught exception: a
    // save that cannot be written is logged and dropped.
    try {
      settings.setWindowState({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: window.isMaximized(),
      });
    } catch (error) {
      console.warn("[window-state] not saved:", error instanceof Error ? error.message : error);
    }
  };

  let flushed = false;
  const scheduleSave = () => {
    clearTimeout(timer);
    // After the quit flush the database is closing; a resize or move the
    // closing window still emits is not saved.
    if (!flushed) {
      timer = setTimeout(save, SAVE_DEBOUNCE_MS);
    }
  };

  const flush = () => {
    clearTimeout(timer);
    if (!flushed) {
      flushed = true;
      save();
    }
  };
  flushers.add(flush);

  window.on("resize", scheduleSave);
  window.on("move", scheduleSave);
  window.on("maximize", scheduleSave);
  window.on("unmaximize", scheduleSave);
  // The debounce would lose the last change on quit, so close saves directly —
  // unless quitting already did: `before-quit` flushes (below) before the
  // database closes, and a save from this later `close` would need it open.
  window.on("close", () => {
    flush();
    flushers.delete(flush);
  });

  return () => {
    clearTimeout(timer);
    flushers.delete(flush);
  };
}

/**
 * Save every tracked window's geometry now, once. Called from `before-quit`
 * BEFORE `closeDb()`: the windows' own `close` events fire after it, when the
 * database is gone, and must not reopen it.
 */
export function flushWindowStates() {
  for (const flush of flushers) {
    flush();
  }
  flushers.clear();
}

function overlaps(area: Rectangle, state: WindowState) {
  const x = state.x ?? 0;
  const y = state.y ?? 0;
  return (
    x < area.x + area.width &&
    x + state.width > area.x &&
    y < area.y + area.height &&
    y + state.height > area.y
  );
}
