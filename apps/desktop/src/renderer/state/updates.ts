import { toast } from "sonner";
import { create } from "zustand";

import type { UpdateStatus } from "@shared/ipc/app";

/**
 * The updater's state, mirrored from main (P8).
 *
 * Main is the authority: it holds the electron-updater instance, checks on a
 * timer, and pushes `app.updateStatus` on every transition. This store is the
 * cache the About page renders, plus the three verbs. `busy` covers the gap
 * between pressing a button and the first push, which is otherwise a button
 * that looks like it did nothing.
 */
type UpdatesState = {
  status: UpdateStatus;
  busy: boolean;
  load: () => Promise<void>;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  /** Applied by the `app.updateStatus` subscription in `subscribeToMain`. */
  receive: (status: UpdateStatus) => void;
};

export const useUpdates = create<UpdatesState>((set) => {
  // A rejected IPC call is the updater being unreachable, not a state main
  // pushed: say so on the row the way a refused answer would, and in a toast.
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    set({ status: { state: "error", message } });
    toast.error("Could not reach the updater", { description: message });
  };

  const run = async (action: () => Promise<UpdateStatus>) => {
    set({ busy: true });
    try {
      set({ status: await action() });
    } catch (error) {
      fail(error);
    } finally {
      set({ busy: false });
    }
  };

  return {
    // Development builds never leave this state, which is the honest answer
    // there: there is no feed to ask.
    status: { state: "unsupported" },
    busy: false,

    load: async () => {
      try {
        set({ status: await window.textToCad.app.updateStatus() });
      } catch (error) {
        fail(error);
      }
    },

    check: () => run(() => window.textToCad.app.checkForUpdates()),

    // Resolves when the download finishes; the progress in between arrives as
    // pushes, which is why this store is not just a promise.
    download: () => run(() => window.textToCad.app.downloadUpdate()),

    install: () => window.textToCad.app.installUpdate(),

    receive: (status) => set({ status }),
  };
});
