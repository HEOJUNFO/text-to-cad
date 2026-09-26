/**
 * The surfaces of everything that floats over the model, defined here once so they cannot drift
 * apart; a caller adds layout, never a surface of its own. Both are translucent and blurred, so the
 * model reads through without the text losing to it, with a border that keeps the edge on a light
 * scene and a dark one alike.
 *
 * `FLOATING_SURFACE_CLASS`: the tool strip, and the popovers and menus opened over the viewport (the
 * viewport's context menu, fullscreen's settings) — small, and read while they are up.
 * `FLOATING_PANEL_SURFACE_CLASS`: each panel of the tool stack, which stays up beside the model
 * for as long as its tool does, so more of the model shows through it: the same blur and border
 * over a lighter background.
 */
export const FLOATING_SURFACE_CLASS = "border border-border bg-background/75 text-foreground shadow-sm backdrop-blur-md";
export const FLOATING_PANEL_SURFACE_CLASS = "border border-border bg-background/55 text-foreground shadow-sm backdrop-blur-md";
