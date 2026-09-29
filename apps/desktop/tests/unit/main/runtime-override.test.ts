/**
 * Changing the CAD interpreter override re-probes and broadcasts the new
 * status, so About and a CAD tab's build-failure note stop quoting the old
 * interpreter's kernel.
 */
import { expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({ repair: vi.fn(), broadcast: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => "" }, BrowserWindow: {}, ipcMain: {}, shell: {} }));
vi.mock("@main/cad", () => ({ cadRuntime: () => ({ repair: calls.repair }) }));
vi.mock("@main/ipc/register", () => ({ broadcast: calls.broadcast }));
import { refreshRuntimeAfterOverride } from "@main/ipc/runtime";

test("probes afresh and tells every window the new interpreter's status", async () => {
  const fresh = { state: "ready", python: "/new/python", source: "override", cadgenVersion: "9.9.9", viewerBuilt: true, log: null };
  calls.repair.mockResolvedValue(fresh);
  expect(await refreshRuntimeAfterOverride()).toBe(fresh);
  expect(calls.repair).toHaveBeenCalledOnce();
  expect(calls.broadcast).toHaveBeenCalledWith("runtime.status", fresh);
});
