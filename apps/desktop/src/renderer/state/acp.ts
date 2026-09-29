import { create } from "zustand";

import { useSessions } from "./sessions";

import { reduce } from "@shared/acp/reduce";
import { errorMessage } from "@shared/ipc/errors";
import type {
  PendingPermission,
  PromptBlock,
  SessionEvent,
  SessionState,
} from "@shared/acp/types";

/**
 * Live session state, one `SessionState` per connected session, mirrored
 * from main (plan §5).
 *
 * Main sends a full snapshot on `session.state` (connect, load) and then one
 * reducer event per `session.update`; this store runs the same pure reducer
 * on them, so both processes hold the same state without a second protocol.
 * Every mutation is an IPC call and never touches the state directly — the
 * event that follows is what updates it, exactly as a change made from
 * anywhere else would.
 *
 * `loading` and `loadErrors` are the renderer's own: they cover the gap
 * between selecting a session from the index and its snapshot arriving,
 * which is where the connecting and the reconnect-failed states live.
 *
 * That gap is a second or two of spawn, `initialize` and replay (README,
 * "Opening a session"), and `reconnecting` is what makes it invisible: a
 * session with no live connection is painted from the snapshot main filed
 * on disk and then reconnected behind the transcript, with `Reconnecting…`
 * in the composer's row instead of a spinner over the pane. While that flag
 * is up the reducer events are dropped — they are the agent replaying a
 * history the snapshot already shows, and folding them onto it would double
 * every turn — and the authoritative state that ends every `load` replaces
 * the picture.
 */
type AcpState = {
  sessions: Record<string, SessionState>;
  /** The most recent chunk per agent-created terminal, keyed `sessionId/terminalId`. */
  terminalOutput: Record<string, string>;
  /** Sessions whose `load` is in flight. */
  loading: Record<string, true>;
  /**
   * Sessions being loaded *behind a painted state* — a snapshot, or the
   * state of a connection that has since been closed. Their reducer events
   * are dropped until the load answers.
   */
  reconnecting: Record<string, true>;
  /** The last `load` failure per session, cleared by the next attempt. */
  loadErrors: Record<string, string>;

  receiveState: (sessionId: string, state: SessionState) => void;
  receiveEvent: (sessionId: string, event: SessionEvent) => void;
  receiveTerminalOutput: (sessionId: string, terminalId: string, data: string) => void;
  forget: (sessionId: string) => void;

  create: (input: {
    projectId: string;
    agentId: string;
    cwd?: string;
    gitMode: "none" | "checkout" | "worktree";
    branch?: string;
  }) => Promise<string>;
  load: (sessionId: string) => Promise<void>;
  /**
   * What a click on a session row costs: nothing when its adapter is still
   * alive, a paint from the stored snapshot plus a background `load` when it
   * is not, and the spinner only for a session that has neither.
   */
  ensureLoaded: (sessionId: string) => Promise<void>;
  prompt: (sessionId: string, content: PromptBlock[] | string) => Promise<string>;
  cancel: (sessionId: string) => Promise<void>;
  setMode: (sessionId: string, modeId: string) => Promise<void>;
  setConfigOption: (sessionId: string, configId: string, value: string | boolean) => Promise<void>;
  respondPermission: (sessionId: string, requestId: string, optionId: string | null) => Promise<void>;
  close: (sessionId: string) => Promise<void>;
};

const TERMINAL_TAIL = 64 * 1024;

export const useAcp = create<AcpState>((set, get) => ({
  sessions: {},
  terminalOutput: {},
  loading: {},
  reconnecting: {},
  loadErrors: {},

  receiveState: (sessionId, state) =>
    set((current) => ({ sessions: { ...current.sessions, [sessionId]: state } })),

  receiveEvent: (sessionId, event) =>
    set((current) => {
      const state = current.sessions[sessionId];
      // Events for a session we have no snapshot of are dropped: the
      // snapshot that follows a connect carries everything up to that point.
      if (!state) {
        return current;
      }
      // A session painted from disk while its agent reconnects: what arrives
      // now is that agent replaying the history already on screen, and the
      // state at the end of the load is what replaces it.
      if (current.reconnecting[sessionId]) {
        return current;
      }
      const next = reduce(state, event);
      // An adapter that closed behind another session's pane — the keep-alive evicting it — is
      // let go: its transcript is the snapshot main flushed, and a click repaints it from there.
      if (next.status === "closed" && !stillWanted(sessionId, current)) {
        return without(current, sessionId);
      }
      return { sessions: { ...current.sessions, [sessionId]: next } };
    }),

  receiveTerminalOutput: (sessionId, terminalId, data) =>
    set((current) => {
      const key = `${sessionId}/${terminalId}`;
      const next = ((current.terminalOutput[key] ?? "") + data).slice(-TERMINAL_TAIL);
      return { terminalOutput: { ...current.terminalOutput, [key]: next } };
    }),

  forget: (sessionId) => set((current) => without(current, sessionId)),

  create: async (input) => {
    const session = await window.textToCad.sessions.create(input);
    useSessions.getState().adopt(session);
    return session.id;
  },

  load: async (sessionId) => {
    set((current) => {
      const loadErrors = { ...current.loadErrors };
      delete loadErrors[sessionId];
      return {
        loading: { ...current.loading, [sessionId]: true },
        // A load with something already on screen is a reconnect: the events
        // it produces are a replay of that, and are dropped.
        ...(current.sessions[sessionId] ? { reconnecting: { ...current.reconnecting, [sessionId]: true as const } } : {}),
        loadErrors,
      };
    });
    const asked = generationOf(sessionId);
    try {
      const state = await window.textToCad.sessions.load({ id: sessionId });
      // Forgotten while it loaded — archived, deleted, disconnected: the answer is for nobody.
      if (generationOf(sessionId) === asked) get().receiveState(sessionId, state);
    } catch (error) {
      if (generationOf(sessionId) === asked) {
        set((current) => ({ loadErrors: { ...current.loadErrors, [sessionId]: errorMessage(error) } }));
      }
    } finally {
      set((current) => {
        const loading = { ...current.loading };
        delete loading[sessionId];
        const reconnecting = { ...current.reconnecting };
        delete reconnecting[sessionId];
        return { loading, reconnecting };
      });
    }
  },

  ensureLoaded: async (sessionId) => {
    const { sessions, loading } = get();
    if (loading[sessionId]) {
      return;
    }
    const held = sessions[sessionId];
    // A connection that is still up: this is a paint and nothing else.
    // `closed` is the adapter the keep-alive evicted (src/main/acp/live.ts)
    // or one that was disconnected by hand — the transcript is still right,
    // and the agent behind it has to come back.
    if (held && held.status !== "closed") {
      return;
    }
    if (!held) {
      // The snapshot main filed for this session, if it has one: painted
      // before the load starts, so the transcript is on screen in a frame
      // rather than in two seconds. `live: true` means main's connection
      // outlived the renderer's copy of it and there is nothing to reconnect.
      const asked = generationOf(sessionId);
      try {
        const painted = await window.textToCad.sessions.state({ id: sessionId });
        if (generationOf(sessionId) !== asked) {
          return;
        }
        // A load that started while this was in flight owns the session now.
        if (painted && !get().sessions[sessionId] && !get().loading[sessionId]) {
          get().receiveState(sessionId, painted.state);
          if (painted.live) {
            return;
          }
        }
      } catch {
        /* no snapshot: the spinner, as before */
      }
    }
    await get().load(sessionId);
  },

  prompt: async (sessionId, content) => {
    const blocks: PromptBlock[] =
      typeof content === "string" ? [{ type: "text", text: content }] : content;
    const { stopReason } = await window.textToCad.sessions.prompt({ id: sessionId, content: blocks });
    return stopReason;
  },

  cancel: (sessionId) => window.textToCad.sessions.cancel({ id: sessionId }),

  setMode: (sessionId, modeId) => window.textToCad.sessions.setMode({ id: sessionId, modeId }),

  setConfigOption: (sessionId, configId, value) =>
    window.textToCad.sessions.setConfigOption({ id: sessionId, configId, value }),

  respondPermission: (sessionId, requestId, optionId) =>
    window.textToCad.sessions.respondPermission({ id: sessionId, requestId, optionId }),

  close: async (sessionId) => {
    await window.textToCad.sessions.close({ id: sessionId });
    get().forget(sessionId);
  },
}));

/**
 * How many times each session has been forgotten. An IPC answer that arrives after a forget —
 * the row archived or deleted while its snapshot or its load was on the way — is dropped rather
 * than bringing back state nothing will forget again.
 */
const forgotten = new Map<string, number>();
const generationOf = (sessionId: string) => forgotten.get(sessionId) ?? 0;

/** Everything held for one session, taken out: its state, its load's leftovers, its terminals' tails. */
function without(current: AcpState, sessionId: string): Partial<AcpState> {
  forgotten.set(sessionId, generationOf(sessionId) + 1);
  const sessions = { ...current.sessions };
  delete sessions[sessionId];
  const loadErrors = { ...current.loadErrors };
  delete loadErrors[sessionId];
  const reconnecting = { ...current.reconnecting };
  delete reconnecting[sessionId];
  const prefix = `${sessionId}/`;
  const terminalOutput = Object.fromEntries(Object.entries(current.terminalOutput).filter(([key]) => !key.startsWith(prefix)));
  return { sessions, loadErrors, reconnecting, terminalOutput };
}

/** Whether a closed session's state is still wanted: it is on screen, or a load is bringing it back. */
function stillWanted(sessionId: string, current: AcpState): boolean {
  return useSessions.getState().activeId === sessionId || Boolean(current.loading[sessionId]);
}

/**
 * The index decides what is kept here. A row deleted, or newly archived, takes its state and its
 * terminals' output with it — nothing else ever would, and each holds images, diffs and 64 KB per
 * terminal. A closed session the person has just left goes too: `ensureLoaded` repaints it from
 * the snapshot main keeps (flushed when the adapter closed) the next time it is picked, which is
 * one read of a row rather than a transcript held for every session ever opened.
 */
useSessions.subscribe((index, previous) => {
  const acp = useAcp.getState();
  const rows = new Map(index.sessions.map((row) => [row.id, row]));
  for (const row of previous.sessions) {
    const now = rows.get(row.id);
    if (!now || (now.archived && !row.archived)) acp.forget(row.id);
  }
  const left = previous.activeId;
  if (left && left !== index.activeId) {
    const held = useAcp.getState();
    if (held.sessions[left]?.status === "closed" && !stillWanted(left, held)) acp.forget(left);
  }
});

/** One session's live state, or null before it connects. */
export function useSessionState(sessionId: string | null): SessionState | null {
  return useAcp((state) => (sessionId ? (state.sessions[sessionId] ?? null) : null));
}

/** The permission request the user has to answer next, if any. */
export function usePendingPermission(sessionId: string | null): PendingPermission | null {
  return useAcp((state) =>
    sessionId ? (state.sessions[sessionId]?.pendingPermissions[0] ?? null) : null,
  );
}
