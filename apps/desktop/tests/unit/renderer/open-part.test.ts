import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { relativeToFolder } from "@renderer/features/session/NewSession";
import { loadParts, openPartIn, partsToShow, whenBound } from "@renderer/features/session/open-part";
import { useExplorer } from "@renderer/state/explorer";

vi.mock("@renderer/state/drawings", () => ({ deleteDrawingScene: vi.fn() }));

/**
 * The new-session screen's parts row, without React: which parts it offers
 * and in what order, and how a path reaches the explorer of a session that
 * did not exist a moment ago.
 */
describe("partsToShow", () => {
  it("is the folder's CAD files, alphabetically by path, capped", () => {
    const parts = partsToShow(["z.glb", "out/bracket.step", "a.3mf", "notes.md", "scripts/gen.py", "housing.stl"]);
    expect(parts).toEqual([
      { path: "a.3mf", name: "a.3mf" },
      { path: "housing.stl", name: "housing.stl" },
      { path: "out/bracket.step", name: "bracket.step" },
      { path: "z.glb", name: "z.glb" },
    ]);
    expect(partsToShow(["1.step", "2.step", "3.step"], 2).map((part) => part.path)).toEqual(["1.step", "2.step"]);
  });
});

describe("loadParts", () => {
  beforeEach(() => {
    vi.mocked(window.hardcore.explorer.paths).mockReset();
  });

  it("reads the folder through the explorer's own walk", async () => {
    vi.mocked(window.hardcore.explorer.paths).mockResolvedValue({ paths: ["README.md", "out/lid.step", "extra.stl"], truncated: false });
    expect((await loadParts("/p")).map((part) => part.path)).toEqual(["extra.stl", "out/lid.step"]);
    expect(window.hardcore.explorer.paths).toHaveBeenCalledWith({ projectId: "/p", path: "", limit: 20_000 });
  });

  it("is empty, not an error, when the folder cannot be read", async () => {
    vi.mocked(window.hardcore.explorer.paths).mockRejectedValue(new Error("that project is no longer open"));
    expect(await loadParts("/p")).toEqual([]);
  });
});

describe("relativeToFolder", () => {
  it("answers the folder-relative path of a chooser's absolute one, or null outside it", () => {
    expect(relativeToFolder("/Users/amy/Parts", "/Users/amy/Parts/out/lid.step")).toBe("out/lid.step");
    expect(relativeToFolder("/Users/amy/Parts/", "/Users/amy/Parts/lid.step")).toBe("lid.step");
    expect(relativeToFolder("/Users/amy/Parts", "/Users/amy/Parts")).toBeNull();
    expect(relativeToFolder("/Users/amy/Parts", "/Users/amy/Parts-old/lid.step")).toBeNull();
    expect(relativeToFolder("/Users/amy/Parts", "/Users/amy/Downloads/vendor.step")).toBeNull();
  });
});

describe("opening into a session that is still binding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(window.hardcore.explorer.saveTabs).mockReset().mockResolvedValue(undefined);
    vi.mocked(window.hardcore.explorer.loadTabs).mockReset().mockResolvedValue([]);
    useExplorer.setState({ sessionId: null, projectId: null, root: null, tabs: [], activeId: null, ready: true });
  });

  afterEach(async () => {
    await useExplorer.getState().bindSession(null, null);
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it("waits for the explorer to bind, then opens the file from the project root with the tree beside it", async () => {
    const opened = openPartIn("s1", "out/lid.step", null);
    // Nothing yet: the explorer still shows no session.
    expect(useExplorer.getState().tabs).toEqual([]);
    await useExplorer.getState().bindSession("s1", "/p", "/worktrees/s1");
    expect(await opened).toBe(true);
    const [tab] = useExplorer.getState().tabs;
    expect(tab).toMatchObject({ kind: "file", path: "out/lid.step", root: null, sessionId: "s1", panel: "tree" });
    expect(useExplorer.getState().collapsed).toBe(false);
  });

  it("leaves the panel of a tab that already had the file alone", async () => {
    await useExplorer.getState().bindSession("s5", "/p");
    useExplorer.getState().openFile("a.step");
    const [before] = useExplorer.getState().tabs;
    useExplorer.getState().update(before!.id, { panel: "settings" });
    expect(await openPartIn("s5", "a.step", null)).toBe(true);
    expect(useExplorer.getState().tabs).toHaveLength(1);
    expect(useExplorer.getState().tabs[0]).toMatchObject({ path: "a.step", panel: "settings" });
  });

  it("resolves immediately when the session is already bound", async () => {
    await useExplorer.getState().bindSession("s2", "/p");
    expect(await whenBound("s2")).toBe(true);
    expect(await openPartIn("s2", "a.step", null)).toBe(true);
  });

  it("gives up rather than waiting forever for a session that never binds", async () => {
    const bound = whenBound("never", 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await bound).toBe(false);
    // Binding to another session in the meantime is not this one.
    const other = whenBound("s3", 1_000);
    await useExplorer.getState().bindSession("s4", "/p");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await other).toBe(false);
  });
});
