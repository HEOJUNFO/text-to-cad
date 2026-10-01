import { expect, it } from "vitest";

import { reduce } from "@shared/acp/reduce";
import { initialSessionState, type SessionEvent, type SessionState } from "@shared/acp/types";

const at = 1_000;
const root = "root-session";
const chunk = (state: SessionState, text: string) =>
  reduce(state, {
    type: "session/update",
    acpSessionId: root,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } as never as SessionEvent extends { update: infer U } ? U : never,
    at,
  });

function stopped(): SessionState {
  let state = reduce(initialSessionState("s1", "fake"), {
    type: "session/connected", acpSessionId: root, modes: null, configOptions: null, loading: false, at,
  } as never);
  state = reduce(state, { type: "prompt/start", turnId: "t1", content: [{ type: "text", text: "hi" }], at });
  state = chunk(state, "Working on it.");
  return reduce(state, { type: "prompt/end", stopReason: "cancelled", usage: null, at });
}

it("marks a chunk that arrives after the turn ended as late, from where it begins", () => {
  const state = chunk(stopped(), "Background task finished.");
  const turn = state.turns.at(-1)!;
  expect(turn.stopReason).toBe("cancelled");
  expect(turn.parts).toHaveLength(2);
  expect(turn.lateFrom).toBe(1);
  // The chunks behind the first join it, and the mark stays where it was.
  expect(chunk(state, " More.").turns.at(-1)).toMatchObject({ lateFrom: 1, parts: [{ text: "Working on it." }, { text: "Background task finished. More." }] });
});

it("leaves a turn that took nothing late unmarked", () => {
  expect(stopped().turns.at(-1)!.lateFrom).toBeUndefined();
});
