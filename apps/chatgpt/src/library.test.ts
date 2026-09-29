import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecentLibrary, filterRecentModels, type RecentModel } from './library';
const item: RecentModel = { id: 'known', name: 'bracket.step', path: '/parts/project/bracket.step', lastOpened: 123, pinned: false, missing: false, revision: 'r1', thumbnailRevision: 'r1' };
test('library operations serialize persisted updates and search names plus folders', async () => {
  const calls: unknown[] = [];
  const library = createRecentLibrary({ async callServerTool(params) {
    calls.push(params.arguments);
    return { structuredContent: { items: [{ ...item, pinned: params.arguments?.action === 'pin' }] } };
  } });
  await Promise.all([library.refresh(), library.pin(item)]);
  assert.equal(library.getSnapshot().items[0].pinned, true);
  assert.deepEqual(calls, [{ action: 'list', apiVersion: 2 }, { action: 'pin', documentId: 'known', pinned: true, apiVersion: 2 }]);
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
  let revision = 'old';
  const thumbnails = createRecentLibrary({ async callServerTool() { return { structuredContent: { thumbnail: 'data:image/png;base64,AAAA', revision } }; } });
  assert.equal(await thumbnails.thumbnail(item), null);
  revision = item.thumbnailRevision!;
  assert.equal(await thumbnails.thumbnail(item), 'data:image/png;base64,AAAA', 'a mismatched reply does not cache an unavailable preview');
  thumbnails.dispose();
});
test('replacement and removed thumbnails evict obsolete cached images', async () => {
  let token = 'image-a';
  let items = [{ ...item, thumbnailRevision: token }];
  let calls = 0;
  const library = createRecentLibrary({ async callServerTool({ arguments: args }) {
    if (args?.action === 'list') return { structuredContent: { items } };
    calls++; return { structuredContent: { thumbnail: `data:image/png;base64,${token}`, revision: token } };
  } });
  await library.refresh();
  assert.equal(await library.thumbnail(items[0]), 'data:image/png;base64,image-a');
  token = 'image-b'; items = [{ ...item, thumbnailRevision: token }]; await library.refresh();
  assert.equal(await library.thumbnail(items[0]), 'data:image/png;base64,image-b');
  token = 'image-a'; items = [{ ...item, thumbnailRevision: token }]; await library.refresh();
  await library.thumbnail(items[0]); assert.equal(calls, 3, 'the superseded image-a was evicted');
  items = []; await library.refresh();
  items = [{ ...item, thumbnailRevision: token }]; await library.refresh();
  await library.thumbnail(items[0]); assert.equal(calls, 4, 'removal releases the retained image');
  library.dispose();
});
