import { createContext, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ScrollArea } from "@hardcore/ui/primitives/scroll-area";
import { TOOL_STACK_MIN_WIDTH, clampToolStackWidth, normalizeToolStack, toolPanelDefaultHeight } from "./toolStackLayout.js";

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
  const commit = next => { setDraft(null); if (next !== width) onLayoutChange({ width: next }); };
  const stopDrag = event => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const next = drag.current.width;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    commit(next);
  };
  const { heights, collapsed } = layout;
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
    defaultHeight: key => toolPanelDefaultHeight(key, stackHeight),
    collapsed: (id, fallback) => collapsed[id] ?? fallback,
    settle,
    room: () => column.current?.clientHeight || 0,
  }), [mobile, heights, collapsed, stackHeight, settle]);
  return <div ref={column} hidden={hidden} data-cad-tool-stack="" className="min-h-0 max-w-full flex-1"
    style={{ width: `max(${TOOL_STACK_MIN_WIDTH}px, min(${shown}px, 50cqw))`, containerType: "size" }}>
    <div className="relative flex max-h-full min-h-0 flex-col">
      {/* The panels give way first (`ToolPanel.jsx`), in a column exactly the stack's height; if
          what cannot give way still does not fit, the column scrolls rather than being cut. The
          bottom inset leaves the last panel's height handle room below its edge. */}
      <ScrollArea className="min-h-0 flex-1" viewportProps={{ "data-tool-stack-scroller": "" }}>
        <div className="flex max-h-[100cqh] min-h-0 flex-col gap-2 pb-1">
          <ToolStackContext.Provider value={panels}>{children}</ToolStackContext.Provider>
        </div>
      </ScrollArea>
      <div role="separator" tabIndex={0} aria-label="Resize tool panels" aria-orientation="vertical" data-tool-stack-width-handle="" data-dragging={draft === null ? undefined : ""}
        aria-valuemin={TOOL_STACK_MIN_WIDTH} aria-valuemax={clampToolStackWidth(Infinity, viewerWidth())} aria-valuenow={clampToolStackWidth(shown, viewerWidth())}
        className="pointer-events-auto absolute inset-y-0 left-full z-10 w-2 -translate-x-1/2 cursor-col-resize touch-none rounded-full outline-none before:absolute before:inset-y-1 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:rounded-full before:bg-transparent hover:before:bg-ring active:before:bg-ring focus-visible:before:bg-ring data-[dragging]:before:bg-ring"
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = { pointerId: event.pointerId, left: event.currentTarget.parentElement.getBoundingClientRect().left, width: clampToolStackWidth(shown, viewerWidth()) };
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
          const current = clampToolStackWidth(shown, viewerWidth());
          const next = { ArrowLeft: current - KEY_NUDGE_PX, ArrowRight: current + KEY_NUDGE_PX, Home: TOOL_STACK_MIN_WIDTH, End: Infinity }[event.key];
          if (next === undefined) return;
          event.preventDefault();
          commit(clampToolStackWidth(next, viewerWidth()));
        }} />
    </div>
  </div>;
}
