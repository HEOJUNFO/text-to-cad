import type { ClipboardPort } from '@text-to-cad/ui/host';
import type { FileActions } from '@text-to-cad/ui/file-viewer';
import { catalogPath } from '@text-to-cad/ui/file-viewer';
import type { createCadClient, CadServerInfo } from '@text-to-cad/core/client';

export type CadClient = ReturnType<typeof createCadClient>;

export function createWebFileActions(client: CadClient, server: CadServerInfo, { clipboard }: {
  clipboard: ClipboardPort;
}): FileActions {
  const copy = async (entry: { path: string }, absolute = false) => {
    const catalogEntry = client.getSnapshot().entries.find(candidate => catalogPath(candidate) === entry.path);
    if (!catalogEntry) return;
    const rootPath = String(server.rootPath || '').replace(/[\\/]+$/, '');
    const rawPath = String(catalogEntry.file).trim().replace(/\\/g, '/');
    const rootPrefix = rootPath.replace(/\\/g, '/');
    const relativePath = rawPath.startsWith(`${rootPrefix}/`) ? rawPath.slice(rootPrefix.length + 1) : catalogPath(catalogEntry);
    const text = absolute ? `${rootPath}${rootPath.includes('\\') ? '\\' : '/'}${rootPath.includes('\\') ? relativePath.replace(/\//g, '\\') : relativePath}` : relativePath;
    await clipboard.writeText(text);

  };
  return {
    platform: server.platform === 'darwin' || server.platform === 'win32' || server.platform === 'linux' ? server.platform : navigator.userAgent.includes('Macintosh') ? 'darwin' : navigator.userAgent.includes('Windows') ? 'win32' : 'linux',
    perform: {
      'copy-relative-path': entry => copy(entry),
      ...(Array.isArray(server.serverFeatures) && server.serverFeatures.includes('reveal-path') ? {
        async reveal(entry: { path: string }) {
          const response = await fetch('/__cad/reveal', { method: 'POST',
            headers: { 'x-cadgen-viewer': '1', 'content-type': 'application/json' },
            body: JSON.stringify({ path: entry.path }) });
          if (!response.ok) {
            const detail = await response.json().catch(() => null);
            throw new Error(detail?.error || 'Could not reveal this file in the file manager.');
          }
        },
      } : {}),
      ...((server.backend || 'local-fs') === 'local-fs' && server.rootPath ? { 'copy-path': (entry: { path: string }) => copy(entry, true) } : {}),
    },
  };
}
