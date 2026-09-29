import { useEffect, useMemo, useState } from 'react';
import { FileViewer, createCadFileSource, type DocumentSource } from '@text-to-cad/ui/file-viewer';
import { PromptContextAction, type ViewerHost, type ClipboardPort } from '@text-to-cad/ui/host';
import { createStepRenderer, type StepSelectionSlotProps } from '@text-to-cad/ui/renderers/step';
import { createGlbRenderer } from '@text-to-cad/ui/renderers/glb';
import { createMeshRenderer } from '@text-to-cad/ui/renderers/mesh';
import { createTabStore, useTabViewerState } from '@text-to-cad/ui/tab-store';
import type { CadClient } from '@text-to-cad/core/client';
import type { PromptContextPort } from '@text-to-cad/core/prompt';
import type { OpenFile } from './transport';
import type { RecentLibrary } from './library';
import { createThumbnailBinding } from './thumbnail';

const clipboard: ClipboardPort = {
  async writeText(text) { if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable.'); await navigator.clipboard.writeText(text); },
  async readText() { if (!navigator.clipboard?.readText) throw new Error('Clipboard is unavailable.'); return navigator.clipboard.readText(); },
  async writeImage(image) { if (!navigator.clipboard?.write || !globalThis.ClipboardItem) throw new Error('Image clipboard is unavailable.'); await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]); },
};
function SelectionAttachment({ createContext, disabled, selectionKey }: StepSelectionSlotProps) {
  const [message, setMessage] = useState('');
  useEffect(() => setMessage(''), [selectionKey]);
  return <div className="cad-context-action"><PromptContextAction size="sm" variant="outline" disabled={disabled}
    createContext={() => createContext()}
    onResult={result => setMessage(result.status === 'added' ? 'Added to prompt' : 'message' in result ? result.message || 'Could not add selection.' : '')} />
    {message && <span role="status">{message}</span>}</div>;
}
export default function App({ client, opened, promptContext, colorScheme, library }: {
  client: CadClient; opened: OpenFile; promptContext: PromptContextPort; colorScheme: 'light' | 'dark'; library: RecentLibrary;
}) {
  const source = useMemo<DocumentSource>(() => {
    const catalog = createCadFileSource(client, { rootId: opened.rootId, rootPath: opened.rootPath });
    return {
      id: catalog.id, rootName: catalog.rootName, stat: catalog.stat, readAsset: catalog.readAsset,
      subscribe(listener) {
        if (!opened.file) return () => {};
        // Resolve first so the client's initial subscribed refresh is file-scoped.
        // resolveEntry records the path synchronously and deduplicates its request.
        void client.resolveEntry(opened.file).catch(() => {});
        return catalog.subscribe!(listener);
      },
    };
  }, [client, opened.rootId, opened.rootPath, opened.file]);
  const tabStore = useMemo(() => createTabStore({ read: () => undefined, write: () => {} }), []);
  const { state, onStateChange } = useTabViewerState(tabStore, source.id);
  const live = useMemo(() => createThumbnailBinding(library, opened.recentId, opened.revision), [library, opened.recentId, opened.revision]);
  const renderers = useMemo(() => [
    createStepRenderer({ client, live, preferences: tabStore.settings, slots: { selectionExtras: SelectionAttachment } }),
    createGlbRenderer({ client, live, preferences: tabStore.settings }), createMeshRenderer({ client, live, preferences: tabStore.settings }),
  ], [client, tabStore, live]);
  const host = useMemo<ViewerHost>(() => ({
    files: source, clipboard, promptContext,
    environment: { colorScheme, platform: /Mac|iPhone|iPad/.test(navigator.platform) ? 'darwin' : 'linux' },
  }), [source, promptContext, colorScheme]);
  return <FileViewer file={opened.file || null} host={host} renderers={renderers} state={state} onStateChange={onStateChange} />;
}
