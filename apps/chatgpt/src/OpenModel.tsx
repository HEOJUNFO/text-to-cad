import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button } from '@text-to-cad/ui/primitives/button';
import { Input } from '@text-to-cad/ui/primitives/input';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@text-to-cad/ui/primitives/popover';
import { isDocumentPath } from './transport';

/** The host can open an absolute path, but does not expose a file chooser. */
export function OpenModel({ onOpen, disabled }: { onOpen(path: string): Promise<void>; disabled?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const active = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const submit = async () => {
    if (busy.current) return;
    const absolutePath = path.trim().replace(/^(["'])(.*)\1$/, '$2');
    if (!isDocumentPath(absolutePath)) { setError('Enter the full absolute path to the model.'); return; }
    if (!/\.(step|stp|stl|glb|3mf)$/i.test(absolutePath)) { setError('Choose a STEP, STL, GLB or 3MF model.'); return; }
    busy.current = true; setPending(true); setError('');
    try {
      await onOpen(absolutePath);
      if (active.current) { setExpanded(false); setPath(''); }
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  };
  return <Popover open={expanded} onOpenChange={(value: boolean) => { if (!busy.current) { setExpanded(value); setError(''); } }}>
    <PopoverTrigger asChild><Button size="sm" disabled={disabled || pending}><FolderOpen aria-hidden="true" />Open Model</Button></PopoverTrigger>
    <PopoverContent align="start" className="cad-open-model text-ui" aria-label="Open model by path">
      <div aria-busy={pending}>
        <label htmlFor="cad-model-path">Model path</label>
        <Input id="cad-model-path" className="h-8" type="text" value={path} onChange={(event: ChangeEvent<HTMLInputElement>) => { setPath(event.target.value); setError(''); }} onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} placeholder="/path/to/model.step" disabled={pending} autoComplete="off" spellCheck={false} aria-invalid={Boolean(error)} aria-describedby={error ? 'cad-model-path-error' : 'cad-model-path-hint'} />
        <p id="cad-model-path-hint" className="text-muted-foreground">Paste the full path to a STEP, STL, GLB or 3MF file.</p>
        {error && <p id="cad-model-path-error" role="alert" className="text-destructive">{error}</p>}
        <div className="cad-open-model-actions">
          <PopoverClose asChild><Button type="button" variant="ghost" size="sm" disabled={pending}>Cancel</Button></PopoverClose>
          <Button type="button" size="sm" disabled={pending} onClick={() => void submit()}>{pending ? 'Opening…' : 'Open'}</Button>
        </div>
      </div>
    </PopoverContent>
  </Popover>;
}
