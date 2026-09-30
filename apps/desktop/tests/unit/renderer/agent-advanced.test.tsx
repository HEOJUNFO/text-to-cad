/**
 * The drawer's Advanced fields, like Settings' other text fields, write a
 * finished edit: on blur, and on unmount for an edit the drawer closed on.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { AgentDrawer } from "@renderer/features/settings/AgentDrawer";
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
  installed: true,
  binaryPath: "/bin/codex",
  version: "1.0.0",
  auth: "authenticated",
  authMethods: [],
  capabilities: {},
  install: { macos: [], windows: [], linux: [] },
  launch: { command: "codex", args: [], env: {} },
  skillRoots: "native",
} as unknown as AgentStatus;

const drawer = () => (
  <TooltipProvider>
    <AgentDrawer agent={codex} onOpenChange={() => {}} open platform="macos" />
  </TooltipProvider>
);

beforeEach(() => {
  vi.mocked(window.textToCad.settings.set).mockReset();
  vi.mocked(window.textToCad.settings.set).mockImplementation(async (patch) => ({ ...defaultSettings(), ...(patch as object) }));
  useSettings.setState({ settings: defaultSettings(), ready: true });
});

it("writes extra arguments typed into the field when the drawer closes without a blur", async () => {
  const user = userEvent.setup();
  const view = render(drawer());
  await user.type(await screen.findByLabelText("Extra arguments"), "--verbose");
  view.unmount();
  expect(window.textToCad.settings.set).toHaveBeenCalledWith({
    agentOverrides: { codex: { extraArgs: ["--verbose"], env: {} } },
  });
});

it("says which environment lines have no KEY= and will not be saved, and keeps the ones that do", async () => {
  const user = userEvent.setup();
  render(drawer());
  const env = await screen.findByLabelText("Environment", { selector: "textarea" });
  await user.type(env, "GOOD=1{Enter}oops{Enter}# note{Enter}=x");
  expect(screen.getByRole("status")).toHaveTextContent("Lines 2 and 4 have no KEY=value and will not be saved.");
  await user.tab();
  expect(window.textToCad.settings.set).toHaveBeenCalledWith({
    agentOverrides: { codex: { extraArgs: [], env: { GOOD: "1" } } },
  });
});
