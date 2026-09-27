// Preview's orbit speed, the person's in every file of the tab (`settings.orbit` of the tab
// record). Importing this module has no environmental effects.
export const DEFAULT_ORBIT = Object.freeze({ speed: 1 });
export const MAX_ORBIT_SPEED = 5;

export function normalizeOrbit(value) {
  const speed = value?.speed;
  return { speed: typeof speed === "number" && Number.isFinite(speed)
    ? Math.min(MAX_ORBIT_SPEED, Math.max(0, speed)) : DEFAULT_ORBIT.speed };
}
