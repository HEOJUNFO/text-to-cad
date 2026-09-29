/** All CAD bytes travel through the app's MCP connection, including worker resources. */
export interface ToolBridge {
  callServerTool(params: { name: string; arguments?: Record<string, unknown> }, options?: { signal?: AbortSignal }): Promise<{ isError?: boolean; structuredContent?: unknown; content?: unknown[] }>;
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
export function createBridgeFetch(bridge: ToolBridge): typeof fetch {
  return async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), CAD_ORIGIN), init);
    const url = new URL(request.url);
    if (url.origin !== CAD_ORIGIN) throw new Error('CAD resources must belong to the connected workspace.');
    request.signal.throwIfAborted();
    const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const args = { path: `${url.pathname}${url.search}`, method: request.method, ...(bytes ? { body: encodeBytes(bytes) } : {}) };
    async function read(extra: Record<string, unknown> = {}) {
      request.signal.throwIfAborted();
      const result = await bridge.callServerTool({ name: 'cad_request', arguments: { ...args, ...extra } }, { signal: request.signal });
      request.signal.throwIfAborted();
      if (result.isError) {
        const detail = result.content?.flatMap(block => block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? [(block as { text: string }).text] : []).join('\n');
        throw new Error(detail || 'The CAD backend could not complete this request.');
      }
      const response = result.structuredContent as Record<string, unknown> | undefined;
      if (!response || !Number.isInteger(response.status) || typeof response.body !== 'string' || !response.headers || typeof response.headers !== 'object') throw new Error('Invalid CAD transport response.');
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

export interface OpenFile { file: string | null; rootId: string; rootPath: string }
export function readOpenFile(value: unknown): OpenFile | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if ((typeof item.file !== 'string' && item.file !== null) || typeof item.rootId !== 'string' || !item.rootId || typeof item.rootPath !== 'string') return null;
  if (typeof item.file === 'string' && item.file && (item.file.startsWith('/') || /[\\\0]/.test(item.file) || item.file.split('/').some(part => !part || part === '..' || part === '.'))) return null;
  return item as unknown as OpenFile;
}
