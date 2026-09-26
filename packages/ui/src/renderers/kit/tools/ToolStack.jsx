import { createContext, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ScrollArea } from "@hardcore/ui/primitives/scroll-area";
import { TOOL_STACK_MIN_WIDTH, clampToolPanelHeight, clampToolStackWidth, normalizeToolStack, toolPanelDefaultHeight } from "./toolStackLayout.js";

const KEY_NUDGE_PX = 16;

/**
 * What a panel of the stack reads of it (`ToolPanel.jsx`): its cap and folded state as the
 * person left them, how to write either back, and the room it has. `null` outside a stack: a panel
 * drawn alone opens at its defaults and keeps its folded state to itself.
 * @type {import("react").Context<null | {
 *   mobile: boolean,
 *   height(key: string): number | null,
 *   defaultHeight(key: string): number,
 *   collapsed(id: string, fallback: boolean): boolean,
 *   settle(id: string, change: { height?: number, collapsed?: boolean, fallback?: boolean }): void,
 *   room(): number,
 * }>}
 */
export const ToolStackContext = createContext(null);

/**
 * The tool stack under the strip: one column, the height the viewer leaves it, in which each
 * panel (`ToolPanel.jsx`) takes its content's height — up to its cap, for a panel that has one —
 * until the column runs out. Every panel is the stack's one width. A handle ON the stack's right
 * edge (centred on it, so nothing sits beside the panels) widens or narrows all of them together —
 * from its minimum up to half the viewer — by pointer or by keyboard. The layout (`layout`: the
 * width, the caps a person dragged panels to, the folded panels) is the person's, and is written
 * back (`onLayoutChange`, a patch or a function of the layout as it stands) once a drag lets go,
 * never per pointer move.
 *
 * The column is a size container, so a panel can bound itself by the stack's height (`cqh`),
 * and its width reads the viewport's (`cqw`), so a narrow viewer never draws a stack wider than
 * half of it, whatever width is stored.
 *
 * @param {{ layout: { width: number, heights: object, collapsed: object },
 *   onLayoutChange(patch: object | ((layout: object) => object)): void, mobile?: boolean, hidden?: boolean,
 *   children?: import("react").ReactNode }} props
 */
export default function ToolStack({ layout: stored, onLayoutChange, mobile = false, hidden = false, children }) {
  const layout = useMemo(() => normalizeToolStack(stored), [stored]);
  const [draft, setDraft] = useState(null);
  const drag = useRef(null);
  const column = useRef(null);
  // The column's own height — the viewer's less the strip above it and the insets: a tree opens
  // at half of it.
  const [stackHeight, setStackHeight] = useState(0);
  const viewer = () => column.current?.closest("[data-cad-scene-backdrop]");
  useLayoutEffect(() => {
    const element = column.current;
    if (!element) return undefined;
    const measure = () => { if (element.clientHeight) setStackHeight(element.clientHeight); };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const viewerWidth = () => viewer()?.getBoundingClientRect().width || window.innerWidth;
  const width = layout.width;
  const shown = draft ?? width;
  // The width on screen, which a narrow viewer holds to half of it.
  const drawnWidth = () => Math.round(column.current?.getBoundingClientRect().width || shown);
  const commit = next => { setDraft(null); if (next !== width) onLayoutChange({ width: next }); };
  const stopDrag = event => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const next = drag.current.width;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    commit(next);
  };
  // The panels whose height a person sets (`sizable`), while they are on screen and open: the
  // stack's own bottom and corner handles size them all at once, each in proportion to its height.
  const [sizable, setSizable] = useState(() => new Set());
  const register = useCallback(key => {
    setSizable(current => new Set(current).add(key));
    return () => setSizable(current => { const next = new Set(current); next.delete(key); return next; });
  }, []);
  // While the bottom or corner handle is dragged: the caps it would leave, drawn at once.
  const [heightDraft, setHeightDraft] = useState(null);
  const heightDrag = useRef(null);
  const { heights: storedHeights, collapsed } = layout;
  const heights = heightDraft ? { ...storedHeights, ...heightDraft } : storedHeights;
  // What one gesture on a panel leaves — its cap, its folded state, or both at once (a folded
  // panel dragged open) — in one write. A panel folded as it starts is not written down: the
  // record holds only what differs.
  const settle = useCallback((id, change) => onLayoutChange(current => {
    const patch = {};
    if (change.height !== undefined) patch.heights = { ...current.heights, [id]: change.height };
    if (change.collapsed !== undefined) {
      const next = { ...current.collapsed };
      if (change.collapsed === Boolean(change.fallback)) delete next[id]; else next[id] = change.collapsed;
      patch.collapsed = next;
    }
    return patch;
  }), [onLayoutChange]);
  const panels = useMemo(() => ({
    mobile,
    height: key => heights[key] ?? null,
    defaultHeight: key => toolPanelDefaultHeight(key, stackHeight, mobile),
    collapsed: (id, fallback) => collapsed[id] ?? fallback,
    settle,
    register,
    room: () => column.current?.clientHeight || 0,
  }), [mobile, heights, collapsed, stackHeight, settle, register]);
  // Each sizable panel's height on screen as a drag starts; a drag scales them all by the same
  // factor, the total following the pointer, each within its own bounds.
  const startHeights = () => Object.fromEntries([...sizable].map(key => [key,
    column.current?.querySelector(`[data-tool-panel-id="${key}"]`)?.getBoundingClientRect().height || 0]).filter(([, height]) => height > 0));
  const scaled = (from, pulled) => {
    const total = Object.values(from).reduce((sum, height) => sum + height, 0);
    const factor = total > 0 ? Math.max(0, total + pulled) / total : 1;
    const room = column.current?.clientHeight || Infinity;
    return Object.fromEntries(Object.entries(from).map(([key, height]) => [key, clampToolPanelHeight(height * factor, room)]));
  };
  const commitHeights = next => { setHeightDraft(null); if (next && Object.keys(next).length) onLayoutChange(current => ({ heights: { ...current.heights, ...next } })); };
  const startResize = (event, { width: withWidth }) => {
    if (event.button !== 0) return;
    event.preventDefault();
    heightDrag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, from: startHeights(), heights: null,
      width: withWidth ? { left: column.current.getBoundingClientRect().left, value: null } : null };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = event => {
    const current = heightDrag.current;
    if (current?.pointerId !== event.pointerId) return;
    current.heights = scaled(current.from, event.clientY - current.y);
    setHeightDraft(current.heights);
    if (current.width) { current.width.value = clampToolStackWidth(event.clientX - current.width.left, viewerWidth()); setDraft(current.width.value); }
  };
  const stopResize = event => {
    const current = heightDrag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    heightDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // One write for the whole gesture: the caps and, from the corner, the width with them.
    setHeightDraft(null);
    setDraft(null);
    const heights = current.heights && Object.keys(current.heights).length ? current.heights : null;
    const nextWidth = current.width ? current.width.value ?? drawnWidth() : null;
    if (!heights && (nextWidth === null || nextWidth === width)) return;
    onLayoutChange(layout => ({
      ...(heights ? { heights: { ...layout.heights, ...heights } } : {}),
      ...(nextWidth !== null && nextWidth !== width ? { width: nextWidth } : {}),
    }));
  };
  const resizable = sizable.size > 0;
  return <div ref={column} hidden={hidden} data-cad-tool-stack="" className="min-h-0 max-w-full flex-1"
    style={{ width: `max(${TOOL_STACK_MIN_WIDTH}px, min(${shown}px, 50cqw))`, containerType: "size" }}>
    <div className="relative flex max-h-full min-h-0 flex-col">
      {/* The panels give way first (`ToolPanel.jsx`), in a column exactly the stack's height; if
          what cannot give way still does not fit, the column scrolls rather than being cut. The
          bottom inset leaves the last panel's height handle room below its edge, clear of the
          stack's own bottom handle under it. */}
      <ScrollArea className="min-h-0 flex-1" viewportProps={{ "data-tool-stack-scroller": "" }}>
        <div className="flex max-h-[100cqh] min-h-0 flex-col gap-2 pb-3">
          <ToolStackContext.Provider value={panels}>{children}</ToolStackContext.Provider>
        </div>
      </ScrollArea>
      <div role="separator" tabIndex={0} aria-label="Resize tool panels" aria-orientation="vertical" data-tool-stack-width-handle="" data-dragging={draft === null ? undefined : ""}
        aria-valuemin={TOOL_STACK_MIN_WIDTH} aria-valuemax={clampToolStackWidth(Infinity, viewerWidth())} aria-valuenow={clampToolStackWidth(drawnWidth(), viewerWidth())}
        className="pointer-events-auto absolute inset-y-0 left-full z-10 w-2 -translate-x-1/2 cursor-col-resize touch-none rounded-full outline-none before:absolute before:inset-y-1 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:rounded-full before:bg-transparent focus-visible:before:bg-ring"
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = { pointerId: event.pointerId, left: event.currentTarget.parentElement.getBoundingClientRect().left, width: clampToolStackWidth(drawnWidth(), viewerWidth()) };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current.width = clampToolStackWidth(event.clientX - drag.current.left, viewerWidth());
          setDraft(drag.current.width);
        }}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onKeyDown={event => {
          const current = clampToolStackWidth(drawnWidth(), viewerWidth());
          const next = { ArrowLeft: current - KEY_NUDGE_PX, ArrowRight: current + KEY_NUDGE_PX, Home: TOOL_STACK_MIN_WIDTH, End: Infinity }[event.key];
          if (next === undefined) return;
          event.preventDefault();
          commit(clampToolStackWidth(next, viewerWidth()));
        }} />
      {/* The stack's foot and corner: every panel a person sizes, taller or shorter together, in
          proportion; the corner widens the stack too. Only while one of them is on screen and open.
          Like every handle here, a cursor and nothing drawn (a focus ring for the keyboard). */}
      {resizable ? <>
        <div role="separator" tabIndex={0} aria-label="Resize tool panel heights" aria-orientation="horizontal" data-tool-stack-height-handle=""
          data-dragging={heightDraft === null ? undefined : ""}
          className="pointer-events-auto absolute -inset-x-px bottom-0 z-10 h-2 cursor-row-resize touch-none rounded-full outline-none before:absolute before:inset-x-1 before:top-1/2 before:h-0.5 before:-translate-y-1/2 before:rounded-full before:bg-transparent focus-visible:before:bg-ring"
          onPointerDown={event => startResize(event, { width: false })} onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize}
          onKeyDown={event => {
            const step = { ArrowUp: -KEY_NUDGE_PX, ArrowDown: KEY_NUDGE_PX }[event.key];
            if (step === undefined) return;
            event.preventDefault();
            commitHeights(scaled(startHeights(), step));
          }} />
        <div aria-hidden="true" data-tool-stack-corner-handle=""
          className="pointer-events-auto absolute bottom-0 left-full z-20 size-3 -translate-x-1/2 cursor-nwse-resize touch-none"
          onPointerDown={event => startResize(event, { width: true })} onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize} />
      </> : null}
    </div>
  </div>;
}
