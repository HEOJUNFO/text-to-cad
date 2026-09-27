import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOrbit } from './orbitPreferences.js';

test('the orbit speed keeps stopped and fractional speeds and bounds a corrupt one', () => {
  for (const speed of [0, 0.05, 1.37, 5]) assert.deepEqual(normalizeOrbit({ speed }), { speed });
  assert.deepEqual(normalizeOrbit({ speed: -1 }), { speed: 0 });
  assert.deepEqual(normalizeOrbit({ speed: 100 }), { speed: 5 });
  for (const speed of [null, 'fast', Infinity, NaN]) assert.deepEqual(normalizeOrbit({ speed }), { speed: 1 });
  for (const value of [null, undefined, 'fast', 3]) assert.deepEqual(normalizeOrbit(value), { speed: 1 });
});
