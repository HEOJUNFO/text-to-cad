import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { useUpdates } from "@renderer/state/updates";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

type AppApi = Record<string, unknown>;
const app = () => window.textToCad.app as unknown as AppApi;

beforeEach(() => {
  useUpdates.setState({ status: { state: "idle" }, busy: false });
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  delete app().checkForUpdates;
  delete app().updateStatus;
});

describe("updates store", () => {
  it("a rejected check becomes an error status and a toast, not an unhandled rejection", async () => {
    app().checkForUpdates = vi.fn(async () => {
      throw new Error("ipc went away");
    });
    await expect(useUpdates.getState().check()).resolves.toBeUndefined();
    expect(useUpdates.getState().status).toEqual({ state: "error", message: "ipc went away" });
    expect(useUpdates.getState().busy).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("a rejected first read lands as an error status too", async () => {
    app().updateStatus = vi.fn(async () => {
      throw new Error("no handler");
    });
    await expect(useUpdates.getState().load()).resolves.toBeUndefined();
    expect(useUpdates.getState().status).toEqual({ state: "error", message: "no handler" });
  });
});
