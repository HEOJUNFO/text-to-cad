import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useEditingPreview } from '../../../../../../dist/renderers/step/components/workbench/hooks/useEditingPreview.js';

afterEach(() => cleanup());

// The feed is polled; while it is down every poll fails the same way. Each failure used to
// publish a new state, re-rendering the whole STEP surface (and its tree) once per poll.
it('keeps its state across repeated identical failures and identical updates', () => {
  let update: (next: unknown) => void = () => {}, fail: (error: Error) => void = () => {};
  const client = { observeEditingPreview: (_file: string, onUpdate: any, onError: any) => { update = onUpdate; fail = onError; return () => {}; } };
  const { result } = renderHook(() => useEditingPreview('part.step', { enabled: true, client }));
  act(() => fail(new Error('offline')));
  const failed = result.current.state;
  expect(failed.error).toBe('offline');
  act(() => fail(new Error('offline')));
  act(() => fail(new Error('offline')));
  expect(result.current.state).toBe(failed);
  // A different failure is news.
  act(() => fail(new Error('refused')));
  expect(result.current.state).not.toBe(failed);
  expect(result.current.state.error).toBe('refused');
  // As is recovery; the same update twice is not.
  act(() => update({ epoch: 'e1', revision: 1, state: 'ready' }));
  const ready = result.current.state;
  act(() => update({ epoch: 'e1', revision: 1, state: 'ready' }));
  expect(result.current.state).toBe(ready);
});

// The case the feed cannot see: the file it last built is rewritten by something else (another
// cadgen, a checkout). The catalog has the new revision, and the view must follow it.
it('lets the catalog win once the file moves on without the feed', () => {
  let update: (next: unknown) => void = () => {};
  const client = { observeEditingPreview: (_file: string, onUpdate: any) => { update = onUpdate; return () => {}; } };
  const before = { file: '/p/part.step', kind: 'part', hash: 'before', documentHash: 'bytes-0' };
  const { result, rerender } = renderHook(({ entry }) => useEditingPreview('part.step', { enabled: true, client, catalogEntry: entry }),
    { initialProps: { entry: before } });
  act(() => update({ epoch: 'e1', revision: 1, state: 'building' }));
  act(() => update({ epoch: 'e1', revision: 1, state: 'done', preview: { tree: 'preview-1', url: '/preview-1', sequence: 1 },
    saved: { tree: 'saved-1', documentHash: 'bytes-1' } }));
  expect(result.current.entry?.hash).toBe('preview-1');
  rerender({ entry: { ...before, hash: 'saved-1', documentHash: 'bytes-1' } });
  expect(result.current.entry?.hash).toBe('preview-1');
  act(() => update({ state: 'disconnected' }));
  rerender({ entry: { ...before, hash: 'elsewhere', documentHash: 'bytes-2' } });
  expect(result.current.entry).toBeNull();
});

// The server says a finished build's file moved on: the preview goes, and the catalog is read at
// once, so the view lands on the file on disk rather than an older catalog entry it still holds.
it('reads the catalog again at once when the feed says the file moved past its build', () => {
  let update: (next: unknown) => void = () => {};
  const refreshes: unknown[] = [];
  const client = {
    observeEditingPreview: (_file: string, onUpdate: any) => { update = onUpdate; return () => {}; },
    refresh: (options: unknown) => { refreshes.push(options); return Promise.resolve(); },
  };
  const saved = { file: '/p/part.step', kind: 'part', hash: 'saved-1', documentHash: 'bytes-1' };
  const { result } = renderHook(() => useEditingPreview('part.step', { enabled: true, client, catalogEntry: saved }));
  act(() => update({ epoch: 'e1', revision: 1, state: 'done', preview: { tree: 'preview-1', url: '/preview-1', sequence: 1 },
    saved: { tree: 'saved-1', documentHash: 'bytes-1' } }));
  expect(result.current.entry?.hash).toBe('preview-1');
  expect(refreshes).toEqual([]);
  act(() => update({ epoch: 'e1', revision: 1, state: 'done', superseded: true }));
  expect(result.current.entry).toBeNull();
  expect(refreshes).toEqual([{ file: 'part.step', markRefreshing: false }]);
  act(() => update({ epoch: 'e1', revision: 1, state: 'done', superseded: true }));
  expect(refreshes).toHaveLength(1);
});
