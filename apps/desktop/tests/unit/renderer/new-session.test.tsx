import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NewSession } from "@renderer/features/session/NewSession";
import { useAcp } from "@renderer/state/acp";
import { useAgents } from "@renderer/state/agents";
import { useAgentOptions } from "@renderer/state/agent-options";
import { useComposer } from "@renderer/state/composer";
import { useUi } from "@renderer/state/ui";
import type { AgentStatus } from "@shared/agents";

// The composer and its chips are their own suites; here the box is a button
// that sends what the draft holds (a stock prompt when it is empty) the way the
// real composer does: taken whole on submit, put back when the start rejects —
// and a submit asked for from outside (`requestSubmit`) is the same send.
vi.mock("@renderer/features/session/Composer", async () => {
  const { useEffect } = await import("react");
  const { useComposer } = await import("@renderer/state/composer");
  return {
    Composer: ({ onSubmit, chips, trailing, newDraftKey, placeholder }: {
      onSubmit: (text: string, content: unknown[], draft: unknown) => Promise<void> | void;
      chips?: React.ReactNode; trailing?: React.ReactNode; newDraftKey: string; placeholder?: string;
    }) => {
      const send = () => {
        const store = useComposer.getState();
        const text = store.drafts[newDraftKey]?.trim() || "make a cube";
        const taken = store.takeDraft(newDraftKey);
        void Promise.resolve(onSubmit(text, [{ type: "text", text }], taken)).catch(() => useComposer.getState().restoreDraft(newDraftKey, taken));
      };
      const request = useComposer((state) => state.submitRequest?.key === newDraftKey ? state.submitRequest.nonce : null);
      useEffect(() => { if (request !== null) send(); }, [request]);
      return (
        <>
          <input aria-label="Prompt" placeholder={placeholder} readOnly />
          <button onClick={send} type="button">Send</button>
          {chips}
          {trailing}
        </>
      );
    },
  };
});
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
const openSettings = vi.fn();

beforeEach(() => {
  create.mockReset();
  submit.mockReset();
  openSettings.mockReset();
  useUi.setState({ openSettings } as never);
  useAgentOptions.setState({ probe: vi.fn(async () => undefined) } as never);
  useAgents.setState({ agents: [AGENT], jobs: {}, ready: true });
  useAcp.setState({ create } as never);
  useComposer.setState({ submit, drafts: {}, annotations: {}, submitRequest: null } as never);
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

  it("leaves the draft to the composer on a failed start, and clears it once Try again has sent it", async () => {
    const user = userEvent.setup();
    const key = "__new__:p1";
    // What the composer restored after the failed start: text and annotation apart.
    useComposer.setState({
      drafts: { [key]: "make a cube" },
      annotations: { [key]: [{ id: "a1", text: "hollow it", references: [] }] },
    });
    create.mockRejectedValueOnce(new Error("Authentication required")).mockResolvedValueOnce("s1");
    render(<NewSession project={PROJECT} />);

    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Try again" });
    expect(useComposer.getState().drafts[key], "not overwritten with the flattened prompt").toBe("make a cube");
    expect(useComposer.getState().annotations[key]).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(submit).toHaveBeenCalledWith("s1", "make a cube", [{ type: "text", text: "make a cube" }]);
    expect(useComposer.getState().drafts[key]).toBe("");
    expect(useComposer.getState().annotations[key]).toBeUndefined();
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

  it("Try again sends what the box holds now, not what failed", async () => {
    const user = userEvent.setup();
    const key = "__new__:p1";
    useComposer.setState({ drafts: { [key]: "make a cube" } });
    create.mockRejectedValueOnce(new Error("Authentication required")).mockResolvedValueOnce("s1");
    render(<NewSession project={PROJECT} />);

    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Try again" });
    // The person edits the restored draft before retrying.
    act(() => useComposer.getState().setDraft(key, "make a sphere"));
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(submit).toHaveBeenCalledWith("s1", "make a sphere", [{ type: "text", text: "make a sphere" }]);
    expect(submit).not.toHaveBeenCalledWith("s1", "make a cube", expect.anything());
  });

  it("does not start again by itself after a login when the draft was edited since the failure", async () => {
    const user = userEvent.setup();
    const key = "__new__:p1";
    useComposer.setState({ drafts: { [key]: "make a cube" } });
    create.mockRejectedValueOnce(new Error("Authentication required")).mockResolvedValueOnce("s1");
    render(<NewSession project={PROJECT} />);

    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Try again" });
    act(() => {
      useComposer.getState().setDraft(key, "make a cube, but hollow");
      useComposer.setState({ annotations: { [key]: [{ id: "a2", text: "this face", references: [] }] } });
    });
    await act(async () => useAgents.getState().receiveOutput({ jobId: "j1", agentId: "claude", kind: "login", data: "", exitCode: 0 }));

    expect(create).toHaveBeenCalledTimes(1);
    expect(useComposer.getState().drafts[key], "the edit is kept").toBe("make a cube, but hollow");
    expect(useComposer.getState().annotations[key]).toHaveLength(1);
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

describe("a machine with no agent ready", () => {
  // Both offered agents launch without their CLI, so `useInstalledAgents`
  // counts them whatever is on the machine; the card is for when detection
  // found every one of them signed out.
  const claude = { ...AGENT, id: "claude-code", name: "Claude Code", installed: true, launchWithoutBinary: true, auth: "unauthenticated" } as unknown as AgentStatus;
  const codex = { ...AGENT, id: "codex", name: "Codex", installed: true, launchWithoutBinary: true, auth: "unauthenticated" } as unknown as AgentStatus;

  it("says so before anything is typed, with each agent's sign-in and Settings › Agents", async () => {
    const user = userEvent.setup();
    const login = vi.fn(async () => "job1");
    useAgents.setState({ agents: [claude, codex], ready: true, login } as never);
    render(<NewSession project={PROJECT} />);

    expect(screen.getByText("No agent ready")).toBeInTheDocument();
    expect(screen.getByText(/Sign in to Claude Code or Codex, or install one/)).toBeInTheDocument();
    expect(screen.getAllByText("Not signed in")).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: "Sign in" })[0]!);
    expect(login).toHaveBeenCalledWith("claude-code");
    await user.click(screen.getByRole("button", { name: "Settings › Agents" }));
    expect(openSettings).toHaveBeenCalledWith("agents");
    expect(create).not.toHaveBeenCalled();
  });

  it("lists the agent one sign-in away before one that needs installing", () => {
    const gone = { ...claude, installed: false, launchWithoutBinary: false, auth: "unknown" } as AgentStatus;
    useAgents.setState({ agents: [gone, codex], ready: true });
    render(<NewSession project={PROJECT} />);

    const rows = [...document.querySelectorAll("[data-agent-setup] [data-onboarding-agent]")].map((row) => row.getAttribute("data-onboarding-agent"));
    expect(rows).toEqual(["codex", "claude-code"]);
    expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument();
  });

  it("is not shown once an agent is ready, even one that runs without its CLI", () => {
    useAgents.setState({ agents: [{ ...claude, installed: false, auth: "authenticated" } as AgentStatus, codex], ready: true });
    render(<NewSession project={PROJECT} />);
    expect(screen.queryByText("No agent ready")).toBeNull();
  });

  it("is not shown for an agent whose sign-in detection cannot tell", () => {
    const copilot = { ...AGENT, id: "copilot", name: "Copilot", installed: true, launchWithoutBinary: false, auth: "unknown" } as unknown as AgentStatus;
    useAgents.setState({ agents: [claude, codex, copilot], ready: true });
    render(<NewSession project={PROJECT} />);
    expect(screen.queryByText("No agent ready")).toBeNull();
  });

  it("does not claim it while detection has not answered", () => {
    useAgents.setState({ agents: [], ready: false });
    render(<NewSession project={PROJECT} />);
    expect(screen.queryByText("No agent ready")).toBeNull();
  });

  it("offers Settings › Agents beside Dismiss when the start fails for another reason", async () => {
    const user = userEvent.setup();
    useAgents.setState({ agents: [{ ...AGENT, auth: "authenticated" } as AgentStatus] });
    create.mockRejectedValueOnce(new Error("Claude Code is not installed"));
    render(<NewSession project={PROJECT} />);

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Claude Code is not installed");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Open Settings › Agents/ }));
    expect(openSettings).toHaveBeenCalledWith("agents");
  });
});

describe("the model chip", () => {
  it("says the models are loading while the agents are probed, and goes once they answer", async () => {
    let answer!: () => void;
    useAgentOptions.setState({ probe: vi.fn(() => new Promise<void>((resolve) => (answer = resolve))) } as never);
    render(<NewSession project={PROJECT} />);

    expect(screen.getByRole("button", { name: /Loading models/ })).toBeDisabled();
    // All three slots hold their place, so the row does not jump when they land.
    expect(document.querySelector("[data-chip=mode-loading]")).not.toBeNull();
    expect(document.querySelector("[data-chip=effort-loading]")).not.toBeNull();
    await act(async () => answer());
    expect(screen.queryByRole("button", { name: /Loading models/ })).toBeNull();
    expect(document.querySelector("[data-chip=mode-loading]")).toBeNull();
    expect(document.querySelector("[data-chip=effort-loading]")).toBeNull();
  });

  it("holds the chips' places while detection has not answered yet", () => {
    useAgents.setState({ ready: false });
    render(<NewSession project={PROJECT} />);
    expect(screen.getByRole("button", { name: /Loading models/ })).toBeDisabled();
    expect(document.querySelector("[data-chip=mode-loading]")).not.toBeNull();
  });

  it("hints at CAD in the box, on this screen only", () => {
    render(<NewSession project={PROJECT} />);
    expect(screen.getByPlaceholderText("Describe a part to build…")).toBeInTheDocument();
  });
});
