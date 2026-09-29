import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FileViewer, createCadFileSource, useFileNavigation, useViewerMobileMeasure } from '@text-to-cad/ui/file-viewer';
import type { ViewerHost } from '@text-to-cad/ui/host';
import { buildCrumbs, clampPanelWidth, EmptyState, FILE_PANEL_TREE, FileNavRow, FilePanelColumn, FileTree, nextOpenPanel, PanelToggle, PANEL_DEFAULT_WIDTH, treePanel } from '@text-to-cad/ui/navigation';
import { FileText } from 'lucide-react';
import { createStepRenderer } from '@text-to-cad/ui/renderers/step';
import { createDxfRenderer } from '@text-to-cad/ui/renderers/dxf';
import { createGlbRenderer } from '@text-to-cad/ui/renderers/glb';
import { createMeshRenderer } from '@text-to-cad/ui/renderers/mesh';
import { createRobotRenderer } from '@text-to-cad/ui/renderers/robot';
import { MissingFileAlert, ViewerLoadingOverlay } from '@text-to-cad/ui/file-viewer/presentation';
import { useTabViewerState, type Appearance, type TabStore } from '@text-to-cad/ui/tab-store';
import { useViewerAutoReload } from './host/useViewerAutoReload.js';
import { EmptyCadBackdrop } from '@text-to-cad/ui/file-viewer/empty';
import type { CadServerInfo } from '@text-to-cad/core/client';
import type { CadClient } from './adapters/fileSource';
import { createWebFileActions } from './adapters/fileSource';
import { browserClipboard, browserClipboardSupportsImages } from './host/clipboard';
import { createWebPromptContext } from './host/promptContext';
import ViewerAppearance from './client/components/workbench/ViewerAppearance.jsx';
import ViewerBrand from './client/components/workbench/ViewerBrand.jsx';
import ViewerLinks from './client/components/workbench/ViewerLinks.jsx';
import { cadFileParamForEntry, findEntryByUrlPath, normalizeCadFileQueryParam, readCadParam, readDefaultCadParam, writeCadParam } from './client/workbench/sidebar.js';
import { applyColorSchemeToDocument, resolveColorSchemeMode } from './client/ui/colorScheme.js';

/** The keyboard the page is typed on — ⌘ on Apple devices, Ctrl elsewhere: the host's one platform answer. */
const keyboardPlatform = () => /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : /Win/.test(navigator.platform) ? "win32" : "linux";
const DARK_QUERY = '(prefers-color-scheme: dark)';
const subscribeToSystemDark = (onChange: () => void) => {
  const query = matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};
const systemPrefersDark = () => matchMedia(DARK_QUERY).matches;

/** The appearance the tab keeps, resolved against the OS: `light` or `dark`, live. */
export function useTabAppearance(tabStore: TabStore): { preference: Appearance; colorScheme: 'light' | 'dark' } {
  const settings = useSyncExternalStore(tabStore.settings.subscribe, tabStore.settings.getSnapshot, tabStore.settings.getSnapshot);
  const prefersDark = useSyncExternalStore(subscribeToSystemDark, systemPrefersDark, systemPrefersDark);
  return { preference: settings.appearance, colorScheme: resolveColorSchemeMode(settings.appearance, { prefersDark }) as 'light' | 'dark' };
}

export default function App(props: { client: CadClient; server: CadServerInfo; tabStore: TabStore }) {
  return <RootView key={props.server.rootId} {...props} />;
}

/** A root change creates a new session; the tab store, and everything in it, is the tab's across roots. */
function RootView({ client, server, tabStore }: { client: CadClient; server: CadServerInfo; tabStore: TabStore }) {
  useViewerAutoReload(server, { fetchServerInfo: () => client.serverInfo({ fresh: true }).then(info => ({ ok: true, identityToken: String(info.identityToken || '') }), () => ({ ok: false })) });
  const source = useMemo(() => createCadFileSource(client, server), [client, server]);
  const promptContext = useMemo(() => createWebPromptContext(source.id, server.rootPath || '', browserClipboard, browserClipboardSupportsImages()), [source.id, server.rootPath]);
  const fileActions = useMemo(() => createWebFileActions(client, server, { clipboard: browserClipboard }), [client, server]);
  // Every renderer reads its preferences from the tab's settings.
  const preferences = tabStore.settings;
  // One renderer per file family; each lazy-loads only its own code.
  const renderers = useMemo(() => [createStepRenderer({ client, preferences }), createDxfRenderer({ client, preferences }), createGlbRenderer({ client, preferences }), createMeshRenderer({ client, preferences }), createRobotRenderer({ client, preferences })], [client, preferences]);
  const catalog = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [file, setFile] = useState(() => readCadParam() || readDefaultCadParam() || '');
  const selectedEntry = useMemo(() => findEntryByUrlPath(catalog.entries, file), [catalog.entries, file]);
  // The page's state, from and into the tab store: the panel column's width, this root's open
  // folders and its file views. The open panel is the page's own and never stored.
  const { state, onStateChange, setPanel } = useTabViewerState(tabStore, source.id);
  const appearance = useTabAppearance(tabStore);
  const changeColorScheme = useCallback((value: string) => tabStore.settings.update({ appearance: value as Appearance }), [tabStore]);
  useEffect(() => { applyColorSchemeToDocument(appearance.colorScheme, document.documentElement); }, [appearance.colorScheme]);
  useEffect(() => {
    const sync = () => setFile(readCadParam() || readDefaultCadParam() || '');
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { void client.refresh({ signal: controller.signal, markRefreshing: false }).catch(() => {}); };
    const visible = () => { if (document.visibilityState !== 'hidden') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.abort();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [client]);
  useEffect(() => {
    document.title = selectedEntry ? `CAD | ${selectedEntry.file.split(/[\\/]/).pop()}` : 'CAD';
    if (selectedEntry && !readCadParam()) writeCadParam(file, { history: 'replace' });
  }, [file, selectedEntry]);
  const shownFile = useRef(file);
  shownFile.current = file;
  const open = useCallback((path: string, options?: { panel?: string }) => {
    const entry = findEntryByUrlPath(client.getSnapshot().entries, path);
    if (!entry) return { status: 'unavailable' as const, reason: 'File is not in the catalog.' };
    const next = normalizeCadFileQueryParam(cadFileParamForEntry(entry));
    if (next !== shownFile.current) {
      writeCadParam(next, { history: 'push' });
      setFile(next);
    } else if (options?.panel === undefined) return { status: 'opened' as const };
    // The file opens with the panel it was opened with (the tree, for one picked there) or with
    // its own default. FileViewer owns mobile visibility and keeps its sheets closed.
    setPanel(options?.panel ?? null);
    return { status: 'opened' as const };
  }, [client, setPanel]);
  const [frameRef, mobile] = useViewerMobileMeasure();
  const [bodyElement, setBodyElement] = useState<HTMLDivElement | null>(null);
  const [statusTarget, setStatusTarget] = useState<HTMLDivElement | null>(null);
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const [mobilePanel, setMobilePanel] = useState<string | null>(null);
  useEffect(() => { setMobilePanel(null); }, [file, mobile]);
  const navigationPath = selectedEntry ? normalizeCadFileQueryParam(cadFileParamForEntry(selectedEntry)) : catalog.hydrated ? normalizeCadFileQueryParam(file) || null : null;
  const navigation = useFileNavigation({ source, actions: fileActions, state, onStateChange,
    onOpenFile: (path, options) => { open(path, options); }, path: navigationPath, onError: error => console.error(error) });
  const crumbs = useMemo(() => {
    const all = buildCrumbs({ path: navigationPath });
    return mobile ? all.slice(-1) : all;
  }, [navigationPath, mobile]);
  const requestedPanel = mobile ? mobilePanel ?? (!file ? null : '') : state.panel;
  const openTree = requestedPanel === FILE_PANEL_TREE || (requestedPanel === null && !file);
  const tree = treePanel(openTree ? FILE_PANEL_TREE : '', { empty: !file });
  const setTreeOpen = useCallback((next: string) => {
    if (mobile) setMobilePanel(next);
    else onStateChange({ ...state, panel: next });
  }, [mobile, onStateChange, state]);
  const host = useMemo<ViewerHost>(() => ({
    files: source, clipboard: browserClipboard, promptContext,
    navigation: { openFile: path => open(path) }, environment: { colorScheme: appearance.colorScheme, platform: keyboardPlatform() },
  }), [source, promptContext, open, appearance.colorScheme]);
  const empty = <div className="pointer-events-auto absolute inset-0 z-10 bg-background"><EmptyState icon={FileText} title="No file open" description="Pick one from the tree on the right, or filter by name." /></div>;
  // Unselected while the catalog resolves the file; once it has, a missing file is named by its crumbs.
  return <div className="flex h-svh flex-col overflow-hidden" ref={frameRef}>
    <FileNavRow activePath={navigationPath} crumbs={crumbs} leading={<ViewerBrand />}
      onOpen={(path) => { open(path); }} source={navigation.crumbs}
      status={<div ref={setStatusTarget} className={mobile ? 'ml-1 shrink-0' : 'ml-2 min-w-0 overflow-hidden'} data-file-navigation-status="" />}
      trailing={<><ViewerLinks /><div ref={setActionsTarget} className="flex items-center gap-0.5" /><PanelToggle id={FILE_PANEL_TREE}
        active={openTree} icon={tree.icon} label={tree.label} testId="tree-toggle"
        onClick={() => setTreeOpen(nextOpenPanel(openTree ? FILE_PANEL_TREE : '', FILE_PANEL_TREE))} /></>} />
    <div ref={setBodyElement} className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-hidden"><FileViewer file={file || null} host={host} renderers={renderers} state={state} onStateChange={onStateChange}
      mobileLayout={mobile} navigationTargets={{ status: statusTarget, actions: actionsTarget }}
      displayActions={<ViewerAppearance colorSchemePreference={appearance.preference} resolvedColorSchemeMode={appearance.colorScheme} onColorSchemePreferenceChange={changeColorScheme} />}
      onError={error => console.error(error)} presentation={{
        empty: <div className="relative h-full">{empty}</div>,
        loading: <div className="relative h-full"><ViewerLoadingOverlay viewerLoading /></div>,
        error: () => <div className="relative h-full">{catalog.error ? empty : <EmptyCadBackdrop colorScheme={appearance.colorScheme}><MissingFileAlert missingFileRef={file} rootPath={server.rootPath} /></EmptyCadBackdrop>}</div>,
      }} /></div>
      {openTree ? <FilePanelColumn mobile={mobile} portalContainer={bodyElement} onDismiss={() => setTreeOpen('')}
        id={FILE_PANEL_TREE} label="Files" width={clampPanelWidth(state.panelWidth)}
        onWidthChange={width => onStateChange({ ...state, panelWidth: clampPanelWidth(width) })}
        onCollapse={() => onStateChange({ ...state, panel: '', panelWidth: PANEL_DEFAULT_WIDTH })}>
        <FileTree key={source.id} source={navigation.tree} activePath={navigationPath} edit={navigation.edit}
          onOpen={path => { if (mobile) setMobilePanel(''); open(path, { panel: FILE_PANEL_TREE }); }} />
      </FilePanelColumn> : null}
    </div>
  </div>;
}
