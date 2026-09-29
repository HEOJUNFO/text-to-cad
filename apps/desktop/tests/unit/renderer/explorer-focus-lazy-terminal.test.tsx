import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { TooltipProvider } from "@text-to-cad/ui/primitives/tooltip";
import { ExplorerPane } from "@renderer/features/explorer/ExplorerPane";
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
  let release: () => void = () => {};
  const landed = new Promise<void>((resolve) => { release = resolve; });
  return { landed, release: () => release() };
});
vi.mock("@renderer/features/explorer/TerminalTab", async (importOriginal) => {
  await chunk.landed;
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

/** Two frames after this call's: `focusTabBody` has settled by then, for better or worse. */
const afterSettle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

it("the first terminal picked in a window takes the keyboard when its chunk lands after focus settled", async () => {
  render(<TooltipProvider><ExplorerPane /></TooltipProvider>);
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
