import { CAD_API_VERSION, CadBackendError, readOpenFile, toolData, type OpenFile, type ToolBridge, type ToolResult } from './transport';

/** Tool input/results may arrive on either side of the initialization promise. */
export function createFileHandoff(bridge: ToolBridge, show: (opened: OpenFile) => void, fail: (error: Error) => void, loading: () => void = () => {}) {
  let connected = false;
  let disposed = false;
  let generation = 0;
  let input: Record<string, unknown> = {};
  let active: AbortController | undefined;
  let pending: { result: ToolResult; input: Record<string, unknown>; generation: number; reload?: boolean } | undefined;
  async function resolve(item: NonNullable<typeof pending>) {
    active?.abort();
    const controller = new AbortController(); active = controller;
    loading();
    try {
      const data = item.reload ? null : toolData(item.result);
      let opened = readOpenFile(data);
      const file = item.input.file as { resourceUri?: string } | undefined;
      // A matching initial native result already contains the trusted path.
      // Only unresolved/stale native inputs need a second server call.
      const legacyDocument = data?.apiVersion !== CAD_API_VERSION ? opened?.document : null;
      if (item.reload || legacyDocument || (file && (!opened?.document || opened.resourceUri !== file.resourceUri))) {
        const args = legacyDocument && !file ? { path: legacyDocument.path } : item.input;
        const result = await bridge.callServerTool({ name: 'cad_open', arguments: { ...args, apiVersion: CAD_API_VERSION } }, { signal: controller.signal, timeout: 30_000 });
        opened = readOpenFile(toolData(result));
        if (file && !opened?.document) throw new CadBackendError('The host did not provide the CAD file path. Open the file again in Codex.', 'FILE_PATH_UNAVAILABLE');
      }
      if (!opened) throw new CadBackendError('CAD returned an invalid file response. Reconnect the plugin and reopen the file.', 'INVALID_RESPONSE');
      if (!disposed && item.generation === generation) show(opened);
    } catch (error) {
      if (!disposed && !controller.signal.aborted && item.generation === generation) fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return {
    input(value: Record<string, unknown>) { input = value; generation++; active?.abort(); },
    result(result: ToolResult) {
      if (disposed) return;
      const item = { result, input, generation: ++generation };
      if (connected) void resolve(item);
      else pending = item;
    },
    connected() {
      if (disposed) return;
      connected = true;
      if (pending) { const item = pending; pending = undefined; void resolve(item); }
    },
    retry() {
      if (!disposed && connected) void resolve({ result: {}, input, generation: ++generation, reload: true });
    },
    cancel(reason: string) {
      generation++; active?.abort(); pending = undefined;
      if (!disposed) fail(new CadBackendError(reason || 'Opening the CAD file was cancelled.', 'CANCELLED'));
    },
    dispose() { disposed = true; generation++; active?.abort(); pending = undefined; },
  };
}
