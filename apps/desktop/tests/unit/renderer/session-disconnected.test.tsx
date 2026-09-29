import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionView } from "@renderer/features/session/SessionView";
import { useAcp } from "@renderer/state/acp";
import { useAgents } from "@renderer/state/agents";
import { useUi } from "@renderer/state/ui";
import type { AgentStatus } from "@shared/agents";
import { initialSessionState } from "@shared/acp/types";
import type { Session } from "@shared/types";

// The pieces around the one state under test are their own suites.
vi.mock("@renderer/features/session/Composer", () => ({
  Composer: ({ disabled }: { disabled: boolean }) => <textarea aria-label="Prompt" disabled={disabled} />,
}));
vi.mock("@renderer/features/session/SessionHeader", () => ({ SessionHeader: () => null }));
vi.mock("@renderer/features/session/Transcript", () => ({ Transcript: () => <div data-transcript /> }));
vi.mock("@renderer/features/session/ContextMeter", () => ({ ContextMeter: () => null }));

const SESSION = {
  id: "s1",
  projectId: "p1",
  agentId: "claude",
  cwd: "/bracket",
  gitMode: "checkout",
  title: "New session",
  titleSource: "prompt",
  createdAt: 0,
  updatedAt: 0,
  status: "closed",
} as unknown as Session;

const load = vi.fn(async () => undefined);
const ensureLoaded = vi.fn(async () => undefined);

beforeEach(() => {
  load.mockClear();
  ensureLoaded.mockClear();
  useAcp.setState({ sessions: {}, loading: {}, reconnecting: {}, loadErrors: {}, load, ensureLoaded } as never);
});

describe("a disconnected agent", () => {
  it("says so above the disabled composer and reconnects from there", async () => {
    const user = userEvent.setup();
    useAcp.setState({ sessions: { s1: { ...initialSessionState("s1", "claude"), status: "closed" } } });
    render(<SessionView session={SESSION} />);

    expect(screen.getByRole("status")).toHaveTextContent("Agent disconnected");
    expect(screen.getByLabelText("Prompt")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(load).toHaveBeenCalledWith("s1");
  });

  it("stays disconnected, not connecting, once a closed transcript is let go of", () => {
    useAcp.setState({ sessions: { s1: { ...initialSessionState("s1", "claude"), status: "closed" } } });
    render(<SessionView session={SESSION} />);
    act(() => useAcp.getState().forget("s1"));

    expect(screen.getByRole("status")).toHaveTextContent("Agent disconnected");
    expect(screen.queryByText(/Connecting to/)).toBeNull();
  });

  it("is not claimed for a closed row opened for the first time, which is still loading", () => {
    render(<SessionView session={SESSION} />);

    expect(screen.queryByText("Agent disconnected")).toBeNull();
    expect(screen.getByText(/Connecting to/)).toBeInTheDocument();
  });
});

describe("an agent whose CLI is not installed", () => {
  const missing = {
    id: "claude",
    name: "Claude Code",
    icon: null,
    installed: false,
    launchWithoutBinary: false,
    auth: "unknown",
    authMethods: [],
  } as unknown as AgentStatus;

  it("offers the install and Settings › Agents instead of a Reconnect that fails again", async () => {
    const user = userEvent.setup();
    const install = vi.fn(async () => "job1");
    const openSettings = vi.fn();
    useAgents.setState({ agents: [missing], jobs: {}, ready: true, install } as never);
    useUi.setState({ openSettings } as never);
    useAcp.setState({ loadErrors: { s1: "Claude Code is not installed" } });
    render(<SessionView session={SESSION} />);

    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Install" }));
    expect(install).toHaveBeenCalledWith("claude");
    await user.click(screen.getByRole("button", { name: "Settings › Agents" }));
    expect(openSettings).toHaveBeenCalledWith("agents");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(load).toHaveBeenCalledWith("s1");
  });

  it("does the same above a painted transcript", () => {
    useAgents.setState({ agents: [missing], jobs: {}, ready: true });
    useAcp.setState({
      sessions: { s1: { ...initialSessionState("s1", "claude"), status: "closed" } },
      loadErrors: { s1: "Claude Code is not installed" },
    });
    render(<SessionView session={SESSION} />);
    expect(screen.getByText("Claude Code is not installed", { selector: "p.font-medium" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });
});
