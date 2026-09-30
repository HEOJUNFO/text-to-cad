import type { DirectorySource, FileEntry } from '@text-to-cad/ui/file-viewer';
import { CAD_API_VERSION, toolData, type ToolBridge } from './transport';

export interface BrowseLocation {
  root: { path: string | null; name: string };
  parent: string | null;
  home: string;
}
interface Listing extends BrowseLocation { directory: string | null; entries: FileEntry[] }
const windowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path);
const normalized = (path: string) => windowsPath(path) ? path.replace(/\\/g, '/') : path;

/** UI paths are relative to the browsing location; document paths remain absolute. */
export function relativeBrowsePath(root: string | null, absolute: string): string | null {
  const path = normalized(absolute);
  if (root === null) return /^[A-Za-z]:\//.test(path) ? path.replace(/\/$/, '') : null;
  const base = normalized(root).replace(/\/$/, '');
  const compare = windowsPath(root) ? (value: string) => value.toLowerCase() : (value: string) => value;
  if (compare(path.replace(/\/$/, '')) === compare(base)) return '';
  return compare(path).startsWith(compare(`${base}/`)) ? path.slice(base.length + 1) : null;
}
export function absoluteBrowsePath(root: string | null, relative: string): string | null {
  if (!relative) return root;
  if (relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid browsing path.');
  if (root === null) {
    if (!/^[A-Za-z]:(?:\/|$)/.test(relative)) throw new Error('Select a drive to browse.');
    return (relative.length === 2 ? `${relative}/` : relative).replace(/\//g, '\\');
  }
  const path = `${normalized(root).replace(/\/$/, '')}/${relative}`;
  return windowsPath(root) ? path.replace(/\//g, '\\') : path;
}
export async function readDirectory(bridge: ToolBridge, browseRoot: string | null, directory: string | null, signal: AbortSignal): Promise<Listing> {
  signal.throwIfAborted();
  const data = toolData(await bridge.callServerTool({ name: 'cad_browse', arguments: {
    apiVersion: CAD_API_VERSION, browseRoot, directory, includeHidden: true,
  } }, { signal, timeout: 15_000 }));
  signal.throwIfAborted();
  const root = data.root as BrowseLocation['root'] | undefined;
  if (!root || !(root.path === null || typeof root.path === 'string') || typeof root.name !== 'string'
    || !(data.parent === null || typeof data.parent === 'string') || typeof data.home !== 'string'
    || !(data.directory === null || typeof data.directory === 'string') || !Array.isArray(data.entries)
    || data.entries.some(entry => !entry || typeof entry.path !== 'string' || typeof entry.name !== 'string' || !['file', 'directory'].includes(entry.kind))) {
    throw new Error('CAD returned an invalid directory listing. Reconnect the plugin.');
  }
  return data as unknown as Listing;
}
export function createDirectorySource(bridge: ToolBridge, location: BrowseLocation): DirectorySource {
  const root = location.root.path;
  const id = `cad-browser:${root ?? 'computer'}`;
  return {
    id, rootName: location.root.name,
    async list(directory, { signal }) {
      const result = await readDirectory(bridge, root, absoluteBrowsePath(root, directory), signal);
      return result.entries.map(entry => {
        const path = relativeBrowsePath(root, entry.path);
        if (path === null || !path) throw new Error('CAD returned a file outside the browsing location.');
        return { ...entry, path };
      });
    },
    // Re-read already loaded directories on return; never scan an entire disk.
    subscribe(listener) {
      const refresh = () => { if (document.visibilityState !== 'hidden') listener({ sourceId: id, changes: [] }); };
      window.addEventListener('focus', refresh);
      document.addEventListener('visibilitychange', refresh);
      return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
    },
  };
}
