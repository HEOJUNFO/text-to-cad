import assert from 'node:assert/strict';
import { test } from 'node:test';
import { absoluteBrowsePath, createDirectorySource, readDirectory, relativeBrowsePath } from './browsing';

test('browsing paths preserve absolute identities across project, Computer and Windows drive roots', () => {
  for (const [root, path, relative] of [
    ['/project', '/project/models/part.step', 'models/part.step'],
    ['/', '/other/part.step', 'other/part.step'],
    ['C:\\project', 'C:\\project\\parts\\a.step', 'parts/a.step'],
    [null, 'D:\\parts\\a.step', 'D:/parts/a.step'],
    [null, 'C:\\', 'C:'],
  ] as const) {
    assert.equal(relativeBrowsePath(root, path), relative);
    assert.equal(absoluteBrowsePath(root, relative), path);
  }
  assert.equal(relativeBrowsePath('/project', '/project-two/a.step'), null);
  assert.equal(relativeBrowsePath('/project', '/elsewhere/a.step'), null);
  assert.equal(relativeBrowsePath('C:\\Project', 'c:\\project\\a.step'), 'a.step');
  assert.throws(() => absoluteBrowsePath('/project', '../outside'), /Invalid/);
});

test('directory adapter lists only the requested folder and leaves document opening to its app', async () => {
  const calls: unknown[] = [];
  const location = { root: { path: '/project', name: 'project' }, parent: '/', home: '/users/me' };
  const bridge = { async callServerTool(params: unknown) {
    calls.push(params);
    return { structuredContent: { ...location, directory: '/project/models', entries: [
      { path: '/project/models/a.step', name: 'a.step', kind: 'file' },
      { path: '/project/models/subfolder', name: 'subfolder', kind: 'directory' },
    ] } };
  } };
  const source = createDirectorySource(bridge, location);
  assert.equal(source.paths, undefined, 'no recursive discovery capability');
  assert.deepEqual(await source.list('models', { signal: new AbortController().signal }), [
    { path: 'models/a.step', name: 'a.step', kind: 'file' },
    { path: 'models/subfolder', name: 'subfolder', kind: 'directory' },
  ]);
  assert.deepEqual(calls, [{ name: 'cad_browse', arguments: { apiVersion: 2, browseRoot: '/project', directory: '/project/models', includeHidden: true } }]);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(source.list('', { signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 1);
  await assert.rejects(readDirectory({ async callServerTool() { return { structuredContent: { entries: [] } }; } }, null, null, new AbortController().signal), /invalid directory/);
});
