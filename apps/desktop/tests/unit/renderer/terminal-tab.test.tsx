import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import type { Project } from "@shared/types";

/**
 * xterm draws to a canvas jsdom does not have; the tab's lifecycle is what is
 * under test. `write` answers a cursor position query the way xterm does —
 * synchronously, through `onData`, while it parses — so the tab's handling of
 * those answers can be seen.
 */
const terminals = vi.hoisted(() => [] as Array<{ options: { fontFamily?: string } }>);
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    private listener: (data: string) => void = () => {};
    constructor(public options: { fontFamily?: string }) {
      terminals.push(this);
    }
    onSelectionChange() {}
    loadAddon() {}
    open() {}
    write(data: string, done?: () => void) {
      if (data.includes("\x1b[6n")) this.listener("\x1b[1;1R");
      done?.();
    }
    onData(listener: (data: string) => void) {
      this.listener = listener;
    }
    attachCustomKeyEventHandler() {}
    focus() {}
    clear() {}
    getSelection() { return ""; }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { TerminalTab } from "@renderer/features/explorer/TerminalTab";
import { useExplorer } from "@renderer/state/explorer";

const project: Project = { id: "terminal-project", name: "Project", path: "/tmp/terminal-project", createdAt: 0 };
const terminal = () => window.textToCad.terminal as unknown as Record<string, ReturnType<typeof vi.fn>>;
const info = (exitCode: number | null) => ({ id: "pty-old", cwd: project.path, shell: "/bin/zsh", cols: 80, rows: 24, exitCode });

let update: ReturnType<typeof vi.fn>;
beforeEach(() => {
  terminals.length = 0;
  document.documentElement.style.removeProperty("--font-mono");
  update = vi.fn();
  useExplorer.setState({ update } as never);
  terminal().kill = vi.fn(async () => {});
  terminal().resize = vi.fn(async () => {});
});

function renderTab() {
  render(<TerminalTab tabId="tab" sessionId="session" project={project} ptyId="pty-old" cwd={project.path} readOnly={false} />);
}

it("kills the exited pty before restarting, so its scrollback is not kept for a tab that moved on", async () => {
  terminal().attach = vi.fn(async () => ({ info: info(0), scrollback: "done\n", seq: 1 }));
  renderTab();
  fireEvent.click(await screen.findByRole("button", { name: "restart" }));
  expect(terminal().kill).toHaveBeenCalledWith({ id: "pty-old", sessionId: "session" });
  expect(update).toHaveBeenCalledWith("tab", { ptyId: null });
});

it("releases the old pty id on Try again too", async () => {
  terminal().attach = vi.fn(async () => null);
  renderTab();
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(terminal().kill).toHaveBeenCalledWith({ id: "pty-old", sessionId: "session" });
  expect(update).toHaveBeenCalledWith("tab", { ptyId: null });
});

it("does not send the answer to a query replayed from scrollback, and still answers a live one", async () => {
  terminal().attach = vi.fn(async () => ({ info: info(null), scrollback: "$ \x1b[6n", seq: 1 }));
  terminal().write = vi.fn(async () => {});
  let live: (event: { id: string; data: string; seq: number }) => void = () => {};
  const on = window.textToCad.on as unknown as ReturnType<typeof vi.fn>;
  on.mockImplementation((channel: string, listener: typeof live) => {
    if (channel === "terminal.data") live = listener;
    return () => {};
  });
  renderTab();
  await waitFor(() => expect(terminal().attach).toHaveBeenCalled());
  await Promise.resolve();
  expect(terminal().write).not.toHaveBeenCalled();

  live({ id: "pty-old", data: "\x1b[6n", seq: 2 });
  expect(terminal().write).toHaveBeenCalledWith({ id: "pty-old", sessionId: "session", data: "\x1b[1;1R" });
});
