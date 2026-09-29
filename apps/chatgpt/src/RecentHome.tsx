import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Pin, Search, X } from 'lucide-react';
import cadLogo from './assets/logo-cad.png';
import { watchRecentModels } from './autoRefresh';
import { filterRecentModels, type RecentLibrary, type RecentModel } from './library';
function Thumbnail({ item, library }: { item: RecentModel; library: RecentLibrary }) {
  const element = useRef<HTMLDivElement>(null);
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
  return <div className="cad-recent-thumbnail" ref={element}>{image ? <img src={image} alt="" /> : <Box size={34} strokeWidth={1} aria-hidden="true" />}</div>;
}
export default function RecentHome({ library, nativeOpenAvailable, onOpen }: {
  library: RecentLibrary; nativeOpenAvailable: boolean; onOpen(item: RecentModel): Promise<void>;
}) {
  const state = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const stop = watchRecentModels(library);
    return () => { alive.current = false; stop(); };
  }, [library]);
  const searchQuery = state.items.length ? query : '';
  const items = filterRecentModels(state.items, searchQuery);
  const open = async (item: RecentModel) => {
    if (opening) return;
    setOpening(item.id); setOpenError('');
    try { await onOpen(item); }
    catch (error) { if (alive.current) setOpenError(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) setOpening(null); }
  };
  return <main className="cad-library">
    <div className="cad-library-brand"><img className="cad-library-logo" src={cadLogo} alt="CAD" width={1202} height={512} /></div>
    <section className="cad-library-content">
    <header className="cad-library-heading"><h1>Recent models</h1>
      <div className="cad-library-tools">{state.items.length > 0 && <label className="cad-library-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="Search recent models" placeholder="Search models" value={query} onChange={event => setQuery(event.target.value)} /></label>}</div>
    </header>
    {(state.error || openError) && <div className="cad-library-error" role="alert"><p>{openError || state.error}</p>{state.error && <button onClick={() => void library.refresh().catch(() => {})}>Try again</button>}</div>}
    {state.loading && !state.hydrated ? <p className="cad-library-empty" role="status">Loading recent models…</p> : !items.length ? <section className="cad-library-empty">
      <p>{searchQuery ? 'No matching models.' : 'Open a CAD file to see it here.'}</p>
    </section> : <div className="cad-recent-grid">{items.map(item => <article key={item.id} className="cad-recent-item">
      <button className="cad-recent-open" disabled={item.missing || Boolean(opening)} aria-label={`${nativeOpenAvailable ? 'Open' : 'Preview'} ${item.name}${nativeOpenAvailable ? '' : ' here'}`} onClick={() => void open(item)}>
        <Thumbnail item={item} library={library} /><span className="cad-recent-name">{item.name}</span><span className="cad-recent-folder">{item.path.replace(/[\\/][^\\/]+$/, '')}</span>
        <span className="cad-recent-status">{item.missing ? 'File unavailable' : opening === item.id ? 'Opening…' : nativeOpenAvailable ? `${item.pinned ? 'Pinned · ' : ''}${new Date(item.lastOpened * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : 'Preview here'}</span>
      </button>
      <div className="cad-recent-actions"><button aria-label={`${item.pinned ? 'Unpin' : 'Pin'} ${item.name}`} aria-pressed={item.pinned} disabled={state.pending.includes(item.id)} onClick={() => void library.pin(item).catch(() => {})}><Pin size={14} /></button>
        <button aria-label={`Remove ${item.name} from recents`} disabled={state.pending.includes(item.id)} onClick={() => void library.remove(item).catch(() => {})}><X size={14} /></button></div>
    </article>)}</div>}
    </section>
  </main>;
}
