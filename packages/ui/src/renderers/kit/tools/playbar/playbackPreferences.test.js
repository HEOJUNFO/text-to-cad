import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePlayback } from './playbackPreferences.js';

test('playback is Autoplay, off by default, and a speed and a loop only once they were chosen', () => {
  for (const value of [null, undefined, {}, 'yes', { autoplay: 'yes' }]) assert.deepEqual(normalizePlayback(value), { autoplay: false });
  assert.deepEqual(normalizePlayback({ autoplay: true }), { autoplay: true });
  assert.deepEqual(normalizePlayback({ autoplay: true, speed: 2, loop: false }), { autoplay: true, speed: 2, loop: false });
  // A chosen speed is bounded as the clock bounds it; anything that is not a speed is unset.
  assert.equal(normalizePlayback({ speed: 99 }).speed, 3);
  for (const speed of [0, -1, 'fast', NaN, Infinity]) assert.equal('speed' in normalizePlayback({ speed }), false);
  assert.equal('loop' in normalizePlayback({ loop: 'yes' }), false);
});
