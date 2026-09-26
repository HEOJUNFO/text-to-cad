import { normalizeExplodedViewSettings } from "@hardcore/core/lib/displaySettings.js";
import { normalizeViewSettings } from "@hardcore/core/common/viewSettings.js";
import { clipAxisBounds, normalizeStepClipSettings } from "@hardcore/core/lib/viewer/clipPlane.js";
import { ToggleGroup, ToggleGroupItem } from "@hardcore/ui/primitives/toggle-group";
import { Slider } from "@hardcore/ui/primitives/slider";
import { FILE_SHEET_PRECISION_SLIDER_CLASSES } from "../../../kit/inspector/FileSheet.js";

const AXES = Object.freeze(["x", "y", "z"]);

function formatNumber(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "0";
}

// Persistent model effects are separate from Display and its presets. Clip and Explode are drawn
// alike: the amount in the panel's heading, one row for a body — Explode's a slider, Clip's the
// axis it cuts along and then its slider.
function clipState(viewSettings, bounds) {
  const clip = normalizeStepClipSettings(normalizeViewSettings(viewSettings).clip);
  const { min, max } = clipAxisBounds(bounds, clip.axis);
  const neutral = clip.invert ? 0 : 1;
  const offset = clip.enabled ? clip.offset : neutral;
  return { clip, neutral, range: max - min, amount: (clip.invert ? offset : 1 - offset) * 100 };
}

/** How far Clip cuts, for its panel's heading. */
export function clipSummary(viewSettings) {
  return `${formatNumber(clipState(viewSettings, null).amount, 0)}%`;
}

/** Clip's axis, left of its slider: X, Y or Z. */
function ClipAxisToggle({ viewSettings, onViewSettingsPatch }) {
  const { clip, neutral } = clipState(viewSettings, null);
  return <ToggleGroup type="single" value={clip.axis} aria-label="Clip axis" className="rounded-sm bg-muted p-0.5"
    onValueChange={nextAxis => {
      if (!nextAxis) return;
      const nextOffset = clip.enabled ? clip.offsets[nextAxis] : neutral;
      onViewSettingsPatch({ clip: { axis: nextAxis, offsets: { [nextAxis]: nextOffset }, enabled: Math.abs(nextOffset - neutral) > 1e-6 } });
    }}>
    {AXES.map(value => <ToggleGroupItem key={value} value={value} aria-label={`Clip ${value.toUpperCase()} axis`}
      className="h-4 min-w-0 w-5 rounded-sm px-1 text-micro data-[state=on]:bg-background data-[state=on]:shadow-xs">{value.toUpperCase()}</ToggleGroupItem>)}
  </ToggleGroup>;
}

// The Clip panel's body: its axis, then one slider, which applies the cut as it leaves zero and
// removes it at zero.
export function CrossSectionControls({ viewSettings, onViewSettingsPatch, bounds }) {
  const { clip, neutral, range, amount } = clipState(viewSettings, bounds);
  const changeOffset = nextOffset => onViewSettingsPatch({ clip: {
    offsets: { [clip.axis]: nextOffset }, enabled: Math.abs(nextOffset - neutral) > 1e-6
  } });
  return <div className="flex min-w-0 items-center gap-2 px-2 py-1">
    <ClipAxisToggle viewSettings={viewSettings} onViewSettingsPatch={onViewSettingsPatch} />
    <Slider thumbProps={{ "aria-label": "Clip amount" }} value={[amount]} min={0} max={100}
      step={0.1} disabled={!range}
      onValueChange={([value]) => changeOffset(clip.invert ? value / 100 : 1 - value / 100)}
      className={FILE_SHEET_PRECISION_SLIDER_CLASSES} />
  </div>;
}

// The Explode panel: one slider, which applies the effect as it leaves zero and removes it at zero.
export function ExplodeControls({ viewSettings, onViewSettingsPatch }) {
  const exploded = normalizeExplodedViewSettings(normalizeViewSettings(viewSettings).exploded);
  return <div className="px-2 py-1"><Slider thumbProps={{ "aria-label": "Explode amount" }}
    value={[exploded.enabled ? exploded.amount * 100 : 0]} min={0} max={100} step={1}
    onValueChange={([amount]) => onViewSettingsPatch({ exploded: { amount: amount / 100, enabled: amount > 0 } })}
    className={FILE_SHEET_PRECISION_SLIDER_CLASSES} /></div>;
}

