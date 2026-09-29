import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import type { Project } from "@shared/types";

/** xterm draws to a canvas jsdom does not have; the tab's lifecycle is what is under test. */
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    onSelectionChange() {}
    loadAddon() {}
    open() {}
    write() {}
    onData() {}
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
