import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionView } from "@renderer/features/session/SessionView";
import { useAcp } from "@renderer/state/acp";
import { subscribeToMain } from "@renderer/state/bridge";
import { useSessions } from "@renderer/state/sessions";
import { initialSessionState } from "@shared/acp/types";
import type { Session } from "@shared/types";

/**
 * A create that failed after `session/new` leaves the row idle with the failure as a note in
 * `session.status.error` (`settleAfterFailedCreate`). Main sends it on a channel of its own, and
 * the note has to reach the person: without it the session looks like a healthy idle one.
 */
vi.mock("@renderer/features/session/Composer", () => ({
  Composer: ({ disabled }: { disabled: boolean }) => <textarea aria-label="Prompt" disabled={disabled} />,
}));
vi.mock("@renderer/features/session/SessionHeader", () => ({ SessionHeader: () => null }));
vi.mock("@renderer/features/session/Transcript", () => ({ Transcript: () => <div data-transcript /> }));
vi.mock("@renderer/features/session/ContextMeter", () => ({ ContextMeter: () => null }));

const NOTE = "The session started, but setting it up failed: SQLITE_BUSY";
const SESSION = { id: "s1", projectId: "p1", agentId: "claude", cwd: "/p", title: "t", status: "idle" } as unknown as Session;

type Handler = (payload: unknown) => void;
const bridge = window.textToCad as unknown as Record<string, unknown>;
const saved = { on: bridge.on, sessions: bridge.sessions };
let handlers: Record<string, Handler>;
let detach: () => void;
const load = vi.fn(async () => ({ ...initialSessionState("s1", "claude"), status: "idle" as const }));

beforeEach(() => {
  handlers = {};
  bridge.on = vi.fn((channel: string, handler: Handler) => { handlers[channel] = handler; return () => {}; });
  bridge.sessions = { ...(saved.sessions as object), load };
  load.mockClear();
  useSessions.setState({ sessions: [SESSION], ready: true, activeId: null });
  useAcp.setState({ sessions: { s1: { ...initialSessionState("s1", "claude"), status: "idle" } }, loading: {}, reconnecting: {}, loadErrors: {}, setupNotes: {}, terminalOutput: {} });
  detach = subscribeToMain();
});

afterEach(() => {
  detach();
  bridge.on = saved.on;
  bridge.sessions = saved.sessions;
});

const emitNote = (error: string | null, status = "idle") =>
  act(() => {
    handlers["session.state"]!({ sessionId: "s1", state: { ...initialSessionState("s1", "claude"), status: "idle" } });
    handlers["session.status"]?.({ sessionId: "s1", status, error });
  });

describe("the note a failed setup leaves", () => {
  it("is shown above a composer that stays sendable, and survives an ordinary status change", () => {
    render(<SessionView session={SESSION} />);
    expect(screen.queryByRole("alert")).toBeNull();
    emitNote(NOTE);
    expect(screen.getByRole("alert")).toHaveTextContent(NOTE);
    expect(screen.getByLabelText("Prompt")).toBeEnabled();
    act(() => handlers["session.status"]?.({ sessionId: "s1", status: "running", error: null }));
    expect(screen.getByRole("alert")).toHaveTextContent(NOTE);
  });

  it("is not taken from an error status, whose message the load failure already shows", () => {
    render(<SessionView session={SESSION} />);
    emitNote("spawn failed", "error");
    expect(useAcp.getState().setupNotes).toEqual({});
  });

  it("goes with the next load, and Reconnect asks for one", async () => {
    const user = userEvent.setup();
    render(<SessionView session={SESSION} />);
    emitNote(NOTE);
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(load).toHaveBeenCalledWith({ id: "s1" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useAcp.getState().setupNotes).toEqual({});
  });
});
