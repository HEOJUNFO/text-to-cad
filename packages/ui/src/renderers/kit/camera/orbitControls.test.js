import assert from "node:assert/strict";
import test from "node:test";

import {
  orbitControlsDeltaSeconds,
  PREVIEW_AUTO_ROTATE_SPEED,
  PREVIEW_ORBIT_SECONDS_PER_TURN,
  stopOrbitMomentum,
  updateOrbitControls
} from "./orbitControls.js";

test("preview auto-rotate speed uses the configured full-turn duration", () => {
  assert.equal(PREVIEW_ORBIT_SECONDS_PER_TURN, 60);
  assert.equal(PREVIEW_AUTO_ROTATE_SPEED, 1);
});

test("orbitControlsDeltaSeconds converts animation timestamps from ms to seconds", () => {
  assert.equal(orbitControlsDeltaSeconds(1016, 1000), 0.016);
});

test("orbitControlsDeltaSeconds preserves slow render frames", () => {
  assert.equal(orbitControlsDeltaSeconds(1400, 1000), 0.4);
});

test("orbitControlsDeltaSeconds clamps stale frame gaps", () => {
  assert.equal(orbitControlsDeltaSeconds(3000, 1000), 1);
});

test("updateOrbitControls passes seconds while auto-rotate is active", () => {
  const updateArgs = [];
  const controls = {
    autoRotate: true,
    update(...args) {
      updateArgs.push(args);
      return true;
    }
  };
  const state = { orbitControlsLastTimestamp: 1000 };

  assert.equal(updateOrbitControls(controls, 1016, state), true);
  assert.deepEqual(updateArgs, [[0.016]]);
  assert.equal(state.orbitControlsLastTimestamp, 1016);
});

test("updateOrbitControls resets timing when auto-rotate is inactive", () => {
  const updateArgs = [];
  const controls = {
    autoRotate: false,
    update(...args) {
      updateArgs.push(args);
      return false;
    }
  };
  const state = { orbitControlsLastTimestamp: 1016 };

  assert.equal(updateOrbitControls(controls, 1032, state), false);
  assert.deepEqual(updateArgs, [[]]);
  assert.equal(state.orbitControlsLastTimestamp, 0);
});

test("stopOrbitMomentum drops the drag momentum damping would keep adding on update", () => {
  const spherical = { theta: 0.2, phi: -0.1, radius: 0, set(r, p, t) { this.radius = r; this.phi = p; this.theta = t; } };
  const pan = { x: 3, y: 0, z: -2, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
  const controls = { _sphericalDelta: spherical, _panOffset: pan, _scale: 1.2 };
  assert.equal(stopOrbitMomentum(controls), true);
  assert.deepEqual([spherical.theta, spherical.phi, spherical.radius], [0, 0, 0]);
  assert.deepEqual([pan.x, pan.y, pan.z], [0, 0, 0]);
  assert.equal(controls._scale, 1);
  assert.equal(stopOrbitMomentum(null), false);
});
