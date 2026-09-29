import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { TooltipProvider } from "@text-to-cad/ui/primitives/tooltip";
import { diffCounts } from "@renderer/features/session/diff-counts";
import { Transcript } from "@renderer/features/session/Transcript";
import { initialSessionState, type SessionState, type ToolCallPart, type Turn } from "@shared/acp/types";

vi.mock("@renderer/features/session/diff-counts", async (original) => {
  const actual = await original<{ diffCounts: typeof diffCounts }>();
  return { diffCounts: vi.fn(actual.diffCounts) };
});

const edit: ToolCallPart = {
  type: "tool_call",
  id: "e1",
  kind: "edit",
  title: "Edit a.py",
  name: null,
  status: "completed",
  input: undefined,
  output: undefined,
  content: [{ type: "diff", path: "a.py", oldText: "first\n", newText: "first\nsecond\n" }],
  locations: [],
  stream: "",
  children: [],
};

const agent = (id: string, parts: Turn["parts"], endedAt: number | null): Turn => ({
  id,
  role: "agent",
  parts,
  startedAt: 1,
  endedAt,
  stopReason: endedAt === null ? null : "end_turn",
});

describe("the transcript while the last turn streams", () => {
  it("does not count an earlier turn's diff lines again", () => {
    const state: SessionState = {
      ...initialSessionState("s1", "codex"),
      status: "running",
      turns: [agent("t1", [edit], 2), agent("t2", [{ type: "text", text: "Now" }], null)],
    };
    const view = (next: SessionState) => (
      <TooltipProvider>
        <Transcript onReconnect={() => {}} onRetry={() => {}} state={next} />
      </TooltipProvider>
    );
    const { rerender } = render(view(state));
    const counts = vi.mocked(diffCounts);
    counts.mockClear();

    // A token on the last turn: the reducer replaces that turn and keeps the first.
    const streamed = { ...state, turns: [state.turns[0]!, agent("t2", [{ type: "text", text: "Now the" }], null)] };
    rerender(view(streamed));
    expect(counts).not.toHaveBeenCalled();
  });
});
