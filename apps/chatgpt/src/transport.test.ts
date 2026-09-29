import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCadClient } from '@text-to-cad/core/client';
import { connectBackend, createBridgeFetch, encodeBytes, readOpenFile, toolData } from './transport';

const document = { id: 'opened-document', path: '/parts/a.step', name: 'a.step', revision: 'r1' };

test('MCP fetch preserves binary response, request bytes, and worker transfer isolation', async () => {
  const calls: unknown[] = [];
  const fetch = createBridgeFetch({ async callServerTool(params) {
    calls.push(params);
    return { structuredContent: { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: encodeBytes(new Uint8Array([0, 255, 128])) } };
  } }, document);
  const response = await fetch('http://cad.local/__tess_cache/key', { method: 'POST', body: new Uint8Array([1, 2, 255]) });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 255, 128]);
  assert.deepEqual(calls[0], { name: 'cad_request', arguments: { apiVersion: 2, document, path: '/__tess_cache/key', method: 'POST', body: 'AQL/' } });
  const client = createCadClient({ origin: 'http://cad.local', scopeId: 'opened-document', fetch });
  try {
    const one = await client.resources.workerTicket('/__cad/asset?file=part.step');
    const two = await client.resources.workerTicket('/__cad/asset?file=part.step');
    assert.equal(one.kind, 'bytes'); assert.equal(two.kind, 'bytes');
    if (one.kind === 'bytes' && two.kind === 'bytes') assert.notEqual(one.bytes, two.bytes);
  } finally { client.dispose(); }
});
test('MCP fetch rejects foreign origins and aborted or invalid responses', async () => {
  let calls = 0;
  const fetch = createBridgeFetch({ async callServerTool() { calls++; return {}; } }, document);
  await assert.rejects(fetch('https://outside.example/file'), /opened document/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(fetch('/__cad/catalog', { signal: abort.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  await assert.rejects(fetch('/__cad/catalog'), { code: 'INVALID_RESPONSE' });
  const failure = createBridgeFetch({ async callServerTool() { return { isError: true, content: [{ type: 'text', text: 'STEP import failed: invalid shape' }] }; } }, document);
  await assert.rejects(failure('/__cad/artifact'), /STEP import failed: invalid shape/);
});
test('document handoff accepts global home and canonical absolute paths only', () => {
  assert.deepEqual(readOpenFile({ document: null }), { document: null });
  const document = { id: 'part', name: 'part.step', revision: 'r1', path: '/outside/project/part.step' };
  assert.deepEqual(readOpenFile({ document }), { document });
  for (const path of ['../secret.step', 'relative.step', '/a/../b.step', '/a/./b.step', '/a//b.step', '/a\\b.step', '/']) assert.equal(readOpenFile({ document: { ...document, path } }), null);
});
test('large resource chunks retain revision and byte order; mismatches fail without mixed bytes', async () => {
  const offsets: unknown[] = [];
  let mismatch = false;
  const fetch = createBridgeFetch({ async callServerTool({ arguments: args }) {
    assert.deepEqual(args?.document, document);
    assert.equal(args?.apiVersion, 2);
    offsets.push(args?.offset ?? 0);
    if (args?.offset) assert.equal(args.revision, 'revision-a');
    return { structuredContent: { status: 200, headers: {}, body: args?.offset ? 'AwQ=' : 'AQI=', transfer: {
      offset: args?.offset ?? 0, totalBytes: 4, revision: mismatch && args?.offset ? 'revision-b' : 'revision-a',
    } } };
  } }, document);
  assert.deepEqual([...new Uint8Array(await (await fetch('/__cad/asset?file=a.step')).arrayBuffer())], [1, 2, 3, 4]);
  assert.deepEqual(offsets, [0, 2]);
  mismatch = true;
  await assert.rejects(fetch('/__cad/asset?file=a.step'), /changed during transfer/);
});

test('startup negotiates document transport and preserves actionable backend failures', async () => {
  const info = await connectBackend({ async callServerTool({ name, arguments: args }) {
    assert.equal(name, 'cad_handshake'); assert.deepEqual(args, { apiVersion: 2 });
    return { structuredContent: { apiVersion: 2, documentTransport: 'descriptor', serverVersion: '1.2.3', uiResourceUri: 'ui://cad/viewer/v2/build.html' } };
  } });
  assert.equal(info.version, '1.2.3');
  await assert.rejects(connectBackend({ async callServerTool() { return { structuredContent: { apiVersion: 1 } }; } }), { code: 'API_VERSION_UNSUPPORTED' });
  await assert.rejects(connectBackend({ async callServerTool() { throw new Error('Unknown tool: cad_handshake'); } }), { code: 'CONNECTION_FAILED' });
  assert.throws(() => toolData({ isError: true, structuredContent: { error: { code: 'FILE_NOT_FOUND', message: 'The selected CAD file was moved.', retryable: false } } }), { code: 'FILE_NOT_FOUND', message: 'The selected CAD file was moved.' });
});
