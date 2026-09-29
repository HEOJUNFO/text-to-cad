import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@text-to-cad/ui/primitives/tooltip";

import { SessionHeader } from "@renderer/features/session/SessionHeader";
import { useAcp } from "@renderer/state/acp";
import { initialSessionState } from "@shared/acp/types";
import type { Session } from "@shared/types";

const SESSION = { id: "s1", projectId: "p", agentId: "codex", cwd: "/p", title: "Bracket", status: "idle", archived: false } as unknown as Session;
const load = vi.fn(async () => undefined);
const close = vi.fn(async () => undefined);

beforeEach(() => {
  load.mockClear();
  close.mockClear();
  useAcp.setState({ sessions: {}, loading: {}, load, close } as never);
});

async function openMenu() {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <SessionHeader session={SESSION} title="Bracket" />
    </TooltipProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Session actions" }));
  return user;
}

describe("the session menu's agent item", () => {
  it("offers Disconnect agent while the agent is connected", async () => {
    useAcp.setState({ sessions: { s1: { ...initialSessionState("s1", "codex"), status: "idle" } } });
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Disconnect agent" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Reconnect" })).toBeNull();
  });

  it("offers Reconnect, not a second disconnect, once the agent is disconnected", async () => {
    useAcp.setState({ sessions: { s1: { ...initialSessionState("s1", "codex"), status: "closed" } } });
    const user = await openMenu();
    expect(screen.queryByRole("menuitem", { name: "Disconnect agent" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Reconnect" }));
    expect(load).toHaveBeenCalledWith("s1");
    expect(close).not.toHaveBeenCalled();
  });
});
