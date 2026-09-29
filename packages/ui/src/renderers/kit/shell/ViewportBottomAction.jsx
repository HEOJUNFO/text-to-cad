import { Button } from "@text-to-cad/ui/primitives/button";
import { VIEWPORT_BOTTOM_CENTER } from "./viewportLayout.js";

/** One shared prompt action over the viewport, independent of renderer tools. */
export default function ViewportBottomAction({ disabled = false, reason, onInvoke }) {
  return <div style={{ bottom: VIEWPORT_BOTTOM_CENTER }}
    className="pointer-events-none absolute inset-x-4 z-20 flex justify-center translate-y-1/2"
    data-viewport-bottom-actions="">
    <Button type="button" variant="default" size="sm"
      className="pointer-events-auto h-11 border border-white bg-white px-5 text-sm text-neutral-950 shadow-lg shadow-black/20 hover:bg-white/90 focus-visible:ring-white/50"
      disabled={disabled} aria-description={disabled ? reason : undefined}
      onClick={() => void onInvoke?.()}>Add To Prompt</Button>
  </div>;
}
