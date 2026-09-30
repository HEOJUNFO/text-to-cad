// Whether the camera on screen is the one a command asked for, as the live binding and the
// shell's own `setCamera` predicate read it. A plain module so the tests import the real
// comparison rather than a copy of it.

// The camera reads back what was asked when position and target agree to a part in ten thousand
// of their size (a float32 round trip through the viewport's matrices is well inside that).
export const near = (actual, asked) =>
  actual.length === asked.length && asked.every((value, index) => Math.abs((actual[index] ?? Number.NaN) - value) <= 1e-4 * Math.max(1, Math.abs(value)));

/** The camera on screen reads back as `asked` in position and target. */
export const cameraReadsBack = (camera, asked) =>
  Boolean(camera) && near(camera.position, asked.position) && near(camera.target, asked.target);
