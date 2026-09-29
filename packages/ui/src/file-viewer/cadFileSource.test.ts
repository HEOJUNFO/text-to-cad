import { describe, expect, it } from 'vitest';
import type { CadEntry, CadService } from '@text-to-cad/core/client';
import { createCadDocumentSource } from './cadFileSource.js';

function catalog(initial: CadEntry[]) {
  let entries = initial;
  const listeners = new Set<() => void>();
  const resolved: string[] = [];
  const client = {
    getSnapshot: () => ({ entries }),
    resolveEntry: async (path: string) => {
      resolved.push(path);
      const entry = entries.find(item => item.file === path);
      if (!entry) throw new Error(`Missing ${path}`);
      return entry;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } as unknown as CadService;
  return { client, resolved, publish(next: CadEntry[]) { entries = next; listeners.forEach(listener => listener()); } };
}

describe('one-document CAD source', () => {
  it('keeps same-named documents distinct by their real absolute identities', async () => {
    const first = '/projects/one/bracket.step';
    const second = '/projects/two/bracket.step';
    const store = catalog([{ file: first, hash: 'one', bytes: 42 }, { file: second, hash: 'two', bytes: 84 }]);
    const one = createCadDocumentSource(store.client, { id: 'doc-one', path: first, name: 'bracket.step' });
    const two = createCadDocumentSource(store.client, { id: 'doc-two', path: second, name: 'bracket.step' });
    const signal = new AbortController().signal;
    const [oneFile, twoFile] = await Promise.all([one.stat(first, { signal }), two.stat(second, { signal })]);
    expect([one.id, two.id]).toEqual(['doc-one', 'doc-two']);
    expect([oneFile.path, twoFile.path]).toEqual([first, second]);
    expect([oneFile.size, twoFile.size]).toEqual([42, 84]);
    expect(one.resourceRef?.(oneFile)).toEqual({ kind: 'local-file', path: first, revision: oneFile.revision });
    expect(two.resourceRef?.(twoFile)).toEqual({ kind: 'local-file', path: second, revision: twoFile.revision });
    expect(store.resolved).toEqual([first, second]);
    expect('list' in one || 'paths' in one || 'rootName' in one).toBe(false);
    await expect(one.stat(second, { signal })).rejects.toThrow(/only its authorized document/);
    expect(() => one.resourceRef?.(twoFile)).toThrow(/another document/);
  });

  it('reports only its document changes at the exact absolute path', () => {
    const first = '/projects/one/bracket.step';
    const second = '/projects/two/bracket.step';
    const original = [{ file: first, hash: 'one', bytes: 42 }, { file: second, hash: 'two', bytes: 84 }];
    const store = catalog(original);
    const source = createCadDocumentSource(store.client, { id: 'doc-one', path: first, name: 'bracket.step' });
    const received: unknown[] = [];
    const unsubscribe = source.subscribe?.(change => received.push(change));
    store.publish([original[0], { ...original[1], hash: 'elsewhere' }]);
    expect(received).toEqual([]);
    store.publish([{ ...original[0], hash: 'updated' }, original[1]]);
    expect(received).toEqual([{ sourceId: 'doc-one', changes: [{ kind: 'content', path: first,
      revision: expect.any(String) }] }]);
    unsubscribe?.();
    store.publish([]);
    expect(received).toHaveLength(1);
  });
});
