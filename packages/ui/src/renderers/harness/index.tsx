import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { FileViewer, useFileNavigation, useViewerMobileMeasure } from '@text-to-cad/ui/file-viewer';
import type { FileBrowserSource, FileBrowserState } from '@text-to-cad/ui/file-viewer';
import { buildCrumbs, clampPanelWidth, FILE_PANEL_TREE, FileNavRow, FilePanelColumn, FileTree, nextOpenPanel, PanelToggle, PANEL_DEFAULT_WIDTH, treePanel } from '@text-to-cad/ui/navigation';
import { createCadClient } from '@text-to-cad/core/client';
import { createTabStore, memoryTabRecord, useTabViewerState } from '@text-to-cad/ui/tab-store';
import type { TabRecordStorage } from '@text-to-cad/ui/tab-store';
import { createStepRenderer } from '@text-to-cad/ui/renderers/step';
import { createDxfRenderer } from '@text-to-cad/ui/renderers/dxf';
import { createGlbRenderer } from '@text-to-cad/ui/renderers/glb';
import { createMeshRenderer } from '@text-to-cad/ui/renderers/mesh';
import { createRobotRenderer } from '@text-to-cad/ui/renderers/robot';
import { createHarnessRenderer } from '@text-to-cad/ui/renderers/shell-harness';
import type { ViewerHost } from '@text-to-cad/ui/host';
import type { CadLiveController } from '@text-to-cad/ui/renderers/step';
import type { ViewerCommands as CadCommands } from '@text-to-cad/ui/renderers/workspace';

// The one file both panes open: `?file=arm.urdf` for a test whose fixture is not the default mesh.
const file = new URLSearchParams(location.search).get('file') || 'part.stl';
const captures: { file: string; size: number; type: string; references: unknown }[] = [];
// What a renderer asked the host to open (a mesh a robot description names, say).
const opened: string[] = [];
// The tab store, as a host builds it: over memory by default (a test seeds it through
// `window.__cadTabRecord`, so "reopen this file" is a real open against a stored record), or over
// this page's sessionStorage (`?store=session`), so a reload of the page is a reload of the tab
// and a new page is a new tab. Nothing under `renderers/` touches either.
const KEY = 'text-to-cad:tab:harness';
const sessionRecord = (): TabRecordStorage => ({
  read: () => JSON.parse(sessionStorage.getItem(KEY) || 'null'),
  write: record => sessionStorage.setItem(KEY, JSON.stringify(record)),
});
const tabStore = createTabStore(new URLSearchParams(location.search).get('store') === 'session'
  ? sessionRecord() : memoryTabRecord((window as unknown as { __cadTabRecord?: unknown }).__cadTabRecord));
const preferences = tabStore.settings;
// The keyboard the browser under test types on, as a web host reports it: the drawing
// editor's history keys must be the ones its SDK listens for on this machine.
const keyboardPlatform = /Mac|iPhone|iPad/.test(navigator.platform) ? 'darwin' : /Win/.test(navigator.platform) ? 'win32' : 'linux';
function workspace(id: string) {
  let snapshot: CadCommands = {};
  const listeners = new Set<() => void>();
  const commands = {
    getSnapshot: () => snapshot,
    acknowledge(kind: keyof CadCommands, key: string | number) {
      if (snapshot[kind]?.key !== key) return;
      snapshot = { ...snapshot, [kind]: null };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
  const request = (next: CadCommands) => { snapshot = next; for (const listener of listeners) listener(); };
  const capture = () => request({ captureRequest: { key: Date.now() } });
  const selectReference = (selector: string) => request({ selectReference: { selector, key: Date.now() } });
  const client = createCadClient({ origin: `${location.origin}/${id}`, scopeId: id, pollIntervalMs: 0 });
  const source: FileBrowserSource = {
    id, rootName: id,
    stat: async (path) => ({ path, name: path, kind: 'file', size: 400, extension: path.split('.').pop() || '' }),
    list: async () => [{ path: file, name: file, kind: 'file' }]
  };
  const destination = { kind: 'composer' as const, available: true };
  const host: ViewerHost = { files: source, navigation: { openFile(path) { opened.push(path); return { status: 'opened' }; } }, environment: { colorScheme: 'dark', platform: keyboardPlatform },
    clipboard: { writeText: async () => {}, readText: async () => '', writeImage: async () => {} },
    promptContext: { getSnapshot: () => destination, subscribe: () => () => {}, deliver: async context => {
      const attachment = context.parts.find(part => part.kind === 'attachment');
      if (attachment?.kind === 'attachment') { const blob = await attachment.content; captures.push({ file, size: blob.size, type: blob.type, references: context.parts.filter(part => part.kind === 'reference').map(part => part.reference) }); }
      return { status: 'added', partIds: context.parts.map(part => part.id) };
    } }
  };
  let controller: CadLiveController | null = null;
  const live = { bind(next: CadLiveController) { controller = next; return () => { controller = null; }; } };
  // One live binding per pane: whichever renderer the file selects binds the mounted view.
  const services = { client, preferences, commands, live };
  // `harness` is test scaffolding for the shell's own tools; it ships nowhere.
  const renderers = [createStepRenderer(services), createDxfRenderer(services), createGlbRenderer(services), createMeshRenderer(services), createRobotRenderer(services), createHarnessRenderer(services)];
  return { client, source, host, renderers, commands, capture, selectReference, get controller() { return controller; } };
}
const a = workspace('one'), b = workspace('two');
// Directory navigation hydrates before a renderer mounts. Large workspaces
// return path-only placeholders until the selected file is requested.
await Promise.all([a.client.refresh(), b.client.refresh()]);
function Pane({ workspace: current, state, onStateChange, testId }: {
  workspace: typeof a; state: FileBrowserState; onStateChange: (next: FileBrowserState) => void; testId: string;
}) {
  const [frameRef, mobile] = useViewerMobileMeasure();
  const [bodyElement, setBodyElement] = useState<HTMLDivElement | null>(null);
  const [statusTarget, setStatusTarget] = useState<HTMLDivElement | null>(null);
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const [mobilePanel, setMobilePanel] = useState<string | null>(null);
  useEffect(() => { setMobilePanel(null); }, [mobile]);
  const navigation = useFileNavigation({ source: current.source, state, onStateChange,
    onOpenFile: path => { opened.push(path); }, path: file });
  const crumbs = buildCrumbs({ path: file });
  const requestedPanel = mobile ? mobilePanel ?? '' : state.panel;
  const openTree = requestedPanel === FILE_PANEL_TREE;
  const tree = treePanel(openTree ? FILE_PANEL_TREE : '');
  const setTreeOpen = (next: string) => { if (mobile) setMobilePanel(next); else onStateChange({ ...state, panel: next }); };
  return <section data-testid={testId} ref={frameRef} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
    <FileNavRow activePath={file} crumbs={mobile ? crumbs.slice(-1) : crumbs} source={navigation.crumbs}
      onOpen={path => { opened.push(path); }} status={<div ref={setStatusTarget} data-file-navigation-status="" />}
      trailing={<><div ref={setActionsTarget} className="flex items-center gap-0.5" />
        <PanelToggle id={FILE_PANEL_TREE} icon={tree.icon} label={tree.label} active={openTree}
          onClick={() => setTreeOpen(nextOpenPanel(openTree ? FILE_PANEL_TREE : '', FILE_PANEL_TREE))} /></>} />
    <div ref={setBodyElement} className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-hidden"><FileViewer file={file} host={current.host} renderers={current.renderers}
        state={state} onStateChange={onStateChange} mobileLayout={mobile}
        navigationTargets={{ status: statusTarget, actions: actionsTarget }} /></div>
      {openTree ? <FilePanelColumn mobile={mobile} portalContainer={bodyElement} onDismiss={() => setTreeOpen('')}
        id={FILE_PANEL_TREE} label="Files" width={clampPanelWidth(state.panelWidth)}
        onWidthChange={width => onStateChange({ ...state, panelWidth: clampPanelWidth(width) })}
        onCollapse={() => onStateChange({ ...state, panel: '', panelWidth: PANEL_DEFAULT_WIDTH })}>
        <FileTree source={navigation.tree} activePath={file} edit={navigation.edit} onOpen={path => { opened.push(path); if (mobile) setMobilePanel(''); }} />
      </FilePanelColumn> : null}
    </div>
  </section>;
}
function App() {
  // Two panes, two roots, one tab: the settings are the tab's, each root's file views its own.
  const { state, onStateChange } = useTabViewerState(tabStore, a.source.id);
  const { state: otherState, onStateChange: onOtherStateChange } = useTabViewerState(tabStore, b.source.id);
  const [second, setSecond] = useState(false);
  const [mounted, setMounted] = useState(true);
  Object.assign(window, { cadHarness: { a, b, state, otherState, preferences, tabStore, record: tabStore.getSnapshot(), captures, opened, capture: a.capture, selectReference: a.selectReference, second: setSecond, mounted: setMounted } });
  return <div style={{ display: 'flex', width: '1200px', height: '720px' }}>
    {mounted ? <Pane workspace={a} state={state} onStateChange={onStateChange} testId="one" />
      : <section data-testid="one" style={{ flex: 1, minWidth: 0 }} />}
    {second && <Pane workspace={b} state={otherState} onStateChange={onOtherStateChange} testId="two" />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
