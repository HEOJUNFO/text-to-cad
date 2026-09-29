import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";

import { ReviewTab } from "@renderer/features/explorer/ReviewTab";
import { MAX_DIFF_HEIGHT, estimateHeight, sideText, singleSide } from "@renderer/features/explorer/review-diff";
import { useExplorer } from "@renderer/state/explorer";
import { useSessions } from "@renderer/state/sessions";
import type { FileDiff, GitStatus } from "@renderer/features/explorer/types";
import type { ProjectGitInfo } from "@shared/ipc/git";

let gitInfo: Partial<ProjectGitInfo> | null = null;
vi.mock("@renderer/lib/git-mode", () => ({ useProjectGitInfo: () => gitInfo }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
import { toast } from "sonner";

// Monaco's clipboard service (a WebKit workaround) builds a ClipboardItem on every click in the
// document; jsdom has none, and without this each click in these tests is an unhandled error.
// The next click cancels the previous item's promise, so the stub observes it.
if (!("ClipboardItem" in globalThis)) {
  Object.assign(globalThis, {
    ClipboardItem: class {
      constructor(items: Record<string, Promise<unknown>>) {
        for (const item of Object.values(items)) void Promise.resolve(item).catch(() => {});
      }
    },
  });
}

const PROJECT = { id: "p1", name: "bracket", path: "/bracket", createdAt: 0 };
const git = window.textToCad.git as unknown as { status: ReturnType<typeof vi.fn>; commit: ReturnType<typeof vi.fn> };
const original = { status: git.status, commit: git.commit };
// One read per refresh: the scope's answer carries the working tree's file count (what a commit takes).
let scoped: Mock<(request: unknown) => Promise<GitStatus>>;

const repo = (branch: string): GitStatus => ({
  isRepository: true, branch, unborn: false, ahead: 0, behind: 0, files: [], insertions: 0, deletions: 0, workingFiles: 0,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const renderReview = () => render(<ReviewTab project={PROJECT} scope="session" sessionId="s1" tabId="t1" />);

const changed = (path: string) => ({ path, status: "modified" as const, insertions: 1, deletions: 0, binary: false });

beforeEach(() => {
  gitInfo = null;
  vi.mocked(toast.success).mockClear();
  scoped = vi.fn<(request: unknown) => Promise<GitStatus>>();
  git.status = scoped;
  git.commit = vi.fn();
});
afterEach(() => { git.status = original.status; git.commit = original.commit; });

it("a read that fails says so, with git's words and a retry — not that the folder is not a repository", async () => {
  const user = userEvent.setup();
  scoped.mockRejectedValueOnce(new Error("fatal: bad revision 'abc123'")).mockResolvedValueOnce(repo("main"));
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
  scoped.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
  renderReview();

  // A batch of file changes asks again before the first read has answered.
  act(() => useExplorer.setState({ fsRevision: useExplorer.getState().fsRevision + 1 }));
  expect(scoped).toHaveBeenCalledTimes(2);
  await act(async () => fast.resolve(repo("newer")));
  await act(async () => slow.resolve(repo("older")));

  expect(screen.getByText("newer")).toBeInTheDocument();
  expect(screen.queryByText("older")).toBeNull();
});

it("a re-read that fails keeps the last answer on screen and marks it", async () => {
  scoped.mockResolvedValueOnce(repo("main")).mockRejectedValueOnce(new Error("index.lock exists"));
  renderReview();
  expect(await screen.findByText("main")).toBeInTheDocument();

  await act(async () => useExplorer.setState({ fsRevision: useExplorer.getState().fsRevision + 1 }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not refresh: index.lock exists");
  expect(screen.getByText("main")).toBeInTheDocument();
});

it("the commit button follows the working tree, not the scope, and says how many files it takes", async () => {
  const user = userEvent.setup();
  // Last turn touched nothing, but the working tree holds two uncommitted files.
  scoped.mockResolvedValue({ ...repo("main"), workingFiles: 2 });
  renderReview();

  const trigger = await screen.findByRole("button", { name: "Commit" });
  await vi.waitFor(() => expect(trigger).toBeEnabled());
  await user.click(trigger);
  expect(within(screen.getByRole("region", { name: "Commit changes" })).getByText("Commit 2 files")).toBeInTheDocument();
  expect(trigger).toHaveAttribute("aria-expanded", "true");

  // Escape closes the panel and hands focus back to the header's button.
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Commit changes" })).toBeNull();
  expect(trigger).toHaveFocus();
});

it("a clean working tree disables the commit even when the scope shows committed history", async () => {
  scoped.mockResolvedValue({ ...repo("main"), files: [changed("a.step")], workingFiles: 0 });
  renderReview();
  expect(await screen.findByRole("button", { name: "Commit" })).toBeDisabled();
});

it("offers push only with a remote, and confirms a commit with its short hash", async () => {
  const user = userEvent.setup();
  scoped.mockResolvedValue({ ...repo("main"), workingFiles: 1 });
  git.commit.mockResolvedValue({ sha: "0123456789abcdef0123456789abcdef01234567" });
  const view = renderReview();

  // No remote: the trigger does not offer a push it cannot make.
  const trigger = await screen.findByRole("button", { name: "Commit" });
  await vi.waitFor(() => expect(trigger).toBeEnabled());
  await user.click(trigger);
  const panel = screen.getByRole("region", { name: "Commit changes" });
  expect(within(panel).getByText("Commit 1 file")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Commit and push" })).toBeNull();

  await user.type(screen.getByLabelText("Commit message"), "one commit");
  await user.click(within(panel).getByRole("button", { name: "Commit" }));
  await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Committed 0123456"));
  expect(git.commit).toHaveBeenCalledWith(expect.objectContaining({ message: "one commit", push: false }));

  view.unmount();
  gitInfo = { hasRemote: true, hasGh: false };
  renderReview();
  const again = await screen.findByRole("button", { name: "Commit or push" });
  await vi.waitFor(() => expect(again).toBeEnabled());
  await user.click(again);
  expect(screen.getByRole("button", { name: "Commit and push" })).toBeInTheDocument();
});

it("a Last turn with no recorded mark says so, instead of showing the working tree under that name", async () => {
  scoped.mockResolvedValue({ ...repo("main"), unmarked: "turn", workingFiles: 1 });
  render(<ReviewTab project={PROJECT} scope="turn" sessionId="s1" tabId="t1" />);

  expect(await screen.findByText("No turn recorded yet")).toBeInTheDocument();
  expect(screen.getByText(/Last turn starts with the next prompt/)).toBeInTheDocument();
  expect(screen.queryByText("No changes")).toBeNull();
  expect(screen.queryByText("a.step")).toBeNull();
});

it("a This session with no recorded mark says so too", async () => {
  scoped.mockResolvedValue({ ...repo("main"), unmarked: "session" });
  renderReview();
  expect(await screen.findByText("No session start recorded")).toBeInTheDocument();
  expect(screen.queryByText("No changes")).toBeNull();
});

it("in a repository with no commits, Last turn shows the work and says it is measured from the start", async () => {
  scoped.mockResolvedValue({ ...repo("main"), unborn: true, fromStart: true, files: [changed("a.step")], insertions: 1, workingFiles: 1 });
  render(<ReviewTab project={PROJECT} scope="turn" sessionId="s1" tabId="t1" />);
  expect(await screen.findByText(/measured from the repository's start/)).toBeInTheDocument();
  expect(screen.getAllByText("a.step").length).toBeGreaterThan(0);
  expect(screen.queryByText("No turn recorded yet")).toBeNull();
});

it("a scoped review reads git once per refresh, not a second time for the commit button", async () => {
  scoped.mockResolvedValue({ ...repo("main"), workingFiles: 3 });
  renderReview();
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "Commit" })).toBeEnabled());
  expect(scoped).toHaveBeenCalledTimes(1);

  await act(async () => useExplorer.setState({ fsRevision: useExplorer.getState().fsRevision + 1 }));
  expect(scoped).toHaveBeenCalledTimes(2);
  expect(scoped.mock.calls.every(([request]) => (request as { scope: { kind: string } }).scope.kind === "session")).toBe(true);
});

it("the header names the branch, not the session's title — the session header already does", async () => {
  useSessions.setState({ sessions: [{ id: "s1", title: "showcase: write a greeting script", cwd: "/bracket" } as never] });
  scoped.mockResolvedValue(repo("main"));
  renderReview();
  expect(await screen.findByText("main")).toBeInTheDocument();
  expect(screen.queryByText("showcase: write a greeting script")).toBeNull();
  useSessions.setState({ sessions: [] });
});

it("Request revision sits in the file's header row, beside its counts", async () => {
  scoped.mockResolvedValue({ ...repo("main"), files: [{ ...changed("hello.py"), binary: true }], workingFiles: 1 });
  renderReview();
  const revise = await screen.findByRole("button", { name: "Request revision for hello.py" });
  const toggle = within(revise.parentElement!).getByRole("button", { name: /hello\.py/, expanded: false });
  expect(toggle).toHaveTextContent("+1");
});

const fileDiff = (over: Partial<FileDiff>): FileDiff => ({
  path: "hello.py", status: "modified", insertions: 0, deletions: 0, binary: false, before: "", after: "", ...over,
});

it("an added file is its one side, not a diff against a phantom empty line", () => {
  const added = fileDiff({ status: "added", insertions: 6, before: "", after: "def main():\n    pass\n" });
  expect(singleSide(added)).toBe("added");
  expect(singleSide(fileDiff({ status: "untracked", before: "", after: "x" }))).toBe("added");
  expect(singleSide(fileDiff({ status: "deleted", before: "x\n", after: "" }))).toBe("deleted");
  expect(singleSide(fileDiff({ status: "modified", before: "a\n", after: "b\n" }))).toBeNull();
  // git's final newline is not a line of its own.
  expect(sideText("a\nb\n")).toBe("a\nb");
});

it("a diff block is sized to its content, and capped", () => {
  const seven = fileDiff({ status: "added", insertions: 7, after: "1\n2\n3\n4\n5\n6\n7\n" });
  expect(estimateHeight(seven)).toBe(7 * 20 + 12);
  const long = fileDiff({ status: "added", insertions: 400, after: "x\n".repeat(400) });
  expect(estimateHeight(long)).toBe(MAX_DIFF_HEIGHT);
  // A four-line edit in a long file is the edit plus its context, not the file.
  const edit = fileDiff({ insertions: 2, deletions: 2, before: "x\n".repeat(400), after: "y\n".repeat(400) });
  expect(estimateHeight(edit)).toBe(12 * 20 + 12);
});
