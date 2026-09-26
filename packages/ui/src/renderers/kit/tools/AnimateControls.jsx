import {
  DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger
} from "@hardcore/ui/primitives/dropdown-menu";
import { cn } from "@hardcore/ui/utils";
import { FileSheetSelectRow } from "../inspector/FileSheet.js";
import { AnimationTransport, PLAYBACK_SPEEDS } from "./playbar/ViewportAnimationBar.js";
import { FLOATING_SURFACE_CLASS } from "./floatingSurface.js";
import { ToolSettingsMenu } from "./ToolModeMenu.jsx";

// A compact dropdown: the height and text of the value boxes beside it, hugging its value.
const COMPACT_TRIGGER = "!h-6 w-auto gap-1 !px-1.5 text-tiny";

/**
 * The Animate panel's settings, in its heading beside the fold chevron as Select's and Measure's
 * are: the sliders button, whose dropdown holds Speed — a submenu of the playback speeds, the one
 * in hand beside its name — then Autoplay (whether taking up Animate starts the routine, the
 * person's across files) and Loop. Ticking a checkbox leaves the menu open.
 */
export function AnimateSettingsMenu({ animation, autoplay, onAutoplayChange }) {
  const speed = Number(animation?.speed) || 1;
  const speeds = PLAYBACK_SPEEDS.includes(speed) ? PLAYBACK_SPEEDS : [...PLAYBACK_SPEEDS, speed].sort((a, b) => a - b);
  return <ToolSettingsMenu label="Animation settings">
    <DropdownMenuSub>
      {/* The speed in hand sits at the right, against the submenu's chevron (which gives up its own push right). */}
      <DropdownMenuSubTrigger className="[&>svg:last-child]:ml-0 [&>svg:last-child]:size-3">
        Speed<span className="ml-auto tabular-nums text-muted-foreground">{speed}×</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent aria-label="Speed" className={cn(FLOATING_SURFACE_CLASS, "min-w-24 data-[state=closed]:animate-none!")}>
        <DropdownMenuRadioGroup value={String(speed)} onValueChange={value => animation.onSpeedChange(Number(value))}>
          {speeds.map(value => <DropdownMenuRadioItem key={value} value={String(value)} className="tabular-nums">{value}×</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
    <DropdownMenuSeparator />
    <DropdownMenuCheckboxItem checked={autoplay === true} onSelect={event => event.preventDefault()}
      onCheckedChange={checked => onAutoplayChange?.(checked === true)}>Autoplay</DropdownMenuCheckboxItem>
    <DropdownMenuCheckboxItem checked={animation?.loopEnabled !== false} onSelect={event => event.preventDefault()}
      onCheckedChange={checked => animation.onLoopToggle(checked === true)}>Loop</DropdownMenuCheckboxItem>
  </ToolSettingsMenu>;
}

/**
 * The Animate panel's body (the tool stack's, while Animate is the tool): with more than one
 * routine, a Routine row — its label left, a compact dropdown right — then the playbar: play or
 * pause and the scrubber over the live clock, the same transport fullscreen draws under the
 * model. `animation` is the playback runtime.
 */
export function AnimateControls({ animation, disabled = false }) {
  const clips = animation?.clips || [];
  return <div className="space-y-1 pb-1" data-animate-controls="">
    {/* With several routines, the one to play: its dropdown alone, which says what it is. */}
    {clips.length > 1 ? <div className="flex min-w-0 px-2">
      <FileSheetSelectRow hideLabel className="min-w-0 flex-1 px-0" triggerClassName={cn(COMPACT_TRIGGER, "w-full")} ariaLabel="Routine"
        value={animation.activeClipId} onValueChange={animation.onClipSelect} options={clips.map(clip => ({ value: clip.id, label: clip.label }))} />
    </div> : null}
    {/* The play button sits in the row as a strip button sits in the strip, 4px in from the
        panel's edge and foot; the scrubber takes the rest and ends where the heading's text begins. */}
    <div className="flex min-w-0 pl-1 pr-2"><AnimationTransport runtime={animation} disabled={disabled} compact /></div>
  </div>;
}
