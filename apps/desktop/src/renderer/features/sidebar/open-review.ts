import { useExplorer } from "@renderer/state/explorer";

/** How long to wait for the explorer to bind to the session just selected. */
const BIND_TIMEOUT_MS = 5_000;

/**
 * Open the Review tab, scoped to `This session`, in *that session's*
 * explorer — the sidebar's `+9 −1` suffix.
 *
 * The explorer belongs to the selected session (docs/session-workspaces.md),
 * so the caller selects the session first and this waits for the bridge to
 * bind the strip to it before touching anything. A review tab already in the
 * strip is brought forward rather than doubled. If the strip never becomes
 * this session's (an archived row, a bind that failed) nothing is opened:
 * a tab in another session's explorer would be worse than none.
 *
 * Returns a function that cancels the wait.
 */
export function openSessionReview(sessionId: string): () => void {
  const ready = () => {
    const state = useExplorer.getState();
    return state.sessionId === sessionId && state.ready;
  };
  const open = () => {
    const state = useExplorer.getState();
    const existing = state.tabs.find((tab) => tab.kind === "review");
    if (existing) {
      if (existing.kind === "review" && existing.scope !== "session") {
        state.update(existing.id, { scope: "session" });
      }
      state.setActive(existing.id);
      state.show();
      return;
    }
    state.open("review", { scope: "session" });
  };

  if (ready()) {
    open();
    return () => {};
  }
  let done = false;
  const finish = () => {
    done = true;
    unsubscribe();
    clearTimeout(timer);
  };
  const unsubscribe = useExplorer.subscribe(() => {
    if (!done && ready()) {
      finish();
      open();
    }
  });
  const timer = setTimeout(finish, BIND_TIMEOUT_MS);
  return finish;
}
