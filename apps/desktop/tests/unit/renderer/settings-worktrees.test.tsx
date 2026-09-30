/**
 * The Git page's per-project worktree card: which worktrees offer Delete, and
 * what a row says about why one does not.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { TooltipProvider } from "@text-to-cad/ui/primitives/tooltip";
import { GitPage } from "@renderer/features/settings/pages/GitPage";
import { useProjects } from "@renderer/state/projects";
import { useSettings } from "@renderer/state/settings";
import { defaultSettings } from "@shared/types";
import type { Worktree } from "@shared/ipc/git";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), info: vi.fn() } }));

const worktree = (over: Partial<Worktree>): Worktree => ({
  path: "/w/p/fillet",
  branch: "text-to-cad/fillet",
  lastUsedAt: null,
  openSessions: 0,
  dirty: false,
  locked: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useSettings.setState({ settings: defaultSettings(), ready: true });
  useProjects.setState({ projects: [{ id: "p", name: "p", path: "/p", createdAt: 0 }], activeId: "p" });
});

it("does not offer Delete on a locked worktree, and names the lock", async () => {
  vi.mocked(window.textToCad.git.worktrees).mockResolvedValue([worktree({ locked: true })]);
  render(
    <TooltipProvider>
      <GitPage />
    </TooltipProvider>,
  );
  const remove = await screen.findByRole("button", { name: "Delete" });
  expect(remove).toBeDisabled();
  expect(remove).toHaveAccessibleDescription(/locked/);
});
