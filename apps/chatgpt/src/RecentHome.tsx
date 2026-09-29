import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ChangeEvent } from 'react';
import { Box, Pin, Search, X } from 'lucide-react';
import { Button } from '@text-to-cad/ui/primitives/button';
import { Input } from '@text-to-cad/ui/primitives/input';
import { TooltipHint } from '@text-to-cad/ui/primitives/tooltip';
import { version } from '../package.json';
import cadLogo from './assets/logo-cad.png';
import { watchRecentModels } from './autoRefresh';
import { filterRecentModels, type RecentLibrary, type RecentModel } from './library';
import { OpenModel } from './OpenModel';

const github = 'https://github.com/earthtojake/text-to-cad';
const discord = 'https://discord.gg/5FGB9DwJYU';
function Thumbnail({ item, library }: { item: RecentModel; library: RecentLibrary }) {
  const element = useRef<HTMLSpanElement>(null);
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setImage(null);
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void library.thumbnail(item).then(value => { if (active) setImage(value); }).catch(() => {});
    });
    if (element.current) observer.observe(element.current);
    return () => { active = false; observer.disconnect(); };
  }, [item.id, item.thumbnailRevision, item.missing, library]);
  return <span className="cad-recent-thumbnail" ref={element}>{image ? <img src={image} alt="" /> : <Box size={28} strokeWidth={1} aria-hidden="true" />}</span>;
}
export default function RecentHome({ library, nativeOpenAvailable, onOpen, onOpenLink }: {
  library: RecentLibrary; nativeOpenAvailable: boolean; onOpen(path: string): Promise<void>; onOpenLink?(url: string): Promise<void>;
}) {
  const state = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState('');
  const alive = useRef(true);
  const pinFocus = useRef<string | null>(null);
  const pinButtons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    const id = pinFocus.current;
    if (id && !state.pending.includes(id)) { pinButtons.current.get(id)?.focus(); pinFocus.current = null; }
  }, [state.items, state.pending]);
  useEffect(() => {
    alive.current = true;
    const stop = watchRecentModels(library);
    return () => { alive.current = false; stop(); };
  }, [library]);
  const searchQuery = state.items.length ? query : '';
  const items = filterRecentModels(state.items, searchQuery);
  const pinned = items.filter(item => item.pinned);
  const recent = items.filter(item => !item.pinned);
  const open = async (item: RecentModel) => {
    if (opening) return;
    setOpening(item.id); setOpenError('');
    try { await onOpen(item.path); }
    catch (error) { if (alive.current) setOpenError(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) setOpening(null); }
  };
  const openLink = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onOpenLink) return;
    event.preventDefault(); setOpenError('');
    void onOpenLink(event.currentTarget.href).catch(error => {
      if (alive.current) setOpenError(error instanceof Error ? error.message : String(error));
    });
  };
  const section = (name: string, models: readonly RecentModel[]) => <section className="cad-library-section" aria-label={name}>
    <h2>{name}</h2>
    <ul className="cad-recent-grid">{models.map(item => {
      const folder = item.path.replace(/[\\/][^\\/]+$/, '');
      const pending = state.pending.includes(item.id);
      return <li key={item.id} className="cad-recent-item">
        <button className="cad-recent-open" disabled={item.missing || Boolean(opening)} aria-label={`${nativeOpenAvailable ? 'Open' : 'Preview'} ${item.name}${nativeOpenAvailable ? '' : ' here'}`} onClick={() => void open(item)}>
          <Thumbnail item={item} library={library} />
          <TooltipHint content={item.path} overflowOnly><span className="cad-recent-name truncate">{item.name}</span></TooltipHint>
          <TooltipHint content={folder} overflowOnly><span className="cad-recent-folder truncate">{folder}</span></TooltipHint>
        </button>
        <div className="cad-recent-detail">
          <span className="cad-recent-status">{item.missing ? 'File unavailable' : opening === item.id ? 'Opening…' : nativeOpenAvailable ? new Date(item.lastOpened * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Preview here'}</span>
          <div className="cad-recent-actions">
            <TooltipHint content={item.pinned ? 'Unpin' : 'Pin'}><Button variant="ghost" size="icon-xs" aria-label={`${item.pinned ? 'Unpin' : 'Pin'} ${item.name}`} aria-pressed={item.pinned} disabled={pending} ref={node => { if (node) pinButtons.current.set(item.id, node); else pinButtons.current.delete(item.id); }} onClick={event => { if (event.detail === 0) pinFocus.current = item.id; void library.pin(item).catch(() => {}); }}><Pin aria-hidden="true" /></Button></TooltipHint>
            <TooltipHint content="Remove from recents"><Button variant="ghost" size="icon-xs" aria-label={`Remove ${item.name} from recents`} disabled={pending} onClick={() => void library.remove(item).catch(() => {})}><X aria-hidden="true" /></Button></TooltipHint>
          </div>
        </div>
      </li>;
    })}</ul>
  </section>;
  return <main className="cad-library text-ui" aria-label="CAD model library">
    <header className="cad-library-brand"><img className="cad-library-logo" src={cadLogo} alt="CAD" width={1202} height={512} /></header>
    <div className="cad-library-content">
      <div className="cad-library-toolbar">
        <OpenModel onOpen={onOpen} disabled={Boolean(opening)} />
        {state.items.length > 0 && <div className="cad-library-search"><Search size={14} aria-hidden="true" /><Input className="h-8" type="search" aria-label="Search models" placeholder="Search models" value={query} onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)} /></div>}
      </div>
      {(state.error || openError) && <div className="cad-library-error" role="alert"><p>{openError || state.error}</p>{state.error && <Button variant="outline" size="sm" onClick={() => void library.refresh().catch(() => {})}>Try again</Button>}</div>}
      {state.loading && !state.hydrated ? <p className="cad-library-empty" role="status">Loading models…</p> : searchQuery && !items.length ? <p className="cad-library-empty" role="status">No matching models.</p> : <>
        {pinned.length > 0 && section('Pinned', pinned)}
        {recent.length > 0 ? section('Recent', recent) : !state.items.length && <section className="cad-library-section" aria-label="Recent"><h2>Recent</h2><p className="cad-library-empty">Open a CAD file to see it here.</p></section>}
      </>}
    </div>
    <footer className="cad-library-footer" aria-label="CAD links">
      <a href={`${github}/releases/tag/v${version}`} aria-label={`CAD version ${version}`} target="_blank" rel="noreferrer" onClick={openLink}>v{version}</a>
      <a href={github} target="_blank" rel="noreferrer" onClick={openLink}>GitHub</a>
      <a href={discord} target="_blank" rel="noreferrer" onClick={openLink}>Discord</a>
    </footer>
  </main>;
}
