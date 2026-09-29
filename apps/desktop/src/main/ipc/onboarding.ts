/**
 * Handlers for `onboarding.*` (src/shared/ipc/onboarding.ts).
 */
import type { IpcHandlers } from "../../shared/ipc";
import type { onboardingContract } from "../../shared/ipc/onboarding";
import { projects } from "../db/repositories";
import { createSampleProject, onboardingEnabled } from "../onboarding";
import { IpcError, broadcast, type IpcContext } from "./register";

export const onboardingHandlers = {
  onboarding: {
    status: () => ({ enabled: onboardingEnabled() }),
    createSample: () => {
      try {
        const selected = projects.choose(createSampleProject());
        // The same selection the folder chooser makes: the renderer opens the
        // folder's new-session screen on this, not on anything it sends back.
        broadcast("ui.directorySelected", selected);
        return selected;
      } catch (error) {
        throw new IpcError(error instanceof Error ? error.message : String(error));
      }
    },
  },
} satisfies IpcHandlers<typeof onboardingContract, IpcContext>;
