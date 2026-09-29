import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

import { TooltipProvider } from "@text-to-cad/ui/primitives/tooltip";
import { EXPLORER_TABPANEL_ID, TabStrip } from "@renderer/features/explorer/TabStrip";
import { useExplorer } from "@renderer/state/explorer";
import type { ExplorerTab } from "@shared/types";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }) }));

const SESSION = "tab-strip-session";
const tab = (id: string, path: string, order: number): ExplorerTab =>
  ({ id, kind: "file", sessionId: SESSION, projectId: SESSION, order, root: null, panel: null, path }) as ExplorerTab;

beforeEach(() => {
  useExplorer.setState({
    sessionId: SESSION, projectId: SESSION, root: null, ready: true, collapsed: false,
    tabs: [tab("a", "a.md", 0), tab("b", "b.md", 1), tab("c", "c.md", 2)], activeId: "b",
  });
});

const strip = () => render(<TooltipProvider><TabStrip /></TooltipProvider>);

it("is one Tab stop: the selected tab, with its close button out of the Tab order", () => {
  strip();
  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((element) => element.tabIndex)).toEqual([-1, 0, -1]);
  expect(tabs[1]).toHaveAttribute("aria-selected", "true");
  expect(tabs[1]).toHaveAttribute("aria-controls", EXPLORER_TABPANEL_ID);
  expect(tabs[0]).not.toHaveAttribute("aria-controls");
  expect(screen.getByRole("button", { name: "Close b.md" })).toHaveAttribute("tabindex", "-1");
});

it("moves focus with the arrows, Home and End, and selects only on Enter", async () => {
  const user = userEvent.setup();
  strip();
  const [a, b, c] = screen.getAllByRole("tab");
  b!.focus();

  await user.keyboard("{ArrowRight}");
  expect(c).toHaveFocus();
  expect(c).toHaveAttribute("tabindex", "0");
  expect(useExplorer.getState().activeId).toBe("b");
  await user.keyboard("{ArrowRight}");
  expect(a).toHaveFocus();
  await user.keyboard("{ArrowLeft}");
  expect(c).toHaveFocus();
  await user.keyboard("{Home}");
  expect(a).toHaveFocus();
  await user.keyboard("{End}");
  expect(c).toHaveFocus();

  await user.keyboard("{Enter}");
  expect(useExplorer.getState().activeId).toBe("c");
});

it("closes the focused tab on Delete and hands focus to its neighbour", async () => {
  const user = userEvent.setup();
  strip();
  screen.getAllByRole("tab")[0]!.focus();

  await user.keyboard("{Delete}");
  expect(useExplorer.getState().tabs.map((candidate) => candidate.id)).toEqual(["b", "c"]);
  await waitFor(() => expect(screen.getByRole("tab", { name: /b\.md/ })).toHaveFocus());
});

it("closing the last tab on Delete hands focus to New tab, not to the page", async () => {
  useExplorer.setState({ tabs: [tab("a", "a.md", 0)], activeId: "a" });
  const user = userEvent.setup();
  strip();
  screen.getByRole("tab")!.focus();

  await user.keyboard("{Backspace}");
  expect(useExplorer.getState().tabs).toEqual([]);
  await waitFor(() => expect(screen.getByRole("button", { name: "New tab" })).toHaveFocus());
});

it("closing a tab with its close button hands focus to the tab selected next, not to the page", async () => {
  const user = userEvent.setup();
  strip();
  await user.click(screen.getByRole("button", { name: "Close b.md" }));
  expect(useExplorer.getState().tabs.map((candidate) => candidate.id)).toEqual(["a", "c"]);
  const selected = useExplorer.getState().activeId!;
  await waitFor(() => expect(document.querySelector(`[data-tab="${selected}"]`)).toHaveFocus());
});

it("Cmd+W from inside the tab's body hands focus to the tab selected next, not to the page", async () => {
  // The body the strip controls, standing in for Monaco or a terminal: it goes with its tab.
  function Body() {
    const activeId = useExplorer((state) => state.activeId);
    return activeId ? <input aria-label={`Body of ${activeId}`} key={activeId} /> : null;
  }
  render(<TooltipProvider><TabStrip /><Body /></TooltipProvider>);
  screen.getByRole("textbox", { name: "Body of b" }).focus();
  act(() => useExplorer.getState().closeActive());
  const selected = useExplorer.getState().activeId!;
  expect(selected).not.toBe("b");
  await waitFor(() => expect(document.querySelector(`[data-tab="${selected}"]`)).toHaveFocus());
});

it("draws the Terminal shortcut's backtick as a keycap and names it, not as a hairline beside ⌃", async () => {
  strip();
  await userEvent.setup().click(screen.getByRole("button", { name: "New tab" }));
  const terminal = await screen.findByRole("menuitem", { name: /Terminal/ });
  const tick = [...terminal.querySelectorAll("kbd")].find((key) => key.textContent === "`");
  expect(tick, "the backtick is its own keycap").toBeDefined();
  expect(terminal).toHaveTextContent(/backtick/);
  // The others are glyphs and letters, left as they are.
  expect((await screen.findByRole("menuitem", { name: /Review/ })).querySelector("kbd")).toBeNull();
});
