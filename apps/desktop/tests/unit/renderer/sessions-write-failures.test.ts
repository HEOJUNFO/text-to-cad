/**
 * Archive, pin and delete from the menus say so when main refuses them, in the shape of the rename
 * sentence, and a refused archive or delete does not walk the user away from the open session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { useSessions } from "@renderer/state/sessions";
import type { Session } from "@shared/types";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }));

const row = (id: string) => ({ id, projectId: "p1", title: id }) as Session;

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  useSessions.setState({ sessions: [row("s1")], ready: true, activeId: "s1" });
});

describe("a refused menu write", () => {
  it("archive toasts and keeps the session open", async () => {
    vi.mocked(window.textToCad.sessions.archive).mockRejectedValueOnce(new Error("disk full"));
    await useSessions.getState().archive("s1", true);
    expect(toast.error).toHaveBeenCalledWith("Could not archive the thread: disk full");
    expect(useSessions.getState().activeId).toBe("s1");
  });

  it("unarchive, pin, unpin and delete each toast their own sentence", async () => {
    const { sessions } = window.textToCad;
    vi.mocked(sessions.archive).mockRejectedValueOnce(new Error("no"));
    await useSessions.getState().archive("s1", false);
    vi.mocked(sessions.setPinned).mockRejectedValueOnce(new Error("no"));
    await useSessions.getState().setPinned("s1", true);
    vi.mocked(sessions.setPinned).mockRejectedValueOnce(new Error("no"));
    await useSessions.getState().setPinned("s1", false);
    vi.mocked(sessions.delete).mockRejectedValueOnce(new Error("no"));
    await useSessions.getState().remove("s1");
    expect(vi.mocked(toast.error).mock.calls.map(([text]) => text)).toEqual([
      "Could not unarchive the thread: no",
      "Could not pin the thread: no",
      "Could not unpin the thread: no",
      "Could not delete the thread: no",
    ]);
    expect(useSessions.getState().activeId).toBe("s1");
  });
});
