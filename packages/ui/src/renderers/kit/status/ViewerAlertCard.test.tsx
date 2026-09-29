import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ViewerAlertCard from './ViewerAlertCard.jsx';
import { failureAlert } from './loadAlerts.js';
import { ViewerHostContext } from '../../../host/context.js';
import { testHost } from '../../../host/testing/host.js';
Object.assign(globalThis, { React });
afterEach(cleanup);

const compileFailure = failureAlert('part.step', 'NameError: name "bracket" is not defined', null, true);

it('a build failure keeps its default next step when the host says nothing', () => {
  render(<ViewerHostContext.Provider value={testHost()}>
    <ViewerAlertCard alert={compileFailure} hasContent={false} onReload={() => {}} />
  </ViewerHostContext.Provider>);
  expect(screen.getByText(/viewer’s terminal output/)).toBeTruthy();
  expect(screen.getByText('“part.step” could not be prepared for display.')).toBeTruthy();
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Try again']);
});

it('the host supplies the build failure’s words and actions beside Try again', async () => {
  const run = vi.fn(async () => 'Added to the prompt.');
  const recover = vi.fn(() => ({ message: 'The CAD runtime reported an error building this file.', recovery: 'Ask the agent to fix it.', actions: [{ label: 'Ask the agent to fix', run }] }));
  const reload = vi.fn();
  render(<ViewerHostContext.Provider value={testHost({ loadFailures: { recover } })}>
    <ViewerAlertCard alert={compileFailure} hasContent={false} onReload={reload} />
  </ViewerHostContext.Provider>);
  expect(recover).toHaveBeenCalledWith(expect.objectContaining({ kind: 'compile', file: 'part.step', reason: 'NameError: name "bracket" is not defined', blocking: true }));
  expect(screen.queryByText(/terminal output/)).toBeNull();
  expect(screen.getByText('The CAD runtime reported an error building this file.')).toBeTruthy();
  expect(screen.getByText('NameError: name "bracket" is not defined')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(reload).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Ask the agent to fix' }));
  expect(run).toHaveBeenCalledTimes(1);
  expect((await screen.findByRole('status')).textContent).toBe('Added to the prompt.');
});

it('an action that fails says why', async () => {
  const recover = () => ({ actions: [{ label: 'Copy details', run: async () => { throw new Error('Clipboard refused.'); } }] });
  render(<ViewerHostContext.Provider value={testHost({ loadFailures: { recover } })}>
    <ViewerAlertCard alert={compileFailure} hasContent={false} onReload={() => {}} />
  </ViewerHostContext.Provider>);
  expect(screen.getByText(/viewer’s terminal output/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
  expect((await screen.findByRole('status')).textContent).toBe('Clipboard refused.');
});
