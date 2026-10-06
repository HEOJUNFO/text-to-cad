// The tube runtime's lazy boundary, asserted on a pristine module registry:
// node --test gives each test FILE its own process, so nothing here has loaded
// tubeDeformation.js before the first test runs. Nothing in this file may
// import it statically, or the test would prove the opposite of its claim.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { evaluateAnimationClip, loadSourceAnimation } from "./animationRuntime.js";
import { loadTubeDeformation, requireTubeDeformation, tubeDeformation } from "./tubeDeformationChunk.js";

const line = (start, end) => ({ kind: "line", start, end });
const REST = { segments: [line([0, 0, 0], [10, 0, 0])], normal: [0, 0, 1] };
const BENT = { segments: [line([0, 0, 0], [10, 4, 0])], normal: [0, 0, 1] };

const clip = (id, track) => ({ id, label: id, duration: 1, loop: true, tracks: [{ targets: ["o1"], times: [0], ...track }] });
const SPIN = clip("spin", { pivot: [0, 0, 0], transform: [[0, 0, 0, 0, 0, 0.7071068, 0.7071068, 0, 0, 0, 0, 0, 0]] });
const FLEX = clip("flex", { rest: REST, maxSegmentLength: 1, tube: [{ path: BENT, twistDeg: 0 }] });

// FIRST, while nothing has loaded it: a document whose clips bend no tube can
// never evaluate a tube track, so it must not drag the tube chunk into the page.
test("a document with no tube track never loads the tube runtime", async () => {
  assert.equal(tubeDeformation(), null);
  assert.throws(() => requireTubeDeformation("a tube animation track"), /loadTubeDeformation/u);
  assert.equal(await loadSourceAnimation({}), null);
  const rigid = await loadSourceAnimation({ animation: { clips: [SPIN] } });
  assert.deepEqual(Object.keys(rigid.clips), ["spin"]);
  assert.equal(tubeDeformation(), null, "a document that only moves parts fetched the tube chunk");
});

test("a tube track loads the runtime before its clip can run, and draws what the eager runtime drew", async () => {
  const { clips } = await loadSourceAnimation({ animation: { clips: [SPIN, FLEX] } });
  assert.notEqual(tubeDeformation(), null);
  const [[partId, deformation]] = [...evaluateAnimationClip(THREE, clips.flex, 0.5).deformations];
  assert.equal(partId, "o1");

  // The same spec through the module's own entry point: the lazy boundary must
  // change nothing about the numbers the renderer draws from.
  const { normalizeTubeDeformation } = await loadTubeDeformation();
  assert.deepEqual(deformation, normalizeTubeDeformation({ rest: REST, path: BENT, maxSegmentLength: 1 }));
});
