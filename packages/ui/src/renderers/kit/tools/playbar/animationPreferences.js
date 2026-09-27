// Global viewing preference: whether entering preview starts the routine playing. The person's,
// in every file, like the orbit speed; the host supplies storage, and importing this module has
// no environmental effects.
export const ANIMATION_STORAGE_KEY = "cad-viewer:animation:v1";
export const DEFAULT_ANIMATION_PREFERENCES = Object.freeze({ autoplay: false });

export function normalizeAnimationPreferences(value) {
  return { autoplay: typeof value?.autoplay === "boolean" ? value.autoplay : DEFAULT_ANIMATION_PREFERENCES.autoplay };
}

export function readAnimationPreferences(storage) {
  try { return normalizeAnimationPreferences(JSON.parse(storage?.getItem(ANIMATION_STORAGE_KEY) || "null")); }
  catch { return { ...DEFAULT_ANIMATION_PREFERENCES }; }
}

export function writeAnimationPreferences(storage, value) {
  try { storage?.setItem(ANIMATION_STORAGE_KEY, JSON.stringify(normalizeAnimationPreferences(value))); }
  catch { /* A blocked preference store must not prevent playback. */ }
}
