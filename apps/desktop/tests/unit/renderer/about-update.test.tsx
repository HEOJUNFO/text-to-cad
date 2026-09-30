import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TooltipProvider } from "@text-to-cad/ui/primitives/tooltip";
import { AboutPage } from "@renderer/features/settings/pages/AboutPage";
import { useSettings } from "@renderer/state/settings";
import { useUpdates } from "@renderer/state/updates";
import { defaultSettings } from "@shared/types";

/** Settings › About › Software update: the one row the updater's state draws. */
type AppApi = Record<string, unknown>;
const app = () => window.textToCad.app as unknown as AppApi;

beforeEach(() => {
  useSettings.setState({ settings: defaultSettings(), ready: true });
  useUpdates.setState({ status: { state: "downloaded", version: "2.0.0" }, busy: false });
});

afterEach(() => {
  delete app().installUpdate;
});

function renderAbout() {
  return render(<TooltipProvider><AboutPage /></TooltipProvider>);
}

describe("About › Software update", () => {
  it("Restart goes disabled on the first press, so a second press never reaches main", async () => {
    const installUpdate = vi.fn(() => new Promise<void>(() => undefined));
    app().installUpdate = installUpdate;
    renderAbout();
    const restart = screen.getByRole("button", { name: /Restart/ });
    await userEvent.click(restart);
    await waitFor(() => expect(restart).toBeDisabled());
    await userEvent.click(restart);
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(restart).toHaveTextContent("Restarting…");
  });

  it("a failing install lands as an error status instead of an unhandled rejection", async () => {
    app().installUpdate = vi.fn(async () => {
      throw new Error("ipc went away");
    });
    renderAbout();
    await userEvent.click(screen.getByRole("button", { name: /Restart/ }));
    expect(await screen.findByText("ipc went away")).toBeInTheDocument();
    expect(useUpdates.getState().busy).toBe(false);
  });

  it("clamps a long error to a line's worth", () => {
    useUpdates.setState({ status: { state: "error", message: "e".repeat(500) } });
    renderAbout();
    const text = screen.getByText(/^e+…$/).textContent ?? "";
    expect(text.length).toBeLessThanOrEqual(160);
  });
});
