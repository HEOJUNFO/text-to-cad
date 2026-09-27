// Preview's playback settings, the person's in every file of the tab (`settings.playback` of
// the tab record): whether entering preview starts the routine, and — once chosen in Playback
// settings — the speed and the loop every routine plays with. While they are unset each
// routine's own authored speed and loop apply. Importing this module has no environmental effects.
import { clampAnimationSpeed } from "@hardcore/core/common/animationClock.js";

export const DEFAULT_PLAYBACK = Object.freeze({ autoplay: false });

/**
 * @param {unknown} value
 * @returns {{ autoplay: boolean, speed?: number, loop?: boolean }}
 */
export function normalizePlayback(value) {
  const record = value && typeof value === "object" ? value : {};
  const playback = { autoplay: record.autoplay === true };
  if (typeof record.speed === "number" && Number.isFinite(record.speed) && record.speed > 0) playback.speed = clampAnimationSpeed(record.speed);
  if (typeof record.loop === "boolean") playback.loop = record.loop;
  return playback;
}
