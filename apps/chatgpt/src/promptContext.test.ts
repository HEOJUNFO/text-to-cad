import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPromptContext } from '@text-to-cad/core/prompt';
import { createComposerContext, type ContextBlock } from './promptContext';
const caps = { experimental: { 'openai/modelContext': {} }, updateModelContext: { text: {}, image: {} } };
const reference = { id: 'face', kind: 'reference' as const, reference: { label: 'Bracket · Face 3', resource: { kind: 'workspace-file' as const, workspaceId: 'root', path: 'parts/bracket.step', revision: 'sha256:a' }, target: { kind: 'cad-selector' as const, selectors: ['f3'] } } };
test('titled composer attachments preserve revisions, deduplicate deliveries and honor user removals', async () => {
  const updates: ContextBlock[][] = [];
  const composer = createComposerContext({ async updateModelContext({ content }) { updates.push(content); } }, 'root', '/project');
  assert.equal(composer.port.getSnapshot().available, false);
  composer.setCapabilities(caps);
  const context = createPromptContext([reference], 'selection');
  assert.equal((await composer.port.deliver(context)).status, 'added');
  await composer.port.deliver(context);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0]._meta?.['openai/title'], 'Bracket · Face 3');
  assert.match((updates[0][0] as { text: string }).text, /\/project\/parts\/bracket.step#f3\nDocument revision: sha256:a/);
  composer.syncHostContext({ 'openai/modelContext': null });
  await composer.port.deliver(createPromptContext([reference], 'after-removal'));
  assert.equal(updates[1].length, 1);
});
test('capture freezes composer revision and rejects changes before delivery', async () => {
  let resolve!: (blob: Blob) => void;
  const content = new Promise<Blob>(done => { resolve = done; });
  let sent = 0;
  const composer = createComposerContext({ async updateModelContext() { sent++; } }, 'root', '/project');
  composer.setCapabilities(caps);
  const pending = composer.port.deliver(createPromptContext([{ id: 'image', kind: 'attachment', name: 'View', mimeType: 'image/png', content }]));
  composer.syncHostContext({ 'openai/modelContext': { content: [] } });
  resolve(new Blob(['PNG'], { type: 'image/png' }));
  assert.equal((await pending).status, 'cancelled');
  assert.equal(sent, 0);
});
test('workspace mismatch and rejected host update never report acceptance; failure can retry', async () => {
  let fail = true;
  const composer = createComposerContext({ async updateModelContext() { if (fail) throw new Error('Rejected'); } }, 'root', '/project');
  composer.setCapabilities(caps);
  const context = createPromptContext([reference], 'retry');
  assert.equal((await composer.port.deliver(context)).status, 'failed');
  fail = false;
  assert.equal((await composer.port.deliver(context)).status, 'added');
  assert.equal((await composer.port.deliver(createPromptContext([{ ...reference, reference: { ...reference.reference, resource: { ...reference.reference.resource, workspaceId: 'other' } } }]))).status, 'failed');
});

test('text-only context hosts support references and decline images', async () => {
  const composer = createComposerContext({ async updateModelContext() {} }, 'root', '/project');
  composer.setCapabilities({ experimental: { 'openai/modelContext': {} }, updateModelContext: { text: {} } });
  assert.equal(composer.port.getSnapshot().available, true);
  assert.equal(composer.port.getSnapshot().capabilities?.attachments, 'none');
  assert.equal((await composer.port.deliver(createPromptContext([reference]))).status, 'added');
  assert.equal((await composer.port.deliver(createPromptContext([{ id: 'image', kind: 'attachment', name: 'View', mimeType: 'image/png', content: new Blob(['PNG'], { type: 'image/png' }) }]))).status, 'failed');
});

test('replacement context bounds accumulated images and text, with capacity restored by removal', async () => {
  let sends = 0;
  const composer = createComposerContext({ async updateModelContext() { sends++; } }, 'root', '/project');
  composer.setCapabilities(caps);
  const limit = 20 * 1024 * 1024;
  const existingImage = { type: 'image', mimeType: 'image/png', data: 'A'.repeat(4 * Math.ceil(limit / 3) - 1) + '=' };
  composer.syncHostContext({ 'openai/modelContext': { content: [existingImage] } });
  const image = createPromptContext([{ id: 'image', kind: 'attachment', name: 'View', mimeType: 'image/png', content: new Blob(['PNG'], { type: 'image/png' }) }], 'full-image-context');
  const full = await composer.port.deliver(image);
  assert.equal(full.status, 'failed');
  assert.match('message' in full ? full.message || '' : '', /combined images/);
  assert.equal(sends, 0);
  composer.syncHostContext({ 'openai/modelContext': { content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }] } });
  const text = await composer.port.deliver(createPromptContext([reference]));
  assert.equal(text.status, 'failed');
  assert.match('message' in text ? text.message || '' : '', /combined text/);
  assert.equal(sends, 0);
  composer.syncHostContext({ 'openai/modelContext': null });
  assert.equal((await composer.port.deliver(image)).status, 'added');
  assert.equal(sends, 1);
});
