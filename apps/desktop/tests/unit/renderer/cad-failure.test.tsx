import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { expect, it, vi } from "vitest";
import { DesktopCadFailure } from "@renderer/features/explorer/adapters/cadRuntime";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

it("a runtime failure offers to reveal its log instead of printing the path", async () => {
  const user = userEvent.setup();
  const onReady = vi.fn();
  const log = "/Users/me/Library/Logs/text-to-cad/cad-runtime.log";
  render(<DesktopCadFailure answer={{ reason: "runtime-not-ready", message: "cadgen: not found", log } as never}
    onReady={onReady} reload={() => {}} />);
  expect(screen.queryByText(/^Log:/)).toBeNull();
  expect(screen.queryByText(log)).toBeNull();
  const reveal = vi.mocked(window.textToCad.runtime.revealLog);
  reveal.mockResolvedValueOnce({ revealed: true });
  await user.click(screen.getByRole("button", { name: "Reveal log" }));
  expect(reveal).toHaveBeenCalledTimes(1);
  expect(toast.error).not.toHaveBeenCalled();
  // The file is gone by the time it is asked for: say so.
  reveal.mockResolvedValueOnce({ revealed: false });
  await user.click(screen.getByRole("button", { name: "Reveal log" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("There is no runtime log yet."));
  expect(onReady).toHaveBeenCalledWith(false);
});

it("no log, no Reveal log button", () => {
  render(<DesktopCadFailure answer={{ reason: "runtime-not-ready", message: "cadgen: not found" } as never}
    onReady={() => {}} reload={() => {}} />);
  expect(screen.queryByRole("button", { name: "Reveal log" })).toBeNull();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
});

it("a file whose project is gone says how to get it back and can try again", async () => {
  const reload = vi.fn();
  render(<DesktopCadFailure answer={{ origin: null, reason: "no-project" } as never} onReady={() => {}} reload={reload} />);
  expect(screen.getByText("Select a session in this folder to render its files.")).toBeInTheDocument();
  screen.getByRole("button", { name: "Try again" }).click();
  expect(reload).toHaveBeenCalledTimes(1);
});
