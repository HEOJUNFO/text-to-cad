/**
 * The native choosers open where they are told to only if there is a folder
 * there: a remembered default that has since been deleted is left off.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const showOpenDialog = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ canceled: true, filePaths: [] as string[] })));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog },
}));

import { dialogsHandlers } from "@main/ipc/dialogs";

const ctx = { event: {}, sender: {} } as never;

it("opens the directory chooser without a default path that no longer exists", async () => {
  await dialogsHandlers.dialogs.chooseDirectory({ defaultPath: join(tmpdir(), "text-to-cad-no-such-folder") }, ctx);
  expect(showOpenDialog.mock.calls[0]?.[0]).not.toHaveProperty("defaultPath", expect.any(String));
});

it("keeps a default path that exists", async () => {
  showOpenDialog.mockClear();
  await dialogsHandlers.dialogs.chooseDirectory({ defaultPath: tmpdir() }, ctx);
  expect(showOpenDialog.mock.calls[0]?.[0]).toHaveProperty("defaultPath", tmpdir());
});
