import { FILE_PANEL_TREE } from "@hardcore/ui/navigation";

import { useExplorer } from "@renderer/state/explorer";
import { isCadFile } from "@shared/cad-refs";
import type { ExplorerRoot } from "@shared/types";

/**
 * Opening a part from the new-session screen.
 *
 * A draft has no explorer — every tab belongs to a session
 * (`docs/session-workspaces.md`) — so "open this STEP" on that screen is
 * "start the session, then open it there". This module is the second half:
 * what the screen offers to open, and how a path reaches the strip of a
 * session that was created a moment ago. `NewSession` owns the first half,
 * because creating the session is the same call its composer makes.
 *
 * Deliberately small: the row is the folder's CAD files and nothing else,
 * read through the explorer's existing `paths` call. No new channel, no
 * store, nothing remembered.
 */

/** One entry in the row under the composer. */
export type Part = {
  /** Root-relative path, POSIX separators. */
  path: string;
  /** The file name alone — what the chip shows. */
  name: string;
};

/** How many chips the row shows. */
export const PARTS_LIMIT = 8;
/** The walk is an affordance, not an index — the tree's own filter uses the same bound. */
const PATHS_LIMIT = 20_000;

/**
 * The row's order: the folder's CAD files, alphabetically by path, capped.
 * Only CAD files — a folder has a README in it too, and the row is "open a
 * part", not "open a file".
 */
export function partsToShow(found: readonly string[], limit = PARTS_LIMIT): Part[] {
  return [...found]
    .filter(isCadFile)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit)
    .map((path) => ({ path, name: path.split("/").pop() ?? path }));
}

/** What the screen can offer for a folder: its CAD files. Empty when the folder cannot be read. */
export async function loadParts(projectId: string): Promise<Part[]> {
  const listing = await window.hardcore.explorer
    .paths({ projectId, path: "", limit: PATHS_LIMIT })
    .catch(() => ({ paths: [] as string[], truncated: true }));
  return partsToShow(listing.paths);
}

/**
 * Resolve once the explorer is bound to `sessionId` and has restored its
 * strip — the point at which `openFile` stops returning null. The binding
 * is asynchronous (`bindSession` reads `explorer_tabs` and starts a
 * watcher), and the session store's subscriber in `state/bridge` is what
 * triggers it, so this waits on the explorer store rather than calling
 * `bindSession` itself: one binder, not two.
 *
 * False on timeout — a session that never binds is a session whose row was
 * dropped, and the caller says so instead of hanging.
 */
export function whenBound(sessionId: string, timeoutMs = 15_000): Promise<boolean> {
  const bound = () => {
    const state = useExplorer.getState();
    return state.sessionId === sessionId && state.ready;
  };
  if (bound()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    const unsubscribe = useExplorer.subscribe(() => {
      if (!bound()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

/**
 * Open `path` in a session's explorer once that explorer exists, with the
 * file tree open beside it. `root` is passed through explicitly: a part
 * listed from the project folder is opened from the project folder even
 * when the session runs in a worktree, because that file is the one the
 * person clicked.
 *
 * The tree, because a part opened this way arrives with no context: the
 * session is new, the transcript is empty, and the folder the part came
 * from — its neighbours, its outputs — is what a person reaches for next.
 * A tab that already had the file keeps whatever panel it had.
 */
export async function openPartIn(sessionId: string, path: string, root: ExplorerRoot): Promise<boolean> {
  if (!(await whenBound(sessionId))) return false;
  const explorer = useExplorer.getState();
  const tab = explorer.openFile(path, root);
  if (!tab) return false;
  if (tab.kind === "file" && tab.panel === null) explorer.update(tab.id, { panel: FILE_PANEL_TREE });
  return true;
}
