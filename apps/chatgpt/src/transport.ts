/** All CAD bytes travel through the app's MCP connection, including worker resources. */
export interface ToolBridge {
  callServerTool(params: { name: string; arguments?: Record<string, unknown> }, options?: { signal?: AbortSignal; timeout?: number }): Promise<ToolResult>;
}
export interface ToolResult { isError?: boolean; structuredContent?: unknown; content?: unknown[] }
export const CAD_API_VERSION = 2;
export class CadBackendError extends Error {
  constructor(message: string, readonly code: string, readonly retryable = false) { super(message); this.name = 'CadBackendError'; }
}
export function toolData(result: ToolResult): Record<string, unknown> {
  const data = result.structuredContent;
  const object = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  if (result.isError || object?.error) {
    const error = object?.error as { message?: unknown; code?: unknown; retryable?: unknown } | undefined;
    const detail = result.content?.flatMap(block => block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? [(block as { text: string }).text] : []).join('\n');
    throw new CadBackendError(typeof error?.message === 'string' ? error.message : detail || 'The CAD backend could not complete this request.',
      typeof error?.code === 'string' ? error.code : 'BACKEND_ERROR', error?.retryable === true);
  }
  if (!object) throw new CadBackendError('CAD returned an invalid response. Reopen the extension to reconnect.', 'INVALID_RESPONSE');
  return object;
}
export interface BackendInfo { apiVersion: number; version: string; uiResourceUri: string }
export async function connectBackend(bridge: ToolBridge, signal?: AbortSignal): Promise<BackendInfo> {
  let result: ToolResult;
  try {
    result = await bridge.callServerTool({ name: 'cad_handshake', arguments: { apiVersion: CAD_API_VERSION } }, { signal, timeout: 15_000 });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new CadBackendError(`Could not connect to the CAD runtime. Reconnect the CAD plugin or restart Codex, then reopen this view. ${error instanceof Error ? error.message : String(error)}`, 'CONNECTION_FAILED', true);
  }
  const data = toolData(result);
  if (data.apiVersion !== CAD_API_VERSION || data.documentTransport !== 'descriptor') {
    throw new CadBackendError('The CAD interface and runtime are incompatible. Reconnect the CAD plugin or restart Codex to load the installed version.', 'API_VERSION_UNSUPPORTED');
  }
  return { apiVersion: CAD_API_VERSION, version: typeof data.serverVersion === 'string' ? data.serverVersion : 'unknown', uiResourceUri: typeof data.uiResourceUri === 'string' ? data.uiResourceUri : 'unknown' };
}
export const CAD_ORIGIN = 'http://cad.local';
export function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
export function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
export function createBridgeFetch(bridge: ToolBridge, document: CadDocument): typeof fetch {
  return async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), CAD_ORIGIN), init);
    const url = new URL(request.url);
    if (url.origin !== CAD_ORIGIN) throw new Error('CAD resources must belong to the opened document.');
    request.signal.throwIfAborted();
    const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const args = { apiVersion: CAD_API_VERSION, document, path: `${url.pathname}${url.search}`, method: request.method, ...(bytes ? { body: encodeBytes(bytes) } : {}) };
    async function read(extra: Record<string, unknown> = {}) {
      request.signal.throwIfAborted();
      const result = await bridge.callServerTool({ name: 'cad_request', arguments: { ...args, ...extra } }, { signal: request.signal, timeout: 60_000 });
      request.signal.throwIfAborted();
      const response = toolData(result);
      if (!Number.isInteger(response.status) || (response.status as number) < 200 || (response.status as number) > 599 || typeof response.body !== 'string' || !response.headers || typeof response.headers !== 'object' || Object.values(response.headers).some(value => typeof value !== 'string')) throw new Error('Invalid CAD transport response.');
      return response as { status: number; body: string; headers: Record<string, string>; transfer?: { offset: number; totalBytes: number; revision: string } };
    }
    const response = await read();
    let body = decodeBytes(response.body);
    if (response.transfer) {
      const { totalBytes, revision } = response.transfer;
      if (request.method !== 'GET' || response.transfer.offset !== 0 || !Number.isSafeInteger(totalBytes) || totalBytes <= 0 || typeof revision !== 'string' || !revision) throw new Error('Invalid CAD resource transfer.');
      const chunks = [body];
      let size = body.byteLength;
      if (!size || size > totalBytes) throw new Error('Invalid CAD resource chunk.');
      while (size < totalBytes) {
        const next = await read({ offset: size, revision });
        if (next.status !== response.status || next.transfer?.offset !== size || next.transfer.totalBytes !== totalBytes || next.transfer.revision !== revision) throw new Error('CAD resource changed during transfer. Reload the file.');
        const chunk = decodeBytes(next.body);
        if (!chunk.byteLength || size + chunk.byteLength > totalBytes) throw new Error('Invalid CAD resource chunk.');
        chunks.push(chunk); size += chunk.byteLength;
      }
      body = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    }
    return new Response(request.method === 'HEAD' || [204, 205, 304].includes(response.status) ? null : body, {
      status: response.status, headers: response.headers,
    });
  };
}

export interface CadDocument { id: string; path: string; name: string; revision: string }
export interface OpenFile { document: CadDocument | null; resourceUri?: string }
export function isDocumentPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.includes('\0')) return false;
  const prefix = path.match(/^(?:\/|[A-Za-z]:[\\/])/);
  if (!prefix) return false;
  const separator = prefix[0].at(-1)!;
  if (path.includes(separator === '/' ? '\\' : '/')) return false;
  return path.slice(prefix[0].length).split(separator).every(part => part && part !== '..' && part !== '.');
}
export function readOpenFile(value: unknown): OpenFile | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const resource = typeof item.resourceUri === 'string' ? { resourceUri: item.resourceUri } : {};
  if (item.document === null) return { document: null, ...resource };
  const document = item.document as Record<string, unknown> | undefined;
  if (!document || typeof document.id !== 'string' || !document.id || !isDocumentPath(document.path)
    || typeof document.name !== 'string' || !document.name || typeof document.revision !== 'string' || !document.revision) return null;
  return { document: document as unknown as CadDocument, ...resource };
}
