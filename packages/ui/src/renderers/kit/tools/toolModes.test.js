import assert from "node:assert/strict";
import test from "node:test";

import { createToolModes } from "./toolModes.js";

const modes = createToolModes({
  defaultMode: "pick",
  modes: { pick: { persists: true }, ruler: { toggles: true, persists: true }, ink: { toggles: true }, play: {}, handles: { persists: true } }
});

test("an unknown tool falls back to the default tool", () => {
  assert.equal(modes.normalize("ruler"), "ruler");
  assert.equal(modes.normalize("laser"), "pick");
  assert.equal(modes.normalize(undefined), "pick");
});

test("Display is not a tool: its old mode id is unknown, so it is the default tool and never restored", () => {
  assert.equal(modes.normalize("display"), "pick");
  assert.equal(modes.next("ink", "display"), "pick");
  assert.equal(modes.persisted("display"), "pick");
  assert.equal(modes.restore("display"), "pick");
});

test("a toggling session ends when its tool is asked for again; other tools stay", () => {
  assert.equal(modes.next("pick", "ink"), "ink");
  assert.equal(modes.next("ink", "ink"), "pick");
  assert.equal(modes.next("ruler", "ruler"), "pick");
  assert.equal(modes.next("play", "play"), "play");
  assert.equal(modes.next("ink", "nonsense"), "pick");
});

test("a record holds only persisting modes", () => {
  assert.deepEqual(["pick", "ruler", "ink", "play", "handles", "", null, " ruler "].map(modes.persisted),
    ["pick", "ruler", "pick", "pick", "handles", "pick", "pick", "pick"]);
});

test("a file opens in its own tool until its tab records another, and never restores an excluded one", () => {
  assert.equal(modes.restore("", { opensIn: "handles" }), "handles");
  assert.equal(modes.restore("pick", { opensIn: "handles" }), "pick");
  assert.equal(modes.restore("ink", { opensIn: "handles" }), "pick");
  assert.equal(modes.restore("handles", { never: ["handles"] }), "pick");
  assert.equal(modes.restore("ruler", { never: ["handles"] }), "ruler");
  assert.equal(modes.restore(undefined), "pick");
});
