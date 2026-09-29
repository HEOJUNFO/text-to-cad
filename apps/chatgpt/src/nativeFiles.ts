import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { App } from '@modelcontextprotocol/ext-apps';
/** The host acknowledges an open request; it does not attest that rendering finished. */
export function createNativeFiles(app: App) {
  return {
    available: () => Boolean(app.getHostCapabilities()?.experimental?.['openai/files']),
    async open(path: string) {
      if (!app.getHostCapabilities()?.experimental?.['openai/files']) throw new Error('This host does not support opening files from an app.');
      await app.request({ method: 'openai/files/open', params: { path } }, EmptyResultSchema);
    },
  };
}
