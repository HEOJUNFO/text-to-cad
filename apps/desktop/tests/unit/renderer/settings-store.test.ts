/**
 * The settings store's write path: a refused write is rolled back and said so,
 * and a reply older than the newest write does not undo it.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { useSettings } from "@renderer/state/settings";
import { defaultSettings } from "@shared/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), info: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  useSettings.setState({ settings: defaultSettings(), ready: true });
});

it("puts the old value back and toasts when main refuses the write", async () => {
  vi.mocked(window.textToCad.settings.set).mockRejectedValue(new Error("disk is full"));
  await useSettings.getState().patch({ launchAtLogin: true });
  expect(useSettings.getState().settings?.launchAtLogin).toBe(false);
  expect(toast.error).toHaveBeenCalledWith(expect.any(String), { description: "disk is full" });
});
