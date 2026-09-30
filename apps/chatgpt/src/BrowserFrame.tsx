import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from 'react';
import { type FileBrowser, type FileBrowserState } from '@text-to-cad/ui/file-viewer';
import { PANEL_DEFAULT_WIDTH } from '@text-to-cad/ui/navigation';
import { Button } from '@text-to-cad/ui/primitives/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@text-to-cad/ui/primitives/dropdown-menu';
import { ArrowUp, FolderOpen, House, Monitor } from 'lucide-react';
import { absoluteBrowsePath, createDirectorySource, readDirectory, relativeBrowsePath, type BrowseLocation } from './browsing';
import type { ToolBridge } from './transport';
import logo from './assets/logo-c.svg';

type Layout = { browser: FileBrowser; browserState: FileBrowserState; onBrowserStateChange: (state: FileBrowserState) => void };
export default function BrowserFrame({ bridge, path, initialRoot, onOpen, onHome, children }: {
  bridge: ToolBridge; path: string; initialRoot: string | null;
  onOpen: (path: string) => Promise<void>; onHome?: () => void;
  children: (layout: Layout) => ReactNode;
}) {
  const [location, setLocation] = useState<BrowseLocation>({ root: { path: initialRoot, name: initialRoot?.split(/[\\/]/).filter(Boolean).pop() || 'Computer' }, parent: null, home: '' });
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  const chooseRoot = useCallback(async (root: string | null) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setPending(true); setError('');
    try {
      const next = await readDirectory(bridge, root, null, controller.signal);
      if (!controller.signal.aborted) setLocation(next);
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (!controller.signal.aborted) setPending(false); }
  }, [bridge]);
  useEffect(() => { void chooseRoot(initialRoot); return () => request.current?.abort(); }, [chooseRoot, initialRoot]);
  const report = useCallback((error: Error) => setError(error.message), []);
  const open = useCallback(async (path: string) => {
    setError('');
    try { await onOpen(path); } catch (error) { report(error instanceof Error ? error : new Error(String(error))); }
  }, [onOpen, report]);
  return <div className="flex h-full min-h-0 flex-col overflow-hidden">
    <Browsing bridge={bridge} location={location} initialRoot={initialRoot} path={path}
      chooseRoot={chooseRoot} pending={pending} onOpen={open} onHome={onHome}
      error={error} dismissError={() => setError('')}>{children}</Browsing>
  </div>;
}
function Browsing({ bridge, location, initialRoot, path, chooseRoot, pending, onOpen, onHome, error, dismissError, children }: {
  bridge: ToolBridge; location: BrowseLocation; initialRoot: string | null; path: string;
  chooseRoot: (root: string | null) => Promise<void>; pending: boolean; onOpen: (path: string) => Promise<void>;
  onHome?: () => void;
  error: string; dismissError: () => void; children: (layout: Layout) => ReactNode;
}) {
  const source = useMemo(() => createDirectorySource(bridge, location), [bridge, location]);
  const [saved, setSaved] = useState({ id: source.id, state: { panel: '', panelWidth: PANEL_DEFAULT_WIDTH } as FileBrowserState });
  const state = saved.id === source.id ? saved.state : { ...saved.state, expandedDirectories: [] };
  const setState = useCallback((update: SetStateAction<FileBrowserState>) => setSaved(previous => {
    const current = previous.id === source.id ? previous.state : { ...previous.state, expandedDirectories: [] };
    return { id: source.id, state: typeof update === 'function' ? update(current) : update };
  }), [source.id]);
  const relative = relativeBrowsePath(location.root.path, path);
  const openRelative = (value: string) => {
    const absolute = absoluteBrowsePath(location.root.path, value);
    if (absolute) void onOpen(absolute);
  };
  const brand = <img src={logo} alt="CAD" width={20} height={20} className="mr-1 size-5 shrink-0 object-contain" />;
  return children({ browserState: state, onBrowserStateChange: setState, browser: { source, path: relative, onOpenFile: openRelative,
    leading: <>{onHome ? <button type="button" aria-label="Back to models" onClick={onHome} className="shrink-0">{brand}</button> : brand}
      {relative === null && <button type="button" className="truncate" title="Reveal model in Computer" onClick={() => void chooseRoot(null)}>{path.split(/[\\/]/).pop()}</button>}</>,
    navigationActions: <>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" aria-label="Browse location" title={location.root.name} disabled={pending} className="size-6 text-muted-foreground">
        <Monitor className="size-3.5" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {initialRoot && <DropdownMenuItem className="" inset={false} onSelect={() => void chooseRoot(initialRoot)}><FolderOpen className="size-3.5" />Project folder</DropdownMenuItem>}
          <DropdownMenuItem className="" inset={false} onSelect={() => void chooseRoot(null)}><Monitor className="size-3.5" />Computer</DropdownMenuItem>
          <DropdownMenuItem className="" inset={false} disabled={!location.home} onSelect={() => void chooseRoot(location.home)}><House className="size-3.5" />Home</DropdownMenuItem>
          <DropdownMenuItem className="" inset={false} disabled={!location.parent} onSelect={() => void chooseRoot(location.parent)}><ArrowUp className="size-3.5" />Up one folder</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>,
    notice: error && <div role="alert" className="flex items-center gap-2 border-b bg-background px-3 py-2 text-destructive"><span className="min-w-0 flex-1">{error}</span><Button variant="ghost" size="sm" onClick={() => void chooseRoot(location.root.path)}>Try again</Button><Button variant="ghost" size="sm" onClick={dismissError}>Dismiss</Button></div>,
  } });
}
