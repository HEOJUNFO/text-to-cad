/**
 * Where focus belongs in each pane, shared by the shell's F6 cycling and by whatever returns the
 * keyboard to the shell from a route of its own (Settings).
 */

/**
 * Where focus lands in a pane it has not been in yet: the sidebar's current
 * session, the composer, the explorer's strip tab — each pane's one stop
 * worth arriving at — else the pane's first control.
 */
export const PANE_HOMES: Record<"sidebar" | "session" | "explorer", string> = {
  sidebar: "[aria-current=page], [aria-current=true]",
  session: "[data-composer-input][contenteditable=true], [data-composer-input]:not([disabled])",
  explorer: '[role=tab][tabindex="0"]',
};

export const TABBABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [contenteditable=true], [tabindex]:not([tabindex="-1"])';

/**
 * Put focus where the session's work is: the composer, else the pane's first control. For a
 * route that just closed (Settings) whose button took its focus with it. The pane mounts in the
 * same commit, but its composer can arrive a frame later, so one retry.
 */
export function focusSessionHome(): void {
  const attempt = () => {
    const pane = document.getElementById("session");
    const target = pane?.querySelector<HTMLElement>(PANE_HOMES.session) ?? pane?.querySelector<HTMLElement>(TABBABLE);
    target?.focus();
    return Boolean(target);
  };
  if (!attempt()) window.requestAnimationFrame(attempt);
}
