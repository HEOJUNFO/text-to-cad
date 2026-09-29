import { act, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionView } from "@renderer/features/session/SessionView";
import { useAcp } from "@renderer/state/acp";
import { initialSessionState, type LiveStatus } from "@shared/acp/types";
import type { Session } from "@shared/types";

/**
 * The composer's model and mode chips and its Stop call main, which refuses a session with no
 * live agent (`requireLive`). Those refusals reach the person as a toast, and the chips are not
 * offered at all unless the agent is there to answer them.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), info: vi.fn() } }));
// The chips' own menus are their suite's; here each is one button that makes its choice.
vi.mock("@renderer/features/session/ComposerChips", () => ({
  ModeChip: ({ onChange }: { onChange: (id: string) => void }) => <button onClick={() => onChange("plan")} type="button">Mode</button>,
  ModelChip: ({ onChange }: { onChange: (agentId: string, value: string) => void }) => (
    <button onClick={() => onChange("codex", "gpt")} type="button">Model</button>
  ),
  EffortChip: () => null,
}));
vi.mock("@renderer/features/session/Composer", () => ({
  Composer: ({ chips, trailing, onStop }: { chips: React.ReactNode; trailing: React.ReactNode; onStop: () => void }) => (
    <div>
      {chips}
      {trailing}
      <button onClick={onStop} type="button">Stop</button>
    </div>
  ),
}));
vi.mock("@renderer/features/session/SessionHeader", () => ({ SessionHeader: () => null }));
vi.mock("@renderer/features/session/Transcript", () => ({ Transcript: () => null }));
vi.mock("@renderer/features/session/ContextMeter", () => ({ ContextMeter: () => null }));

const SESSION = { id: "s1", projectId: "p1", agentId: "codex", cwd: "/p", title: "t", status: "idle" } as unknown as Session;
const refused = () => Promise.reject(new Error("the session is not connected; load it first"));
const setMode = vi.fn(refused);
const setConfigOption = vi.fn(refused);
const cancel = vi.fn(refused);

function state(status: LiveStatus) {
  return {
    ...initialSessionState("s1", "codex"),
    status,
    currentModeId: "ask",
    modes: [{ id: "ask", name: "Ask", description: null }, { id: "plan", name: "Plan", description: null }],
    configOptions: [{ id: "model", name: "Model", type: "select", category: "model", currentValue: "a", options: [{ value: "a", name: "A" }, { value: "gpt", name: "GPT" }] }],
  } as never;
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  useAcp.setState({ sessions: {}, loading: {}, reconnecting: {}, loadErrors: {}, ensureLoaded: vi.fn(async () => undefined), setMode, setConfigOption, cancel } as never);
});

const click = (name: string) => act(async () => screen.getByRole("button", { name, hidden: true }).click());

describe("the composer's chips and Stop", () => {
  it("tell the person why main refused, rather than failing unhandled", async () => {
    useAcp.setState({ sessions: { s1: state("running") } } as never);
    render(<SessionView session={SESSION} />);
    await click("Mode");
    await click("Model");
    await click("Stop");
    expect(setMode).toHaveBeenCalled();
    expect(setConfigOption).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(vi.mocked(toast.error).mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringMatching(/mode.*not connected/i),
      expect.stringMatching(/model.*not connected/i),
      expect.stringMatching(/stop.*not connected/i),
    ]);
  });

  it.each(["closed", "connecting", "error"] as const)("are not offered on a %s session", (status) => {
    useAcp.setState({ sessions: { s1: state(status) } } as never);
    render(<SessionView session={SESSION} />);
    for (const name of ["Mode", "Model"]) {
      expect(screen.getByRole("button", { name, hidden: true }).closest("[inert]"), name).not.toBeNull();
    }
  });

  it("are offered on an idle session", () => {
    useAcp.setState({ sessions: { s1: state("idle") } } as never);
    render(<SessionView session={SESSION} />);
    expect(screen.getByRole("button", { name: "Mode" }).closest("[inert]")).toBeNull();
  });
});
