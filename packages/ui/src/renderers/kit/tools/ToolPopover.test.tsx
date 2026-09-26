import React, { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ToolPopover from '../../../../dist/renderers/kit/tools/ToolPopover.js';
import FloatingToolBar from '../../../../dist/renderers/kit/tools/FloatingToolBar.js';
import { MeasureModeIcon, MeasureModeMenu, SelectModeIcon, SelectModeMenu } from '../../../../dist/renderers/step/components/workbench/SelectionFilterMenu.js';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('ephemeral tool options dismiss on a choice, outside press, or repeated trigger press', async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  function Harness() {
    const [active, setActive] = useState(false);
    return <><button>Outside</button><FloatingToolBar tools={[{ id: 'select', label: 'Select', active, icon: null,
      secondPressOpensMenu: true, onSelect: () => setActive(true),
      menu: trigger => <MeasureModeMenu trigger={trigger} mode="all" onModeChange={changed} /> }]} /></>;
  }
  render(<Harness />);
  const select = screen.getByRole('button', { name: 'Select', exact: true });
  await user.click(select);
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(select);
  expect(screen.getByRole('menu')).toBeTruthy();
  await user.click(screen.getByRole('menuitemradio', { name: 'Faces' }));
  expect(changed).toHaveBeenCalledWith('faces');
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(select);
  await user.click(screen.getByRole('button', { name: 'Outside' }));
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(select);
  await user.click(select);
  expect(screen.queryByRole('menu')).toBeNull();
});

it('a corner press selects first and only opens options when already selected', async () => {
  const user = userEvent.setup();
  const activate = vi.fn();
  function Harness() {
    const [active, setActive] = useState(false);
    return <FloatingToolBar tools={[{ id: 'tool', label: 'Tool', active, icon: null,
      secondPressOpensMenu: true, onSelect: () => { activate(); setActive(true); },
      menu: trigger => <ToolPopover trigger={trigger} label="Tool options">Options</ToolPopover> }]} />;
  }
  render(<Harness />);
  const button = screen.getByRole('button', { name: 'Tool', exact: true });
  await user.click(button.querySelector('[data-tool-menu-corner]')!);
  expect(activate).toHaveBeenCalledOnce();
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(button.querySelector('[data-tool-menu-corner]')!);
  expect(screen.getByRole('menu')).toBeTruthy();
  await user.hover(button);
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it('the Select mode menu offers Parts only in an assembly, keeps inapplicable options disabled, and a tick leaves it open', async () => {
  const user = userEvent.setup();
  const connectedChange = vi.fn();
  function Harness({ assembly, mode }: { assembly: boolean, mode: string }) {
    return <FloatingToolBar tools={[{ id: 'select', label: 'Select', active: true, icon: null, secondPressOpensMenu: true, onSelect: () => {},
      menu: trigger => <SelectModeMenu trigger={trigger} mode={mode} assembly={assembly} onModeChange={() => {}}
        connected={{ edgeChain: false, tangentFaces: true }} onConnectedChange={connectedChange} /> }]} />;
  }
  const view = render(<Harness assembly={false} mode="faces" />);
  await user.click(screen.getByRole('button', { name: 'Select', exact: true }));
  expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual(['All', 'Faces', 'Edges']);
  const chain = screen.getByRole('menuitemcheckbox', { name: 'Edge chain' });
  expect(chain.getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole('menuitemcheckbox', { name: 'Tangent faces' }).getAttribute('aria-checked')).toBe('true');
  await user.click(screen.getByRole('menuitemcheckbox', { name: 'Tangent faces' }));
  expect(connectedChange).toHaveBeenCalledWith('tangentFaces', false);
  expect(screen.getByRole('menu')).toBeTruthy();
  await user.keyboard('{Escape}');
  view.rerender(<Harness assembly mode="all" />);
  await user.click(screen.getByRole('button', { name: 'Select', exact: true }));
  expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual(['All', 'Parts', 'Faces', 'Edges']);
  expect(screen.getByRole('menuitemcheckbox', { name: 'Edge chain' }).getAttribute('aria-disabled')).toBeNull();
});

it('Select and Measure draw one composite icon, the tool\'s glyph badged with the mode, and Measure\'s menu is four plain rows', async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<FloatingToolBar tools={[
    { id: 'select', label: 'Select', active: false, icon: <SelectModeIcon mode="parts" aria-hidden="true" />, onSelect: () => {} },
    { id: 'measure', label: 'Measure', active: true, icon: <MeasureModeIcon mode="edges" aria-hidden="true" />, secondPressOpensMenu: true, onSelect: () => {},
      menu: trigger => <MeasureModeMenu trigger={trigger} mode="edges" onModeChange={changed} /> }]} />);
  const badges = (root: Element) => [...root.querySelectorAll('svg[data-tool-icon-base]')].map(icon =>
    `${icon.getAttribute('data-tool-icon-base')}:${icon.querySelector('[data-tool-icon-badge]')?.getAttribute('data-tool-icon-badge') ?? ''}`);
  // The strip shows the mode in hand, on the tool's own glyph.
  const select = screen.getByRole('button', { name: 'Select', exact: true });
  const measure = screen.getByRole('button', { name: 'Measure', exact: true });
  expect(select.querySelector('[data-select-mode]')?.getAttribute('data-select-mode')).toBe('parts');
  expect(measure.querySelector('[data-measure-mode]')?.getAttribute('data-measure-mode')).toBe('edges');
  expect([...badges(select), ...badges(measure)]).toEqual(['select:parts', 'measure:edges']);
  await user.click(measure);
  const menu = document.querySelector('[role=menu][aria-label="Measure snapping"]')!;
  expect(menu).toBeTruthy();
  // No heading and no descriptions: four rows, each its icon and one word.
  expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual(['All', 'Points', 'Edges', 'Faces']);
  expect(menu.querySelector('[data-slot=dropdown-menu-label]')).toBeNull();
  // Each row its mode's own glyph at full size (All: the ruler); the composite is the strip's alone.
  expect([...menu.querySelectorAll('svg[data-mode-glyph]')].map(icon => icon.getAttribute('data-mode-glyph'))).toEqual(['measure', 'points', 'edges', 'faces']);
  expect(badges(menu)).toEqual([]);
  await user.click(screen.getByRole('menuitemradio', { name: 'Points' }));
  expect(changed).toHaveBeenCalledWith('points');
  cleanup();
  render(<SelectModeIcon mode="nonsense" />);
  expect(badges(document.body)).toEqual(['select:']);
});
