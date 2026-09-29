import { useEffect, useMemo, useState } from 'react';
import { FileViewer, createCadFileSource, type FileSource } from '@text-to-cad/ui/file-viewer';
import { PromptContextAction, type ViewerHost, type ClipboardPort } from '@text-to-cad/ui/host';
import { createStepRenderer, type StepSelectionSlotProps } from '@text-to-cad/ui/renderers/step';
import { createGlbRenderer } from '@text-to-cad/ui/renderers/glb';
import { createMeshRenderer } from '@text-to-cad/ui/renderers/mesh';
import { createTabStore, useTabViewerState } from '@text-to-cad/ui/tab-store';
import type { CadClient } from '@text-to-cad/core/client';
import type { PromptContextPort } from '@text-to-cad/core/prompt';
import type { OpenFile } from './transport';

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
export default function App({ client, opened, promptContext, colorScheme }: {
  client: CadClient; opened: OpenFile; promptContext: PromptContextPort; colorScheme: 'light' | 'dark';
}) {
  const source = useMemo<FileSource>(() => {
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
  const renderers = useMemo(() => [
    createStepRenderer({ client, preferences: tabStore.settings, slots: { selectionExtras: SelectionAttachment } }),
    createGlbRenderer({ client, preferences: tabStore.settings }), createMeshRenderer({ client, preferences: tabStore.settings }),
  ], [client, tabStore]);
  const host = useMemo<ViewerHost>(() => ({
    files: source, clipboard, promptContext,
    // The host owns file opening; CAD renderers do not navigate between files.
    navigation: { openFile() {} },
    environment: { colorScheme, platform: /Mac|iPhone|iPad/.test(navigator.platform) ? 'darwin' : 'linux' },
  }), [source, promptContext, colorScheme]);
  return <FileViewer file={opened.file || null} host={host} renderers={renderers} state={state} onStateChange={onStateChange}
    navigationPresentation="overlay" presentation={{ empty: <div className="cad-home">
      <h1>Create or open a part</h1>
      <ol>
        <li><strong>Create</strong><p>Ask the composer to create or modify a part. Try “Create an L-bracket with two mounting holes.”</p></li>
        <li><strong>Open</strong><p>Open a STEP, STL, GLB or 3MF file, then choose CAD.</p></li>
        <li><strong>Inspect</strong><p>Select geometry, then use Add to prompt to include its reference in your next request.</p></li>
      </ol>
    </div> }} />;
}
