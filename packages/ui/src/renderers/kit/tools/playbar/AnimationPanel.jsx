import { DropdownMenuCheckboxItem } from "@text-to-cad/ui/primitives/dropdown-menu";
import { FileSheetSelectRow } from "../../inspector/FileSheet.js";
import { SpeedSubmenu } from "../PlaybackMenu.jsx";
import { ToolSettingsMenu } from "../ToolModeMenu.jsx";
import ToolPanel from "../ToolPanel.jsx";
import { AnimationTransport, PLAYBACK_SPEEDS } from "./ViewportAnimationBar.js";

/**
 * The Animation tool's panel: a file's routines, played in the tools view. A toolbar like
 * Draw's, with no heading and no X — a second press on the tool puts it down. With more than one
 * routine its first row is the Routine's dropdown; then the transport (play/pause and the scrubber),
 * and at that row's end the settings: Speed, Loop and Autoplay, the same settings as preview's
 * Playback settings (`PlaybackMenu.jsx`). Ticking a checkbox leaves the menu open.
 *
 * @param {{ runtime: object, autoplay: boolean, onAutoplayChange(value: boolean): void, disabled?: boolean }} props
 *   `runtime` is the playbar runtime, its Speed and Loop already writing the file's choice.
 */
export default function AnimationPanel({ runtime, autoplay, onAutoplayChange, disabled = false }) {
  const clips = runtime.clips;
  const active = clips.find(clip => clip.id === runtime.activeClipId);
  const keepOpen = event => event.preventDefault();
  return <ToolPanel id="animation" label="Animation controls" collapsible={false}>
    {/* The routine's name is the row: the dropdown spans the panel, named and hinted "Routine". */}
    {clips.length > 1 ? <FileSheetSelectRow hideLabel className="flex h-7 items-center px-1" triggerClassName="!h-6 gap-1 !px-1.5"
      value={runtime.activeClipId} onValueChange={runtime.onClipSelect} ariaLabel="Routine"
      triggerContent={<span className="truncate">{active?.label}</span>}
      options={clips.map(clip => ({ value: clip.id, label: clip.label }))} /> : null}
    <div className="flex h-7 min-w-0 items-center gap-1 pl-0.5 pr-1">
      <AnimationTransport runtime={runtime} disabled={disabled} />
      <ToolSettingsMenu label="Animation settings" disabled={disabled}>
        <SpeedSubmenu label="Speed" name="Animation speed" value={Number(runtime.speed) || 1} values={PLAYBACK_SPEEDS} onChange={runtime.onSpeedChange} />
        <DropdownMenuCheckboxItem checked={runtime.loopEnabled !== false} onSelect={keepOpen}
          onCheckedChange={checked => runtime.onLoopToggle(checked === true)}>Loop</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={autoplay === true} onSelect={keepOpen}
          onCheckedChange={checked => onAutoplayChange(checked === true)}>Autoplay</DropdownMenuCheckboxItem>
      </ToolSettingsMenu>
    </div>
  </ToolPanel>;
}
