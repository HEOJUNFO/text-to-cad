import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useAcp } from "@renderer/state/acp";
import { subscribeToMain } from "@renderer/state/bridge";
import { useComposer } from "@renderer/state/composer";
import type { PromptBlock } from "@shared/acp/types";
import { initialSessionState } from "@shared/acp/types";

/**
 * Main as the queue sees it: `sessions.prompt` is a reply that arrives when the turn is over,
 * and the turn's events arrive on `session.update` — `prompt/end` BEFORE that reply.
 */
const SESSION = "s1";
type Handler = (payload: unknown) => void;
let handlers: Record<string, Handler>;
let replies: { text: string; resolve: () => void; reject: (error: Error) => void }[];
let detach: () => void;
const bridge = window.textToCad as unknown as Record<string, unknown>;
const saved = { on: bridge.on, sessions: bridge.sessions };

const block = (text: string): PromptBlock[] => [{ type: "text", text }];
const emit = (event: Record<string, unknown>) =>
  handlers["session.update"]!({ sessionId: SESSION, event: { at: Date.now(), ...event } });
const start = (text: string) => emit({ type: "prompt/start", turnId: text, content: block(text) });
const end = () => emit({ type: "prompt/end", stopReason: "end_turn", usage: null });
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
/** What main has been handed and not yet answered: more than one is two turns at once. */
const inFlight = () => replies.map(reply => reply.text);

beforeEach(() => {
  handlers = {};
  replies = [];
  bridge.on = vi.fn((channel: string, handler: Handler) => { handlers[channel] = handler; return () => {}; });
  bridge.sessions = {
    ...(saved.sessions as object),
    prompt: vi.fn(({ content }: { content: PromptBlock[] }) => new Promise((resolve, reject) => {
      const text = content[0]?.type === "text" ? content[0].text : "";
      const reply = {
        text,
        resolve: () => { replies = replies.filter(item => item !== reply); resolve({ stopReason: "end_turn" }); },
        reject: (error: Error) => { replies = replies.filter(item => item !== reply); reject(error); },
      };
      replies.push(reply);
    })),
  };
  useAcp.setState({ sessions: { [SESSION]: initialSessionState(SESSION, "claude") }, reconnecting: {} });
  useComposer.setState({ queues: {}, sending: {}, drafts: {}, annotations: {}, referenceLabels: {}, draftRoots: {} });
  detach = subscribeToMain();
});

afterEach(() => {
  detach();
  bridge.on = saved.on;
  bridge.sessions = saved.sessions;
});

it("sends queued prompts one at a time: prompt/end then the reply does not send two", async () => {
  const composer = useComposer.getState();
  void composer.submit(SESSION, "first", block("first"));
  // Submitted before main has said the first one started: already in flight, so queued.
  void composer.submit(SESSION, "second", block("second"));
  start("first");
  void composer.submit(SESSION, "third", block("third"));
  await settle();
  expect(inFlight()).toEqual(["first"]);
  expect(useComposer.getState().queues[SESSION]?.map(item => item.text)).toEqual(["second", "third"]);

  // Main broadcasts the end, then replies to the first prompt.
  end();
  await settle();
  replies.find(reply => reply.text === "first")!.resolve();
  await settle();
  expect(inFlight(), "only the next queued prompt goes out").toEqual(["second"]);
  expect(useComposer.getState().queues[SESSION]?.map(item => item.text)).toEqual(["third"]);

  start("second");
  end();
  await settle();
  replies[0]!.resolve();
  await settle();
  expect(inFlight()).toEqual(["third"]);
  expect(useComposer.getState().queues[SESSION]).toEqual([]);
});

it("a failed turn pauses the queue; what is sent next goes first and the queue resumes after it", async () => {
  const composer = useComposer.getState();
  void composer.submit(SESSION, "first", block("first"));
  start("first");
  void composer.submit(SESSION, "queued", block("queued"));
  emit({ type: "prompt/error", message: "boom" });
  replies[0]!.reject(new Error("boom"));
  await settle();
  expect(useAcp.getState().sessions[SESSION]?.status).toBe("error");
  expect(inFlight(), "nothing is sent into the failure").toEqual([]);
  expect(useComposer.getState().queues[SESSION]?.map(item => item.text)).toEqual(["queued"]);

  void composer.submit(SESSION, "first", block("first"));
  await settle();
  expect(inFlight(), "the Retry goes out ahead of the queue").toEqual(["first"]);
  start("first");
  end();
  await settle();
  replies[0]!.resolve();
  await settle();
  expect(inFlight()).toEqual(["queued"]);
});

it("a prompt the IPC refuses before any turn event frees the session", async () => {
  void useComposer.getState().submit(SESSION, "first", block("first"));
  expect(useComposer.getState().sending[SESSION]).toBeDefined();
  replies[0]!.reject(new Error("no such session"));
  await settle();
  expect(useComposer.getState().sending[SESSION]).toBeUndefined();
});

it("a queue left behind by a disconnect drains when a reconnect's session.state says idle", async () => {
  const composer = useComposer.getState();
  void composer.submit(SESSION, "first", block("first"));
  start("first");
  void composer.submit(SESSION, "queued", block("queued"));
  await settle();
  // The agent is evicted mid-turn: no prompt/end, the reply rejects, the session reads closed.
  emit({ type: "status", status: "closed", error: null });
  replies[0]!.reject(new Error("disconnected"));
  await settle();
  expect(useComposer.getState().queues[SESSION]?.map(item => item.text)).toEqual(["queued"]);

  // The reconnect: a full snapshot, idle, and no turn event at all.
  handlers["session.state"]!({ sessionId: SESSION, state: { ...initialSessionState(SESSION, "claude"), status: "idle" } });
  await settle();
  expect(inFlight(), "the queued prompt goes out on reconnect").toEqual(["queued"]);
  expect(useComposer.getState().queues[SESSION]).toEqual([]);
});

it("a prompt typed behind a queue while the agent is gone waits its turn: the reconnect sends the queue first", async () => {
  const ensureLoaded = vi.fn(async () => undefined);
  const savedEnsure = useAcp.getState().ensureLoaded;
  useAcp.setState({ ensureLoaded });
  try {
    const composer = useComposer.getState();
    void composer.submit(SESSION, "A", block("A"));
    start("A");
    void composer.submit(SESSION, "B", block("B"));
    await settle();
    // Disconnected mid-turn: A's turn never ends, the session reads closed, B is left queued.
    emit({ type: "status", status: "closed", error: null });
    replies[0]!.reject(new Error("disconnected"));
    await settle();
    expect(useComposer.getState().queues[SESSION]?.map(item => item.text)).toEqual(["B"]);

    void composer.submit(SESSION, "C", block("C"));
    await settle();
    expect(inFlight(), "C is not sent past the queue").toEqual([]);
    expect(useComposer.getState().queues[SESSION]?.map(item => item.text)).toEqual(["B", "C"]);
    expect(ensureLoaded, "and the agent is asked back").toHaveBeenCalledWith(SESSION);

    handlers["session.state"]!({ sessionId: SESSION, state: { ...initialSessionState(SESSION, "claude"), status: "idle" } });
    await settle();
    expect(inFlight()).toEqual(["B"]);
    start("B");
    end();
    await settle();
    replies[0]!.resolve();
    await settle();
    expect(inFlight()).toEqual(["C"]);
  } finally {
    useAcp.setState({ ensureLoaded: savedEnsure });
  }
});

it("on a connecting session, or none at all, a prompt behind a queue is queued and the agent asked back", async () => {
  const ensureLoaded = vi.fn(async () => undefined);
  const savedEnsure = useAcp.getState().ensureLoaded;
  useAcp.setState({ ensureLoaded });
  try {
    useComposer.getState().enqueue(SESSION, "stranded", block("stranded"));
    useAcp.setState({ sessions: { [SESSION]: { ...initialSessionState(SESSION, "claude"), status: "connecting" } } });
    void useComposer.getState().submit(SESSION, "new-connecting", block("new-connecting"));
    useAcp.setState({ sessions: {} });
    void useComposer.getState().submit(SESSION, "new-none", block("new-none"));
    await settle();
    expect(inFlight()).toEqual([]);
    expect(useComposer.getState().queues[SESSION]?.map(item => item.text)).toEqual(["stranded", "new-connecting", "new-none"]);
    expect(ensureLoaded).toHaveBeenCalledWith(SESSION);
  } finally {
    useAcp.setState({ ensureLoaded: savedEnsure });
  }
});
