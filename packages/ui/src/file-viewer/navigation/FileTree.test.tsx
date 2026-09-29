import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileTree } from '../../../dist/file-viewer/navigation/FileTree.js';

const scrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Element.prototype.scrollIntoView = scrollIntoView; });

const LISTINGS = {
  '': [
    { path: '.git', name: '.git', kind: 'directory' },
    { path: '.github', name: '.github', kind: 'directory' },
    { path: '.gitignore', name: '.gitignore', kind: 'file' },
    { path: 'notes.txt', name: 'notes.txt', kind: 'file' },
    { path: 'part.step', name: 'part.step', kind: 'file' },
  ],
  '.git': [{ path: '.git/config', name: 'config', kind: 'file' }],
};

function Tree({ activePath = null as string | null, onOpen = (_: string) => {} }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState(activePath);
  const source = { rootName: 'project', expanded, setExpanded, listings: LISTINGS, load() {}, revision: 0,
    paths: async () => ['.git/config', '.github/ci.yml', 'notes.txt', 'part.step'], platform: 'darwin', onAction() {} };
  return <FileTree source={source as any} activePath={active} onOpen={(path: string) => { setActive(path); onOpen(path); }} />;
}
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-path]')].map(row => row.dataset.path);

it('leaves .git out of the tree and the filter, and keeps every other dotfile', async () => {
  render(<Tree />);
  expect(rows()).toEqual(['.github', '.gitignore', 'notes.txt', 'part.step']);
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter files' }), { target: { value: 'c' } });
  await waitFor(() => expect(rows()).toContain('.github/ci.yml'));
  expect(rows()).not.toContain('.git/config');
});

it('shows .git while the open file is inside it', () => {
  render(<Tree activePath=".git/config" />);
  expect(rows()).toContain('.git');
});

it('a file picked from the filter opens and brings the whole tree back', async () => {
  const onOpen = vi.fn();
  render(<Tree onOpen={onOpen} />);
  const filter = screen.getByRole('textbox', { name: 'Filter files' }) as HTMLInputElement;
  fireEvent.change(filter, { target: { value: 'part' } });
  await waitFor(() => expect(rows()).toEqual(['part.step']));
  fireEvent.click(document.querySelector('[data-path="part.step"]')!);
  expect(onOpen).toHaveBeenCalledWith('part.step');
  expect(filter.value).toBe('');
  expect(rows()).toEqual(['.github', '.gitignore', 'notes.txt', 'part.step']);

  // From the keyboard too: Enter on the ranked list opens its first match and ends the search.
  fireEvent.change(filter, { target: { value: 'notes' } });
  await waitFor(() => expect(rows()).toEqual(['notes.txt']));
  fireEvent.keyDown(filter, { key: 'Enter' });
  expect(onOpen).toHaveBeenLastCalledWith('notes.txt');
  expect(filter.value).toBe('');
});
