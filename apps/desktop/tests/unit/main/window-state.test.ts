import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ calls: 0, closed: false }));

vi.mock("electron", () => ({ screen: { getAllDisplays: () => [] } }));
vi.mock("@main/db/repositories", () => ({
  settings: {
    setWindowState: () => {
      if (saved.closed) {
        throw new Error("database used after close");
      }
      saved.calls += 1;
    },
  },
}));

import { flushWindowStates, trackWindowState } from "@main/window-state";

function fakeWindow() {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isMaximized: () => false,
    getNormalBounds: () => ({ x: 1, y: 2, width: 900, height: 600 }),
  });
}

describe("window state on quit", () => {
  it("saves in before-quit, and the later close does not touch the closed database", () => {
    const window = fakeWindow();
    trackWindowState(window as never);
    flushWindowStates();
    expect(saved.calls).toBe(1);
    saved.closed = true;
    expect(() => window.emit("close")).not.toThrow();
    expect(saved.calls).toBe(1);
  });
});
