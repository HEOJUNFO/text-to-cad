import { expect, test } from 'vitest';
import { createStoredCadPreferences } from './preferences.js';

function memory() {
  const values = new Map<string, string>();
  return { values, storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } } as unknown as Storage };
}

test('stored preferences read their storage, write the orbit back, and re-read only their own key', () => {
  const { values, storage } = memory();
  values.set('cad-viewer:orbit:v1', JSON.stringify({ speed: 2 }));
  values.set('cad-viewer:theme', 'retired');
  const preferences = createStoredCadPreferences(storage);
  expect(preferences.getSnapshot()).toEqual({ orbit: { speed: 2 }, toolStack: { width: 190, heights: {}, collapsed: {} } });
  preferences.update({ orbit: { speed: 1.37 } });
  expect(JSON.parse(values.get('cad-viewer:orbit:v1')!)).toEqual({ speed: 1.37 });
  expect(createStoredCadPreferences(storage).getSnapshot().orbit).toEqual({ speed: 1.37 });
  // Another window wrote it: read back and bounded, never written again.
  const heard: unknown[] = [];
  preferences.subscribe(() => heard.push(preferences.getSnapshot().orbit));
  values.set('cad-viewer:orbit:v1', JSON.stringify({ speed: 99 }));
  preferences.storageChanged('cad-viewer:orbit:v1');
  expect(heard).toEqual([{ speed: 5 }]);
  expect(values.get('cad-viewer:orbit:v1')).toBe(JSON.stringify({ speed: 99 }));
  // Someone else's key is theirs; a clear resets to the default.
  const before = preferences.getSnapshot();
  preferences.storageChanged('cad-viewer:theme');
  expect(preferences.getSnapshot()).toBe(before);
  values.clear();
  preferences.storageChanged(null);
  expect(preferences.getSnapshot().orbit).toEqual({ speed: 1 });
  expect(values.size).toBe(0);
});

test('the tool stack layout is one stored record: its width, the panel caps and the folded panels, bounded, written back and heard from other windows', () => {
  const { values, storage } = memory();
  // The retired width-only key is nobody's any more: it is neither read nor removed.
  values.set('cad-viewer:tool-stack-width:v1', '300');
  const preferences = createStoredCadPreferences(storage);
  expect(preferences.getSnapshot().toolStack).toEqual({ width: 190, heights: {}, collapsed: {} });
  const layout = { width: 240, heights: { tree: 320, reference: 180 }, collapsed: { reference: true, sdf: false } };
  preferences.update({ toolStack: layout });
  expect(JSON.parse(values.get('cad-viewer:tool-stack:v1')!)).toEqual(layout);
  expect(values.get('cad-viewer:tool-stack-width:v1')).toBe('300');
  expect(values.has('cad-viewer:orbit:v1')).toBe(false);
  expect(createStoredCadPreferences(storage).getSnapshot().toolStack).toEqual(layout);
  // Another window wrote it: read back and bounded, never written again.
  const written = JSON.stringify({ width: 12, heights: { tree: 3, reference: 'tall', other: 400 }, collapsed: { tree: true, 'Not an id': true, clip: 'yes' } });
  values.set('cad-viewer:tool-stack:v1', written);
  preferences.storageChanged('cad-viewer:tool-stack:v1');
  expect(preferences.getSnapshot().toolStack).toEqual({ width: 160, heights: { tree: 64 }, collapsed: { tree: true } });
  expect(values.get('cad-viewer:tool-stack:v1')).toBe(written);
});
