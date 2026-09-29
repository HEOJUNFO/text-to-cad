import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCadClient } from '@text-to-cad/core/client';
import { createBridgeFetch, encodeBytes, readOpenFile } from './transport';

test('MCP fetch preserves binary response, request bytes, and worker transfer isolation', async () => {
  const calls: unknown[] = [];
  const fetch = createBridgeFetch({ async callServerTool(params) {
    calls.push(params);
    return { structuredContent: { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: encodeBytes(new Uint8Array([0, 255, 128])) } };
  } });
  const response = await fetch('http://cad.local/__tess_cache/key', { method: 'POST', body: new Uint8Array([1, 2, 255]) });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 255, 128]);
  assert.deepEqual(calls[0], { name: 'cad_request', arguments: { path: '/__tess_cache/key', method: 'POST', body: 'AQL/' } });
  const client = createCadClient({ origin: 'http://cad.local', workspaceId: 'root', fetch });
  try {
    const one = await client.resources.workerTicket('/__cad/asset?file=part.step');
    const two = await client.resources.workerTicket('/__cad/asset?file=part.step');
    assert.equal(one.kind, 'bytes'); assert.equal(two.kind, 'bytes');
    if (one.kind === 'bytes' && two.kind === 'bytes') assert.notEqual(one.bytes, two.bytes);
  } finally { client.dispose(); }
});
test('MCP fetch rejects foreign origins and aborted or invalid responses', async () => {
  let calls = 0;
  const fetch = createBridgeFetch({ async callServerTool() { calls++; return {}; } });
  await assert.rejects(fetch('https://outside.example/file'), /connected workspace/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(fetch('/__cad/catalog', { signal: abort.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  await assert.rejects(fetch('/__cad/catalog'), /Invalid CAD transport/);
  const failure = createBridgeFetch({ async callServerTool() { return { isError: true, content: [{ type: 'text', text: 'STEP import failed: invalid shape' }] }; } });
  await assert.rejects(failure('/__cad/artifact'), /STEP import failed: invalid shape/);
});
test('file handoff accepts empty thread view and rejects path traversal', () => {
  assert.deepEqual(readOpenFile({ file: null, rootId: 'root', rootPath: '/project' }), { file: null, rootId: 'root', rootPath: '/project' });
  for (const file of ['../secret.step', '/secret.step', 'a/../b.step', 'a\\b.step']) assert.equal(readOpenFile({ file, rootId: 'root', rootPath: '/project' }), null);
});
test('large resource chunks retain revision and byte order; mismatches fail without mixed bytes', async () => {
  const offsets: unknown[] = [];
  let mismatch = false;
  const fetch = createBridgeFetch({ async callServerTool({ arguments: args }) {
    offsets.push(args?.offset ?? 0);
    if (args?.offset) assert.equal(args.revision, 'revision-a');
    return { structuredContent: { status: 200, headers: {}, body: args?.offset ? 'AwQ=' : 'AQI=', transfer: {
      offset: args?.offset ?? 0, totalBytes: 4, revision: mismatch && args?.offset ? 'revision-b' : 'revision-a',
    } } };
  } });
  assert.deepEqual([...new Uint8Array(await (await fetch('/__cad/asset?file=a.step')).arrayBuffer())], [1, 2, 3, 4]);
  assert.deepEqual(offsets, [0, 2]);
  mismatch = true;
  await assert.rejects(fetch('/__cad/asset?file=a.step'), /changed during transfer/);
});
