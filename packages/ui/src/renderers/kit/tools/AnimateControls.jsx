import { Pause, Play } from "lucide-react";
import { Button } from "@hardcore/ui/primitives/button";
import { cn } from "@hardcore/ui/utils";
import { FILE_SHEET_FIELD_LABEL_CLASSES, FileSheetCheckboxRow, FileSheetSelectRow } from "../inspector/FileSheet.js";
import { PLAYBACK_SPEEDS } from "./playbar/ViewportAnimationBar.js";

function LabelledRow({ label, children }) {
  return <div className="flex min-w-0 items-center gap-2 px-2">
    <span className={cn(FILE_SHEET_FIELD_LABEL_CLASSES, "w-12 shrink-0")}>{label}</span>
    <div className="min-w-0 flex-1">{children}</div>
  </div>;
}

/**
 * The Animate panel's rows (the tool stack's, while Animate is the tool): the routine — with more
 * than one — as a label beside its dropdown, then Speed the same way, then Loop. The playbar under
 * the model keeps the transport; the panel's heading carries play and pause
 * (`AnimatePlayButton`). `animation` is the playback runtime the playbar reads.
 */
export function AnimateControls({ animation }) {
  const clips = animation?.clips || [];
  const speed = Number(animation?.speed) || 1;
  const speeds = PLAYBACK_SPEEDS.includes(speed) ? PLAYBACK_SPEEDS : [...PLAYBACK_SPEEDS, speed].sort((a, b) => a - b);
  return <div className="space-y-1 px-1 pb-1.5 pt-0.5" data-animate-controls="">
    {clips.length > 1 ? <LabelledRow label="Routine">
      <FileSheetSelectRow hideLabel className="px-0" triggerClassName="h-6" ariaLabel="Routine" value={animation.activeClipId}
        onValueChange={animation.onClipSelect} options={clips.map(clip => ({ value: clip.id, label: clip.label }))} />
    </LabelledRow> : null}
    <LabelledRow label="Speed">
      <FileSheetSelectRow hideLabel className="px-0" triggerClassName="h-6" ariaLabel="Speed" value={String(speed)}
        onValueChange={value => animation.onSpeedChange(Number(value))} options={speeds.map(value => ({ value: String(value), label: `${value}×` }))} />
    </LabelledRow>
    <FileSheetCheckboxRow label="Loop" checked={animation?.loopEnabled !== false} onCheckedChange={checked => animation.onLoopToggle(checked)} />
  </div>;
}

/** Play or pause the routine in hand: the Animate panel heading's action. */
export function AnimatePlayButton({ animation, disabled = false }) {
  const playing = Boolean(animation?.playing);
  return <Button type="button" variant="ghost" size="icon-xs" className="size-5 shrink-0 text-muted-foreground" disabled={disabled}
    aria-label={playing ? "Pause routine" : "Play routine"} onClick={() => animation?.onPlayToggle?.()}>
    {playing ? <Pause className="size-3" aria-hidden="true" /> : <Play className="size-3" aria-hidden="true" />}
  </Button>;
}
