import { useMemo } from 'react';
import { FileViewer, createCadDocumentSource, type FileViewerProps } from '@text-to-cad/ui/file-viewer';
import { type ViewerHost, type ClipboardPort } from '@text-to-cad/ui/host';
import { createStepRenderer } from '@text-to-cad/ui/renderers/step';
import { createGlbRenderer } from '@text-to-cad/ui/renderers/glb';
import { createMeshRenderer } from '@text-to-cad/ui/renderers/mesh';
import { createTabStore, useTabViewerState } from '@text-to-cad/ui/tab-store';
import type { CadService } from '@text-to-cad/core/client';
import type { PromptContextPort } from '@text-to-cad/core/prompt';
import type { CadDocument } from './transport';
import type { RecentLibrary } from './library';
import { createThumbnailBinding } from './thumbnail';

const clipboard: ClipboardPort = {
  async writeText(text) { if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable.'); await navigator.clipboard.writeText(text); },
  async readText() { if (!navigator.clipboard?.readText) throw new Error('Clipboard is unavailable.'); return navigator.clipboard.readText(); },
  async writeImage(image) { if (!navigator.clipboard?.write || !globalThis.ClipboardItem) throw new Error('Image clipboard is unavailable.'); await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]); },
};
export default function App({ client, document, promptContext, colorScheme, library, browser, browserState, onBrowserStateChange }: {
  client: CadService; document: CadDocument; promptContext: PromptContextPort; colorScheme: 'light' | 'dark'; library: RecentLibrary;
  browser?: FileViewerProps['browser']; browserState?: FileViewerProps['state']; onBrowserStateChange?: FileViewerProps['onStateChange'];
}) {
  const source = useMemo(() => createCadDocumentSource(client, document), [client, document.id, document.path, document.name, document.revision]);
  const tabStore = useMemo(() => createTabStore({ read: () => undefined, write: () => {} }), []);
  const { state, onStateChange } = useTabViewerState(tabStore, source.id);
  const live = useMemo(() => createThumbnailBinding(library, document.id, document.revision), [library, document.id, document.revision]);
  const renderers = useMemo(() => [
    createStepRenderer({ client, live, preferences: tabStore.settings }),
    createGlbRenderer({ client, live, preferences: tabStore.settings }), createMeshRenderer({ client, live, preferences: tabStore.settings }),
  ], [client, tabStore, live]);
  const host = useMemo<ViewerHost>(() => ({
    files: source, clipboard, promptContext,
    environment: { colorScheme, platform: /Mac|iPhone|iPad/.test(navigator.platform) ? 'darwin' : 'linux' },
  }), [source, promptContext, colorScheme]);
  return <FileViewer file={document.path} host={host} renderers={renderers} browser={browser} state={browserState ? { ...state, ...browserState, renderers: state.renderers } : state} onStateChange={next => { onStateChange(next); onBrowserStateChange?.(next); }} />;
}
