import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecentLibrary, filterRecentModels, type RecentModel } from './library';
const item: RecentModel = { id: 'known', file: 'bracket.step', name: 'bracket.step', rootPath: '/parts/project', absolutePath: '/parts/project/bracket.step', lastOpened: 123, pinned: false, missing: false, revision: 'r1', thumbnailRevision: 'r1' };
test('library operations serialize persisted updates and search names plus folders', async () => {
  const calls: unknown[] = [];
  const library = createRecentLibrary({ async callServerTool(params) {
    calls.push(params.arguments);
    return { structuredContent: { items: [{ ...item, pinned: params.arguments?.action === 'pin' }] } };
  } });
  await Promise.all([library.refresh(), library.pin(item)]);
  assert.equal(library.getSnapshot().items[0].pinned, true);
  assert.deepEqual(calls, [{ action: 'list' }, { action: 'pin', recentId: 'known', pinned: true }]);
  assert.equal(filterRecentModels([item], 'PROJECT bracket').length, 1);
  assert.equal(filterRecentModels([item], 'another').length, 0);
  library.dispose();
});
test('failed library operations report errors and can retry without deleting previous models', async () => {
  let fail = false;
  const library = createRecentLibrary({ async callServerTool() { return fail ? { isError: true, content: [{ type: 'text', text: 'Library unavailable' }] } : { structuredContent: { items: [item] } }; } });
  await library.refresh(); fail = true;
  await assert.rejects(library.remove(item), /Library unavailable/);
  assert.equal(library.getSnapshot().items.length, 1); assert.match(library.getSnapshot().error, /Library unavailable/);
  fail = false; await library.refresh(); assert.equal(library.getSnapshot().error, ''); library.dispose();
});
test('late library results cannot publish after disposal and stale thumbnails are not reused', async () => {
  let finish!: (result: { structuredContent: unknown }) => void;
  const pending = new Promise<{ structuredContent: unknown }>(resolve => { finish = resolve; });
  const library = createRecentLibrary({ callServerTool: () => pending });
  const refresh = library.refresh(); await Promise.resolve(); library.dispose();
  finish({ structuredContent: { items: [item] } }); await assert.rejects(refresh, { name: 'AbortError' });
  assert.equal(library.getSnapshot().items.length, 0);
  const thumbnails = createRecentLibrary({ async callServerTool() { return { structuredContent: { thumbnail: 'data:image/png;base64,AAAA', revision: 'old' } }; } });
  assert.equal(await thumbnails.thumbnail(item), null); thumbnails.dispose();
});
