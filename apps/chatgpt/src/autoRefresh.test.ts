import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchRecentModels } from './autoRefresh';

test('visible recents refresh without overlapping, pause when hidden, and stop on unmount', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = { window: new EventTarget(), document: Object.assign(new EventTarget(), { visibilityState: 'visible' }) };
  let calls = 0;
  let complete!: () => void;
  const stop = watchRecentModels({ refresh() { calls++; return new Promise(resolve => { complete = resolve; }); } }, page);
  assert.equal(calls, 1);
  page.window.dispatchEvent(new Event('focus')); t.mock.timers.tick(20_000);
  assert.equal(calls, 1, 'slow refreshes never overlap');
  complete(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(5000); assert.equal(calls, 2);
  page.document.visibilityState = 'hidden'; page.document.dispatchEvent(new Event('visibilitychange'));
  complete(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(20_000); assert.equal(calls, 2);
  page.document.visibilityState = 'visible'; page.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 3, 'returning to the home refreshes immediately');
  stop(); complete(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(20_000); page.window.dispatchEvent(new Event('focus'));
  assert.equal(calls, 3, 'late results do not revive polling after unmount');
});
