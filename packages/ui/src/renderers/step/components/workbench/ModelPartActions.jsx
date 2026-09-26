import { TooltipHint } from "@hardcore/ui/primitives/tooltip";
import { Eye, EyeOff, Focus } from 'lucide-react';
import { Button } from '@hardcore/ui/primitives/button';
import { cn } from '@hardcore/ui/utils';

// A row's actions show on hover (or keyboard focus) and stay shown while they are ON: an
// isolated row keeps its lit Isolate, a hidden row its crossed-out eye, so what is isolated
// or hidden can be read down the tree without hovering. Isolate is an assembly's; a single
// part has nothing to isolate it from.
const REVEAL_ON_HOVER = 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100';

export default function ModelPartActions({ node, controls, disabled }) {
  const {focusedNodeIds=[], onTogglePartVisibility, onFocusTreeNode, onUnfocusTreeNode, isAssemblyView} = controls;
  const focused = focusedNodeIds.includes(node.selectionId);
  const hidden = node.leafPartIds?.length > 0 && node.leafPartIds.every(id => controls.hiddenPartIds?.includes(id));
  const canIsolate = isAssemblyView && typeof onFocusTreeNode === 'function';
  const isolateLabel = `${focused ? 'Exit isolate' : 'Isolate'} ${node.label}`;
  // The actions float over the row's right end rather than taking width from it: the name runs
  // the row's full width, and while an action shows, the name under the buttons alone is blurred
  // away — no tint and no fade beyond them, so the row reads in its own (hover) colour throughout.
  const persistent = focused || hidden;
  return <div data-row-actions="" className={cn(
    "absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-md pl-0.5 pr-1 backdrop-blur-sm transition-opacity",
    persistent ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 focus-within:opacity-100")}>
    {canIsolate && <TooltipHint content={focused ? "Exit isolate" : "Isolate"}><Button variant="ghost" size="icon-xs" disabled={disabled || hidden} aria-label={isolateLabel} aria-pressed={focused}
      className={cn('size-5', focused ? 'text-foreground' : cn('text-muted-foreground', REVEAL_ON_HOVER))}
      onClick={() => focused ? onUnfocusTreeNode?.(node.selectionId) : onFocusTreeNode(node.selectionId)}>
      <Focus className="size-3"/>
    </Button></TooltipHint>}
    <TooltipHint content={hidden ? "Reveal" : "Hide"}><Button variant="ghost" size="icon-xs" disabled={disabled || focused} aria-label={`${hidden ? 'Reveal' : 'Hide'} ${node.label}`}
      className={cn('size-5 text-muted-foreground', !hidden && REVEAL_ON_HOVER)}
      onClick={() => onTogglePartVisibility?.(node.selectionId)}>
      {hidden ? <EyeOff className="size-3"/> : <Eye className="size-3"/>}
    </Button></TooltipHint>
  </div>;
}
