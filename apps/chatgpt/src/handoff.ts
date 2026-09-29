import { readOpenFile, type OpenFile, type ToolBridge } from './transport';

/** Tool input/results may arrive on either side of the initialization promise. */
export function createFileHandoff(bridge: ToolBridge, show: (opened: OpenFile) => void, fail: (error: Error) => void) {
  let connected = false;
  let disposed = false;
  let generation = 0;
  let input: Record<string, unknown> = {};
  let pending: { opened: OpenFile; input: Record<string, unknown>; generation: number } | undefined;
  async function resolve(item: NonNullable<typeof pending>) {
    try {
      let opened = item.opened;
      if (!opened.file && item.input.file) {
        // Native entrypoints learn their trusted path only after the view mounts.
        const result = await bridge.callServerTool({ name: 'cad_open', arguments: item.input });
        const resolved = readOpenFile(result.structuredContent);
        if (result.isError || !resolved?.file) throw new Error('The host did not provide the CAD file path. Open the file again in Codex.');
        opened = resolved;
      }
      if (!disposed && item.generation === generation) show(opened);
    } catch (error) {
      if (!disposed && item.generation === generation) fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return {
    input(value: Record<string, unknown>) { input = value; },
    result(value: unknown) {
      const opened = readOpenFile(value);
      if (!opened || disposed) return;
      const item = { opened, input, generation: ++generation };
      if (connected) void resolve(item);
      else pending = item;
    },
    connected() {
      if (disposed) return;
      connected = true;
      if (pending) { const item = pending; pending = undefined; void resolve(item); }
    },
    dispose() { disposed = true; generation++; pending = undefined; },
  };
}
