/**
 * Whether the app is on its way out. Set by `before-quit` (`./menu.ts`) and,
 * earlier, by `installUpdate` (`./updater.ts`): Electron's
 * `autoUpdater.quitAndInstall` closes every window BEFORE it emits
 * `before-quit`, so without the early mark a window with an unsaved draft
 * would ask Discard/Cancel — and Cancel would strand the restart.
 */
let quitting = false;

export function markQuitting(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}
