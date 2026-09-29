import { isDocumentPath, type ToolBridge } from './transport';
export interface RecentModel {
  id: string; path: string; name: string;
  lastOpened: number; pinned: boolean; missing: boolean; revision: string | null; thumbnailRevision?: string | null;
}
export interface LibrarySnapshot { items: readonly RecentModel[]; hydrated: boolean; loading: boolean; pending: readonly string[]; error: string }
export function filterRecentModels(items: readonly RecentModel[], query: string) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return items.filter(item => terms.every(term => `${item.name} ${item.path}`.toLocaleLowerCase().includes(term)));
}
export function createRecentLibrary(bridge: ToolBridge) {
  let snapshot: LibrarySnapshot = { items: [], hydrated: false, loading: false, pending: [], error: '' };
  let disposed = false;
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  const thumbnails = new Map<string, Promise<string | null>>();
  let queue = Promise.resolve();
  let refreshing: Promise<void> | undefined;
  const publish = (patch: Partial<LibrarySnapshot>) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener();
  };
  async function call(arguments_: Record<string, unknown>) {
    lifetime.signal.throwIfAborted();
    const result = await bridge.callServerTool({ name: 'cad_library', arguments: arguments_ }, { signal: lifetime.signal });
    lifetime.signal.throwIfAborted();
    if (result.isError) {
      const message = result.content?.flatMap(block => block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? [(block as { text: string }).text] : []).join('\n');
      throw new Error(message || 'Could not update recent models.');
    }
    if (!result.structuredContent || typeof result.structuredContent !== 'object') throw new Error('Invalid recent-model response.');
    return result.structuredContent as Record<string, unknown>;
  }
  function update(action: 'list' | 'pin' | 'remove', item?: RecentModel) {
    if (disposed) return Promise.reject(new Error('The recent-model home has closed.'));
    publish({ loading: action === 'list' || snapshot.loading, pending: item ? [...snapshot.pending, item.id] : snapshot.pending });
    const operation = queue.then(async () => {
      const result = await call({ action, ...(item ? { documentId: item.id } : {}), ...(action === 'pin' ? { pinned: !item!.pinned } : {}) });
      if (!Array.isArray(result.items) || result.items.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' || !isDocumentPath(item.path) || typeof item.pinned !== 'boolean' || typeof item.missing !== 'boolean' || !Number.isFinite(item.lastOpened))) throw new Error('Invalid recent-model list.');
      const items = result.items as RecentModel[];
      const currentKeys = new Set(items.filter(item => item.thumbnailRevision && !item.missing).map(item => `${item.id}:${item.thumbnailRevision}`));
      for (const key of thumbnails.keys()) if (!currentKeys.has(key)) thumbnails.delete(key);
      publish({ items, hydrated: true, error: '' });
    }).catch(error => { publish({ error: error instanceof Error ? error.message : String(error) }); throw error; })
      .finally(() => publish({ loading: false, pending: item ? snapshot.pending.filter(id => id !== item.id) : snapshot.pending }));
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh() {
      if (!refreshing) refreshing = update('list').finally(() => { refreshing = undefined; });
      return refreshing;
    }, pin: (item: RecentModel) => update('pin', item), remove: (item: RecentModel) => update('remove', item),
    thumbnail(item: RecentModel) {
      if (!item.thumbnailRevision || item.missing) return Promise.resolve(null);
      const key = `${item.id}:${item.thumbnailRevision}`;
      let pending = thumbnails.get(key);
      if (!pending) {
        pending = call({ action: 'thumbnail', documentId: item.id }).then(value => {
          const image = value.revision === item.thumbnailRevision && typeof value.thumbnail === 'string' && value.thumbnail.startsWith('data:image/png;base64,') ? value.thumbnail : null;
          if (image === null && thumbnails.get(key) === pending) thumbnails.delete(key);
          return image;
        });
        thumbnails.set(key, pending);
        void pending.catch(() => { if (thumbnails.get(key) === pending) thumbnails.delete(key); });
      }
      return pending;
    },
    async saveThumbnail(documentId: string, revision: string, thumbnail: string) { await call({ action: 'thumbnail', documentId, revision, thumbnail }); },
    dispose() { disposed = true; lifetime.abort(); listeners.clear(); thumbnails.clear(); },
  };
}
export type RecentLibrary = ReturnType<typeof createRecentLibrary>;
