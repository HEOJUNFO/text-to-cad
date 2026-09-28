/**
 * Handlers for `telemetry.*` (src/shared/ipc/telemetry.ts).
 */
import type { IpcHandlers } from "../../shared/ipc";
import type { telemetryContract } from "../../shared/ipc/telemetry";
import { sentEvents, telemetryStatus } from "../telemetry";
import type { IpcContext } from "./register";

export const telemetryHandlers = {
  telemetry: {
    status: () => telemetryStatus(),
    log: () => ({ events: sentEvents() }),
  },
} satisfies IpcHandlers<typeof telemetryContract, IpcContext>;
