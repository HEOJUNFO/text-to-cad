import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFileHandoff } from './handoff';
import type { OpenFile } from './transport';
const empty = { document: null };
const file = { document: { id: 'bracket', path: '/project/bracket.step', name: 'bracket.step', revision: 'r1' } };
const input = { file: { name: 'bracket.step', resourceUri: 'host-resource://bracket' } };
for (const connectFirst of [true, false]) test(`native path handoff waits for input/result, initialization first=${connectFirst}`, async () => {
  const shown: OpenFile[] = [];
  let accept!: () => void;
  const shownFile = new Promise<void>(resolve => { accept = resolve; });
  const calls: unknown[] = [];
  const handoff = createFileHandoff({ async callServerTool(params) { calls.push(params); return { structuredContent: file }; } }, value => { shown.push(value); accept(); }, error => { throw error; });
  if (connectFirst) handoff.connected();
  assert.equal(calls.length, 0);
  handoff.input(input);
  handoff.result({ structuredContent: empty });
  if (!connectFirst) handoff.connected();
  await shownFile;
  assert.deepEqual(calls, [{ name: 'cad_open', arguments: { ...input, apiVersion: 2 } }]);
  assert.deepEqual(shown, [file]);
});
test('a late trusted-path response cannot replace the newer file or revive teardown', async () => {
  let finish!: (value: { structuredContent: OpenFile }) => void;
  const response = new Promise<{ structuredContent: OpenFile }>(resolve => { finish = resolve; });
  const shown: OpenFile[] = [];
  const handoff = createFileHandoff({ callServerTool: () => response }, value => shown.push(value), error => { throw error; });
  handoff.connected(); handoff.input(input); handoff.result({ structuredContent: empty });
  const newer = { document: { ...file.document, id: 'newer', path: '/outside/newer.step', name: 'newer.step' } };
  handoff.input({ path: 'newer.step' }); handoff.result({ structuredContent: { apiVersion: 2, ...newer } });
  finish({ structuredContent: file });
  await response; await Promise.resolve();
  assert.deepEqual(shown, [newer]);
  handoff.dispose(); handoff.result({ structuredContent: { apiVersion: 2, ...file } });
  assert.deepEqual(shown, [newer]);
});

test('native mounting resolves trusted document identity despite a previous same-name result', async () => {
  const original = { document: { id: 'other', path: '/other/bracket.step', name: 'bracket.step', revision: 'r1' } };
  const native = file;
  const shown: OpenFile[] = [];
  let ready!: () => void;
  const complete = new Promise<void>(resolve => { ready = resolve; });
  const handoff = createFileHandoff({ async callServerTool(params) {
    assert.deepEqual(params, { name: 'cad_open', arguments: { ...input, apiVersion: 2 } });
    return { structuredContent: native };
  } }, opened => { shown.push(opened); ready(); }, error => { throw error; });
  handoff.connected(); handoff.input(input); handoff.result({ structuredContent: { apiVersion: 2, ...original } });
  await complete; assert.deepEqual(shown, [native]); handoff.dispose();
});

test('matching native results avoid duplicate opens; malformed and failed results become visible errors', () => {
  const shown: OpenFile[] = [];
  const errors: Error[] = [];
  const handoff = createFileHandoff({ async callServerTool() { throw new Error('Unexpected duplicate open'); } }, value => shown.push(value), error => errors.push(error));
  handoff.connected(); handoff.input(input);
  const opened = { ...file, resourceUri: input.file.resourceUri };
  handoff.result({ structuredContent: { apiVersion: 2, ...opened } });
  assert.deepEqual(shown, [opened]);
  // A malformed ordinary result must never silently hang.
  handoff.input({}); handoff.result({ structuredContent: { unrecognized: true } });
  handoff.result({ isError: true, structuredContent: { error: { code: 'FILE_NOT_FOUND', message: 'The file was moved.' } } });
  assert.match(errors[0].message, /invalid file response/);
  assert.equal(errors[1].message, 'The file was moved.');
  handoff.dispose();
});

test('a cached legacy UUID is normalized before descriptor transport starts', async () => {
  let ready!: (value: OpenFile) => void;
  const shown = new Promise<OpenFile>(resolve => { ready = resolve; });
  const current = { document: { ...file.document, id: 'current-path-derived-id' } };
  const handoff = createFileHandoff({ async callServerTool(params) {
    assert.deepEqual(params.arguments, { apiVersion: 2, path: file.document.path });
    return { structuredContent: { apiVersion: 2, ...current } };
  } }, ready, error => { throw error; });
  handoff.connected(); handoff.input({}); handoff.result({ structuredContent: file });
  assert.deepEqual(await shown, current);
  handoff.dispose();
});
