import { useViewerMobile } from "../../../file-viewer/responsive.js";
import { VIEWPORT_BOTTOM_CENTER } from "./viewportLayout.js";
import { useLayoutEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { Button } from "@text-to-cad/ui/primitives/button";
import { TooltipHint } from "@text-to-cad/ui/primitives/tooltip";
import { cn } from "@text-to-cad/ui/utils";

const ACTION_CLASS = "pointer-events-auto border border-white bg-white text-neutral-950 shadow-lg shadow-black/20 hover:bg-white/90 focus-visible:ring-white/50";
const METRICS_CLASS = "h-11 w-fit min-w-0 max-w-full shrink overflow-hidden px-5 text-sm";

/**
 * The viewport's bottom action row, centred over the shared bottom inset. The
 * active tool's action and any contributed action precede its snapshot button.
 *
 * `shortLabel` is what the button says when `label` does not FIT — a label cut off
 * mid-token reads like a broken name rather than a long one, so a long one is
 * replaced outright ("Copy 3 references"). Whether it fits depends on the
 * viewport, not on the string, so it is measured rather than guessed from a
 * length: a hidden ruler carries the full label under the button's own width
 * constraints. The ruler is deliberately independent of what the button is
 * currently showing — measuring the visible label would latch, because swapping in
 * the shorter one makes the long one fit again. The full label remains accessible.
 *
 * `render` replaces the button itself for an action that is not a plain press (a
 * host's prompt action, which opens its own destination): it is given the classes,
 * the disabled state and the label node. `children` may be a render function that
 * receives those same classes for a contributed action.
 */
export default function ViewportBottomAction({
  label = null, shortLabel = "", disabled = false, onInvoke, render = null, children = null, shortcut = "", snapshot = null
}) {
  const mobile = useViewerMobile();
  const rowRef = useRef(null);
  const rulerRef = useRef(null);
  const extrasRef = useRef(null);
  const snapshotRef = useRef(null);
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const ruler = rulerRef.current;
    const row = rowRef.current;
    if (!ruler || !row) return undefined;
    // +1 so sub-pixel rounding does not read as an overflow.
    const measure = () => {
      const companions = Number(Boolean(children)) + Number(Boolean(snapshot));
      const available = row.clientWidth - (extrasRef.current?.offsetWidth || 0)
        - (snapshotRef.current?.offsetWidth || 0) - companions * 8;
      setFits(ruler.scrollWidth + (mobile ? 32 : 40) <= available + 1);
    };
    measure();
    // Belt and braces: ResizeObserver is the precise signal but is not always
    // delivered promptly while the document is not being painted, and a window
    // resize is the case that actually changes the answer.
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(row);
    if (extrasRef.current) observer?.observe(extrasRef.current);
    if (snapshotRef.current) observer?.observe(snapshotRef.current);
    return () => { window.removeEventListener("resize", measure); observer?.disconnect(); };
  }, [label, shortLabel, children, snapshot]);

  const metrics = cn(METRICS_CLASS, mobile && "h-10 px-4");
  const shown = shortLabel && !fits ? shortLabel : label;
  const content = <><span className="block min-w-0 max-w-full truncate">{shown}</span>{shortcut && !mobile ? <kbd className="ml-3 shrink-0 font-sans text-xs opacity-65">{shortcut}</kbd> : null}</>;
  const className = cn(ACTION_CLASS, metrics);
  return (
    <div ref={rowRef} style={{ bottom: VIEWPORT_BOTTOM_CENTER }} className="pointer-events-none absolute inset-x-4 z-20 translate-y-1/2 flex min-w-0 justify-center gap-2" data-viewport-bottom-actions="">
      {shortLabel ? (
        <span aria-hidden="true" className={cn("pointer-events-none invisible absolute left-0 top-0", metrics)}>
          <span ref={rulerRef} className="block whitespace-nowrap">{label}</span>
        </span>
      ) : null}
      {label && (render
        ? render({ className, disabled, children: content })
        : <Button type="button" variant="default" size="sm" className={className} aria-label={shortLabel && !fits ? label : undefined}
            disabled={disabled} onClick={() => void onInvoke?.()} >{content}</Button>)}
      {children ? <div ref={extrasRef} className="pointer-events-auto shrink-0">{typeof children === "function" ? children(className) : children}</div> : null}
      {snapshot ? <div ref={snapshotRef} className="pointer-events-auto shrink-0"><SnapshotButton snapshot={snapshot} mobile={mobile} /></div> : null}
    </div>
  );
}

/** The same camera action in the regular bottom row and preview's playbar. */
export function SnapshotButton({ snapshot, mobile = false }) {
  if (!snapshot) return null;
  return <TooltipHint content="Snapshot"><Button type="button" variant="default" size="icon" className={cn(ACTION_CLASS, "size-11 p-0", mobile && "size-10")}
    aria-label="Take snapshot" disabled={snapshot.disabled} onClick={() => void snapshot.onInvoke?.()}><Camera className="size-4" aria-hidden="true" /></Button></TooltipHint>;
}

/** Draw's bottom action: the view with its ink, to the clipboard. */
export function drawingCaptureAction({ disabled = false, onInvoke }) {
  return {
    label: "Copy Drawing",
    disabled, onInvoke
  };
}
