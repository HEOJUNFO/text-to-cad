import assert from "node:assert/strict";
import test from "node:test";

import { chooseTopologyBatch, sameTopologyIds, topologyIdsWithin } from "./topologyRequests.js";

test("a batch keeps what is loaded and still requested, and adds the newest requests within budget", () => {
  const order = new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5]]);
  assert.deepEqual(chooseTopologyBatch(["a", "b", "c", "d", "e"], ["a", "x"], { budget: 2, requestOrder: order }), ["a", "e", "d"]);
  assert.deepEqual(chooseTopologyBatch(["a", "b"], ["a", "b", "c"], { budget: 2, requestOrder: order }), ["a", "b"]);
  assert.deepEqual(chooseTopologyBatch(["c", "a", "a"], [], {}), ["c", "a"]);
  assert.deepEqual(chooseTopologyBatch([], ["a"], { budget: 3 }), []);
});

test("requested ids compare as sets", () => {
  assert.ok(sameTopologyIds(["a", "b"], ["b", "a", "a"]));
  assert.ok(!sameTopologyIds(["a"], ["a", "b"]));
  assert.ok(topologyIdsWithin(["a"], ["b", "a"]));
  assert.ok(topologyIdsWithin([], ["a"]));
  assert.ok(!topologyIdsWithin(["a", "c"], ["a"]));
});
