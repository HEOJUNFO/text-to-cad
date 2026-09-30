/**
 * The Git page's per-project worktree card: which worktrees offer Delete, and
 * what a row says about why one does not.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TooltipProvider } from "@text-to-cad/ui/primitives/tooltip";
import { SettingsRoute } from "@renderer/features/settings/SettingsRoute";
import { GitPage } from "@renderer/features/settings/pages/GitPage";
import { useWorktreeCache } from "@renderer/features/settings/worktree-cache";
import { useUi } from "@renderer/state/ui";
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
  useWorktreeCache.getState().invalidate();
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

it("says on the row why a worktree is kept: in use, locked", async () => {
  vi.mocked(window.textToCad.git.worktrees).mockResolvedValue([
    worktree({ path: "/w/p/busy", branch: "busy", openSessions: 1 }),
    worktree({ path: "/w/p/held", branch: "held", locked: true }),
  ]);
  render(
    <TooltipProvider>
      <GitPage />
    </TooltipProvider>,
  );
  expect(await screen.findByText(/busy · 1 open session \(in use\)/)).toBeInTheDocument();
  expect(screen.getByText(/held · locked/)).toBeInTheDocument();
});

it("reads a project's worktrees once for the visit, however often the search mounts the Git page", async () => {
  const user = userEvent.setup();
  vi.mocked(window.textToCad.git.worktrees).mockClear();
  vi.mocked(window.textToCad.git.worktrees).mockResolvedValue([worktree({})]);
  useUi.setState({ route: "settings", settingsSection: "general", commandPaletteOpen: false });
  render(
    <TooltipProvider>
      <SettingsRoute />
    </TooltipProvider>,
  );
  const search = screen.getByPlaceholderText("Search settings");
  await user.type(search, "a");
  expect(await screen.findAllByText("text-to-cad/fillet")).not.toHaveLength(0);
  await user.clear(search);
  await user.type(search, "a");
  expect(await screen.findAllByText("text-to-cad/fillet")).not.toHaveLength(0);
  expect(window.textToCad.git.worktrees).toHaveBeenCalledTimes(1);
});
