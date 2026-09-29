import { createPromptDeliveryLedger, formatPromptReference, validatePromptContext } from '@text-to-cad/core/prompt';
import type { PromptContextPort, PromptDestinationState, ResourceRef } from '@text-to-cad/core/prompt';
import { encodeBytes } from './transport';

export type ContextBlock = { type: 'text'; text: string; _meta?: Record<string, unknown> } | { type: 'image'; data: string; mimeType: string; _meta?: Record<string, unknown> };
export interface ContextBridge {
  updateModelContext(params: { content: ContextBlock[] }): Promise<unknown>;
}
const LIMIT = 20 * 1024 * 1024;
const TEXT_LIMIT = 256 * 1024;
const textBytes = (block: ContextBlock) => new TextEncoder().encode(
  (block.type === 'text' ? block.text : '') + (typeof block._meta?.['openai/title'] === 'string' ? block._meta['openai/title'] : ''),
).byteLength;
// Count accepted PNGs without decoding or copying their accumulated payload again.
const imageBytes = (block: ContextBlock) => block.type === 'image'
  ? Math.floor(block.data.length * 3 / 4) - (block.data.endsWith('==') ? 2 : block.data.endsWith('=') ? 1 : 0)
  : 0;
const unavailable: PromptDestinationState = { kind: 'unavailable', available: false, reason: 'This host does not support composer context attachments.' };
const available: PromptDestinationState = { kind: 'composer', available: true, capabilities: {
  attachments: 'png', maxParts: 128, maxAttachmentBytes: LIMIT, maxTotalAttachmentBytes: LIMIT, mixedTextAndImage: 'atomic',
} };

/** Host context is authoritative: replacing it after a removal must not resurrect deleted items. */
export function createComposerContext(bridge: ContextBridge, workspaceId: string, rootPath: string) {
  const ledger = createPromptDeliveryLedger({ maxPending: 1 });
  const listeners = new Set<() => void>();
  let destination = unavailable;
  let content: ContextBlock[] = [];
  let revision = 0;
  let disposed = false;
  const resolvePath = (resource: ResourceRef) => {
    if (resource.kind === 'url' || resource.workspaceId !== workspaceId) throw new Error('The reference belongs to another workspace.');
    return `${rootPath.replace(/[\\/]+$/, '')}/${resource.path}`;
  };
  const port: PromptContextPort = {
    getSnapshot: () => destination,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    deliver(context) {
      // Captures begin in the gesture even when another part later fails validation.
      // Observe every encoder so an unavailable destination cannot orphan a rejection.
      for (const part of context.parts ?? []) if (part.kind === 'attachment') void Promise.resolve(part.content).catch(() => {});
      return ledger.deliver(context.operationId, async () => {
        validatePromptContext(context);
        if (!destination.available || disposed) return { status: 'failed', message: destination.reason };
        if (content.length + context.parts.length > 128) throw new Error('Remove some CAD attachments before adding more.');
        const boundRevision = revision;
        let attachmentBytes = content.reduce((total, block) => total + imageBytes(block), 0);
        let accumulatedTextBytes = content.reduce((total, block) => total + textBytes(block), 0);
        if (attachmentBytes > LIMIT) throw new Error('Remove some CAD images before adding more; combined images are limited to 20 MiB.');
        const addition: ContextBlock[] = [];
        const append = (block: ContextBlock) => {
          accumulatedTextBytes += textBytes(block);
          if (accumulatedTextBytes > TEXT_LIMIT) throw new Error('Remove some CAD attachments before adding more; combined text is limited to 256 KiB.');
          addition.push(block);
        };
        for (const part of context.parts) {
          if (part.kind === 'text') append({ type: 'text', text: part.text, _meta: { 'openai/title': 'CAD note' } });
          else if (part.kind === 'reference') {
            const ref = part.reference;
            const path = resolvePath(ref.resource);
            const text = formatPromptReference(ref, { resolvePath: () => path });
            const filename = path.split(/[\\/]/).pop() || path;
            const title = ref.label ? `${filename} · ${ref.label}` : formatPromptReference(ref, { resolvePath: () => filename });
            // Codex owns the aggregate Context chip. The block title and first
            // text line label its popup; the canonical reference stays intact.
            const described = `${title}\n${text}`;
            append({ type: 'text', text: ref.resource.revision ? `${described}\nDocument revision: ${ref.resource.revision}` : described,
              _meta: { 'openai/title': title } });
          } else {
            if (destination.capabilities?.attachments === 'none') throw new Error('This host does not support image attachments.');
            const blob = await part.content;
            attachmentBytes += blob.size;
            if (part.mimeType !== 'image/png' || blob.type !== 'image/png' || !blob.size || blob.size > LIMIT) throw new Error('Only PNG attachments up to 20 MiB are supported.');
            if (attachmentBytes > LIMIT) throw new Error('Remove some CAD images before adding more; combined images are limited to 20 MiB.');
            append({ type: 'image', data: encodeBytes(new Uint8Array(await blob.arrayBuffer())), mimeType: 'image/png', _meta: { 'openai/title': part.name } });
          }
        }
        if (disposed || boundRevision !== revision || !destination.available) return { status: 'cancelled', message: 'Composer context changed. Add the selection again.' };
        const next = [...content, ...addition];
        await bridge.updateModelContext({ content: next });
        // A host notification may already reflect the accepted update (or a later user removal).
        if (boundRevision === revision) { content = next; revision += 1; }
        return { status: 'added', partIds: context.parts.map(part => part.id) };
      });
    },
  };
  return {
    port,
    setCapabilities(capabilities: unknown) {
      const caps = capabilities as { experimental?: Record<string, unknown>; updateModelContext?: { text?: unknown; image?: unknown } } | undefined;
      destination = !disposed && caps?.experimental?.['openai/modelContext'] && caps.updateModelContext?.text
        ? caps.updateModelContext.image ? available : { ...available, capabilities: { ...available.capabilities!, attachments: 'none', mixedTextAndImage: 'unsupported' } }
        : unavailable;
      for (const listener of listeners) listener();
    },
    syncHostContext(context: Record<string, unknown>) {
      if (!Object.hasOwn(context, 'openai/modelContext')) return;
      const value = context['openai/modelContext'] as { content?: ContextBlock[] } | null;
      content = Array.isArray(value?.content) ? value.content : [];
      revision += 1;
    },
    dispose() { disposed = true; destination = unavailable; revision += 1; listeners.clear(); },
  };
}
