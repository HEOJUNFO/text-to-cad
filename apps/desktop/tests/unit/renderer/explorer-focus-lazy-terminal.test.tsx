import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { TooltipProvider } from "@text-to-cad/ui/primitives/tooltip";
import { ExplorerPane, useExplorerShortcuts } from "@renderer/features/explorer/ExplorerPane";
import { claimFocus } from "@renderer/features/explorer/focus";
import { useExplorer } from "@renderer/state/explorer";
import { useProjects } from "@renderer/state/projects";
import type { ExplorerTab } from "@shared/types";

/**
 * The first terminal a window opens is drawn through `React.lazy`, and its
 * chunk can land after `focusTabBody` has settled. The module is held here
 * until the test lets it go; everything past it is the real `TerminalTab`,
 * with xterm stood in for (jsdom has no canvas) and counting its `focus()`.
 */
const chunk = vi.hoisted(() => {
  const state = { gate: Promise.resolve(), release: () => {}, fail: false };
  const hold = () => { state.gate = new Promise<void>((resolve) => { state.release = resolve; }); };
  hold();
  return { state, hold, release: () => state.release() };
});
vi.mock("@renderer/features/explorer/TerminalTab", async (importOriginal) => {
  await chunk.state.gate;
  if (chunk.state.fail) throw new Error("Failed to fetch dynamically imported module");
  return importOriginal();
});
const focused = vi.hoisted(() => ({ count: 0 }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    onSelectionChange() {}
    loadAddon() {}
    open() {}
    write(_data: string, done?: () => void) { done?.(); }
    onData() {}
    attachCustomKeyEventHandler() {}
    focus() { focused.count += 1; }
    clear() {}
    getSelection() { return ""; }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@renderer/features/explorer/FileTab", () => ({
  FileTab: ({ tabId }: { tabId: string }) => <input aria-label={`Editor ${tabId}`} />,
}));

// `Shell` mounts the chords; this suite has no shell around the pane.
function Pane() {
  useExplorerShortcuts();
  return <ExplorerPane />;
}

const PROJECT = { id: "lazy-focus-project", name: "Project", path: "/repo", createdAt: 0 };
const fileTab: ExplorerTab = { id: "f1", kind: "file", sessionId: "s1", projectId: PROJECT.id, order: 0,
  root: null, panel: null, path: "f1.ts" } as ExplorerTab;
const terminalTab: ExplorerTab = { id: "t1", kind: "terminal", sessionId: "s1", projectId: PROJECT.id, order: 1,
  ptyId: "pty-test", cwd: null, readOnly: false } as ExplorerTab;

beforeEach(() => {
  useProjects.setState({ projects: [PROJECT], ready: true, activeId: PROJECT.id, draft: null });
  useExplorer.setState({ sessionId: "s1", projectId: PROJECT.id, root: null, ready: true, collapsed: false,
    tabs: [fileTab, terminalTab], activeId: "f1" });
  const terminal = window.textToCad.terminal as unknown as Record<string, ReturnType<typeof vi.fn>>;
  terminal.attach = vi.fn(async () => ({ info: { id: "pty-test", cwd: "/repo", shell: "/bin/zsh", cols: 80, rows: 24, exitCode: null }, scrollback: "", seq: 0 }));
  terminal.resize = vi.fn(async () => {});
});

/**
 * A chunk that fails to load must not take the window with it: `lazy` stays rejected, so the tab
 * draws an alert with a Try again that builds a new `lazy`. This runs first, and ends with the
 * retry waiting on the gate again, so the tests below still see the chunk arrive late.
 */
it("a terminal chunk that fails to load draws an alert with Try again, and Try again asks for it anew", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  chunk.state.fail = true;
  useExplorer.setState({ activeId: "t1" });
  render(<TooltipProvider><Pane /></TooltipProvider>);
  chunk.release();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Could not open the terminal");
  fireEvent.keyDown(window, { key: "1", metaKey: true, ctrlKey: true });
  expect(useExplorer.getState().activeId).toBe("f1");
  fireEvent.keyDown(window, { key: "2", metaKey: true, ctrlKey: true });

  chunk.state.fail = false;
  chunk.hold();
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Opening terminal…")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
  logged.mockRestore();
});

/** Two frames after this call's: `focusTabBody` has settled by then, for better or worse. */
const afterSettle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

it("the first terminal picked in a window takes the keyboard when its chunk lands after focus settled", async () => {
  render(<TooltipProvider><Pane /></TooltipProvider>);
  screen.getByRole("textbox", { name: "Editor f1" }).focus();
  fireEvent.keyDown(window, { key: "2", metaKey: true, ctrlKey: true });
  expect(useExplorer.getState().activeId).toBe("t1");
  await afterSettle();
  expect(screen.getByText("Opening terminal…")).toBeInTheDocument();

  chunk.release();
  await waitFor(() => expect(screen.queryByText("Opening terminal…")).toBeNull());
  await waitFor(() => expect(focused.count).toBe(1));
  const stripTab = document.querySelector('[data-tab-strip] [data-tab="t1"]');
  expect(document.activeElement).not.toBe(stripTab);
});

/**
 * A terminal already mounted has used its one claim. Picking its tab again names it wanted, and
 * nothing is left to consume that: it is focused then, and not by the next rebuild of its widget.
 */
it("picking the active terminal's tab focuses it then, and leaves no claim for a later rebuild", async () => {
  chunk.release();
  focused.count = 0;
  useExplorer.setState({ activeId: "t1" });
  render(<TooltipProvider><Pane /></TooltipProvider>);
  await waitFor(() => expect(screen.queryByText("Opening terminal…")).toBeNull());
  expect(focused.count).toBe(0);

  fireEvent.keyDown(window, { key: "2", metaKey: true, ctrlKey: true });
  await afterSettle();
  expect(focused.count).toBe(1);
  expect(claimFocus("t1")).toBe(false);
});
