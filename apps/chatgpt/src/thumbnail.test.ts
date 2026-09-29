import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createThumbnailBinding } from './thumbnail';

test('thumbnail waits for complete, stable geometry and drops an in-flight image after unmount', async t => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0, captures = 0, closed = 0;
  const saved: unknown[][] = [];
  const globals = (name: string, value: unknown) => {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (before) Object.defineProperty(globalThis, name, before); else Reflect.deleteProperty(globalThis, name); });
  };
  globals('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  globals('cancelAnimationFrame', (id: number) => frames.delete(id));
  globals('createImageBitmap', async () => ({ width: 1200, height: 800, close() { closed++; } }));
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (callback: BlobCallback) => callback(new Blob(['image'], { type: 'image/png' })) };
  globals('document', { createElement: () => canvas });
  const tick = async () => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(0));
    await new Promise(resolve => setImmediate(resolve));
  };
  const state = { active: true, loading: true, resource: { id: 'part' }, revision: 'r1', camera: { zoom: 1 }, display: {} };
  let pixels: Promise<Blob> = Promise.resolve(new Blob(['frame']));
  const controller = { readState: () => state, capture: () => { captures++; return pixels; } };
  const library = { async saveThumbnail(...args: unknown[]) { saved.push(args); } };
  const binding = createThumbnailBinding(library as never, 'recent', 'r1');
  const stop = binding.bind(controller as never);
  await tick(); assert.equal(captures, 0);
  state.loading = false; await tick(); assert.equal(captures, 0);
  state.camera.zoom = 2; await tick(); assert.equal(captures, 0, 'opening camera is still fitting');
  await tick(); assert.equal(captures, 1); assert.equal(saved.length, 1);
  assert.equal(canvas.width, 320); assert.equal(canvas.height, 213); assert.equal(closed, 1);
  assert.deepEqual(saved[0].slice(0, 2), ['recent', 'r1']);
  stop();

  let resolvePixels!: (value: Blob) => void;
  pixels = new Promise(resolve => { resolvePixels = resolve; });
  const stopPending = binding.bind(controller as never);
  await tick(); await tick(); assert.equal(captures, 2);
  stopPending(); resolvePixels(new Blob(['late-frame']));
  await tick(); assert.equal(saved.length, 1, 'departed views cannot replace recents');
  assert.equal(closed, 2); assert.equal(frames.size, 0);

  let rejectPixels!: (error: Error) => void;
  pixels = new Promise((_resolve, reject) => { rejectPixels = reject; });
  const stopReplacing = binding.bind(controller as never);
  await tick(); await tick();
  state.loading = true; state.revision = 'r2';
  rejectPixels(new Error('The displayed model revision changed'));
  await tick(); assert.equal(saved.length, 1);
  pixels = Promise.resolve(new Blob(['replacement'])); state.loading = false;
  await tick(); await tick();
  assert.equal(saved.length, 2, 'a superseded in-flight capture waits for the replacement view');
  stopReplacing();
});
