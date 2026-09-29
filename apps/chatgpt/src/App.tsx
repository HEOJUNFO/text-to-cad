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

const supportsFile = (path: string) => /\.(?:step|stp|stl|glb|3mf)$/i.test(path);

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
  const [file, setFile] = useState(opened.file);
  useEffect(() => setFile(opened.file), [opened]);
  const source = useMemo<FileSource>(() => {
    const catalog = createCadFileSource(client, { rootId: opened.rootId, rootPath: opened.rootPath });
    return {
      ...catalog,
      async list(directory, options) {
        const entries = await catalog.list!(directory, options);
        return entries.filter(entry => entry.kind === 'directory' || supportsFile(entry.path));
      },
      async paths(options) { return (await catalog.paths!(options)).filter(supportsFile); },
    };
  }, [client, opened.rootId, opened.rootPath]);
  const tabStore = useMemo(() => createTabStore({ read: () => undefined, write: () => {} }), []);
  const { state, onStateChange, setPanel } = useTabViewerState(tabStore, source.id);
  const renderers = useMemo(() => [
    createStepRenderer({ client, preferences: tabStore.settings, slots: { selectionExtras: SelectionAttachment } }),
    createGlbRenderer({ client, preferences: tabStore.settings }), createMeshRenderer({ client, preferences: tabStore.settings }),
  ], [client, tabStore]);
  const host = useMemo<ViewerHost>(() => ({
    files: source, clipboard, promptContext,
    navigation: { openFile(path, options) { if (!supportsFile(path)) return; setFile(path); setPanel(options?.panel ?? null); } },
    environment: { colorScheme, platform: /Mac|iPhone|iPad/.test(navigator.platform) ? 'darwin' : 'linux' },
  }), [source, promptContext, colorScheme, setPanel]);
  return <FileViewer file={file || null} host={host} renderers={renderers} state={state} onStateChange={onStateChange}
    presentation={{ empty: <div className="cad-message">Open a STEP, STL, GLB, or 3MF file in Codex to view it here.</div> }} />;
}
