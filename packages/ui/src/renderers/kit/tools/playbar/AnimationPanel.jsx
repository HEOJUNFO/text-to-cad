import { Pause, Play } from "lucide-react";
import { DropdownMenuCheckboxItem } from "@text-to-cad/ui/primitives/dropdown-menu";
import { cn } from "@text-to-cad/ui/utils";
import { FileSheetSelectRow } from "../../inspector/FileSheet.js";
import { SpeedSubmenu } from "../PlaybackMenu.jsx";
import { ToolSettingsMenu } from "../ToolModeMenu.jsx";
import ToolPanel, { TOOL_PANEL_BUTTON_CLASS } from "../ToolPanel.jsx";
import { AnimationTimeControl, PLAYBACK_SPEEDS } from "./ViewportAnimationBar.js";

/**
 * The Animation tool's panel: a file's routines, played in the tools view. Headed as Measure's is:
 * "Animation", then its settings — Speed, Loop and Autoplay, the same settings as preview's Playback
 * settings (`PlaybackMenu.jsx`) — and its X, which puts the tool down. Its body, rowed as Explode's and
 * Clip's are: with more than one routine, the routine's dropdown; then play/pause and the scrubber.
 * Ticking a checkbox leaves the menu open.
 *
 * @param {{ runtime: object, autoplay: boolean, onAutoplayChange(value: boolean): void, onClose(): void,
 *   disabled?: boolean }} props  `runtime` is the playbar runtime, its Speed and Loop already writing the
 *   file's choice.
 */
export default function AnimationPanel({ runtime, autoplay, onAutoplayChange, onClose, disabled = false }) {
  const clips = runtime.clips;
  const active = clips.find(clip => clip.id === runtime.activeClipId);
  const playing = runtime.playing === true;
  const keepOpen = event => event.preventDefault();
  return <ToolPanel id="animation" title="Animation" label="Animation controls" collapsible={false} onClose={onClose}
    actions={<ToolSettingsMenu label="Animation settings" disabled={disabled}>
      <SpeedSubmenu label="Speed" name="Animation speed" value={Number(runtime.speed) || 1} values={PLAYBACK_SPEEDS} onChange={runtime.onSpeedChange} />
      <DropdownMenuCheckboxItem checked={runtime.loopEnabled !== false} onSelect={keepOpen}
        onCheckedChange={checked => runtime.onLoopToggle(checked === true)}>Loop</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem checked={autoplay === true} onSelect={keepOpen}
        onCheckedChange={checked => onAutoplayChange(checked === true)}>Autoplay</DropdownMenuCheckboxItem>
    </ToolSettingsMenu>}>
    <div className="space-y-1 pb-1">
      {/* The routine's name is the row: the dropdown spans it, named and hinted "Routine". */}
      {clips.length > 1 ? <FileSheetSelectRow hideLabel className="px-2 py-1" triggerClassName="!h-6 gap-1 !px-1.5"
        value={runtime.activeClipId} onValueChange={runtime.onClipSelect} ariaLabel="Routine"
        triggerContent={<span className="truncate">{active?.label}</span>}
        options={clips.map(clip => ({ value: clip.id, label: clip.label }))} /> : null}
      {/* A heading's small button against the scrubber: its glyph on the rows' 8px line, its press area
          out to the panel's 4px, as a tree row's is. */}
      <div className="flex min-w-0 items-center gap-0.5 py-1 pl-1 pr-2" data-animation-transport="">
        <button type="button" aria-label={`${playing ? "Pause" : "Play"} animation`} disabled={disabled}
          className={cn(TOOL_PANEL_BUTTON_CLASS, "disabled:pointer-events-none disabled:opacity-50")} onClick={() => runtime.onPlayToggle()}>
          {playing ? <Pause className="size-3" aria-hidden="true" /> : <Play className="size-3" aria-hidden="true" />}
        </button>
        <div className="min-w-0 flex-1"><AnimationTimeControl runtime={runtime} disabled={disabled} /></div>
      </div>
    </div>
  </ToolPanel>;
}
