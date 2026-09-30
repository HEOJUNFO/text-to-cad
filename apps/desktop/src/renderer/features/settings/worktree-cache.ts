/**
 * The Git page's worktree lists, kept for the Settings visit.
 *
 * Searching mounts every page and clearing the query unmounts all but the open
 * one, so type, clear, type would read every project's worktrees (a `git
 * worktree list` plus three git calls per worktree for its date) each time the
 * Git page came back. The lists live here instead, and go when Settings closes,
 * when a session opens or closes (`openSessions` is part of a row), and when a
 * worktree is deleted.
 */
import { create } from "zustand";

import type { Worktree } from "@shared/ipc/git";

type WorktreeCache = {
  lists: Record<string, Worktree[]>;
  /** Bumped by every invalidation: the cards mounted at the time read again. */
  epoch: number;
  invalidate: () => void;
};

export const useWorktreeCache = create<WorktreeCache>((set) => ({
  lists: {},
  epoch: 0,
  invalidate: () => set((state) => ({ lists: {}, epoch: state.epoch + 1 })),
}));

const inflight = new Map<string, Promise<void>>();

/** Read a project's worktrees unless the visit already has them. A failed read is not kept. */
export function ensureWorktrees(projectId: string): Promise<void> {
  if (useWorktreeCache.getState().lists[projectId]) {
    return Promise.resolve();
  }
  const running = inflight.get(projectId);
  if (running) {
    return running;
  }
  const { epoch } = useWorktreeCache.getState();
  const read = window.textToCad.git
    .worktrees({ projectId })
    .then((list) => {
      // An invalidation since the read began means the answer is already old.
      if (useWorktreeCache.getState().epoch === epoch) {
        useWorktreeCache.setState((state) => ({ lists: { ...state.lists, [projectId]: list } }));
      }
    })
    .catch(() => {})
    .finally(() => inflight.delete(projectId));
  inflight.set(projectId, read);
  return read;
}
