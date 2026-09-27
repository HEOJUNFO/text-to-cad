import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { cn } from "@hardcore/ui/utils";
import { ScrollArea } from "@hardcore/ui/primitives/scroll-area";
import { FLOATING_CHROME_SURFACE_CLASS } from "./floatingSurface.js";
import { ToolStackContext } from "./ToolStack.jsx";
import { TOOL_PANEL_MIN_HEIGHT, clampToolPanelHeight } from "./toolStackLayout.js";

/**
 * How a panel of the tool stack answers a viewer too short for every panel at its height
 * (`RendererShell.jsx` bounds the stack by the viewer). A `"fixed"` panel keeps its height. A
 * `"tree"` panel gives way first and scrolls inside itself; a `"details"` panel gives way once the
 * tree has. On mobile a tree takes at most 40% of the stack's height, however tall it is.
 * The shrink factors are orders of magnitude apart, so the tree absorbs nearly all of the
 * overflow until it reaches its floor and a fixed panel never scrolls a few pixels meanwhile.
 */
const FIT = Object.freeze({
  fixed: "shrink-0",
  tree: "shrink-[100000]",
  details: "shrink",
});
// How far a panel gives way before the next one does: never below its content's own height (a
// panel is never taller than what it holds, so a short one keeps no empty space), and otherwise
// room for its first row and a few more.
const FLOOR = Object.freeze({ tree: 128, details: 96 });
const KEY_NUDGE_PX = 16;
/** A panel header's small icon button: the chevron, the X, and a tool's mode menu (`ToolModeMenu.jsx`). */
/**
 * Every panel's heading text: the size and weight of the Display panel's section headings
 * (`FILE_SHEET_SECTION_HEADING_CLASSES`, 11px), so every heading in the stack reads alike.
 */
export const TOOL_PANEL_HEADING_TEXT_CLASS = "text-tiny font-normal leading-4 text-foreground";

export const TOOL_PANEL_BUTTON_CLASS = "flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45";

const ToolPanelContext = createContext(null);

function CollapseButton({ panel, className }) {
  return <button type="button" aria-label={`${panel.collapsed ? "Expand" : "Collapse"} ${panel.label.toLowerCase()}`} aria-expanded={!panel.collapsed}
    data-tool-panel-collapse="" className={cn(TOOL_PANEL_BUTTON_CLASS, className)} onClick={panel.toggle}>
    {/* Down to open a folded panel, up to fold an open one. */}
    {panel.collapsed ? <ChevronDown className="size-3" aria-hidden="true" data-chevron="down" /> : <ChevronUp className="size-3" aria-hidden="true" data-chevron="up" />}
  </button>;
}

/**
 * The chevron that folds the panel it is drawn in to its first row, for a panel whose first row
 * is its content's own: a tree's filter row, Display's first heading, a set of joints' Pose row.
 * Drawn anywhere inside a collapsible `ToolPanel`, at that row's trailing end; nothing outside one.
 */
export function ToolPanelCollapse({ className }) {
  const panel = useContext(ToolPanelContext);
  const place = panel?.place;
  useLayoutEffect(() => place?.(), [place]);
  return panel ? <CollapseButton panel={panel} className={className} /> : null;
}

/**
 * One panel of the tool stack under the strip: a kept effect's controls, or what the tool in
 * hand shows (a model tree and the Reference for a selection, a set of joints). Every panel is
 * the stack's one width, on the stack's translucent surface, and exactly its content's height —
 * up to its cap, if it has one — never padded to a minimum.
 *
 * A panel folds to its first row and unfolds again, by a chevron at that row's trailing end
 * (down to open, up to fold); folded content stays mounted and keeps working, so a tree keeps its
 * expansion, filter and scroll. `collapsible={false}` for a panel with nothing to fold away (a
 * row of buttons). A panel's first row is, in order: its heading (`title`, with a `summary`, the chevron and
 * an X when it has something to remove); its `header` (a tree's filter, which carries a
 * `ToolPanelCollapse`); or its content's own first row, which carries one too. Folded, a panel
 * without a heading or a header shows its `name` beside the chevron. Which panels are folded is
 * the person's (`ToolStack.jsx`), by `id`, across files.
 *
 * `sizable`: the panel's cap is the person's to set, by a handle on its bottom edge (pointer or
 * keyboard), written back once on release under its `id` ("tree", "reference"); until then it
 * opens at the stack's default for that id. A cap is never a floor: a short tree is its rows. The
 * handle stays on a folded panel's edge: pulling it down opens the panel at the height it is
 * pulled to, one gesture and one write (ArrowDown or End does the same from the keyboard).
 *
 * `hidden` keeps a panel mounted while its tool is not up, so a tree keeps its expansion,
 * filter and scroll across a trip to another tool. `header` never scrolls; the body under it
 * does, for a panel that gives way.
 *
 * @param {{ id: string, title?: import("react").ReactNode, name?: string, label: string, summary?: import("react").ReactNode,
 *   actions?: import("react").ReactNode,
 *   header?: import("react").ReactNode, collapsible?: boolean, onClose?: (() => void) | null, closeLabel?: string,
 *   fit?: "fixed" | "tree" | "details", sizable?: boolean, hidden?: boolean, defaultCollapsed?: boolean,
 *   children?: import("react").ReactNode }} props
 *   `label` names the panel for assistive technology ("Clip controls"), with a heading or
 *   without; the chevron, the X and the height handle take their names from it, unless the X says
 *   what it does itself (`closeLabel`, "Clear selection").
 */
export default function ToolPanel({ id, title = null, name = "", label, summary = null, actions = null, header = null, collapsible = true, onClose = null, closeLabel = "",
  fit = "fixed", sizable = false, hidden = false, defaultCollapsed = false, children }) {
  const stack = useContext(ToolStackContext);
  const kept = Boolean(stack && id);
  // Folded: the person's, kept by the stack across files; a panel drawn alone keeps its own.
  const [ownCollapsed, setOwnCollapsed] = useState(defaultCollapsed);
  const collapsed = collapsible && (kept ? stack.collapsed(id, defaultCollapsed) : ownCollapsed);
  // The cap: dragged (`draft`), then as the person left it, then the stack's default for this id.
  const [draft, setDraft] = useState(null);
  const [ownHeight, setOwnHeight] = useState(null);
  const capKey = sizable ? id : null;
  // One gesture's outcome, written once: a cap, a fold, or both (a folded panel dragged open).
  const settle = change => {
    setDraft(null);
    if (kept) { stack.settle(id, { ...change, fallback: defaultCollapsed }); return; }
    if (change.height !== undefined) setOwnHeight(change.height);
    if (change.collapsed !== undefined) setOwnCollapsed(change.collapsed);
  };
  const toggle = useCallback(() => {
    if (kept) stack.settle(id, { collapsed: !collapsed, fallback: defaultCollapsed }); else setOwnCollapsed(value => !value);
  }, [kept, stack, id, collapsed, defaultCollapsed]);
  // Whether the content carries the chevron in its own first row (`ToolPanelCollapse`).
  const [placed, setPlaced] = useState(0);
  const place = useCallback(() => { setPlaced(count => count + 1); return () => setPlaced(count => count - 1); }, []);
  const panel = useMemo(() => collapsible ? { collapsed, toggle, label, place } : null, [collapsible, collapsed, toggle, label, place]);
  // A folded panel being dragged open is drawn open, at the height it is dragged to.
  const folded = collapsed && draft === null;
  // While it is on screen and open, a panel a person sizes is one the stack's own bottom and
  // corner handles size too (`ToolStack.jsx`).
  const registerSizable = stack?.register;
  useEffect(() => (registerSizable && capKey && !hidden && !folded ? registerSizable(capKey) : undefined), [registerSizable, capKey, hidden, folded]);

  const section = useRef(null), body = useRef(null), content = useRef(null);
  const drag = useRef(null);
  const personal = capKey ? draft ?? (kept ? stack.height(capKey) : ownHeight) : null;
  const cap = capKey ? personal ?? stack?.defaultHeight(capKey) ?? null : null;
  const maxHeight = folded || cap === null ? undefined : `${cap}px`;
  const room = () => stack?.room() || Infinity;

  // The floor it gives way to: its content's own height when that is less (`FLOOR`).
  const floored = fit !== "fixed" && !folded && !hidden;
  const [natural, setNatural] = useState(null);
  useLayoutEffect(() => {
    if (!floored || !section.current || !body.current || !content.current) return undefined;
    const measure = () => setNatural(Math.ceil(section.current.offsetHeight - body.current.clientHeight + content.current.offsetHeight));
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(section.current);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [floored]);
  const minHeight = floored && natural !== null ? Math.min(natural, FLOOR[fit], cap === null ? Infinity : cap) : undefined;

  const stopDrag = event => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!current.moved) { setDraft(null); return; }
    // A folded panel opens only when it was pulled open; a nudge leaves it folded.
    if (current.folded) settle(current.opened ? { height: current.height, collapsed: false } : {});
    else settle({ height: current.height });
  };
  // What a nudge starts from: the height on screen, which is less than the cap for a short panel.
  const drawnHeight = () => Math.min(cap ?? Infinity, section.current?.getBoundingClientRect().height ?? Infinity);

  const heading = title ? <div className="flex min-h-7 shrink-0 items-center justify-end gap-0.5 pl-2 pr-1" data-tool-panel-heading="">
    <h3 className={cn("min-w-0 truncate", TOOL_PANEL_HEADING_TEXT_CLASS)}>{title}</h3>
    {summary ? <span className="ml-2 shrink-0 text-tiny text-muted-foreground">{summary}</span> : null}
    <span className="min-w-0 flex-1" aria-hidden="true" />
    {actions}
    {panel ? <CollapseButton panel={panel} /> : null}
    {onClose ? <button type="button" aria-label={closeLabel || `Close ${label.toLowerCase()}`}
      className={TOOL_PANEL_BUTTON_CLASS} onClick={onClose}><X className="size-3" aria-hidden="true" /></button> : null}
  </div>
    // No heading of its own: while its content's first row is out of sight (folded) or carries no
    // chevron, the panel's name stands in for it.
    : panel && (!placed || (folded && !header)) ? <div className="flex min-h-7 shrink-0 items-center gap-0.5 pl-2 pr-1" data-tool-panel-heading="">
      <h3 className={cn("min-w-0 flex-1 truncate", TOOL_PANEL_HEADING_TEXT_CLASS)}>{name || label}</h3>
      <CollapseButton panel={panel} />
    </div> : null;

  return <section ref={section} aria-label={label} hidden={hidden} data-tool-panel={fit} data-tool-panel-id={id || undefined}
    data-collapsed={folded ? "" : undefined}
    // Folded to a filter row, the row's rule under it has nothing under it to divide off.
    className={cn("pointer-events-auto relative flex w-full flex-col rounded-md text-tiny", FLOATING_CHROME_SURFACE_CLASS, folded ? "shrink-0" : FIT[fit],
      "data-[collapsed]:[&_[data-slot=tree-filter]]:shadow-none")}
    style={{ maxHeight, minHeight }}>
    <ToolPanelContext.Provider value={panel}>
      {heading}
      {/* Typing into a folded panel's filter opens it: what the filter finds is in the body. The
          keystroke is the filter's first — it lands as it would in an open panel — and the panel
          opens once it has: opening writes the viewer's preferences, whose store re-renders at once,
          and doing that mid-keystroke would put the box back to what it held before the key. */}
      {header ? <div className="contents" onInput={event => {
        if (!folded || !(event.target instanceof HTMLInputElement) || !event.target.value) return;
        queueMicrotask(() => { if (kept) stack.settle(id, { collapsed: false, fallback: defaultCollapsed }); else setOwnCollapsed(false); });
      }}>{header}</div> : null}
      {/* A panel that gives way scrolls in the chrome's one scroll region; a fixed one never scrolls. */}
      {fit === "fixed" ? <div ref={body} hidden={folded} data-tool-panel-body="" className="min-w-0 overflow-x-clip rounded-b-md">
        <div ref={content} className="flow-root">{children}</div>
      </div> : <ScrollArea hidden={folded} className="min-w-0 flex-1 rounded-b-md" viewportRef={body} viewportProps={{ "data-tool-panel-body": "" }}>
        <div ref={content} className="flow-root">{children}</div>
      </ScrollArea>}
    </ToolPanelContext.Provider>
    {/* Folded or not: pulling a folded panel's edge down opens it at the height it is pulled to. */}
    {capKey ? <div role="separator" tabIndex={0} aria-label={`Resize ${label.toLowerCase()}`} aria-orientation="horizontal"
      data-tool-panel-height-handle="" data-dragging={draft === null ? undefined : ""}
      aria-valuemin={TOOL_PANEL_MIN_HEIGHT} aria-valuenow={clampToolPanelHeight(folded ? section.current?.getBoundingClientRect().height ?? 0 : cap, room())}
      className="pointer-events-auto absolute -inset-x-px top-full z-10 h-2 -translate-y-1/2 cursor-row-resize touch-none rounded-full outline-none before:absolute before:inset-x-1 before:top-1/2 before:h-0.5 before:-translate-y-1/2 before:rounded-full before:bg-transparent focus-visible:before:bg-ring"
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { pointerId: event.pointerId, y: event.clientY, from: section.current.getBoundingClientRect().height,
          folded: collapsed, height: null, moved: false, opened: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (current?.pointerId !== event.pointerId) return;
        const pulled = event.clientY - current.y;
        current.moved = true;
        current.opened = pulled > KEY_NUDGE_PX / 2;
        // A folded panel stays folded until it is pulled open.
        if (current.folded && !current.opened) { setDraft(null); return; }
        current.height = clampToolPanelHeight(current.from + pulled, room());
        setDraft(current.height);
      }}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onKeyDown={event => {
        if (collapsed) {
          // Folded: down opens it — at its cap, or (End) as tall as the stack allows.
          if (event.key !== "ArrowDown" && event.key !== "End") return;
          event.preventDefault();
          settle(event.key === "End" ? { collapsed: false, height: clampToolPanelHeight(Infinity, room()) } : { collapsed: false });
          return;
        }
        const from = drawnHeight();
        const next = { ArrowUp: from - KEY_NUDGE_PX, ArrowDown: from + KEY_NUDGE_PX, Home: TOOL_PANEL_MIN_HEIGHT, End: Infinity }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        settle({ height: clampToolPanelHeight(next, room()) });
      }} /> : null}
  </section>;
}
