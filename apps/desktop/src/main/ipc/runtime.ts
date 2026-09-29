/**
 * `runtime.*` handlers: the CAD runtime (src/main/cad/runtime.ts).
 *
 * `status` probes the resolved interpreter once and remembers the answer;
 * `repair` forgets it and probes again — there is nothing to install, the
 * runtime ships inside the app — and both broadcast `runtime.status` so the
 * About page and an open CAD tab agree afterwards. `revealLog` shows the
 * runtime log in the file manager — main's own path, never the renderer's.
 */
import { existsSync } from "node:fs";
import { app, shell } from "electron";
import type { IpcHandlers } from "../../shared/ipc";
import type { runtimeContract } from "../../shared/ipc/runtime";
import { cadRuntime } from "../cad";
import { runtimeLogPath } from "../cad/runtime";
import { broadcast, type IpcContext } from "./register";

export const runtimeHandlers = {
  runtime: {
    status: () => cadRuntime().status(),
    repair: async () => {
      const status = await cadRuntime().repair();
      broadcast("runtime.status", status);
      return status;
    },
    revealLog: () => revealRuntimeLog(),
  },
} satisfies IpcHandlers<typeof runtimeContract, IpcContext>;

/** Reveals `userData/cad-runtime.log` when it exists; answers whether it did. */
export function revealRuntimeLog(): { revealed: boolean } {
  const log = runtimeLogPath(app.getPath("userData"));
  if (!existsSync(log)) {
    return { revealed: false };
  }
  shell.showItemInFolder(log);
  return { revealed: true };
}
