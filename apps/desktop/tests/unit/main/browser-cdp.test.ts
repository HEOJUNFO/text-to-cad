/** The scoped CDP endpoint keeps download policy with the host, in both protocol spellings. */
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
vi.mock("electron", () => ({ WebContentsView: vi.fn(), app: {}, session: {} }));
import { ScopedBrowserCdp } from "@main/browser/cdp";
import type { BrowserService } from "@main/browser/service";

const scope = { sessionId: "session", projectId: "project", root: "/work" };
const sendCommand = vi.fn(async (method: string) => {
  if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "native-target" } };
  if (method === "Target.attachToTarget") return { sessionId: "native-session" };
  return {};
});
const contents = { isDestroyed: () => false, debugger: Object.assign(new EventEmitter(), { isAttached: () => true, attach: vi.fn(), sendCommand }) };
const service = {
  events: new EventEmitter(),
  metadata: () => ({ tabId: "tab", title: "Page", url: "https://example.com/" }),
  contents: () => contents,
  list: () => [{ tabId: "tab" }],
} as unknown as BrowserService;
const tabs = { open: vi.fn(), show: vi.fn(), close: vi.fn() };
let endpoint: ScopedBrowserCdp | undefined;
afterEach(async () => { await endpoint?.dispose(); });

it("refuses Page.setDownloadBehavior as well as Browser.setDownloadBehavior on an attached page", async () => {
  endpoint = new ScopedBrowserCdp(service, scope, tabs);
  const socket = new WebSocket(await endpoint.start());
  await new Promise(resolve => socket.once("open", resolve));
  let id = 0;
  const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>(resolve => {
    const message = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
    const listener = (bytes: Buffer) => { const reply = JSON.parse(bytes.toString()); if (reply.id === message.id) { socket.off("message", listener); resolve(reply); } };
    socket.on("message", listener);
    socket.send(JSON.stringify(message));
  });
  await call("Target.getTargets");
  const attached = await call("Target.attachToTarget", { targetId: "native-target", flatten: true });
  const sessionId = String(attached.result?.sessionId);
  const page = await call("Page.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp/anywhere" }, sessionId);
  expect(page.error?.message).toContain("Download policy");
  const browser = await call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp/anywhere" });
  expect(browser.error?.message).toContain("Download policy");
  expect(sendCommand.mock.calls.some(([method]) => String(method).endsWith("setDownloadBehavior"))).toBe(false);
  // Ordinary page commands still reach the owned page.
  expect((await call("Page.enable", {}, sessionId)).error).toBeUndefined();
  expect(sendCommand).toHaveBeenCalledWith("Page.enable", {}, "native-session");
  socket.close();
});
