/** BrowserTab's address bar and navigation row, against a mounted-but-empty native page. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserTab } from "@renderer/features/explorer/BrowserTab";
import { useBrowser } from "@renderer/state/browser";
import type { BrowserTarget } from "@shared/browser";

const target: BrowserTarget = { sessionId: "first", tabId: "page", projectId: "project", root: "/project", generation: 1, title: "Example page", url: "https://example.com/", loading: false, visible: true, canGoBack: true, canGoForward: true, logs: [] };
const navigate = vi.fn();
const originalMount = useBrowser.getState().mount;
const originalNavigate = useBrowser.getState().navigate;
beforeEach(() => {
  navigate.mockReset().mockResolvedValue(undefined);
  useBrowser.setState({ targets: { page: target }, errors: {}, consoles: {}, mount: () => () => {}, navigate });
});
afterEach(() => { cleanup(); useBrowser.setState({ mount: originalMount, navigate: originalNavigate }); });
const renderTab = () => render(<BrowserTab sessionId="first" projectId="project" root={null} tabId="page" url={target.url} />);

it("names its icon-only buttons, and says whether the console is open", () => {
  renderTab();
  for (const name of [/^back$/i, /^forward$/i, /^reload$/i, /open in your browser/i]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
  const console = screen.getByRole("button", { name: /^console$/i });
  expect(console).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(console);
  expect(screen.getByRole("button", { name: /^console$/i })).toHaveAttribute("aria-pressed", "true");
});
