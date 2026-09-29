/**
 * The palette's shape: one prompt string for the box and the dialog's
 * description, a Create group holding every New-tab kind, and a dialog
 * anchored near the top rather than centred (a centred one jumps as the list
 * filters).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { COMMAND_PALETTE_PROMPT, CommandPalette } from "@renderer/app/CommandPalette";
import { useSessions } from "@renderer/state/sessions";
import { useUi } from "@renderer/state/ui";

beforeEach(() => {
  useUi.setState({ route: "app", commandPaletteOpen: true, commandPaletteQuery: "" });
});

describe("the command palette", () => {
  it("uses one string for its placeholder and its description", () => {
    render(<CommandPalette />);
    expect(screen.getByPlaceholderText(COMMAND_PALETTE_PROMPT)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(COMMAND_PALETTE_PROMPT);
  });

  it("is anchored near the top, not centred", () => {
    render(<CommandPalette />);
    const classes = screen.getByRole("dialog").className.split(/\s+/);
    expect(classes).toContain("top-[20%]");
    expect(classes).toContain("translate-y-0");
    expect(classes).not.toContain("top-[50%]");
    expect(classes).not.toContain("translate-y-[-50%]");
  });

  it("finds every New-tab kind under Create when a session is open", async () => {
    useSessions.setState({ activeId: "s1" });
    const user = userEvent.setup();
    render(<CommandPalette />);
    await user.type(screen.getByPlaceholderText(COMMAND_PALETTE_PROMPT), "new");
    for (const name of ["New session", "New file tab", "New review tab", "New terminal", "New browser tab", "New drawing"]) {
      expect(screen.getByRole("option", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("Create")).toBeInTheDocument();
  });
});
