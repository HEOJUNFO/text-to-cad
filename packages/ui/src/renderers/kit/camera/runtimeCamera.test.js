import assert from "node:assert/strict";
import test from "node:test";

import { createRealOrbitRuntime } from "./harness/realOrbit.js";
import { applyPerspectiveSnapshot } from "./runtimeCamera.js";

// The camera a host hands the viewport is driven through a REAL three OrbitControls, so a
// three change to what `update()` does to a pose is caught here rather than in the browser.

const asked = { position: [30, -20, 15], target: [1, 2, 3], up: [0, 0, 1] };
const vectorOf = vector => [vector.x, vector.y, vector.z];
const closeTo = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) < 1e-9);

test("applyPerspectiveSnapshot leaves the camera where it was put while the Preview orbit plays", () => {
  const runtime = createRealOrbitRuntime({ autoRotate: true });
  assert.equal(applyPerspectiveSnapshot(runtime, asked), true);
  assert.ok(closeTo(vectorOf(runtime.camera.position), asked.position), `position ${vectorOf(runtime.camera.position)} is the request, not one auto-rotate step on`);
  assert.ok(closeTo(vectorOf(runtime.controls.target), asked.target));
  assert.equal(runtime.controls.autoRotate, true, "and the orbit is still playing afterwards");
});

