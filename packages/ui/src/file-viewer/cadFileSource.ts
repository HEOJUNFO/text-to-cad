import type { CadEntry, CadServerInfo, CadWorkspaceService } from '@text-to-cad/core/client';
import type { FileBrowserSource, FileChange, FileEntry, FileMetadata } from './types.js';

export const catalogPath = (entry: CadEntry): string => String(entry.rootRelativeFile || entry.file || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

/** Catalog access remains read-only; the shared viewer derives menus from these capabilities. */
export function createCadFileSource(client: CadWorkspaceService, server: CadServerInfo): FileBrowserSource {
  const paths = () => client.getSnapshot().entries.map(catalogPath).filter(Boolean);
  async function ready(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!client.getSnapshot().hydrated) await client.refresh({ signal });
    signal.throwIfAborted();
  }
  return {
    id: server.rootId,
    rootName: 'This directory',
    async stat(path, { signal }): Promise<FileMetadata> {
      const entry = await client.resolveEntry(path, { signal });
      signal.throwIfAborted();
      const relative = catalogPath(entry);
      return { path: relative, name: relative.split('/').pop() || relative, kind: 'file', size: Number(entry.bytes || 0), extension: relative.split('.').pop()?.toLowerCase() || '', mediaType: 'cad', revision: contentRevision(entry) };
    },
    async list(directory, { signal }) {
      await ready(signal);
      const prefix = directory ? `${directory}/` : '';
      const entries = new Map<string, FileEntry>();
      for (const path of paths()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (!rest) continue;
        const name = rest.split('/')[0];
        const child = prefix + name;
        entries.set(child, { path: child, name, kind: rest.includes('/') ? 'directory' : 'file' });
      }
      return [...entries.values()].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    },
    async paths({ signal }) { await ready(signal); return paths(); },
    subscribe(listener) {
      let previous = client.getSnapshot().entries;
      return client.subscribe(() => {
        const current = client.getSnapshot().entries;
        if (current === previous) return;
        const before = new Map(previous.map(entry => [catalogPath(entry), entry]));
        const after = new Map(current.map(entry => [catalogPath(entry), entry]));
        const changes: FileChange[] = [];
        for (const path of new Set([...before.keys(), ...after.keys()])) {
          const oldEntry = before.get(path), entry = after.get(path);
          if (!oldEntry) changes.push({ kind: 'added', path, entryKind: 'file' });
          else if (!entry) changes.push({ kind: 'deleted', path, entryKind: 'file' });
          else if (contentRevision(oldEntry) !== contentRevision(entry)) changes.push({ kind: 'content', path, revision: contentRevision(entry) });
          else if (JSON.stringify(oldEntry) !== JSON.stringify(entry)) changes.push({ kind: 'metadata', path });
        }
        previous = current;
        if (changes.length) listener({ sourceId: server.rootId, changes });
      });
    },
  };
}

/** Render-affecting revisions, not transient compiler progress, invalidate the document. */
function contentRevision(entry: CadEntry): string {
  return JSON.stringify([entry.hash, entry.documentHash, entry.animationHash, entry.appearanceHash, entry.url, entry.relations, entry.sourceSidecar, entry.mtime, entry.bytes]);
}
