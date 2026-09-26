// The tool stack's layout, a viewing preference of the person's rather than of a file: the host
// keeps it (`CadPreferences.toolStack`) and it holds across files. Three things, and nothing else:
//
//   width      the one width every panel under the strip is drawn at (one handle, on the stack's
//              right edge, moves it for all of them together);
//   heights    the tallest the tree, Position and Reference panels may grow, by the handle on each
//              one's bottom edge (a cap, never a floor: a panel is its content's height up to it);
//   collapsed  which panels are folded to their first row, by panel id.
//
// Importing this module has no environmental effects.

// The default width: a strip of five tools — each a 24px button (`size-6`,
// `primitives/toolbar-button.jsx`), 2px apart (`gap-0.5`), inside 4px of padding (`p-1`) and a 1px
// border (`FloatingToolBar.js`): 138px, whatever tools a file's own strip has.
const DEFAULT_TOOLS = 5, BUTTON_PX = 24, GAP_PX = 2, PADDING_PX = 4, BORDER_PX = 1;
export const TOOL_STACK_DEFAULT_WIDTH = DEFAULT_TOOLS * BUTTON_PX + (DEFAULT_TOOLS - 1) * GAP_PX + 2 * PADDING_PX + 2 * BORDER_PX;
// The narrowest a person can make it: a dense tree row still shows an icon and a few characters
// of its name under its row actions (it truncates).
export const TOOL_STACK_MIN_WIDTH = 128;
// The panels whose height a person sets, and what each opens at when they have not:
//   tree       the model tree, half the stack's own height — the viewer's less the strip above
//              it and the insets (`toolPanelDefaultHeight`);
//   position   a set of joints, the same;
//   reference  what is picked: a heading and a dozen compact rows, which a part's or a face's
//              facts and its material fit without scrolling.
export const TOOL_PANEL_HEIGHTS = Object.freeze(["tree", "position", "reference"]);
export const TOOL_PANEL_REFERENCE_DEFAULT_HEIGHT = 288;
// The shortest a person can drag a panel's cap: its first row and a row of content under it.
export const TOOL_PANEL_MIN_HEIGHT = 64;
export const TOOL_STACK_STORAGE_KEY = "cad-viewer:tool-stack:v1";
// A stored size is kept whatever the viewer it was chosen in; the widest any viewer draws the
// stack is half its own width (`clampToolStackWidth`), and no panel is ever taller than the stack.
const MAX_STORED_PX = 4000;
// Panel ids are short words (`ToolPanel.jsx`'s `id`); a record full of anything else is not ours.
const PANEL_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_COLLAPSED = 32;

export const DEFAULT_TOOL_STACK = Object.freeze({ width: TOOL_STACK_DEFAULT_WIDTH, heights: Object.freeze({}), collapsed: Object.freeze({}) });

const finite = value => typeof value === "number" && Number.isFinite(value);

/** A width the stack can be drawn at, from anything a store handed back: the default when it is no width. */
export function normalizeToolStackWidth(value) {
  return finite(value) ? Math.round(Math.min(MAX_STORED_PX, Math.max(TOOL_STACK_MIN_WIDTH, value))) : TOOL_STACK_DEFAULT_WIDTH;
}

/**
 * The layout the stack is drawn with, from anything a store handed back: a width, the heights of
 * the panels a person has set (the others are absent, and open at their default), and the panels
 * whose folded state differs from nothing at all (`true` folded, `false` unfolded against a
 * panel that starts folded).
 * @returns {{ width: number, heights: { tree?: number, position?: number, reference?: number }, collapsed: Record<string, boolean> }}
 */
export function normalizeToolStack(value) {
  const heights = {};
  for (const key of TOOL_PANEL_HEIGHTS) {
    const height = value?.heights?.[key];
    if (finite(height)) heights[key] = Math.round(Math.min(MAX_STORED_PX, Math.max(TOOL_PANEL_MIN_HEIGHT, height)));
  }
  const collapsed = {};
  const entries = value?.collapsed && typeof value.collapsed === "object" && !Array.isArray(value.collapsed) ? Object.entries(value.collapsed) : [];
  for (const [id, folded] of entries.slice(0, MAX_COLLAPSED)) if (PANEL_ID.test(id) && typeof folded === "boolean") collapsed[id] = folded;
  return { width: normalizeToolStackWidth(value?.width), heights, collapsed };
}

/** The width drawn in a viewer `viewerWidth` wide: never under the minimum, never over half the viewer. */
export function clampToolStackWidth(width, viewerWidth) {
  const widest = Math.max(TOOL_STACK_MIN_WIDTH, Math.floor(Number(viewerWidth) / 2) || TOOL_STACK_MIN_WIDTH);
  return Math.round(Math.min(widest, Math.max(TOOL_STACK_MIN_WIDTH, Number(width) || TOOL_STACK_MIN_WIDTH)));
}

/** A panel's cap in a stack `stackHeight` tall: never under the minimum, never over the stack. */
export function clampToolPanelHeight(height, stackHeight) {
  const tallest = Math.max(TOOL_PANEL_MIN_HEIGHT, Math.floor(Number(stackHeight)) || TOOL_PANEL_MIN_HEIGHT);
  return Math.round(Math.min(tallest, Math.max(TOOL_PANEL_MIN_HEIGHT, Number(height) || TOOL_PANEL_MIN_HEIGHT)));
}

/** What a sizable panel opens at in a stack `stackHeight` tall, before a person sets it. */
/**
 * The cap a panel opens with where a person has set none: the tree and Position, half the stack's
 * own height on desktop and all of it on a phone (where the tree starts folded, and gives way to
 * whatever joins it); the Reference, its own default.
 */
export function toolPanelDefaultHeight(key, stackHeight, mobile = false) {
  const height = Number(stackHeight) || 0;
  if (key === "tree" || key === "position") return Math.round(mobile ? height : height / 2) || TOOL_PANEL_REFERENCE_DEFAULT_HEIGHT;
  return TOOL_PANEL_REFERENCE_DEFAULT_HEIGHT;
}

export function readToolStack(storage) {
  try { return normalizeToolStack(JSON.parse(storage?.getItem(TOOL_STACK_STORAGE_KEY) || "null")); }
  catch { return normalizeToolStack(null); }
}

export function writeToolStack(storage, value) {
  try { storage?.setItem(TOOL_STACK_STORAGE_KEY, JSON.stringify(normalizeToolStack(value))); }
  catch { /* A blocked preference store must not stop the stack resizing for this session. */ }
}
