/**
 * Whether the app is on its way out. Set by `before-quit` (`./menu.ts`) and,
 * for an update, earlier by `before-quit-for-update` (`./updater.ts`): the
 * install's quit closes every window BEFORE it emits `before-quit`, so without
 * the early mark a window with an unsaved draft would ask Discard/Cancel — and
 * Cancel would strand the restart. Never set by merely asking to install: an
 * install that does not quit must leave the ask working.
 */
let quitting = false;

export function markQuitting(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}
