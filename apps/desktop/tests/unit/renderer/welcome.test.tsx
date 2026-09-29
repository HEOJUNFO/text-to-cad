import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

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
  useAgents.setState({ agents: [], ready: false, jobs: {} });
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

  it("says it is looking while detection has not answered", async () => {
    await toAgentStep();
    expect(screen.getByText("Looking for agents on this machine…")).toBeInTheDocument();
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
