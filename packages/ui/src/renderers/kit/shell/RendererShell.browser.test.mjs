import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import { interactiveCameraFrameForBounds } from '../../../../dist/renderers/kit/camera/viewportCameraFit.js';
import { DEFAULT_VIEW_DIRECTION, WORLD_UP } from '../../../../dist/renderers/kit/camera/viewportCameraKit.js';
import { CAD_DEFAULT_VERTICAL_FOV_DEGREES } from '../../../../dist/renderers/kit/camera/cameraLens.js';
import { TOOL_STACK_DEFAULT_WIDTH, TOOL_STACK_MIN_WIDTH } from '../../../../dist/renderers/kit/tools/toolStackLayout.js';

// The shell end to end, in a real browser, under the smallest renderer that mounts it: a
// one-triangle mesh file. Everything asserted here is the shell's (kit/shell), so it holds
// for every renderer built on it. Inline fixture bytes are served in memory with a private
// temporary harness.
const mesh = 'solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 20 0 0\nvertex 0 20 0\nendloop\nendfacet\nendsolid triangle\n';

test('a shell renderer resolves deferred files, reuses warm assets, restores isolated view state and edits settings on the live canvas', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'hardcore-cad-browser-'));
  let server, browser;
  t.after(async () => { await browser?.close(); if (server) await new Promise((resolve) => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); });
  await build({ entryPoints: [fileURLToPath(new URL('../../harness/index.tsx', import.meta.url))], outfile: join(temporary, 'harness.js'), bundle: true, format: 'esm', platform: 'browser', conditions: ['production'], jsx: 'automatic', loader: { '.webp': 'dataurl', '.woff2': 'dataurl' } });
  const bundle = await readFile(join(temporary, 'harness.js'));
  const compiledCss = await readFile(new URL('../../../../dist/styles.css', import.meta.url));
  const requests = [];
  const catalogFiles = [];
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://test');
    requests.push(url.pathname);
    const root = url.pathname.split('/')[1];
    if (url.pathname === '/harness.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle); }
    else if (url.pathname === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(compiledCss); }
    else if (url.pathname.endsWith('/__cad/catalog')) {
      response.setHeader('Content-Type', 'application/json');
      catalogFiles.push({ root, file: url.searchParams.get('file') });
      const entry = url.searchParams.get('file') === 'part.stl'
        ? { kind: 'stl', file: 'part.stl', rootRelativeFile: 'part.stl', url: '/mesh.stl', hash: root, bytes: mesh.length }
        : { file: 'part.stl', rootRelativeFile: 'part.stl', catalogPending: true };
      response.end(JSON.stringify({ rootId: root, entries: [entry] }));
    } else if (url.pathname.endsWith('/__cad/server')) {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ rootId: root, rootPath: '/models', backend: 'cadgen' }));
    } else if (url.pathname.endsWith('/mesh.stl')) { response.end(mesh); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><title>Host title</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, args: process.platform === 'darwin'
    ? ['--use-angle=metal']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.Worker = undefined;
    // A Retina quality switch resizes the drawing buffer. Every such clear
    // must be followed by its replacement draw in the SAME task, even while
    // shader preparation is asynchronous. Canvas identity alone cannot catch it.
    const draws = new WeakMap();
    window.cadBufferClears = [];
    for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const original = WebGL2RenderingContext.prototype[name];
      WebGL2RenderingContext.prototype[name] = function (...args) {
        draws.set(this.canvas, (draws.get(this.canvas) || 0) + 1);
        return original.apply(this, args);
      };
    }
    for (const name of ['width', 'height']) {
      const property = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name);
      Object.defineProperty(HTMLCanvasElement.prototype, name, { ...property, set(value) {
        property.set.call(this, value);
        if (this !== window.cadHarnessView?.canvas) return;
        const before = draws.get(this) || 0;
        queueMicrotask(() => window.cadBufferClears.push({ name, redrawn: (draws.get(this) || 0) > before }));
      } });
    }

    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(window, name, { get() { throw new Error(`Renderer accessed ${name}`); } });
    }
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const first = page.getByTestId('one');
  // The nav row's panel toggles, in order, each with whether its panel is the open one.
  const panels = pane => pane.locator('[data-file-panel]')
    .evaluateAll(buttons => buttons.map(button => `${button.getAttribute('aria-label')}:${button.getAttribute('aria-pressed')}`));
  // Display's settings are a popover from the button beside Fullscreen (`DisplayPopover.jsx`),
  // portaled out of the pane: a file never opens with it, and it is not a tool.
  const displayButton = pane => pane.getByRole('button', { name: 'Display settings', exact: true });
  const display = page.locator('[data-display-popover]');
  const openDisplay = async pane => {
    if (await displayButton(pane).getAttribute('aria-pressed') !== 'true') await displayButton(pane).click();
    await display.waitFor();
  };
  const openSection = async title => {
    await openDisplay(first);
    if (['Mode', 'Projection'].includes(title)) await display.getByRole('combobox', { name: title, exact: true }).click();
    else await display.getByRole('heading', { name: title, exact: true }).hover();
  };
  const setEnabled = async (title, enabled) => {
    await openDisplay(first);
    const button = display.getByRole('button', { name: `${enabled ? 'Enable' : 'Disable'} ${title}`, exact: true });
    if (await button.count()) await button.click();
  };
  const modeLabel = async () => `Mode${await display.getByRole('combobox', { name: 'Mode', exact: true }).innerText()}`;
  // The camera is moved through the live controller now: there is no zoom control in the
  // viewer to press.
  const zoomTo = (testId, zoom) => page.evaluate(async ([id, value]) => {
    const controller = window.cadHarness[id].controller;
    await controller.setCamera({ ...controller.readState().camera, zoom: value });
  }, [testId, zoom]);
  const cameraZoom = () => page.evaluate(() => window.cadHarness.a.controller.readState().camera?.zoom ?? null);
  await displayButton(first).waitFor().catch(async (error) => { throw new Error(`${error.message}; page errors: ${errors.join('; ')}; body: ${await page.locator("body").innerText()}; requests: ${requests.join(", ")}`); });
  // The file opened directly and opened with nothing: a mesh has no panel of its own, and
  // Display, its only one, is never where a file opens. Nor is the tree.
  assert.deepEqual(await panels(first), ['Show files:false']);
  assert.equal(await first.locator('[data-file-panel-container]').count(), 0, 'nothing in the host\'s column');
  await openDisplay(first);
  await page.waitForFunction(() => Object.keys(window.cadHarness.state.renderers || {}).length > 0);
  assert.deepEqual(errors, []);
  assert.equal(await page.title(), 'Host title');
  // No zoom chrome survives anywhere in the shell: not the percentage readout, and not the
  // menu behind it. Nor is there a header of tabs inside the panel to carry either: the nav
  // row is the tab strip.
  assert.equal(await first.getByRole('button', { name: 'Zoom controls', exact: true }).count(), 0);
  assert.equal(await first.getByLabel('Zoom level percent', { exact: true }).count(), 0);
  assert.equal(await first.getByRole('tablist').count(), 0, 'no tab strip inside the panel');
  await zoomTo('a', 1.1);
  await page.waitForFunction(() => Math.abs((window.cadHarness.a.controller.readState().camera?.zoom ?? 0) - 1.1) < 1e-6);
  await openDisplay(first);
  assert.equal(await first.getByRole('button', { name: 'Theme settings', exact: true }).count(), 0);
  // Its button puts it away again.
  await displayButton(first).click();
  await display.waitFor({ state: 'detached' });
  assert.equal(await displayButton(first).getAttribute('aria-pressed'), 'false');
  await first.getByRole('button', { name: 'Take snapshot', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.captures.length === 1);
  const captured = await page.evaluate(() => window.cadHarness.captures[0]);
  assert.equal(captured.file, 'part.stl');
  assert.equal(captured.type, 'image/png');
  assert.ok(captured.size > 100);
  assert.equal(captured.references.length, 1);
  assert.deepEqual(captured.references[0].target, { kind: 'whole-resource' });
  assert.equal(captured.references[0].resource.workspaceId, 'one');
  assert.equal(captured.references[0].resource.path, 'part.stl');
  // A mesh hands the shell no tools, so there is no strip over its viewport at
  // all: orbit, pan and zoom, and nothing to take up. Display is not a tool: its settings are
  // the button in the top-right bar.
  assert.equal(await first.getByRole('group', { name: 'Interaction tools' }).count(), 0, 'no tools, so no strip');
  assert.equal(await first.locator('[data-cad-toolbar]').getByRole('button', { name: /^Display/ }).count(), 0, 'Display is never on the strip');
  for (const name of ['Orbit', 'Draw', 'Select', 'Measure', 'Position', 'Animate']) {
    assert.equal(await first.getByRole('button', { name, exact: true }).count(), 0, name);
  }
  // Nor a menu of its own on a secondary press — and the browser's own is still
  // kept off the canvas, so the press is the camera's and nothing else.
  const canvasBox = await first.locator('[aria-busy] > div > canvas').first().boundingBox();
  await page.evaluate(() => {
    window.nativeMenu = [];
    window.addEventListener('contextmenu', event => window.nativeMenu.push(event.defaultPrevented), true);
    document.addEventListener('contextmenu', event => window.nativeMenu.push(event.defaultPrevented));
  });
  await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2, { button: 'right' });
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('menu').count(), 0, 'a mesh viewport opens no menu');
  assert.deepEqual(await page.evaluate(() => window.nativeMenu), [false, true],
    'the event reaches the canvas and leaves it prevented: no native menu either');
  await openDisplay(first);
  await page.evaluate(() => window.cadHarness.second(true));
  await openDisplay(page.getByTestId('two'));
  // One popover at a time: the press on the second viewer's button put the first one's away.
  assert.equal(await display.count(), 1);
  assert.equal(await displayButton(first).getAttribute('aria-pressed'), 'false');
  assert.equal(await displayButton(page.getByTestId('two')).getAttribute('aria-pressed'), 'true');
  await displayButton(page.getByTestId('two')).click();
  await display.waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('two').getByRole('button', { name: 'Zoom controls', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.cadHarness.b.controller.readState().camera?.zoom), 1,
    'a sibling renderer opens at its own framing');
  assert.ok(requests.includes('/one/mesh.stl'));
  assert.ok(requests.includes('/two/mesh.stl'));
  assert.ok(catalogFiles.some(({ root, file }) => root === 'one' && file === 'part.stl'));
  assert.ok(catalogFiles.some(({ root, file }) => root === 'two' && file === 'part.stl'));
  assert.ok(Math.abs(await cameraZoom() - 1.1) < 1e-6, 'the first pane kept the camera it was given');
  // A second pane changes the first viewport's dimensions. Let its resize
  // observer and camera event publish before taking the saved snapshot.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // The file goes with its Display settings open.
  await openDisplay(first);
  await page.evaluate(() => window.cadHarness.mounted(false));
  await display.waitFor({ state: 'detached' });
  await first.locator('[data-slot="cad-file-view"]').waitFor({ state: 'detached' });
  // Unmount persists display preferences, but never camera framing.
  const before = await page.evaluate(() => window.cadHarness.state);
  assert.deepEqual(Object.keys(before.renderers), [JSON.stringify(['part.stl', 'mesh'])], 'one record per file, keyed [path, renderer id]');
  for (const saved of Object.values(before.renderers)) assert.equal(saved.camera, null, 'camera framing is not persisted');
  await page.evaluate(() => window.cadHarness.mounted(true));
  // Popover visibility is transient, not file state.
  await displayButton(first).waitFor();
  assert.equal(await display.count(), 0, 'the remounted file opens with its Display settings shut');
  assert.equal(await displayButton(first).getAttribute('aria-pressed'), 'false');
  // The pane remounts before the viewport adopts the mesh and publishes its restored
  // camera. Wait for the actual presented frame, not an arbitrary settling delay.
  const restoreDiagnostic = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="one"]');
    const state = Object.values(window.cadHarness.state.renderers || {})[0];
    return { busy: pane.querySelector('[aria-busy]')?.getAttribute('aria-busy'), savedCamera: state?.camera };
  });
  await page.waitForFunction(() => {
    const pane = document.querySelector('[data-testid="one"]');
    return pane?.querySelector('[aria-busy="false"] canvas') &&
      !pane.querySelector('[data-viewer-transition], [data-viewer-loading]');
  });
  t.diagnostic(`Remount camera readiness: ${JSON.stringify({ ...restoreDiagnostic, presentedZoom: await cameraZoom() })}`);
  // Each remount opens at its own fit; display settings are durable.
  await page.waitForFunction(() => Math.abs((window.cadHarness.a.controller.readState().camera?.zoom ?? 0) - 1) < 1e-6);
  const after = await page.evaluate(() => window.cadHarness.state);
  const previousState = structuredClone(before.renderers);
  const restoredState = structuredClone(after.renderers);
  assert.deepEqual(restoredState, previousState);
  assert.equal(requests.filter((path) => path === '/one/mesh.stl').length, 1, 'reopening a file reuses its decoded mesh without another asset request');
  // Presets and settings edit the live renderer; no replacement canvas, hidden
  // canvas or opening overlay may appear, even transiently between assertions.
  await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="one"]');
    const canvas = pane.querySelector('[aria-busy] > div > canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing live WebGL canvas');
    window.cadHarnessView = { canvas, interruptions: [] };
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of record.removedNodes) {
            if (node === canvas || node.contains?.(canvas)) window.cadHarnessView.interruptions.push('canvas removed');
          }
          for (const node of record.addedNodes) {
            if (node.matches?.('[data-viewer-transition]') || node.querySelector?.('[data-viewer-transition]')) window.cadHarnessView.interruptions.push('opening overlay');
          }
        }
        if (record.target === canvas && (canvas.style.visibility === 'hidden' || /visibility:\s*hidden/.test(record.oldValue || ''))) {
          window.cadHarnessView.interruptions.push('canvas hidden');
        }
      }
    });
    observer.observe(pane, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'], attributeOldValue: true });
  });
  await openDisplay(first);
  // Display's popover: sections under headings, with no tab in sight; the nav row is unchanged.
  assert.deepEqual(await panels(first), ['Show files:false']);
  assert.equal(await first.getByRole('tab').count(), 0);
  for (const title of ['Explode', 'Cross-section', 'Edges']) {
    assert.equal(await display.getByRole('heading', { name: title, exact: true }).count(), 0);
  }
  assert.equal(await display.getByRole('heading', { name: 'Lighting', exact: true }).count(), 1);
  await openSection('Lighting');
  assert.equal(await display.getByLabel('Exposure value', { exact: true }).count(), 0);
  await setEnabled('Lighting', true);
  assert.equal(await display.getByLabel('Exposure value', { exact: true }).inputValue(), '0.0 EV');
  await setEnabled('Lighting', false);
  assert.equal(await display.getByLabel('Exposure value', { exact: true }).count(), 0);
  assert.equal(await display.getByRole('button', { name: /^Projection:/ }).count(), 0);
  assert.equal(await display.getByRole('combobox', { name: 'Projection', exact: true }).innerText(), 'Orthographic');
  assert.equal(await display.getByRole('combobox', { name: 'Surface style', exact: true }).count(), 1);
  assert.equal(await display.getByRole('combobox', { name: 'Parts', exact: true }).count(), 1);
  await openSection('Floor');
  await page.waitForTimeout(250);
  assert.equal(await display.getByRole('button', { name: 'Enable Floor', exact: true }).count(), 1, 'hover never enables Floor');
  await setEnabled('Floor', true);
  await page.waitForFunction(() => Object.values(window.cadHarness.state.renderers || {}).some(saved => saved.display?.floor?.enabled));
  assert.match(await display.getByRole('combobox', { name: 'Floor position', exact: true }).innerText(), /Model origin/);
  await setEnabled('Floor', false);
  await page.waitForTimeout(200);
  assert.equal(await display.getByRole('button', { name: 'Enable Floor', exact: true }).count(), 1);
  assert.deepEqual(await page.evaluate(() => window.cadHarness.a.controller.readState().display.floor), { enabled: false });
  // A guide's paint is a settings-only edit: it reaches the saved state without a scene sync.
  // The floor is scene content, so its gate above does sync; let that land first.
  const settledSceneSyncs = () => page.evaluate(async () => {
    for (let count = -1; count !== window.__viewerSurfaceLooks.count;) {
      count = window.__viewerSurfaceLooks.count;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return window.__viewerSurfaceLooks.count;
  });
  const syncsBeforeGrid = await settledSceneSyncs();
  await openSection('Grid / Axes');
  await display.getByRole('button', { name: 'Grid color', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Color opacity' }).fill('40');
  await page.getByRole('spinbutton', { name: 'Color opacity' }).press('Tab');
  await page.waitForFunction(() => Object.values(window.cadHarness.state.renderers || {}).some(saved => saved.display?.grid?.opacity === 0.4));
  await page.keyboard.press('Escape');
  assert.equal(await settledSceneSyncs(), syncsBeforeGrid, 'Grid paint only changes the guide: the scene is not dressed again');
  await setEnabled('Lighting', true);
  await display.getByLabel('Exposure value', { exact: true }).fill('0.8');
  await display.getByLabel('Exposure value', { exact: true }).press('Enter');
  await display.getByLabel('Rotation value', { exact: true }).fill('45');
  await display.getByLabel('Rotation value', { exact: true }).press('Enter');
  await page.waitForFunction(() => Object.values(window.cadHarness.state.renderers || {}).some(saved => {
    const lighting = saved.display?.lighting;
    return lighting?.exposure === 0.8 && lighting.rotation === 45;
  }));
  await setEnabled('Lighting', false);
  assert.deepEqual(await page.evaluate(() => window.cadHarness.a.controller.readState().display.lighting), { enabled: false });
  // Reopening a gate starts from its defaults, never its previous values.
  await setEnabled('Lighting', true);
  assert.equal(await display.getByLabel('Exposure value', { exact: true }).inputValue(), '0.0 EV');
  assert.equal(await display.getByLabel('Rotation value', { exact: true }).inputValue(), '0°');
  await page.evaluate(() => window.cadHarness.a.controller.setDisplaySettings({
    clip: { enabled: true, axis: 'x', offsets: { x: 0.6 } },
    exploded: { enabled: true, amount: 0.3 },
    surfaces: { colorMode: 'single', color: '#336699' }
  }));
  await page.waitForFunction(() => !window.cadHarness.a.controller.readState().loading);
  const beforeStyle = await page.evaluate(() => window.cadHarness.a.controller.readState());
  // A command's tools are saved as written, never rewritten to fit the file; a view whose
  // features leave those sections out resolves them off, and no section appears.
  const assertMeshToolsStayOff = async () => {
    for (const scope of [first, display]) {
      assert.equal(await scope.getByRole('region', { name: /^(?:Cross-section|Explode|Clip)$/ }).count(), 0);
      assert.equal(await scope.getByRole('button', { name: /^(?:Cross-section|Explode|Clip)$/ }).count(), 0);
    }
  };
  assert.equal(beforeStyle.display.clip.enabled, true);
  assert.equal(beforeStyle.display.clip.axis, 'x');
  assert.equal(beforeStyle.display.clip.offsets.x, 0.6);
  assert.deepEqual(beforeStyle.display.exploded, { enabled: true, amount: 0.3 });
  await page.waitForFunction(() => Object.values(window.cadHarness.state.renderers || {}).some(saved => {
    const display = saved.display;
    return display?.clip?.enabled === true && display.clip.offsets?.x === 0.6 && display.exploded?.amount === 0.3;
  }));
  await assertMeshToolsStayOff();
  const assertPreservedState = async (preserveTools = true) => {
    const current = await page.evaluate(() => window.cadHarness.a.controller.readState());
    for (const key of ['target', 'up']) {
      current.camera[key].forEach((v, i) => assert.ok(Math.abs(v - beforeStyle.camera[key][i]) < 1e-6, `${key}[${i}] preserved`));
    }
    assert.ok(Math.abs(current.camera.zoom - beforeStyle.camera.zoom) < 1e-6, 'zoom preserved');
    for (const key of ['clip', 'exploded']) {
      if (preserveTools) assert.deepEqual(current.display[key], beforeStyle.display[key]);
      else assert.notEqual(current.display[key]?.enabled, true);
    }
    assert.equal(await page.evaluate(() => window.cadHarness.b.controller.readState().display.mode), 'solid');
  };
  for (const [mode, projection, label] of [
    ['render', 'perspective', 'Render'], ['solid', 'orthographic', 'Solid'],
    ['render', 'perspective', 'Render'], ['solid', 'orthographic', 'Solid']
  ]) {
    await openSection('Mode');
    // The fixture is a mesh: the presets made of CAD edges (X-ray, Hidden line, Wireframe) are not offered.
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['Solid', 'Render']);
    await page.getByRole('option', { name: label, exact: true }).click();
    await page.waitForFunction(({ mode, projection }) => {
      const state = window.cadHarness.a.controller.readState();
      return state.display.mode === mode && state.camera.projection === projection && !state.loading;
    }, { mode, projection });
    await assertPreservedState();
    // A real pointer may land over a different section when the menu closes or
    // preset groups change height. Dwell long enough to catch delayed writes.
    const presetState = await page.evaluate(() => window.cadHarness.a.controller.readState().display);
    for (const title of ['Grid / Axes', 'Lighting', 'Background', 'Floor']) {
      await openSection(title);
      await page.waitForTimeout(220);
      assert.deepEqual(await page.evaluate(() => window.cadHarness.a.controller.readState().display), presetState, `${label}: hover over ${title} must not change settings`);
    }
    assert.equal((await modeLabel()).replace(/\s/g, ''), `Mode${label}`);
  }
  await openSection('Projection');
  await page.getByRole('option', { name: 'Perspective', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().camera.projection === 'perspective');
  await openDisplay(first);
  assert.equal((await modeLabel()).replace(/\s/g, ''), 'ModeCustom');
  // Custom is a muted placeholder, never an option or a selected base preset.
  await openSection('Mode');
  assert.equal(await page.getByRole('option', { name: 'Solid', exact: true }).getAttribute('aria-selected'), 'false');
  assert.equal(await page.getByRole('option', { name: 'Custom', exact: true }).count(), 0);
  await page.getByRole('option', { name: 'Solid', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().camera.projection === 'orthographic');
  await openDisplay(first);
  assert.equal((await modeLabel()).replace(/\s/g, ''), 'ModeSolid');
  await assertPreservedState();

  // Actual control edits must survive subsequent edits and the debounced host
  // save, rather than only being visible in an intermediate React render.
  await openSection('Surfaces');
  await display.getByLabel('Surface opacity value', { exact: true }).fill('65');
  await display.getByLabel('Surface opacity value', { exact: true }).press('Enter');
  await display.getByRole('combobox', { name: 'Surface style', exact: true }).click();
  await page.getByRole('option', { name: 'Flat', exact: true }).click();
  assert.equal(await display.isVisible(), true, 'choosing an option in its Select leaves the popover open');
  await openSection('Surfaces');
  await display.getByRole('combobox', { name: 'Parts', exact: true }).click();
  await page.getByRole('option', { name: 'Single color', exact: true }).click();
  await page.waitForFunction(() => Object.values(window.cadHarness.state.renderers || {}).some(saved => {
    const surfaces = saved.display?.surfaces;
    return surfaces?.opacity === 0.65 && surfaces.style === 'flat' && surfaces.colorMode === 'single';
  }));
  assert.deepEqual(await page.evaluate(() => window.cadHarness.a.controller.readState().display.surfaces), {
    enabled: true, opacity: 0.65, style: 'flat', colorMode: 'single'
  });
  await page.evaluate(() => {
    window.cadHarness.a.controller.setDisplaySettings({ surfaces: { opacity: 0.7 } });
    window.cadHarness.a.controller.setDisplaySettings({ grid: { color: '#123456' } });
    window.cadHarness.a.controller.setDisplaySettings({ axes: { color: '#654321' } });
  });
  await page.waitForFunction(() => Object.values(window.cadHarness.state.renderers || {}).some(saved => {
    const display = saved.display;
    return display?.surfaces?.opacity === 0.7 && display.grid?.color === '#123456' && display.axes?.color === '#654321';
  }));

  // Lighting is independent of the preset and backgrounds carry real alpha.
  await page.evaluate(() => window.cadHarness.a.controller.setDisplaySettings({
    mode: 'solid', lighting: { quality: 'preview', exposure: 0.5 }, background: { opacity: 0.4 }
  }));
  await page.waitForFunction(() => !window.cadHarness.a.controller.readState().loading);
  await openSection('Lighting');
  assert.equal(await display.getByLabel('Exposure value', { exact: true }).inputValue(), '0.5 EV');
  assert.equal((await modeLabel()).replace(/\s/g, ''), 'ModeCustom');
  assert.equal(await display.getByRole('checkbox', { name: 'Transparent', exact: true }).count(), 0);
  await openSection('Background');
  await display.getByRole('button', { name: 'Background color', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Color opacity' }).fill('0');
  await page.getByRole('spinbutton', { name: 'Color opacity' }).press('Tab');
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.background.opacity === 0);
  await page.keyboard.press('Escape');
  await setEnabled('Lighting', false);
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.lighting.enabled === false);
  assert.equal(await display.getByLabel('Exposure value', { exact: true }).count(), 0);
  await openSection('Background');
  assert.equal(await display.getByRole('button', { name: 'Background color', exact: true }).count(), 1, 'disabling Lighting does not disable Background');
  await display.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.waitForFunction(() => !window.cadHarness.a.controller.readState().loading);
  await assertPreservedState(false);
  await openDisplay(first);
  assert.equal((await modeLabel()).replace(/\s/g, ''), 'ModeSolid');

  await openSection('Mode');
  await page.getByRole('option', { name: 'Render', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.mode === 'render' && !window.cadHarness.a.controller.readState().loading);
  await openSection('Lighting');
  await display.getByLabel('Exposure value', { exact: true }).fill('1.5');
  await display.getByLabel('Exposure value', { exact: true }).press('Enter');
  await display.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.mode === 'render' && !window.cadHarness.a.controller.readState().loading);
  assert.equal((await modeLabel()).replace(/\s/g, ''), 'ModeRender');
  await openSection('Lighting');
  assert.equal(await display.getByLabel('Exposure value', { exact: true }).inputValue(), '0.0 EV');
  await assertPreservedState(false);
  // Several commands in one turn must leave controls at the final request,
  // and capture must await that recipe rather than the last React render.
  const finalCapture = await page.evaluate(async () => {
    const controller = window.cadHarness.a.controller;
    const commands = [
      controller.setDisplaySettings({ mode: 'solid' }),
      controller.setDisplaySettings({ mode: 'render' }),
      controller.setDisplaySettings({ lighting: { exposure: 1.25 } }),
      controller.setDisplaySettings({ clip: { enabled: true, offset: 0.3 } }),
    ];
    // Superseded command acknowledgements may reject their old target; handle
    // all of them while the renderer itself coalesces to the latest recipe.
    void Promise.allSettled(commands);
    const capture = await controller.capture();
    return { size: capture.size, display: controller.readState().display,
      error: document.querySelector('[data-view-update-status][role="alert"]')?.textContent };
  });
  assert.ok(finalCapture.size > 100);
  assert.equal(finalCapture.display.mode, 'render');
  assert.equal(finalCapture.display.lighting.exposure, 1.25);
  // The clip command is saved as written; the mesh it was sent to is still not cut.
  assert.equal(finalCapture.display.clip.enabled, true);
  assert.equal(finalCapture.display.clip.offset, 0.3);
  await assertMeshToolsStayOff();
  assert.equal(finalCapture.error, undefined);
  assert.equal(await page.evaluate(() => window.cadHarness.captures.length), 1, 'an acknowledged capture does not replay after remount');
  assert.equal(await page.evaluate(() => window.cadHarnessView.canvas === document.querySelector('[data-testid="one"] [aria-busy] > div > canvas')), true);
  assert.deepEqual(await page.evaluate(() => window.cadHarnessView.interruptions), [], 'settings never replace or cover the live canvas');
  assert.equal(requests.filter(path => path === '/one/mesh.stl').length, 1, 'view edits never reload geometry');
  const clears = await page.evaluate(() => window.cadBufferClears);
  assert.ok(clears.length > 0, 'exercise actual Retina buffer resizes');
  assert.ok(clears.every(clear => clear.redrawn), 'no cleared framebuffer is left waiting for a later draw');
  assert.deepEqual(errors, []);
});

// A wide, flat box: the shape whose fit is decided by its WIDTH against the viewport's
// aspect, so a fit taken under the wrong lens or the wrong canvas shows up immediately.
// (A tall or cubic model is fitted by its height and hides the difference entirely.)
const WIDE_CORNERS = [[0, 0, 0], [140, 0, 0], [140, 80, 0], [0, 80, 0], [0, 0, 2], [140, 0, 2], [140, 80, 2], [0, 80, 2]];
const WIDE_TRIANGLES = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
const widePlate = `solid plate\n${WIDE_TRIANGLES.map(triangle =>
  `facet normal 0 0 0\nouter loop\n${triangle.map(index => `vertex ${WIDE_CORNERS[index].join(' ')}`).join('\n')}\nendloop\nendfacet`
).join('\n')}\nendsolid plate\n`;

test('a file opens framed at 100% of its own ruler: the open fit is the fit, whatever lens it was taken under', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'hardcore-shell-fit-'));
  let server, browser;
  t.after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); });
  await build({ entryPoints: [fileURLToPath(new URL('../../harness/index.tsx', import.meta.url))], outfile: join(temporary, 'harness.js'), bundle: true, format: 'esm', platform: 'browser', conditions: ['production'], jsx: 'automatic', loader: { '.webp': 'dataurl', '.woff2': 'dataurl' } });
  const bundle = await readFile(join(temporary, 'harness.js'));
  const compiledCss = await readFile(new URL('../../../../dist/styles.css', import.meta.url));
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://test');
    const root = url.pathname.split('/')[1];
    if (url.pathname === '/harness.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle); }
    else if (url.pathname === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(compiledCss); }
    else if (url.pathname.endsWith('/__cad/catalog')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ rootId: root, entries: [
        { kind: 'stl', file: 'plate.stl', rootRelativeFile: 'plate.stl', url: '/plate.stl', hash: root, bytes: widePlate.length }] }));
    } else if (url.pathname.endsWith('/__cad/server')) {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ rootId: root, rootPath: '/models', backend: 'cadgen' }));
    } else if (url.pathname.endsWith('/plate.stl')) { response.end(widePlate); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><title>Host title</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, args: process.platform === 'darwin'
    ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.Worker = undefined; });
  await page.goto(`http://127.0.0.1:${server.address().port}/?file=plate.stl`);
  const pane = page.getByTestId('one');
  await pane.locator('[aria-busy="false"] > div > canvas').first().waitFor();
  await page.waitForFunction(() => window.cadHarness.a.controller?.readState().loading === false);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const opened = await page.evaluate(() => {
    const camera = window.__cadCamera();
    const canvas = document.querySelector('[data-testid="one"] [aria-busy] > div > canvas');
    return { projection: camera.projection, halfHeight: camera.halfHeight, zoomPercent: camera.zoomPercent,
      bounds: camera.originalBounds, aspect: canvas.clientWidth / canvas.clientHeight };
  });
  assert.equal(opened.projection, 'orthographic');
  // 100% means "framed as the file opens". It is a ruler the viewport computes independently
  // of the fit, so the two agreeing is the whole claim: a fit taken under the opening
  // PERSPECTIVE lens and then converted to orthographic used to land near 89% of it.
  assert.equal(Math.round(opened.zoomPercent), 100, `opened at ${opened.zoomPercent}% of its own ruler`);
  // And it is the half-height the fit mathematics gives for this box at the REAL canvas aspect.
  const expected = interactiveCameraFrameForBounds(THREE, {
    camera: Object.assign(new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000), { fov: CAD_DEFAULT_VERTICAL_FOV_DEGREES }),
    controls: { target: new THREE.Vector3() }, bounds: opened.bounds, frameAspect: opened.aspect,
    minRadius: 0, viewDirection: DEFAULT_VIEW_DIRECTION, viewUp: WORLD_UP,
  }).halfHeight;
  assert.ok(Math.abs(opened.halfHeight - expected) / expected < 0.01,
    `framed at the fit for this aspect: ${opened.halfHeight} vs ${expected}`);

  // Home resets the complete view; cube faces keep the current zoom and target.
  const canvas = pane.locator('[aria-busy] > div > canvas').first();
  const inkFraction = async () => {
    const png = PNG.sync.read(await canvas.screenshot());
    const background = [png.data[0], png.data[1], png.data[2]];
    let drawn = 0;
    for (let offset = 0; offset < png.data.length; offset += 4) {
      const delta = Math.abs(png.data[offset] - background[0]) + Math.abs(png.data[offset + 1] - background[1])
        + Math.abs(png.data[offset + 2] - background[2]);
      if (delta > 32) drawn += 1;
    }
    return drawn / (png.width * png.height);
  };
  const settleInk = async (reached, what) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const ink = await inkFraction();
      if (reached(ink)) return ink;
      await page.waitForTimeout(150);
    }
    throw new Error(`the drawn frame never ${what}`);
  };
  assert.ok(await settleInk(ink => ink > 0.05, 'showed the plate') > 0.05);
  // Zoomed right in and dragged far off it: the model is no longer on screen.
  await page.evaluate(async () => {
    const controller = window.cadHarness.a.controller;
    const camera = controller.readState().camera;
    await controller.setCamera({ ...camera, target: [camera.target[0] + 4000, camera.target[1] + 4000, camera.target[2]],
      position: [camera.position[0] + 4000, camera.position[1] + 4000, camera.position[2]], zoom: 9 });
  });
  const lost = await settleInk(ink => ink < 0.01, 'emptied when the camera was driven off the model');

  const beforeSnap = await page.evaluate(() => window.__cadCamera());
  await pane.getByRole('button', { name: 'Jump to top view', exact: true }).click();
  await page.waitForFunction(() => { const c = window.__cadCamera(); return Math.hypot(c.position[0] - c.target[0], c.position[1] - c.target[1]) / Math.abs(c.position[2] - c.target[2]) < 0.001; });
  const snapped = await page.evaluate(() => window.__cadCamera());
  snapped.target.forEach((value, index) => assert.ok(Math.abs(value - beforeSnap.target[index]) < 1e-8));
  assert.equal(snapped.zoom, beforeSnap.zoom);
  assert.equal(await pane.getByRole('button', { name: 'Home', exact: true }).count(), 0);
  await page.evaluate(() => window.cadHarness.a.controller.resetCamera());
  const recovered = await settleInk(ink => ink > 0.05, 'Zoom to Fit frames the plate after panning away');
  assert.ok(recovered > lost * 5);
  assert.deepEqual(errors, []);
});

// Draw is the one tool the shell itself owns, and fullscreen the one presentation it
// owns. Both are driven here through a harness-only renderer over one triangle
// (`renderers/shell-harness`), which declares fullscreen the way a STEP does: a renderer
// that does not is never handed the host's (the mesh, GLB, robot and DXF tests hold that).
test('the shell keeps its Draw session across fullscreen, and fullscreen drags are the camera\'s', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'hardcore-shell-draw-'));
  let server, browser;
  t.after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); });
  await build({ entryPoints: [fileURLToPath(new URL('../../harness/index.tsx', import.meta.url))], outfile: join(temporary, 'harness.js'), bundle: true, format: 'esm', platform: 'browser', conditions: ['production'], jsx: 'automatic', loader: { '.webp': 'dataurl', '.woff2': 'dataurl' } });
  const bundle = await readFile(join(temporary, 'harness.js'));
  // The drawing editor's own stylesheet, extracted from what the bundle imports:
  // without it the editor has no layout and sizes its canvas from an unconstrained container.
  const bundledCss = await readFile(join(temporary, 'harness.css')).catch(() => '');
  const compiledCss = await readFile(new URL('../../../../dist/styles.css', import.meta.url));
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://test');
    const root = url.pathname.split('/')[1];
    if (url.pathname === '/harness.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle); }
    else if (url.pathname === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(compiledCss); }
    else if (url.pathname === '/harness.css') { response.setHeader('Content-Type', 'text/css'); response.end(bundledCss); }
    else if (url.pathname.endsWith('/__cad/catalog')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ rootId: root, entries: [] }));
    } else if (url.pathname.endsWith('/__cad/server')) {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ rootId: root, rootPath: '/models', backend: 'cadgen' }));
    } else if (/\.(woff2|ttf)$/.test(url.pathname)) { response.statusCode = 404; response.end(); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><title>Host title</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, args: process.platform === 'darwin'
    ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.Worker = undefined; });
  await page.goto(`http://127.0.0.1:${server.address().port}/?file=one.harness`);
  const pane = page.getByTestId('one');
  await pane.locator('[aria-busy="false"] > div > canvas').first().waitFor();
  const camera = () => page.evaluate(() => window.cadHarness.a.controller.readState().camera);

  await page.evaluate(async () => {
    window.cadHarness.preferences.update({ orbit: { speed: 0 } });
    const controller = window.cadHarness.a.controller;
    await controller.setCamera({ ...controller.readState().camera, position: [40, -25, 30], target: [2, 3, 0], zoom: 1.4 });
  });
  await pane.getByRole('button', { name: 'Draw', exact: true }).click();
  await pane.locator('[data-drawing-ready]').waitFor();
  await page.waitForTimeout(250);
  const regularCamera = await camera();

  // Fullscreen is the viewer's own: it keeps the host's nav row, hides the tools, and neither
  // remounts the scene nor loses the tool.
  await page.evaluate(() => { window.beforeFullscreenCanvas = document.querySelector('[data-testid="one"] [aria-busy] > div > canvas'); });
  await pane.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await pane.getByRole('button', { name: 'Exit fullscreen', exact: true }).waitFor();
  assert.equal(await pane.locator('[data-file-panel]').first().isVisible(), true, 'fullscreen retains navbar actions');
  assert.equal(await pane.getByRole('group', { name: 'Interaction tools' }).count(), 0);
  assert.equal(await pane.getByRole('button', { name: 'Zoom controls' }).count(), 0);
  const defaultFullscreenCamera = await camera();
  assert.notDeepEqual(defaultFullscreenCamera.position, regularCamera.position, 'fullscreen starts from the default camera');
  assert.equal(defaultFullscreenCamera.zoom, 1);
  await page.evaluate(async () => {
    const controller = window.cadHarness.a.controller;
    await controller.setCamera({ ...controller.readState().camera, position: [80, 30, 35], target: [4, 6, 1], zoom: 1.8, projection: 'perspective' });
  });
  const beforeDrag = await camera();
  const viewport = await pane.locator('[aria-busy] > div > canvas').first().boundingBox();
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await page.mouse.down(); await page.mouse.move(viewport.x + viewport.width / 2 + 80, viewport.y + viewport.height / 2 + 30, { steps: 5 }); await page.mouse.up();
  assert.notDeepEqual((await camera()).position, beforeDrag.position, 'Draw cannot capture fullscreen camera drags');
  assert.equal(await page.evaluate(() => window.beforeFullscreenCanvas === document.querySelector('[data-testid="one"] [aria-busy] > div > canvas')), true);
  // Exercise actual hit testing above the pointer-transparent viewport overlay,
  // and the exit callback across FileViewer -> renderer -> toolbar.
  assert.equal(await pane.getByRole('toolbar', { name: 'Animation playback' }).count(), 0);
  await pane.getByRole('button', { name: 'Orbit settings', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Orbit', exact: true }).click();
  assert.equal(await page.getByRole('menuitemcheckbox', { name: 'Orbit', exact: true }).getAttribute('aria-checked'), 'false');
  await page.keyboard.press('Escape');
  await pane.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await pane.getByRole('button', { name: 'Draw', exact: true }).waitFor();
  const restoredCamera = await camera();
  for (const key of ['position', 'target', 'up']) {
    regularCamera[key].forEach((value, index) => assert.ok(Math.abs(value - restoredCamera[key][index]) < 1e-6, `restore ${key}[${index}]`));
  }
  assert.equal(restoredCamera.projection, regularCamera.projection);
  assert.equal(restoredCamera.zoom, regularCamera.zoom);
  // Presentation state is discarded each time, never resumed from the last orbit.
  await pane.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await pane.getByRole('button', { name: 'Exit fullscreen', exact: true }).waitFor();
  const secondFullscreenCamera = await camera();
  for (const key of ['position', 'target', 'up']) {
    defaultFullscreenCamera[key].forEach((value, index) => assert.ok(Math.abs(value - secondFullscreenCamera[key][index]) < 1e-6, `fresh fullscreen ${key}[${index}]`));
  }
  await pane.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await pane.getByRole('button', { name: 'Draw', exact: true }).waitFor();
  assert.equal(await pane.getByRole('button', { name: 'Draw', exact: true }).getAttribute('aria-pressed'), 'true',
    'the session the sketch is in survives a trip through fullscreen');
  // Its tools, color, stroke width and history are a panel in the tool stack for as long as Draw is
  // the tool, headed "Draw": it does not fold, and its X, like a second press on its button, puts
  // Draw down, panel and all.
  const draw = pane.getByRole('button', { name: 'Draw', exact: true });
  const drawPanel = pane.locator('[data-tool-panel][aria-label="Drawing controls"]');
  await drawPanel.waitFor();
  const drawHeading = drawPanel.locator('[data-tool-panel-heading]');
  assert.equal((await drawHeading.getByRole('heading').innerText()).trim(), 'Draw');
  assert.deepEqual(await drawHeading.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), ['Close draw']);
  // Its buttons are laid in a grid of 24px columns spread across the panel, with no separator.
  assert.equal(await drawPanel.locator('[data-drawing-controls]').evaluate(node => getComputedStyle(node).display), 'grid');
  assert.equal(await drawPanel.getByRole('separator').count(), 0);
  // The weight is a button beside Color: a radiogroup of three.
  const drawSettings = drawPanel.getByRole('group', { name: 'Drawing settings', exact: true });
  assert.deepEqual((await drawSettings.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).slice(0, 2), ['Color', 'Stroke width']);
  await drawPanel.getByRole('button', { name: 'Stroke width', exact: true }).click();
  const widths = drawPanel.getByRole('radiogroup', { name: 'Stroke width', exact: true });
  assert.deepEqual(await widths.getByRole('radio').evaluateAll(radios => radios.map(radio => `${radio.getAttribute('aria-label')}:${radio.getAttribute('aria-checked')}`)),
    ['Thin:false', 'Medium:true', 'Bold:false']);
  // What the person chose — the tool, the weight, the colour — outlasts leaving Draw.
  await widths.getByRole('radio', { name: 'Bold', exact: true }).click();
  await widths.waitFor({ state: 'detached' });
  await drawPanel.getByRole('button', { name: 'Line', exact: true }).click();
  await drawPanel.getByRole('button', { name: 'Color', exact: true }).click();
  await drawPanel.getByRole('radiogroup', { name: 'Drawing color', exact: true }).getByRole('radio', { name: 'Neon cyan', exact: true }).click();
  const chosen = async () => {
    await drawPanel.getByRole('button', { name: 'Stroke width', exact: true }).click();
    const weight = await drawPanel.getByRole('radiogroup', { name: 'Stroke width', exact: true }).locator('[aria-checked="true"]').getAttribute('aria-label');
    await drawPanel.getByRole('button', { name: 'Stroke width', exact: true }).click();
    await drawPanel.getByRole('button', { name: 'Color', exact: true }).click();
    const color = await drawPanel.getByRole('radiogroup', { name: 'Drawing color', exact: true }).locator('[aria-checked="true"]').getAttribute('aria-label');
    await drawPanel.getByRole('button', { name: 'Color', exact: true }).click();
    return { tool: await drawPanel.getByRole('group', { name: 'Drawing tools', exact: true }).locator('[aria-pressed="true"]').getAttribute('aria-label'), weight, color };
  };
  assert.deepEqual(await chosen(), { tool: 'Line', weight: 'Bold', color: 'Neon cyan' });
  await drawHeading.getByRole('button', { name: 'Close draw', exact: true }).click();
  await drawPanel.waitFor({ state: 'detached' });
  assert.equal(await draw.getAttribute('aria-pressed'), 'false', 'the X puts Draw down');
  await draw.click();
  await pane.locator('[data-drawing-ready]').waitFor();
  await drawPanel.waitFor();
  assert.deepEqual(await chosen(), { tool: 'Line', weight: 'Bold', color: 'Neon cyan' }, 'taken up again, Draw is as it was left');
  await draw.click();
  await drawPanel.waitFor({ state: 'detached' });
  assert.equal(await draw.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(errors, []);
});

// Three shell surfaces a renderer opts into, driven under the same harness-only
// renderer over one triangle: a viewport menu whose items are its own, a bottom
// action whose long label falls back to a count, and the camera-settled report.
// They go with this renderer when STEP arrives on the shell and uses them for real.
test('a scene that arrives in place is framed when whole, a renderer hears what became of its WebGL runtime, hairlines stay sharp while the camera moves, and an open menu is reported', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'hardcore-shell-scene-'));
  let server, browser;
  t.after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); });
  await build({ entryPoints: [fileURLToPath(new URL('../../harness/index.tsx', import.meta.url))], outfile: join(temporary, 'harness.js'), bundle: true, format: 'esm', platform: 'browser', conditions: ['production'], jsx: 'automatic', loader: { '.webp': 'dataurl', '.woff2': 'dataurl' } });
  const bundle = await readFile(join(temporary, 'harness.js'));
  const compiledCss = await readFile(new URL('../../../../dist/styles.css', import.meta.url));
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://test');
    const root = url.pathname.split('/')[1];
    if (url.pathname === '/harness.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle); }
    else if (url.pathname === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(compiledCss); }
    else if (url.pathname.endsWith('/__cad/catalog')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ rootId: root, entries: [] })); }
    else if (url.pathname.endsWith('/__cad/server')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ rootId: root, rootPath: '/models', backend: 'cadgen' })); }
    else if (/\.(woff2|ttf)$/.test(url.pathname)) { response.statusCode = 404; response.end(); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><title>Host title</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, args: process.platform === 'darwin'
    ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.Worker = undefined; });
  await page.goto(`http://127.0.0.1:${server.address().port}/?file=one.harness`);
  const pane = page.getByTestId('one');
  const canvasElement = pane.locator('[aria-busy="false"] > div > canvas').first();
  const canvas = await canvasElement.boundingBox();
  const middle = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
  // The drawn frame: how much of it is the triangle, and whether it runs off the edge.
  const drawn = async () => {
    const png = PNG.sync.read(await canvasElement.screenshot());
    const { width, height, data } = png;
    const background = [data[8 * 4 * width + 32], data[8 * 4 * width + 33], data[8 * 4 * width + 34]];
    let painted = 0, atEdge = 0;
    for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
      const at = (y * width + x) * 4;
      // The triangle is a flat blue-grey; the grid lines and the axes are thin and sampled away by the solid test.
      const solid = Math.abs(data[at] - background[0]) + Math.abs(data[at + 1] - background[1]) + Math.abs(data[at + 2] - background[2]) > 60
        && data[at + 2] > data[at] + 8;
      if (!solid) continue;
      painted += 1;
      if (x < 6 || y < 6 || x > width - 8 || y > height - 8) atEdge += 1;
    }
    return { painted, atEdge };
  };
  const waitForFrame = async (accept, what) => {
    let last;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      last = await drawn();
      if (accept(last)) return last;
      await page.waitForTimeout(100);
    }
    assert.fail(`the drawn frame never ${what}: ${JSON.stringify(last)}`);
  };

  // A SCENE THAT ARRIVES IN PLACE. The same scene identity grows fourfold and says it is not
  // whole yet: the viewport adopts what arrived (it is drawn, larger) but does NOT re-frame,
  // so the triangle runs off the canvas. When the scene says it is whole, it is framed again.
  const opened = await waitForFrame(frame => frame.painted > 500 && frame.atEdge === 0, 'showed the framed triangle');
  const pose = () => page.evaluate(() => { const c = window.__cadCamera(); return [c.position, c.target, c.zoom]; });
  const openedPose = await pose();
  await pane.locator('[data-harness-arrive="partial"]').click();
  const partial = await waitForFrame(frame => frame.painted > opened.painted * 3 && frame.atEdge > 0,
    'drew the grown scene, unframed, while it was still arriving');
  // Not reframed: the pose is the opened one, to within the float noise of a settled camera
  // (a reframe moves it by the scene's own size, four orders of magnitude more).
  const partialPose = (await pose()).flat();
  openedPose.flat().forEach((value, index) => assert.ok(Math.abs(value - partialPose[index]) < 1e-4,
    `the camera did not move for a partial arrival (${index}: ${value} → ${partialPose[index]})`));
  await pane.locator('[data-harness-arrive="whole"]').click();
  const whole = await waitForFrame(frame => frame.atEdge === 0 && frame.painted > 500 && frame.painted < partial.painted,
    'framed the scene once it was whole');
  assert.ok(Math.abs(whole.painted - opened.painted) < opened.painted * 0.2,
    `the whole scene fills the frame as the first one did: ${JSON.stringify({ opened, whole })}`);

  // SHADOW RECEPTION IS THE SCENE'S, where the scene says so. Entering Render turns shadows
  // on: the scene is told, and its mesh -- which never takes one -- is left exactly as it was.
  assert.equal(await pane.locator('[data-harness-shadows]').innerText(), 'false:false');
  await page.evaluate(() => window.cadHarness.a.controller.setRenderMode(true));
  await page.waitForFunction(() => document.querySelector('[data-harness-shadows]').textContent.startsWith('true:'));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.cadHarness.a.controller.setRenderMode(false));
  await page.waitForFunction(() => document.querySelector('[data-harness-shadows]').textContent.startsWith('false:'));
  assert.equal(await pane.locator('[data-harness-shadows]').innerText(), 'false:false', 'the viewport never set the mesh itself');
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().renderMode !== 'render');
  await page.waitForTimeout(600);

  // AN OPEN MENU IS REPORTED, for exactly as long as it is up.
  const menuUp = () => pane.locator('[data-harness-menu-open]').innerText();
  assert.equal(await menuUp(), '');
  await page.mouse.click(middle.x, middle.y, { button: 'right' });
  await page.getByRole('menu').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-harness-menu-open]').textContent === 'up');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-harness-menu-open]').textContent === '');
  await page.mouse.click(middle.x, middle.y, { button: 'right' });
  await page.waitForFunction(() => document.querySelector('[data-harness-menu-open]').textContent === 'up');
  await page.getByRole('menuitem', { name: 'Note the press', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-harness-menu-open]').textContent === '');
  // Primary and secondary together is the pan chord, never a menu -- in either order. (A
  // button that joins one already held is a pointer MOVE, so the secondary-first order is the
  // one that reaches the menu's own press and has to be refused there.)
  await page.mouse.move(middle.x, middle.y);
  for (const [first, second] of [['left', 'right'], ['right', 'left']]) {
    await page.mouse.down({ button: first });
    await page.mouse.down({ button: second });
    await page.mouse.up({ button: second });
    await page.mouse.up({ button: first });
    await page.waitForTimeout(250);
    assert.equal(await page.getByRole('menu').count(), 0, `a ${first}-then-${second} chord opens no menu`);
  }
  assert.equal(await menuUp(), '');

  // HAIRLINES STAY SHARP. While the camera moves the backing store drops to the interaction
  // pixel ratio; a renderer that says its scene is drawn with hairlines keeps the idle one.
  const backingScale = async (file) => {
    await page.goto(`http://127.0.0.1:${server.address().port}/?file=${file}`);
    const element = page.getByTestId('one').locator('[aria-busy="false"] > div > canvas').first();
    const box = await element.boundingBox();
    await page.waitForTimeout(400);
    const idle = await element.evaluate(node => node.width / node.clientWidth);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 4 });
    const moving = await element.evaluate(node => node.width / node.clientWidth);
    await page.mouse.up();
    return { idle, moving };
  };
  const plain = await backingScale('one.harness');
  assert.ok(plain.idle > 1.4 && plain.moving < plain.idle - 0.2, `an ordinary scene drops its pixel ratio while it moves: ${JSON.stringify(plain)}`);
  const hairline = await backingScale('hairline.harness');
  assert.ok(hairline.idle === plain.idle && hairline.moving === hairline.idle, `a hairline scene keeps it: ${JSON.stringify(hairline)}`);

  // THE RUNTIME UNDER THE SCENE. A lost context is reported; the replacement runtime's
  // predecessor is released while its renderer is still alive, and named a handoff.
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const node = document.querySelector('[data-testid="one"] [aria-busy] > div > canvas');
    const gl = node.getContext('webgl2') || node.getContext('webgl');
    window.__lose = gl.getExtension('WEBGL_lose_context');
    window.__lose.loseContext();
  });
  await page.waitForFunction(() => document.querySelector('[data-harness-runtime]').textContent === 'lost');
  await page.evaluate(() => window.__lose.restoreContext());
  await page.waitForFunction(() => document.querySelector('[data-harness-runtime]').textContent === 'lost release:live:handoff');
  await waitForFrame(frame => frame.painted > 500, 'drew again on the replacement runtime');
  assert.deepEqual(errors, []);
});

test('a renderer supplies the viewport menu, a bottom action that falls back to a count, and is told when the camera settles', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'hardcore-shell-surfaces-'));
  let server, browser;
  t.after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); });
  await build({ entryPoints: [fileURLToPath(new URL('../../harness/index.tsx', import.meta.url))], outfile: join(temporary, 'harness.js'), bundle: true, format: 'esm', platform: 'browser', conditions: ['production'], jsx: 'automatic', loader: { '.webp': 'dataurl', '.woff2': 'dataurl' } });
  const bundle = await readFile(join(temporary, 'harness.js'));
  const compiledCss = await readFile(new URL('../../../../dist/styles.css', import.meta.url));
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://test');
    const root = url.pathname.split('/')[1];
    if (url.pathname === '/harness.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle); }
    else if (url.pathname === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(compiledCss); }
    else if (url.pathname.endsWith('/__cad/catalog')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ rootId: root, entries: [] })); }
    else if (url.pathname.endsWith('/__cad/server')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ rootId: root, rootPath: '/models', backend: 'cadgen' })); }
    else if (/\.(woff2|ttf)$/.test(url.pathname)) { response.statusCode = 404; response.end(); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><title>Host title</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, args: process.platform === 'darwin'
    ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.Worker = undefined; });
  await page.goto(`http://127.0.0.1:${server.address().port}/?file=one.harness`);
  const pane = page.getByTestId('one');
  const canvas = await pane.locator('[aria-busy="false"] > div > canvas').first().boundingBox();
  const middle = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };

  // THE VIEWPORT MENU. A secondary tap over the canvas opens what the renderer
  // offered, where it was pressed, and the browser's own menu never appears.
  await page.evaluate(() => {
    window.nativeMenu = [];
    document.addEventListener('contextmenu', event => window.nativeMenu.push(event.defaultPrevented));
  });
  await page.mouse.click(middle.x, middle.y, { button: 'right' });
  const menu = page.getByRole('menu');
  // The menu ANIMATES in (it scales up from 95%), so a box read the moment it is
  // attached is a box mid-flight, several pixels from where it comes to rest.
  // Every measurement here waits for that animation to finish first.
  const restingBox = async () => {
    await menu.waitFor();
    await menu.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
    return menu.boundingBox();
  };
  await menu.waitFor();
  assert.deepEqual(await page.getByRole('menuitem').allInnerTexts(), ['Note the press', 'Clear the note']);
  assert.deepEqual(await page.evaluate(() => window.nativeMenu), [true], 'the native menu stays off the canvas');
  const menuBox = await restingBox();
  // It opens AT the press, not at a corner: a second press elsewhere moves it by
  // the same amount the press moved.
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  const elsewhere = { x: middle.x + 220, y: middle.y - 140 };
  await page.mouse.click(elsewhere.x, elsewhere.y, { button: 'right' });
  const movedBox = await restingBox();
  assert.ok(Math.abs((movedBox.x - menuBox.x) - 220) < 6 && Math.abs((movedBox.y - menuBox.y) + 140) < 6,
    `the menu follows the press (${JSON.stringify(menuBox)} -> ${JSON.stringify(movedBox)})`);
  assert.ok(Math.abs(movedBox.x - elsewhere.x) < 24 && Math.abs(movedBox.y - elsewhere.y) < 24,
    `and opens on it (${JSON.stringify(movedBox)} for ${JSON.stringify(elsewhere)})`);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  await page.mouse.click(middle.x, middle.y, { button: 'right' });
  await menu.waitFor();
  // The second item is disabled until the first has been taken, which is the
  // renderer's own state reaching the shell's menu.
  assert.equal(await page.getByRole('menuitem', { name: 'Clear the note', exact: true }).getAttribute('data-disabled'), '');
  await page.getByRole('menuitem', { name: 'Note the press', exact: true }).click();
  await menu.waitFor({ state: 'detached' });
  assert.equal(await pane.locator('[data-harness-menu-note]').innerText(),
    `${Math.round(middle.x)},${Math.round(middle.y)}`, 'the item acted on the press the renderer was given');

  // A press the renderer has nothing to say about opens nothing — and still no native menu.
  await page.evaluate(() => { window.nativeMenu = []; });
  await page.keyboard.down('Shift');
  await page.mouse.click(middle.x, middle.y, { button: 'right' });
  await page.keyboard.up('Shift');
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('menu').count(), 0, 'no items, no menu');
  assert.deepEqual(await page.evaluate(() => window.nativeMenu), [true]);

  // A secondary DRAG is the camera's: it pans and opens nothing.
  const settles = () => pane.locator('[data-harness-camera-settles]').innerText();
  const beforeDrag = await page.evaluate(() => window.cadHarness.a.controller.readState().camera.target);
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(middle.x + 90, middle.y + 40, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(250);
  assert.equal(await page.getByRole('menu').count(), 0, 'a secondary drag opens no menu');
  assert.notDeepEqual(await page.evaluate(() => window.cadHarness.a.controller.readState().camera.target), beforeDrag,
    'and still pans the camera');

  // THE CAMERA SETTLED. The pan above was reported; so is a presentation camera
  // that moves in fullscreen (which records no perspective at all), and so is a
  // viewport RESIZE, which can change what is on screen without moving the camera.
  const afterPan = Number(await settles());
  assert.ok(afterPan > 0, `a camera that moved was reported (${afterPan})`);
  // A viewport whose size changed is a settle too. (This one is over-covered: every
  // resize the harness can make also moves the stored camera, so the perspective path
  // reports it as well. The viewport reports it unconditionally because an aspect
  // change CAN expose part of a scene while every stored field stays equal, which is
  // the case a renderer that samples the camera for detail needs.)
  const beforeWidthChange = Number(await settles());
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForFunction(count => Number(document.querySelector('[data-harness-camera-settles]').textContent) > count, beforeWidthChange);
  const afterResize = Number(await settles());
  await page.evaluate(() => window.cadHarness.preferences.update({ orbit: { speed: 0 } }));
  await pane.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await pane.getByRole('button', { name: 'Exit fullscreen', exact: true }).waitFor();
  const fullscreenCanvas = await pane.locator('[aria-busy] > div > canvas').first().boundingBox();
  await page.mouse.move(fullscreenCanvas.x + fullscreenCanvas.width / 2, fullscreenCanvas.y + fullscreenCanvas.height / 2);
  await page.mouse.down();
  await page.mouse.move(fullscreenCanvas.x + fullscreenCanvas.width / 2 + 80, fullscreenCanvas.y + fullscreenCanvas.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(count => Number(document.querySelector('[data-harness-camera-settles]').textContent) > count, afterResize);
  await pane.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await pane.getByRole('button', { name: 'Draw', exact: true }).waitFor();

  // THE BOTTOM ACTION. What it SAYS is measured, not guessed from the string: a
  // reference too wide for the button is replaced by the count the renderer
  // supplied, while the full reference stays the title; a reference that fits is
  // shown whole. `render` is what actually drew the control both times.
  const action = pane.locator('[data-harness-bottom-action]');
  await action.waitFor();
  assert.equal(await action.getAttribute('title'), null, 'no redundant native tooltip');
  assert.equal(await action.locator('span').first().innerText(), 'Copy 1 reference', 'a reference that does not fit becomes the count');
  // What is on screen is one line of the count, not a cut-off reference.
  assert.ok((await action.boundingBox()).width < 320, 'the button is the count\'s width');
  await action.click();
  await page.waitForFunction(() => document.querySelector('[data-harness-bottom-action]')?.textContent?.startsWith('#'));
  const short = await action.locator('span').first().innerText();
  assert.equal(short, '#harness_document/triangle_face_0001', 'a reference that fits is shown whole');
  assert.equal(await action.getAttribute('title'), null);
  assert.deepEqual(errors, []);
});

test('a renderer says more about its load than a download: finding the file, edit states, a failed update the model survives, the revision on screen, its own snapshot and its own frame', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'hardcore-shell-load-'));
  let server, browser;
  t.after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); });
  await build({ entryPoints: [fileURLToPath(new URL('../../harness/index.tsx', import.meta.url))], outfile: join(temporary, 'harness.js'), bundle: true, format: 'esm', platform: 'browser', conditions: ['production'], jsx: 'automatic', loader: { '.webp': 'dataurl', '.woff2': 'dataurl' } });
  const bundle = await readFile(join(temporary, 'harness.js'));
  const compiledCss = await readFile(new URL('../../../../dist/styles.css', import.meta.url));
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://test');
    const root = url.pathname.split('/')[1];
    if (url.pathname === '/harness.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle); }
    else if (url.pathname === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(compiledCss); }
    else if (url.pathname.endsWith('/__cad/catalog')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ rootId: root, entries: [] })); }
    else if (url.pathname.endsWith('/__cad/server')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ rootId: root, rootPath: '/models', backend: 'cadgen' })); }
    else if (/\.(woff2|ttf)$/.test(url.pathname)) { response.statusCode = 404; response.end(); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><title>Host title</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, args: process.platform === 'darwin'
    ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.Worker = undefined; });
  await page.goto(`http://127.0.0.1:${server.address().port}/?file=one.harness`);
  const pane = page.getByTestId('one');
  const canvasElement = pane.locator('[aria-busy="false"] > div > canvas').first();
  const canvas = await canvasElement.boundingBox();
  const middle = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
  const stage = name => pane.locator(`[data-harness-stage="${name}"]`).click();
  // What the shell draws over the viewport about a load: the overlay that covers a model
  // still opening, and the card for an alert. Nothing is drawn beside the filename any more.
  const overlay = pane.locator('[data-viewer-loading]');
  const card = pane.getByRole('alert');
  // The DRAWN frame, and how much of it is the triangle: its lit blue-grey, counted below the
  // harness's own controls along the top, and outside `hole` (a box in canvas pixels).
  const shot = async () => PNG.sync.read(await canvasElement.screenshot());
  const triangle = ({ width, height, data }, hole = null) => {
    let count = 0;
    for (let y = 48; y < height; y += 2) for (let x = 0; x < width; x += 2) {
      if (hole && x >= hole.x0 && x <= hole.x1 && y >= hole.y0 && y <= hole.y1) continue;
      const at = (y * width + x) * 4;
      if (data[at] + data[at + 1] + data[at + 2] > 250 && data[at + 2] > data[at] + 8) count += 1;
    }
    return count;
  };

  // THE FRAME IS THE RENDERER'S TO WRAP. Its own context reaches the frame — and
  // it is above the frame, so it is there before anything the renderer draws in it.
  assert.equal(await pane.locator('[data-harness-frame-context]').innerText(), 'frame:idle');

  // A LOAD THAT IS ONLY A DOWNLOAD SAYS NOTHING. Nothing of the load's extras is
  // passed, and nothing covers the model or stands over it.
  assert.equal(await overlay.count(), 0, 'a plain load covers nothing');
  assert.equal(await card.count(), 0, 'and raises nothing');

  // FINDING: the wait before the file is even located covers the viewport, and says
  // so as such rather than as a phase of reading it.
  await stage('finding');
  await overlay.waitFor();
  assert.match(await overlay.innerText(), /Finding file/);
  assert.equal(await pane.locator('[data-harness-frame-context]').innerText(), 'frame:finding');

  // AN EDIT OF THE PERSON'S OWN is a wait with nothing downloading, and the model it
  // edits stays on screen: nothing covers it. The corner says the model is catching up.
  const updating = pane.locator('[data-view-update-status]');
  await stage('editing');
  await overlay.waitFor({ state: 'detached' });
  assert.equal(await card.count(), 0);
  await updating.waitFor();
  assert.match(await updating.innerText(), /Updating model/);

  // THE PREVIEW ENDS IT: the result is on screen, so the wait is over even though the
  // write is not.
  await stage('previewing');
  await updating.waitFor({ state: 'detached' });
  await page.waitForTimeout(300);
  assert.deepEqual([await overlay.count(), await card.count()], [0, 0]);
  const settled = await shot();
  const whole = triangle(settled);
  assert.ok(whole > 500, `the triangle is drawn: ${whole} samples of it`);

  // A FAILED UPDATE THE MODEL SURVIVES is an error, and the viewport is where it is said:
  // a card over the model — which is still drawn around it, neither blanked nor covered.
  await stage('failed');
  await card.waitFor();
  const said = await card.innerText();
  assert.match(said, /Harness update failed/);
  assert.match(said, /The existing model remains visible/);
  assert.equal(await overlay.count(), 0, 'it is not a load: nothing covers the model');
  const [canvasBox, cardBox] = [await canvasElement.boundingBox(), await card.boundingBox()];
  const hole = { x0: cardBox.x - canvasBox.x - 4, y0: cardBox.y - canvasBox.y - 4,
    x1: cardBox.x - canvasBox.x + cardBox.width + 4, y1: cardBox.y - canvasBox.y + cardBox.height + 4 };
  const around = triangle(settled, hole);
  assert.ok(around > 200, `there is triangle to see around the card: ${around}`);
  const survived = triangle(await shot(), hole);
  assert.ok(Math.abs(survived - around) <= around * 0.05, `and it is still drawn there: ${survived} of ${around}`);
  // DISMISS puts the card away, since the previous version is there to use: the card goes
  // and the whole model is on screen again.
  await card.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  assert.ok(Math.abs(triangle(await shot()) - whole) <= whole * 0.05, 'the triangle is all there under where the card was');
  // It stays put away while that alert stands; once the alert clears, the same failure
  // raised again (a retry that failed the same way) is shown again.
  await page.waitForTimeout(300);
  assert.equal(await card.count(), 0, 'dismissed while the same alert stands');
  await stage('idle');
  await page.waitForTimeout(300);
  assert.equal(await card.count(), 0);
  await stage('failed');
  await card.waitFor();
  assert.match(await card.innerText(), /Harness update failed/);
  await stage('idle');
  await card.waitFor({ state: 'detached' });

  // THE REVISION ON SCREEN. Live state reports what is being SHOWN, which a renderer
  // holding a predecessor over a rebuild knows and the shell does not.
  const shown = () => page.evaluate(() => { const s = window.cadHarness.a.controller.readState(); return [s.revision, s.resource.revision]; });
  assert.deepEqual(await shown(), ['harness', 'harness']);
  await pane.locator('[data-harness-shown-revision]').click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().revision === 'shown-revision');
  assert.deepEqual(await shown(), ['shown-revision', 'shown-revision'], 'both halves name the revision on screen');

  // THE SNAPSHOT IS THE RENDERER'S TO ASSEMBLE. Its own reference vocabulary goes
  // through its own builder — and the resource it names is the one on screen.
  const before = await page.evaluate(() => window.cadHarness.captures.length);
  await pane.getByRole('button', { name: 'Take snapshot', exact: true }).click();
  await page.waitForFunction(count => window.cadHarness.captures.length > count, before);
  assert.deepEqual(await page.evaluate(() => {
    const context = window.cadHarness.captures.at(-1);
    return [context.type, context.references.map(reference => reference.resource.revision)];
  }), ['image/png', ['shown-revision']]);
  await pane.locator('[data-harness-shown-revision]').click();

  // A PRESS ON THE MODEL is the renderer's to hear: it puts down what it was
  // showing about something else before the viewport sees the press at all.
  assert.equal(await pane.locator('[data-harness-put-down]').innerText(), '');
  await page.mouse.click(middle.x, middle.y);
  await page.waitForFunction(() => document.querySelector('[data-harness-put-down]')?.textContent === 'put down @idle');
  // And the frame still takes focus on that same press, as it always did.
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.slot), 'cad-file-view');
  assert.deepEqual(errors, []);
});

// The tool stack under the strip, and keyboard ownership between two viewers on one page.
test('the tool stack: one width, bounded by the viewer, resizable by edge, foot and corner, one floating surface; Display is a popover beside it, Draw a panel; and keys belong to the viewer that has them', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'hardcore-shell-keys-'));
  let server, browser;
  t.after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); });
  await build({ entryPoints: [fileURLToPath(new URL('../../harness/index.tsx', import.meta.url))], outfile: join(temporary, 'harness.js'), bundle: true, format: 'esm', platform: 'browser', conditions: ['production'], jsx: 'automatic', loader: { '.webp': 'dataurl', '.woff2': 'dataurl' } });
  const bundle = await readFile(join(temporary, 'harness.js'));
  const compiledCss = await readFile(new URL('../../../../dist/styles.css', import.meta.url));
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://test');
    const root = url.pathname.split('/')[1];
    if (url.pathname === '/harness.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle); }
    else if (url.pathname === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(compiledCss); }
    else if (url.pathname.endsWith('/__cad/catalog')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ rootId: root, entries: [] })); }
    else if (url.pathname.endsWith('/__cad/server')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ rootId: root, rootPath: '/models', backend: 'cadgen' })); }
    else if (/\.(woff2|ttf)$/.test(url.pathname)) { response.statusCode = 404; response.end(); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, args: process.platform === 'darwin'
    ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.Worker = undefined; });
  await page.goto(`http://127.0.0.1:${server.address().port}/?file=panel.harness`);
  const one = page.getByTestId('one');
  await one.locator('[aria-busy="false"] > div > canvas').first().waitFor();
  const stack = one.locator('[data-cad-tool-stack]');
  const tree = one.locator('[data-tool-panel][aria-label="Harness tree"]');
  const reference = one.locator('[data-tool-panel][aria-label="Harness reference"]');
  const keep = one.getByRole('button', { name: 'Keep', exact: true });
  const kept = one.locator('[data-tool-panel][aria-label="Kept controls"]');
  await tree.waitFor();
  const viewer = async () => one.locator('[data-cad-scene-backdrop]').boundingBox();
  const shown = () => one.locator('[data-cad-tool-stack] [data-tool-panel]').evaluateAll(panels => panels
    .filter(panel => panel.getClientRects().length).map(panel => {
      const body = panel.querySelector('[data-tool-panel-body]'), box = panel.getBoundingClientRect();
      return { label: panel.getAttribute('aria-label'), top: box.top, bottom: box.bottom, height: box.height, width: box.width,
        scrolls: body.scrollHeight > body.clientHeight + 1 };
    }));
  const withinViewer = async () => {
    const [panels, box] = [await shown(), await viewer()];
    assert.ok(panels.at(-1).bottom <= box.y + box.height - 8 + 1, `the stack ends inside the viewer: ${panels.at(-1).bottom} vs ${box.y + box.height}`);
    return panels;
  };

  const layout = () => page.evaluate(() => window.cadHarness.preferences.getSnapshot().toolStack);
  const strip = one.locator('[data-cad-toolbar] [role=group]');

  // THE CHROME'S INSET: the strip sits 8px in from the viewer's top and left, and the top-right
  // bar (Display settings, then Fullscreen) 8px in from its top and right.
  const [stripBox, backdrop] = [await strip.boundingBox(), await viewer()];
  assert.ok(Math.abs(stripBox.x - backdrop.x - 8) <= 1 && Math.abs(stripBox.y - backdrop.y - 8) <= 1, `the strip is inset 8px: ${JSON.stringify(stripBox)}`);
  const [displayBox, fullscreenBox] = [await one.getByRole('button', { name: 'Display settings', exact: true }).boundingBox(),
    await one.getByRole('button', { name: 'Fullscreen', exact: true }).boundingBox()];
  assert.ok(displayBox.x + displayBox.width <= fullscreenBox.x + 1 && Math.abs(displayBox.y - fullscreenBox.y) <= 1, 'Display settings sits left of Fullscreen, level with it');
  assert.ok(Math.abs(backdrop.x + backdrop.width - (fullscreenBox.x + fullscreenBox.width) - 8) <= 1, 'the bar is inset 8px from the right');
  // The stack's default width is a five-tool strip's (138px), whatever tools this file's strip has
  // (two here): nothing is stored until a person drags it.
  assert.equal((await layout())?.width, undefined, 'no width is stored until one is dragged');
  const defaultWidth = TOOL_STACK_DEFAULT_WIDTH;
  assert.equal(defaultWidth, 138);
  assert.ok(stripBox.width < defaultWidth, 'not the strip\'s own width');

  // HEIGHTS. A tree opens at half the stack's own height — the viewer's less the strip above it
  // and the insets — (its default cap) and scrolls inside it; the Reference opens at its content's
  // height, under its own cap.
  const stackHeight = await stack.evaluate(node => node.clientHeight);
  let panels = await shown();
  assert.deepEqual(panels.map(panel => panel.label), ['Harness tree', 'Harness reference']);
  assert.ok(Math.abs(stackHeight - ((await viewer()).height - stripBox.height - 3 * 8)) <= 1,
    `the stack is the area under the strip, 8px from it and from the viewer's bottom: ${stackHeight}`);
  assert.ok(Math.abs(panels[0].height - stackHeight / 2) <= 1, `the tree opens at half the stack: ${panels[0].height} of ${stackHeight}`);
  assert.equal(panels[0].scrolls, true);
  assert.equal(panels[1].scrolls, false, 'a Reference that fits its cap is its content\'s height');

  // THE STACK. A tree far taller than the viewer, a Reference and a kept effect: every panel the
  // stack's one width, the whole never past the viewer, the tree giving way and scrolling inside
  // itself while the others keep their natural height.
  await keep.click();
  await kept.waitFor();
  panels = await withinViewer();
  assert.deepEqual(panels.map(panel => panel.label), ['Harness tree', 'Harness reference', 'Kept controls']);
  assert.deepEqual(new Set(panels.map(panel => Math.round(panel.width))), new Set([defaultWidth]), 'one width, the default');
  const [treePanel, referencePanel, keptPanel] = panels;
  assert.equal(treePanel.scrolls, true, 'the tree gives way and scrolls inside itself');
  assert.equal(referencePanel.scrolls, false, 'the Reference keeps its height while the tree can give way');
  assert.equal(keptPanel.scrolls, false);
  const keptHeight = keptPanel.height;
  // A short viewer: the tree stops at its floor, and then the Reference gives way too; the kept
  // panel never does.
  await one.evaluate(element => { element.parentElement.style.height = '480px'; });
  await page.waitForTimeout(200);
  panels = await withinViewer();
  assert.ok(Math.abs(panels[0].height - 128) <= 1, `the tree holds its floor: ${panels[0].height}`);
  assert.equal(panels[1].scrolls, true, 'then the Reference gives way');
  assert.equal(panels[2].height, keptHeight, 'a small panel keeps its height');
  await one.evaluate(element => { element.parentElement.style.height = '720px'; });
  await page.waitForTimeout(200);

  // One handle ON the stack's right edge — centred on it, nothing beside the panels — widens every
  // panel together; the width is the person's, kept by the host across files (both viewers share
  // it) and bounded to the minimum.
  const handle = one.getByRole('separator', { name: 'Resize tool panels', exact: true });
  const [handleBox, treeBox] = [await handle.boundingBox(), await tree.boundingBox()];
  assert.ok(Math.abs(handleBox.x + handleBox.width / 2 - (treeBox.x + treeBox.width)) <= 1,
    `the handle is centred on the stack's edge: ${handleBox.x + handleBox.width / 2} vs ${treeBox.x + treeBox.width}`);
  assert.ok(handleBox.width >= 8, 'with a comfortable hit area');
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 60, handleBox.y + 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(wider => window.cadHarness.preferences.getSnapshot().toolStack?.width > wider, defaultWidth);
  const widened = (await layout()).width;
  assert.deepEqual(new Set((await shown()).map(panel => panel.width)), new Set([widened]), 'every panel follows');
  await handle.focus();
  await page.keyboard.press('Home');
  await page.waitForFunction(minimum => window.cadHarness.preferences.getSnapshot().toolStack?.width === minimum, TOOL_STACK_MIN_WIDTH);
  assert.deepEqual(new Set((await shown()).map(panel => panel.width)), new Set([TOOL_STACK_MIN_WIDTH]), 'down to its minimum, narrower than the default');
  // A width that is no width is the default again.
  await page.evaluate(() => window.cadHarness.preferences.update({ toolStack: { ...window.cadHarness.preferences.getSnapshot().toolStack, width: null } }));
  await page.waitForTimeout(100);
  assert.deepEqual(new Set((await shown()).map(panel => Math.round(panel.width))), new Set([defaultWidth]));

  // A TREE'S HEIGHT is the person's too: a handle on its bottom edge (centred on it, like the
  // width's) sets its cap by pointer or keyboard, written back once on release, and a remount opens
  // at what was left.
  await keep.click();
  await kept.waitFor({ state: 'detached' });
  const treeHandle = one.getByRole('separator', { name: 'Resize harness tree', exact: true });
  const [bottomHandle, treeNow] = [await treeHandle.boundingBox(), await tree.boundingBox()];
  assert.ok(Math.abs(bottomHandle.y + bottomHandle.height / 2 - (treeNow.y + treeNow.height)) <= 1, 'the height handle is centred on the panel\'s bottom edge');
  assert.ok(Math.abs(bottomHandle.x - treeNow.x) <= 1 && Math.abs(bottomHandle.width - treeNow.width) <= 1, 'and runs its width');
  await page.evaluate(() => { window.layoutWrites = 0; window.cadHarness.preferences.subscribe(() => { window.layoutWrites += 1; }); });
  await page.mouse.move(bottomHandle.x + 60, bottomHandle.y + bottomHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(bottomHandle.x + 60, bottomHandle.y + bottomHandle.height / 2 - 100, { steps: 8 });
  const midDrag = await tree.boundingBox();
  assert.ok(Math.abs(midDrag.height - (treeNow.height - 100)) <= 2, `the tree follows the pointer: ${midDrag.height}`);
  assert.equal(await page.evaluate(() => window.layoutWrites), 0, 'nothing is written while the pointer moves');
  await page.mouse.up();
  await page.waitForFunction(() => window.cadHarness.preferences.getSnapshot().toolStack?.heights?.tree !== undefined);
  assert.equal(await page.evaluate(() => window.layoutWrites), 1, 'the height is written back once, on release');
  const dragged = (await layout()).heights.tree;
  assert.ok(Math.abs(dragged - (treeNow.height - 100)) <= 2, `the cap is the height it was dragged to: ${dragged}`);
  await treeHandle.focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(wanted => window.cadHarness.preferences.getSnapshot().toolStack?.heights?.tree === wanted, dragged + 16);
  await page.keyboard.press('Home');
  await page.waitForFunction(() => window.cadHarness.preferences.getSnapshot().toolStack?.heights?.tree === 64);
  assert.ok(Math.abs((await tree.boundingBox()).height - 64) <= 1, 'down to its minimum');
  await page.evaluate(height => window.cadHarness.preferences.update({ toolStack: { ...window.cadHarness.preferences.getSnapshot().toolStack,
    heights: { tree: height } } }), dragged);
  await page.evaluate(() => window.cadHarness.mounted(false));
  await tree.waitFor({ state: 'detached' });
  await page.evaluate(() => window.cadHarness.mounted(true));
  await tree.waitFor();
  assert.ok(Math.abs((await tree.boundingBox()).height - dragged) <= 1, 'a remount opens the tree at the height the person left');

  // FOLDING. Every panel folds to its first row by a chevron at that row's end — up to fold, down
  // to open — and unfolds again, its content kept mounted meanwhile; which panels are folded is
  // the person's, across remounts.
  const treeScroller = tree.locator('[data-tool-panel-body]');
  await treeScroller.evaluate(element => { element.scrollTop = 200; });
  const fold = tree.getByRole('button', { name: 'Collapse harness tree', exact: true });
  assert.deepEqual([await fold.getAttribute('aria-expanded'), await fold.locator('[data-chevron]').getAttribute('data-chevron')], ['true', 'up'], 'open: up folds it');
  await fold.click();
  const unfold = tree.getByRole('button', { name: 'Expand harness tree', exact: true });
  await unfold.waitFor();
  assert.deepEqual([await unfold.getAttribute('aria-expanded'), await unfold.locator('[data-chevron]').getAttribute('data-chevron')], ['false', 'down'], 'folded: down opens it');
  const foldedBox = await tree.boundingBox();
  assert.ok(Math.abs(foldedBox.height - 36 - 2) <= 1, 'folded to its first row');
  assert.equal(await tree.getByText('Row 1', { exact: true }).count(), 1, 'its content stays mounted');
  assert.equal(await tree.getByText('Row 1', { exact: true }).isVisible(), false);
  assert.deepEqual((await layout()).collapsed, { tree: true });
  // Its height handle stays on the folded edge: pulling it down opens the panel at the height it
  // is pulled to — one gesture, one write.
  const foldedHandle = await treeHandle.boundingBox();
  assert.ok(Math.abs(foldedHandle.y + foldedHandle.height / 2 - (foldedBox.y + foldedBox.height)) <= 1, 'the handle is on the folded panel\'s edge');
  await page.evaluate(() => { window.layoutWrites = 0; });
  await page.mouse.move(foldedHandle.x + 60, foldedHandle.y + foldedHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(foldedHandle.x + 60, foldedHandle.y + foldedHandle.height / 2 + 150, { steps: 8 });
  assert.ok(Math.abs((await tree.boundingBox()).height - (foldedBox.height + 150)) <= 2, 'it opens under the pointer');
  await page.mouse.up();
  await page.waitForFunction(() => !window.cadHarness.preferences.getSnapshot().toolStack?.collapsed?.tree);
  assert.equal(await page.evaluate(() => window.layoutWrites), 1, 'opened and sized in one write');
  assert.ok(Math.abs((await layout()).heights.tree - (foldedBox.height + 150)) <= 2, 'at the height it was pulled to');
  assert.equal(await tree.getByText('Row 1', { exact: true }).isVisible(), true);
  // From the keyboard, ArrowDown on a folded panel's handle opens it too.
  await fold.click();
  await unfold.waitFor();
  await treeHandle.focus();
  await page.keyboard.press('ArrowDown');
  await fold.waitFor();
  assert.deepEqual((await layout()).collapsed, {});
  // A heading panel folds to its heading.
  await fold.click();
  const referenceFold = reference.getByRole('button', { name: 'Collapse harness reference', exact: true });
  assert.equal(await referenceFold.locator('[data-chevron]').getAttribute('data-chevron'), 'up');
  await referenceFold.click();
  assert.equal(await reference.locator('[data-tool-panel-body]').isVisible(), false);
  assert.ok((await reference.boundingBox()).height <= 28 + 2 + 1, 'a heading panel folds to its heading');
  assert.equal(await reference.getByRole('button', { name: 'Expand harness reference', exact: true }).locator('[data-chevron]').getAttribute('data-chevron'), 'down');
  await page.evaluate(() => window.cadHarness.mounted(false));
  await tree.waitFor({ state: 'detached' });
  await page.evaluate(() => window.cadHarness.mounted(true));
  await tree.waitFor();
  assert.equal(await tree.getByRole('button', { name: 'Expand harness tree', exact: true }).isVisible(), true, 'folded across a remount');
  await tree.getByRole('button', { name: 'Expand harness tree', exact: true }).click();
  await reference.getByRole('button', { name: 'Expand harness reference', exact: true }).click();
  assert.equal(await tree.getByText('Row 1', { exact: true }).isVisible(), true);
  assert.deepEqual((await layout()).collapsed, {}, 'unfolded as they start, nothing is kept');
  await page.evaluate(width => window.cadHarness.preferences.update({ toolStack: { width, heights: {}, collapsed: {} } }), TOOL_STACK_DEFAULT_WIDTH);

  // THE STACK'S FOOT AND CORNER: while a panel a person sizes (here the tree and the Reference) is
  // on screen and open, a handle along the stack's bottom scales every such panel's cap together,
  // each in proportion to its height, and one at its bottom-right corner does that and sets the
  // width too — drawn at once, written back once, on release.
  const foot = one.locator('[data-tool-stack-height-handle]');
  const corner = one.locator('[data-tool-stack-corner-handle]');
  await foot.waitFor();
  assert.equal(await corner.count(), 1);
  assert.deepEqual([await foot.getAttribute('role'), await foot.getAttribute('aria-label')], ['separator', 'Resize tool panel heights']);
  // Nothing is drawn on the handles, hovered or dragged: a cursor, and a ring only for the keyboard.
  for (const handleLocator of [foot, one.getByRole('separator', { name: 'Resize tool panels', exact: true }), treeHandle]) {
    assert.doesNotMatch(await handleLocator.getAttribute('class'), /(?:^|\s)(?:hover|active|data-\[dragging\]):before:bg-/, 'no line on hover or drag');
  }
  // Folded panels are not sized: with both folded, neither handle is there.
  await fold.click();
  await referenceFold.click();
  await foot.waitFor({ state: 'detached' });
  assert.equal(await corner.count(), 0, 'no corner without a sizable panel open');
  await tree.getByRole('button', { name: 'Expand harness tree', exact: true }).click();
  await reference.getByRole('button', { name: 'Expand harness reference', exact: true }).click();
  await foot.waitFor();
  await page.evaluate(width => window.cadHarness.preferences.update({ toolStack: { width, heights: {}, collapsed: {} } }), TOOL_STACK_DEFAULT_WIDTH);
  await page.waitForTimeout(100);
  const heightsNow = async () => Object.fromEntries(await Promise.all([['tree', tree], ['reference', reference]]
    .map(async ([key, panel]) => [key, (await panel.boundingBox()).height])));
  const before = await heightsNow();
  const footBox = await foot.boundingBox();
  const stackBox = await stack.boundingBox();
  const lastPanel = await reference.boundingBox();
  assert.ok(footBox.y >= lastPanel.y + lastPanel.height && footBox.y <= lastPanel.y + lastPanel.height + 16,
    `the foot is at the stack's bottom, just under the last panel: ${footBox.y} vs ${lastPanel.y + lastPanel.height}`);
  assert.ok(footBox.width >= stackBox.width - 2, 'and runs the stack\'s width');
  await page.evaluate(() => { window.layoutWrites = 0; });
  await page.mouse.move(footBox.x + footBox.width / 2, footBox.y + footBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(footBox.x + footBox.width / 2, footBox.y + footBox.height / 2 - 90, { steps: 8 });
  const midway = await heightsNow();
  assert.ok(midway.tree < before.tree - 10 && midway.reference < before.reference - 10, `both panels shrink as the pointer moves: ${JSON.stringify([before, midway])}`);
  assert.equal(await page.evaluate(() => window.layoutWrites), 0, 'nothing is written while the pointer moves');
  await page.mouse.up();
  await page.waitForFunction(() => Object.keys(window.cadHarness.preferences.getSnapshot().toolStack?.heights || {}).length === 2);
  assert.equal(await page.evaluate(() => window.layoutWrites), 1, 'both caps written back in one write, on release');
  const caps = (await layout()).heights;
  const factor = (before.tree + before.reference - 90) / (before.tree + before.reference);
  assert.ok(Math.abs(caps.tree - before.tree * factor) <= 2 && Math.abs(caps.reference - before.reference * factor) <= 2,
    `each cap scaled by the same factor: ${JSON.stringify({ before, caps, factor })}`);
  assert.ok(Math.abs(caps.tree / before.tree - caps.reference / before.reference) < 0.02, 'in proportion');
  const after = await heightsNow();
  assert.ok(Math.abs(after.tree - caps.tree) <= 1 && Math.abs(after.reference - caps.reference) <= 1, `the panels are drawn at their new caps: ${JSON.stringify(after)}`);
  assert.equal((await layout()).width, TOOL_STACK_DEFAULT_WIDTH, 'the foot leaves the width alone');
  // The keyboard: ArrowDown and ArrowUp nudge the total by 16px, split in proportion.
  await foot.focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(total => {
    const heights = window.cadHarness.preferences.getSnapshot().toolStack.heights;
    return Math.abs(heights.tree + heights.reference - total) <= 2;
  }, caps.tree + caps.reference + 16);
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(total => {
    const heights = window.cadHarness.preferences.getSnapshot().toolStack.heights;
    return Math.abs(heights.tree + heights.reference - total) <= 2;
  }, caps.tree + caps.reference);
  // The corner scales the caps and sets the width in the same gesture.
  const cornerBefore = { heights: await heightsNow(), width: (await stack.boundingBox()).width };
  const cornerBox = await corner.boundingBox();
  assert.ok(Math.abs(cornerBox.x + cornerBox.width / 2 - (stackBox.x + stackBox.width)) <= 1, 'the corner is centred on the stack\'s right edge');
  await page.evaluate(() => { window.layoutWrites = 0; });
  await page.mouse.move(cornerBox.x + cornerBox.width / 2, cornerBox.y + cornerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cornerBox.x + cornerBox.width / 2 + 50, cornerBox.y + cornerBox.height / 2 - 60, { steps: 8 });
  assert.ok(Math.abs((await stack.boundingBox()).width - (cornerBefore.width + 50)) <= 2, 'the stack widens under the pointer');
  await page.mouse.up();
  await page.waitForFunction(from => window.cadHarness.preferences.getSnapshot().toolStack?.width !== from, TOOL_STACK_DEFAULT_WIDTH);
  const cornerLayout = await layout();
  assert.ok(Math.abs(cornerLayout.width - (cornerBefore.width + 50)) <= 2, `the corner set the width: ${cornerLayout.width}`);
  const cornerFactor = (cornerBefore.heights.tree + cornerBefore.heights.reference - 60) / (cornerBefore.heights.tree + cornerBefore.heights.reference);
  assert.ok(Math.abs(cornerLayout.heights.tree - cornerBefore.heights.tree * cornerFactor) <= 2
    && Math.abs(cornerLayout.heights.reference - cornerBefore.heights.reference * cornerFactor) <= 2, `and scaled the caps: ${JSON.stringify(cornerLayout)}`);
  assert.equal(await page.evaluate(() => window.layoutWrites), 1, 'the corner writes its caps and its width at once');
  await page.evaluate(width => window.cadHarness.preferences.update({ toolStack: { width, heights: {}, collapsed: {} } }), TOOL_STACK_DEFAULT_WIDTH);
  await keep.click();
  await kept.waitFor();

  // TWO SURFACES, one place (`floatingSurface.js`): the strip and the stack's panels, which stay up
  // beside the model, share the light chrome surface; a menu or a popover over the viewport has the
  // other, more opaque and more blurred. Both have the same border.
  await one.locator('[data-cad-surface] canvas').first().click({ button: 'right', position: { x: 600, y: 400 } });
  const menu = page.getByRole('menu');
  await menu.waitFor();
  const surface = locator => locator.evaluate(node => { const style = getComputedStyle(node); return [style.backdropFilter, style.borderTopColor].join(' | '); });
  const alpha = locator => locator.evaluate(node => Number(getComputedStyle(node).backgroundColor.match(/[\d.]+(?=\)$)/)?.[0] ?? 1));
  const border = locator => locator.evaluate(node => getComputedStyle(node).borderTopColor);
  // Located by CSS: the open menu hides the rest of the page from the accessibility tree.
  const stripSurface = one.locator('[data-cad-toolbar] [role=group]'), panelSurface = one.locator('[data-tool-panel][aria-label="Harness tree"]');
  const chrome = await surface(stripSurface);
  assert.match(chrome, /blur\(2px\)/);
  assert.equal(await surface(panelSurface), chrome, 'a stack panel has the strip\'s blur and border');
  assert.equal(await alpha(stripSurface), 0.35);
  assert.equal(await alpha(panelSurface), 0.35, 'and its background');
  assert.match(await surface(menu), /blur\(12px\)/, 'a menu over the viewport is blurred more');
  assert.equal(await alpha(menu), 0.75, 'and more opaque');
  assert.equal(await border(menu), await border(stripSurface), 'with the same border');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });

  // DISPLAY is not a tool: its settings are a popover from its button in the top-right bar. Opening
  // it leaves the tools as they were — a kept effect highlighted, Draw in hand with its panel — and
  // the stack's panels where they were; the popover has the menus' surface.
  const display = one.getByRole('button', { name: 'Display settings', exact: true });
  const displayPanel = page.locator('[data-display-popover]');
  assert.equal(await one.locator('[data-cad-toolbar]').getByRole('button', { name: /^Display/ }).count(), 0, 'Display is never on the strip');
  await one.getByRole('button', { name: 'Draw', exact: true }).click();
  await one.locator('[data-drawing-ready]').waitFor();
  const stackBefore = (await withinViewer()).map(panel => panel.label);
  assert.deepEqual(stackBefore, ['Drawing controls', 'Harness tree', 'Harness reference', 'Kept controls']);
  await display.click(); await displayPanel.waitFor();
  assert.equal(await displayPanel.getAttribute('aria-label'), 'Display settings');
  assert.equal(await display.getAttribute('aria-pressed'), 'true');
  assert.deepEqual((await withinViewer()).map(panel => panel.label), stackBefore, 'the stack is as it was: no Display panel in it');
  assert.equal(await keep.getAttribute('aria-pressed'), 'true', 'the kept effect stays highlighted');
  assert.equal(await one.getByRole('button', { name: 'Draw', exact: true }).getAttribute('aria-pressed'), 'true', 'Draw stays the tool');
  assert.equal(await alpha(displayPanel), 0.75, 'the popover is a menu\'s surface');
  // (Measured once its opening animation, a slide and a zoom, has run.)
  await displayPanel.evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
  const [popoverBox, displayButtonBox] = [await displayPanel.boundingBox(), await display.boundingBox()];
  assert.ok(popoverBox.y >= displayButtonBox.y + displayButtonBox.height, 'it opens under its button');
  // Its X puts it away, and so does its button; Draw is still the tool.
  await displayPanel.getByRole('button', { name: 'Close display settings', exact: true }).click();
  await displayPanel.waitFor({ state: 'detached' });
  assert.equal(await display.getAttribute('aria-pressed'), 'false');
  await display.click(); await displayPanel.waitFor();
  await display.click(); await displayPanel.waitFor({ state: 'detached' });
  assert.equal(await one.getByRole('button', { name: 'Draw', exact: true }).getAttribute('aria-pressed'), 'true');
  await one.getByRole('button', { name: 'Draw', exact: true }).click();
  await one.locator('[data-cad-drawing-overlay]').waitFor({ state: 'detached' });
  // A press anywhere outside it — the model included — puts it away; the press is still the model's.
  await display.click(); await displayPanel.waitFor();
  const modelBox = await one.locator('[data-cad-surface] canvas').first().boundingBox();
  await page.mouse.click(modelBox.x + modelBox.width * 0.6, modelBox.y + modelBox.height * 0.6);
  await displayPanel.waitFor({ state: 'detached' });
  assert.equal(await keep.getAttribute('aria-pressed'), 'true');

  // ESCAPE. A quick second Escape after closing a Select puts the popover away: a listbox on its
  // way out does not hold the key. The stack's own panels are never Escape's to close.
  await display.click(); await displayPanel.waitFor();
  await displayPanel.getByRole('combobox', { name: 'Mode', exact: true }).click();
  await page.getByRole('listbox').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  assert.equal(await displayPanel.isVisible(), true, 'the first Escape was the listbox\'s');
  await page.keyboard.press('Escape');
  await displayPanel.waitFor({ state: 'detached' });
  assert.equal(await display.getAttribute('aria-pressed'), 'false');
  assert.equal(await tree.isVisible(), true, 'Escape leaves the stack\'s panels alone');
  assert.equal(await kept.isVisible(), true);

  // Draw's surface keeps its Escape: Draw stays, with its panel.
  await one.getByRole('button', { name: 'Draw', exact: true }).click();
  await one.locator('[data-drawing-ready]').waitFor();
  const canvas = await one.locator('[data-cad-drawing-overlay] canvas').last().boundingBox();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.down(); await page.mouse.move(canvas.x + canvas.width / 2 + 40, canvas.y + canvas.height / 2 + 20, { steps: 4 }); await page.mouse.up();
  await one.locator('[data-cad-drawing-overlay] .excalidraw').focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert.equal(await one.getByRole('button', { name: 'Draw', exact: true }).getAttribute('aria-pressed'), 'true', 'Escape on the drawing surface is Draw\'s');
  assert.equal(await one.locator('[data-tool-panel][aria-label="Drawing controls"]').isVisible(), true);
  assert.equal(await one.locator('[data-tool-panel][aria-label="Drawing controls"]').getByRole('button', { name: /^(?:Collapse|Expand) / }).count(), 0, 'the Drawing panel does not fold');
  await one.getByRole('button', { name: 'Draw', exact: true }).click();
  await one.locator('[data-cad-drawing-overlay]').waitFor({ state: 'detached' });
  await keep.click();
  await kept.waitFor({ state: 'detached' });

  // MOBILE (a second pane halves the width): the same stack. A tree's default cap is the whole
  // column there, not half of it — it is not held to a share of it — and with the Reference up too,
  // the tree gives way so that both fit, nothing running past the viewer.
  await page.evaluate(() => window.cadHarness.second(true));
  await page.waitForFunction(() => document.querySelector('[data-testid="one"] .hardcore-file-viewer')?.getAttribute('data-viewer-layout') === 'mobile');
  await page.waitForTimeout(200);
  const [mobileTree, mobileReference, column] = await Promise.all([tree.boundingBox(), reference.boundingBox(), stack.boundingBox()]);
  const columnHeight = await stack.evaluate(node => node.clientHeight);
  assert.equal(await tree.evaluate(node => node.style.maxHeight), `${columnHeight}px`, 'its cap is the whole column');
  assert.ok(mobileTree.height > column.height * 0.4 + 1, `not held to 40%: ${mobileTree.height} of ${column.height}`);
  assert.ok(mobileReference.y >= mobileTree.y + mobileTree.height && mobileReference.y + mobileReference.height <= column.y + column.height + 1,
    `the Reference fits under it: ${JSON.stringify({ mobileTree, mobileReference, column })}`);
  assert.equal(await tree.locator('[data-tool-panel-body]').evaluate(body => body.scrollHeight > body.clientHeight), true, 'the tree gave way and scrolls');
  await page.evaluate(() => window.cadHarness.second(false));
  await page.waitForFunction(() => document.querySelector('[data-testid="one"] .hardcore-file-viewer')?.getAttribute('data-viewer-layout') === 'desktop');

  // ARROWS orbit the viewer the key landed in, or the one under the pointer when it landed
  // on the page — never every viewer on the page.
  await page.evaluate(() => window.cadHarness.second(true));
  const two = page.getByTestId('two');
  await two.locator('[aria-busy="false"] > div > canvas').first().waitFor();
  await page.waitForFunction(() => window.cadHarness.a.controller?.readState().loading === false && window.cadHarness.b.controller?.readState().loading === false);
  const cameras = () => page.evaluate(() => [window.cadHarness.a.controller.readState().camera.position, window.cadHarness.b.controller.readState().camera.position]);
  const turned = (before, after) => before.some((value, index) => Math.abs(value - after[index]) > 1e-6);
  await page.evaluate(() => document.activeElement?.blur());
  const twoBox = await two.locator('[aria-busy="false"] > div > canvas').first().boundingBox();
  await page.mouse.move(twoBox.x + twoBox.width / 2, twoBox.y + twoBox.height - 30);
  let [a0, b0] = await cameras();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  let [a1, b1] = await cameras();
  assert.equal(turned(a0, a1), false, 'the viewer the pointer is not over keeps its camera');
  assert.equal(turned(b0, b1), true, 'the viewer under the pointer turns');
  await page.mouse.move(1260, 790);
  [a0, b0] = await cameras();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(250);
  [a1, b1] = await cameras();
  assert.equal(turned(a0, a1) || turned(b0, b1), false, 'a key on the page with the pointer outside every viewer turns none');
  await one.locator('[data-slot="cad-file-view"]').focus();
  await page.mouse.move(twoBox.x + twoBox.width / 2, twoBox.y + twoBox.height - 30);
  [a0, b0] = await cameras();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(250);
  [a1, b1] = await cameras();
  assert.equal(turned(a0, a1), true, 'the focused viewer turns');
  assert.equal(turned(b0, b1), false, 'and the one under the pointer does not');

  // A CAP IS NEVER A FLOOR. A tree of two rows is its filter and its two rows, with no empty space
  // under them; a Reference of forty facts stops at its cap and scrolls.
  await page.evaluate(() => window.cadHarness.second(false));
  await page.goto(`http://127.0.0.1:${server.address().port}/?file=panel-short.harness`);
  await one.locator('[aria-busy="false"] > div > canvas').first().waitFor();
  await tree.waitFor();
  const [shortTree, longReference] = await Promise.all([tree, reference].map(panel => panel.evaluate(node => {
    const body = node.querySelector('[data-tool-panel-body]');
    // The panel's first row: its header, drawn through a `display: contents` wrapper.
    const first = node.firstElementChild;
    const header = (getComputedStyle(first).display === 'contents' ? first.firstElementChild : first).getBoundingClientRect().height;
    return { height: node.getBoundingClientRect().height, header, content: body.scrollHeight, scrolls: body.scrollHeight > body.clientHeight + 1 };
  })));
  assert.equal(shortTree.scrolls, false);
  assert.ok(Math.abs(shortTree.height - (shortTree.header + shortTree.content + 2)) <= 1,
    `the tree is its filter row and its rows: ${JSON.stringify(shortTree)}`);
  assert.ok(shortTree.height < 128, 'with no minimum height of its own');
  assert.equal(longReference.scrolls, true, 'a long Reference scrolls');
  assert.ok(Math.abs(longReference.height - 288) <= 1, `at its cap: ${longReference.height}`);
  assert.deepEqual(errors, []);
});
