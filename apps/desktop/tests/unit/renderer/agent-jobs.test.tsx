/**
 * An install or sign-in is a pty job in main, and the store holds the truth
 * about it: a drawer or an agent row that is closed and opened again, or
 * unmounted and remounted, has to find the job still running rather than
 * offer to start a second one.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { AgentDrawer } from "@renderer/features/settings/AgentDrawer";
import { useAgents } from "@renderer/state/agents";
import { useSettings } from "@renderer/state/settings";
import { defaultSettings } from "@shared/types";
import type { AgentStatus } from "@shared/agents";

const codex = {
  id: "codex",
  name: "Codex",
  description: "",
  websiteUrl: "https://example.com",
  docsUrl: "https://example.com",
  icon: null,
  installed: false,
  launchWithoutBinary: false,
  binaryPath: null,
  version: null,
  auth: "unknown",
  authMethods: [],
  capabilities: {},
  install: { macos: [{ label: "npm", command: "npm i -g codex" }], windows: [], linux: [] },
  launch: { command: "codex", args: [], env: {} },
  skillRoots: "native",
} as unknown as AgentStatus;

beforeEach(() => {
  useSettings.setState({ settings: defaultSettings(), ready: true });
  useAgents.setState({ agents: [codex], ready: true, loadError: null, jobs: {} });
});

describe("a job that outlives the component that started it", () => {
  it("the drawer, opened while the agent's install is running, shows it running with its log", () => {
    useAgents.setState({ jobs: { j1: { agentId: "codex", kind: "install", output: "fetching…\n", exitCode: null } } });
    render(
      <TooltipProvider>
        <AgentDrawer agent={codex} onOpenChange={() => {}} open platform="macos" />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
    expect(screen.getByText("fetching…")).toBeInTheDocument();
  });
});
