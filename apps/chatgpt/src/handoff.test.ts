import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFileHandoff } from './handoff';
import type { OpenFile } from './transport';
const empty = { file: null, rootId: 'plugin', rootPath: '/plugin' };
const file = { file: 'bracket.step', rootId: 'project', rootPath: '/project' };
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
  handoff.result(empty);
  if (!connectFirst) handoff.connected();
  await shownFile;
  assert.deepEqual(calls, [{ name: 'cad_open', arguments: input }]);
  assert.deepEqual(shown, [file]);
});
test('a late trusted-path response cannot replace the newer file or revive teardown', async () => {
  let finish!: (value: { structuredContent: OpenFile }) => void;
  const response = new Promise<{ structuredContent: OpenFile }>(resolve => { finish = resolve; });
  const shown: OpenFile[] = [];
  const handoff = createFileHandoff({ callServerTool: () => response }, value => shown.push(value), error => { throw error; });
  handoff.connected(); handoff.input(input); handoff.result(empty);
  const newer = { ...file, file: 'newer.step' };
  handoff.input({ path: 'newer.step' }); handoff.result(newer);
  finish({ structuredContent: file });
  await response; await Promise.resolve();
  assert.deepEqual(shown, [newer]);
  handoff.dispose(); handoff.result(file);
  assert.deepEqual(shown, [newer]);
});

test('native mounting rebinds a nonempty repo-root result to the host file root', async () => {
  const original = { file: 'nested/bracket.step', rootId: 'repo', rootPath: '/repo' };
  const native = { file: 'bracket.step', rootId: 'native', rootPath: '/repo/nested' };
  const shown: OpenFile[] = [];
  let ready!: () => void;
  const complete = new Promise<void>(resolve => { ready = resolve; });
  const handoff = createFileHandoff({ async callServerTool(params) {
    assert.deepEqual(params, { name: 'cad_open', arguments: input });
    return { structuredContent: native };
  } }, opened => { shown.push(opened); ready(); }, error => { throw error; });
  handoff.connected(); handoff.input(input); handoff.result(original);
  await complete; assert.deepEqual(shown, [native]); handoff.dispose();
});
