/**
 * Where the keyboard goes when the person opens or picks an explorer tab.
 *
 * A tab's body mounts on many occasions the person did not ask for — a
 * session switch, Back, a theme change, the sidebar folding — and a body that
 * took focus on every mount (the terminal did) pulled the keyboard out of
 * whatever the person was in. So a body takes focus only when asked: the
 * person's own open or pick (a shortcut, the `+` menu, a click on its tab)
 * names the tab here, and a body that can take focus claims it once it can
 * (a terminal, when its shell is attached). A body that claims nothing — a
 * review, a browser, a file — leaves focus on its strip tab: one Tab from the
 * rest of the pane, never the page, where no key reaches anything.
 */

/**
 * The one body the strip controls. `ExplorerPane` renders it and `TabStrip`
 * names it; it is declared here so the three share it without a cycle.
 */
export const EXPLORER_TABPANEL_ID = "explorer-tabpanel";

/** The tab the person asked for, until its body claims it or another request replaces it. */
let wanted: string | null = null;
/** Bodies that will claim focus when they can, and are not ready yet. */
const claimants = new Set<string>();

/**
 * The person opened or picked `tabId`: its body takes focus, or its strip tab does.
 *
 * Two frames: one for the strip's render, one for the body's effects. A body
 * that is still getting ready to claim (a terminal whose shell is starting) is
 * left to claim when it is ready.
 */
export function focusTabBody(tabId: string): void {
  wanted = tabId;
  const settle = () => {
    if (wanted !== tabId) return;
    if (document.getElementById(EXPLORER_TABPANEL_ID)?.contains(document.activeElement)) {
      wanted = null;
      return;
    }
    if (claimants.has(tabId)) return;
    wanted = null;
    document.querySelector<HTMLElement>(`[data-tab-strip] [data-tab="${CSS.escape(tabId)}"]`)?.focus();
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(settle));
}

/**
 * A body that will take focus once it can: registered while it is mounted, so
 * the strip tab does not take focus it is about to claim. The return releases
 * it — an unmounted body claims nothing, and a request it never claimed must
 * not be claimed by the next mount of the same tab (a session switch back).
 */
export function holdFocusClaim(tabId: string): () => void {
  claimants.add(tabId);
  return () => {
    claimants.delete(tabId);
    if (wanted === tabId) wanted = null;
  };
}

/** True once, for the body of the tab the person asked for. */
export function claimFocus(tabId: string): boolean {
  if (wanted !== tabId) return false;
  wanted = null;
  return true;
}
