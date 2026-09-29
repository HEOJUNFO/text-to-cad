import type { CadEntry, CadServerInfo, CadService } from '@text-to-cad/core/client';
import type { DocumentSource, FileBrowserSource, FileChange, FileEntry, FileMetadata } from './types.js';

export const catalogPath = (entry: CadEntry): string => String(entry.rootRelativeFile || entry.file || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

/** Catalog access remains read-only; the shared viewer derives menus from these capabilities. */
export function createCadFileSource(client: CadService, server: CadServerInfo): FileBrowserSource {
  const sourceId = server.rootId;
  if (!sourceId) throw new Error('Directory browsing requires a server rootId.');
  const paths = () => client.getSnapshot().entries.map(catalogPath).filter(Boolean);
  async function ready(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!client.getSnapshot().hydrated) await client.refresh({ signal });
    signal.throwIfAborted();
  }
  return {
    id: sourceId,
    rootName: 'This directory',
    async stat(path, { signal }): Promise<FileMetadata> {
      const entry = await client.resolveEntry(path, { signal });
      signal.throwIfAborted();
      const relative = catalogPath(entry);
      return cadMetadata(entry, relative);
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
        if (changes.length) listener({ sourceId, changes });
      });
    },
  };
}

/** A host-authorized document, independent of catalog browsing or a workspace root. */
export interface CadDocumentDescriptor { id: string; path: string; name: string; revision?: string | null }

/** One absolute document from a CAD catalog. No directory or other-file discovery is exposed. */
export function createCadDocumentSource(client: CadService, document: CadDocumentDescriptor): DocumentSource {
  if (!document.id || !document.path || !document.name) throw new TypeError('A CAD document requires an id, path and name.');
  const entryAt = (entries: readonly CadEntry[]) => entries.find(entry => entry.file === document.path);
  return {
    id: document.id,
    async stat(path, { signal }) {
      if (path !== document.path) throw new Error('This source can open only its authorized document.');
      const entry = await client.resolveEntry(path, { signal });
      signal.throwIfAborted();
      if (entry.file !== document.path) throw new Error('The catalog resolved a different document.');
      return cadMetadata(entry, document.path, document.name);
    },
    resourceRef(file) {
      if (file.path !== document.path) throw new Error('This reference belongs to another document.');
      const revision = file.revision ?? document.revision;
      return { kind: 'local-file', path: document.path, ...(revision == null ? {} : { revision }) };
    },
    subscribe(listener) {
      let previous = entryAt(client.getSnapshot().entries);
      // The client records this exact file for its scoped refresh when subscription
      // starts before the first stat has finished.
      void client.resolveEntry(document.path).catch(() => {});
      return client.subscribe(() => {
        const current = entryAt(client.getSnapshot().entries);
        if (current === previous) return;
        const changes: FileChange[] = [];
        if (!previous && current) changes.push({ kind: 'added', path: document.path, entryKind: 'file' });
        else if (previous && !current) changes.push({ kind: 'deleted', path: document.path, entryKind: 'file' });
        else if (previous && current && contentRevision(previous) !== contentRevision(current))
          changes.push({ kind: 'content', path: document.path, revision: contentRevision(current) });
        else if (previous && current && JSON.stringify(previous) !== JSON.stringify(current))
          changes.push({ kind: 'metadata', path: document.path });
        previous = current;
        if (changes.length) listener({ sourceId: document.id, changes });
      });
    },
  };
}

function cadMetadata(entry: CadEntry, path: string, name = path.split('/').pop() || path): FileMetadata {
  return { path, name, kind: 'file', size: Number(entry.bytes || 0), extension: name.split('.').pop()?.toLowerCase() || '', mediaType: 'cad', revision: contentRevision(entry) };
}

/** Render-affecting revisions, not transient compiler progress, invalidate the document. */
function contentRevision(entry: CadEntry): string {
  return JSON.stringify([entry.hash, entry.documentHash, entry.animationHash, entry.appearanceHash, entry.url, entry.relations, entry.sourceSidecar, entry.mtime, entry.bytes]);
}
