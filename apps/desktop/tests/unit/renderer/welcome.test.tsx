import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Welcome } from "@renderer/features/onboarding/Welcome";
import { useAgents } from "@renderer/state/agents";
import type { AgentStatus } from "@shared/agents";

const agent = (overrides: Partial<AgentStatus>) =>
  ({
    id: "claude-code",
    name: "Claude Code",
    icon: null,
    installed: false,
    launchWithoutBinary: false,
    auth: "unknown",
    authMethods: [],
    ...overrides,
  }) as unknown as AgentStatus;

async function toAgentStep() {
  const user = userEvent.setup();
  render(<Welcome />);
  await user.click(screen.getByRole("button", { name: /Continue/ }));
  return user;
}

beforeEach(() => {
  useAgents.setState({ agents: [], ready: false, loadError: null, jobs: {} });
});

describe("the welcome", () => {
  it("names the panes as they are and the viewer's Annotate action", () => {
    render(<Welcome />);
    expect(screen.getByText("Session in the middle.")).toBeInTheDocument();
    expect(screen.getByText("Select a face or edge and Annotate it.")).toBeInTheDocument();
    expect(screen.queryByText(/Chat on the left/)).toBeNull();
  });

  it("reserves the title bar and the traffic lights' corner like Settings", () => {
    const { container } = render(<Welcome />);
    const strip = container.querySelector<HTMLElement>("[data-onboarding-titlebar]")!;
    expect(strip.style.height).toBe("var(--titlebar-height)");
    expect(strip.style.paddingLeft).toBe("var(--titlebar-inset)");
  });

  it("says it is looking while detection has not answered, with Continue held until it does", async () => {
    await toAgentStep();
    expect(screen.getByText("Looking for agents on this machine…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Continue$/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /without an agent/ })).toBeNull();

    useAgents.setState({ agents: [agent({})], ready: true });
    expect(await screen.findByRole("button", { name: /Continue without an agent/ })).toBeEnabled();
  });

  it("offers an enabled Continue without an agent when detection answered with an empty table", async () => {
    await toAgentStep();
    expect(screen.getByRole("button", { name: /^Continue$/ })).toBeDisabled();
    // Detection's answer arrives on `agents.status`; an empty one is still an answer.
    useAgents.getState().receive([]);
    expect(await screen.findByRole("button", { name: /Continue without an agent/ })).toBeEnabled();
  });

  it("stops waiting when the agent list cannot be read, and says so rather than showing no agents", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(window.textToCad.agents.list).mockRejectedValueOnce(new Error("ipc down"));
    await useAgents.getState().load();
    expect(useAgents.getState()).toMatchObject({ ready: true, loadError: "ipc down" });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("Could not read the agent list"), expect.any(Error));
    logged.mockRestore();

    await toAgentStep();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not read the agent list: ipc down");
    expect(screen.getByRole("button", { name: /Continue without an agent/ })).toBeEnabled();

    // A list that arrives afterwards is the answer, and the failure goes.
    useAgents.getState().receive([agent({})]);
    expect(await screen.findByRole("button", { name: /Install/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps waiting on an empty first list: that is the probe still running, not an answer", async () => {
    vi.mocked(window.textToCad.agents.list).mockResolvedValueOnce([]);
    await useAgents.getState().load();
    expect(useAgents.getState().ready).toBe(false);
  });

  it("pins the block's top rather than centring it, so steps do not jump", () => {
    const { container } = render(<Welcome />);
    const body = container.querySelector<HTMLElement>("[data-onboarding-body]")!;
    expect(body.className).not.toMatch(/\bitems-center\b/);
    expect(body.className).toMatch(/\bpt-\[/);
  });

  it("offers Continue without an agent when none is ready, and plain Continue once one is", async () => {
    useAgents.setState({ agents: [agent({})], ready: true });
    await toAgentStep();
    expect(screen.queryByText("Looking for agents on this machine…")).toBeNull();
    expect(screen.getByRole("button", { name: /Install/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue without an agent/ })).toBeInTheDocument();

    useAgents.setState({ agents: [agent({ installed: true, auth: "authenticated" })] });
    expect(await screen.findByRole("button", { name: /^Continue$/ })).toBeInTheDocument();
  });

  it("says Not signed in only when detection found the agent signed out", async () => {
    useAgents.setState({
      agents: [agent({ installed: true, auth: "unknown" }), agent({ id: "codex", name: "Codex", installed: true, auth: "unauthenticated" })],
      ready: true,
    });
    await toAgentStep();
    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.getAllByText("Not signed in")).toHaveLength(1);
  });
});
