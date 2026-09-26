import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TOOL_STACK, TOOL_PANEL_REFERENCE_DEFAULT_HEIGHT, TOOL_STACK_DEFAULT_WIDTH, TOOL_STACK_MIN_WIDTH,
  normalizeToolStackWidth, toolPanelDefaultHeight
} from "./toolStackLayout.js";

test("the stack's default width is a five-tool strip's, whatever a store hands back that is no width", () => {
  assert.equal(TOOL_STACK_DEFAULT_WIDTH, 5 * 24 + 4 * 2 + 2 * 4 + 2 * 1);
  assert.equal(TOOL_STACK_DEFAULT_WIDTH, 138);
  assert.equal(TOOL_STACK_MIN_WIDTH, 128);
  assert.equal(DEFAULT_TOOL_STACK.width, TOOL_STACK_DEFAULT_WIDTH);
  for (const value of [null, undefined, "240", Number.NaN, Infinity, {}]) assert.equal(normalizeToolStackWidth(value), TOOL_STACK_DEFAULT_WIDTH, String(value));
  assert.equal(normalizeToolStackWidth(12), TOOL_STACK_MIN_WIDTH, "never under the minimum");
  assert.equal(normalizeToolStackWidth(240.4), 240);
});

test("a tree or Position opens capped at half the stack on desktop and the whole of it on mobile; a Reference at its own default", () => {
  assert.equal(toolPanelDefaultHeight("tree", 600), 300);
  assert.equal(toolPanelDefaultHeight("position", 601), 301);
  assert.equal(toolPanelDefaultHeight("tree", 600, true), 600);
  assert.equal(toolPanelDefaultHeight("position", 600, true), 600);
  assert.equal(toolPanelDefaultHeight("reference", 600), TOOL_PANEL_REFERENCE_DEFAULT_HEIGHT);
  assert.equal(toolPanelDefaultHeight("reference", 600, true), TOOL_PANEL_REFERENCE_DEFAULT_HEIGHT);
  assert.equal(toolPanelDefaultHeight("tree", 0), TOOL_PANEL_REFERENCE_DEFAULT_HEIGHT, "an unmeasured stack falls back to a height");
});
