import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NewSession } from "@renderer/features/session/NewSession";
import { useAcp } from "@renderer/state/acp";
import { useAgents } from "@renderer/state/agents";
import { useComposer } from "@renderer/state/composer";
import type { AgentStatus } from "@shared/agents";

// The composer and its chips are their own suites; here the box is a button
// that sends one prompt, which is all a start needs.
vi.mock("@renderer/features/session/Composer", () => ({
  Composer: ({ onSubmit }: { onSubmit: (text: string, content: unknown[]) => void }) => (
    <button onClick={() => onSubmit("make a cube", [{ type: "text", text: "make a cube" }])} type="button">
      Send
    </button>
  ),
}));
vi.mock("@renderer/features/session/ComposerChips", () => ({
  EffortChip: () => null,
  GitModeChip: () => null,
  ModeChip: () => null,
  ModelChip: () => null,
  ProjectChip: () => null,
}));
vi.mock("@renderer/lib/git-mode", () => ({
  resolveGitMode: () => "checkout",
  useProjectGitInfo: () => null,
}));
vi.mock("@renderer/state/agent-options", async () => {
  const { create } = await import("zustand");
  return {
    useAgentOptions: create(() => ({ probe: vi.fn(), setDefaults: vi.fn(), setEffort: vi.fn() })),
    useProviderModels: () => [],
    useProviderEffort: () => null,
    useProviderMode: () => null,
  };
});

const PROJECT = { id: "p1", name: "bracket", path: "/bracket", createdAt: 0 };
const AGENT = {
  id: "claude",
  name: "Claude Code",
  installed: true,
  launchWithoutBinary: true,
  auth: "unauthenticated",
  authMethods: [{ type: "cli-login", label: "Sign in" }],
} as unknown as AgentStatus;

const create = vi.fn();
const submit = vi.fn(async () => undefined);

beforeEach(() => {
  create.mockReset();
  submit.mockReset();
  useAgents.setState({ agents: [AGENT], jobs: {} });
  useAcp.setState({ create } as never);
  useComposer.setState({ submit } as never);
});

describe("a start that needs a sign-in", () => {
  it("sends the same prompt again from Try again", async () => {
    const user = userEvent.setup();
    create.mockRejectedValueOnce(new Error("Authentication required")).mockResolvedValueOnce("s1");
    render(<NewSession project={PROJECT} />);

    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(create).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledWith("s1", "make a cube", [{ type: "text", text: "make a cube" }]);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("starts again by itself when a login that began after the failure exits 0", async () => {
    const user = userEvent.setup();
    // A login that finished before this failure is not this failure's sign-in.
    useAgents.setState({ jobs: { old: { agentId: "claude", kind: "login", output: "", exitCode: 0 } } });
    create.mockRejectedValueOnce(new Error("Authentication required")).mockResolvedValueOnce("s1");
    render(<NewSession project={PROJECT} />);

    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Try again" });
    expect(create).toHaveBeenCalledTimes(1);

    act(() => useAgents.getState().receiveOutput({ jobId: "j1", agentId: "claude", kind: "login", data: "ok", exitCode: null }));
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => useAgents.getState().receiveOutput({ jobId: "j1", agentId: "claude", kind: "login", data: "", exitCode: 0 }));

    expect(create).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledWith("s1", "make a cube", [{ type: "text", text: "make a cube" }]);
  });

  it("does not start again when the login fails", async () => {
    const user = userEvent.setup();
    create.mockRejectedValueOnce(new Error("Authentication required"));
    render(<NewSession project={PROJECT} />);

    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Try again" });
    await act(async () => useAgents.getState().receiveOutput({ jobId: "j1", agentId: "claude", kind: "login", data: "", exitCode: 1 }));

    expect(create).toHaveBeenCalledTimes(1);
  });
});
