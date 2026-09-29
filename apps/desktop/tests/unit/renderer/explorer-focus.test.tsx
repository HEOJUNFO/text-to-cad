import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { TooltipProvider } from "@text-to-cad/ui/primitives/tooltip";
import { ExplorerPane } from "@renderer/features/explorer/ExplorerPane";
import { useExplorer } from "@renderer/state/explorer";
import { useProjects } from "@renderer/state/projects";
import type { ExplorerTab } from "@shared/types";

/**
 * Where the keyboard goes after a chord opens or picks a tab. The bodies are stand-ins: an editor
 * that goes with its tab (Monaco, a tree row) and a review with nothing that claims focus.
 */
vi.mock("@renderer/features/explorer/FileTab", () => ({
  FileTab: ({ tabId }: { tabId: string }) => <input aria-label={`Editor ${tabId}`} />,
}));
vi.mock("@renderer/features/explorer/ReviewTab", () => ({ ReviewTab: () => <p>Review body</p> }));

const PROJECT = { id: "focus-project", name: "Project", path: "/repo", createdAt: 0 };
const fileTab = (id: string, order: number): ExplorerTab =>
  ({ id, kind: "file", sessionId: "s1", projectId: PROJECT.id, order, root: null, panel: null, path: `${id}.ts` }) as ExplorerTab;
const reviewTab = (id: string, order: number): ExplorerTab =>
  ({ id, kind: "review", sessionId: "s1", projectId: PROJECT.id, order, scope: "turn" }) as ExplorerTab;

beforeEach(() => {
  useProjects.setState({ projects: [PROJECT], ready: true, activeId: PROJECT.id, draft: null });
  useExplorer.setState({ sessionId: "s1", projectId: PROJECT.id, root: null, ready: true, collapsed: false,
    tabs: [fileTab("f1", 0), reviewTab("r1", 1)], activeId: "f1" });
});

const pane = () => render(<TooltipProvider><ExplorerPane /></TooltipProvider>);
const stripTab = (id: string) => document.querySelector(`[data-tab-strip] [data-tab="${id}"]`);

it("Mod+Shift+R from an editor hands focus to the new review's tab, not the page", async () => {
  pane();
  screen.getByRole("textbox", { name: "Editor f1" }).focus();
  fireEvent.keyDown(window, { key: "R", shiftKey: true, metaKey: true, ctrlKey: true });
  const opened = useExplorer.getState().activeId!;
  expect(useExplorer.getState().tabs.find((tab) => tab.id === opened)?.kind).toBe("review");
  await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  expect(document.activeElement).toBe(stripTab(opened));
});

it("Mod+2 from an editor hands focus to the picked tab, and Mod+1 back into its body's tab", async () => {
  pane();
  screen.getByRole("textbox", { name: "Editor f1" }).focus();
  fireEvent.keyDown(window, { key: "2", metaKey: true, ctrlKey: true });
  await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  expect(document.activeElement).toBe(stripTab("r1"));
  fireEvent.keyDown(window, { key: "1", metaKey: true, ctrlKey: true });
  await waitFor(() => expect(document.activeElement).toBe(stripTab("f1")));
});
