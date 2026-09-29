import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DesktopCadFailure } from "@renderer/features/explorer/adapters/cadRuntime";

it("a runtime failure's log line truncates with a shared hint, never a native title", () => {
  const onReady = vi.fn();
  render(<DesktopCadFailure answer={{ reason: "runtime-not-ready", message: "cadgen: not found", log: "/Users/me/Library/Logs/text-to-cad/cad-runtime.log" } as never}
    onReady={onReady} reload={() => {}} />);
  const log = screen.getByText(/^Log:/).closest("p")!;
  expect(log.hasAttribute("title")).toBe(false);
  expect(log.getAttribute("data-slot")).toBe("tooltip-trigger");
  expect(onReady).toHaveBeenCalledWith(false);
});

it("a file whose project is gone says how to get it back and can try again", async () => {
  const reload = vi.fn();
  render(<DesktopCadFailure answer={{ origin: null, reason: "no-project" } as never} onReady={() => {}} reload={reload} />);
  expect(screen.getByText("Select a session in this folder to render its files.")).toBeInTheDocument();
  screen.getByRole("button", { name: "Try again" }).click();
  expect(reload).toHaveBeenCalledTimes(1);
});
