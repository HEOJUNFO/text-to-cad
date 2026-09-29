import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ReviewTab } from "@renderer/features/explorer/ReviewTab";
import { useExplorer } from "@renderer/state/explorer";
import type { GitStatus } from "@renderer/features/explorer/types";

vi.mock("@renderer/lib/git-mode", () => ({ useProjectGitInfo: () => null }));

const PROJECT = { id: "p1", name: "bracket", path: "/bracket", createdAt: 0 };
const git = window.textToCad.git as unknown as { status: ReturnType<typeof vi.fn> };
const original = git.status;

const repo = (branch: string): GitStatus => ({
  isRepository: true, branch, unborn: false, ahead: 0, behind: 0, files: [], insertions: 0, deletions: 0,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const renderReview = () => render(<ReviewTab project={PROJECT} scope="session" sessionId="s1" tabId="t1" />);

beforeEach(() => { git.status = vi.fn(); });
afterEach(() => { git.status = original; });

it("a read that fails says so, with git's words and a retry — not that the folder is not a repository", async () => {
  const user = userEvent.setup();
  git.status.mockRejectedValueOnce(new Error("fatal: bad revision 'abc123'")).mockResolvedValueOnce(repo("main"));
  renderReview();

  expect(await screen.findByText("Could not read the changes")).toBeInTheDocument();
  expect(screen.getByText("fatal: bad revision 'abc123'")).toBeInTheDocument();
  expect(screen.queryByText("Not a repository")).toBeNull();

  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("main")).toBeInTheDocument();
  expect(screen.queryByText("Could not read the changes")).toBeNull();
});

it("an older read that answers after a newer one does not replace it", async () => {
  const slow = deferred<GitStatus>();
  const fast = deferred<GitStatus>();
  git.status.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
  renderReview();

  // A batch of file changes asks again before the first read has answered.
  act(() => useExplorer.setState({ fsRevision: useExplorer.getState().fsRevision + 1 }));
  expect(git.status).toHaveBeenCalledTimes(2);
  await act(async () => fast.resolve(repo("newer")));
  await act(async () => slow.resolve(repo("older")));

  expect(screen.getByText("newer")).toBeInTheDocument();
  expect(screen.queryByText("older")).toBeNull();
});

it("a re-read that fails keeps the last answer on screen and marks it", async () => {
  git.status.mockResolvedValueOnce(repo("main")).mockRejectedValueOnce(new Error("index.lock exists"));
  renderReview();
  expect(await screen.findByText("main")).toBeInTheDocument();

  await act(async () => useExplorer.setState({ fsRevision: useExplorer.getState().fsRevision + 1 }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not refresh: index.lock exists");
  expect(screen.getByText("main")).toBeInTheDocument();
});
