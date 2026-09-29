import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const appDir = path.join(repo, 'apps/chatgpt');

test('built UI views STEP revisions and provides persistent recents, real thumbnails, native opening and preview fallback', { timeout: 120_000 }, async t => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'cad-mcp-browser-')));
  let closeBrowser = async () => {};
  let closeServer = () => {};
  let closeClient = async () => {};
  // Stop producers before deleting their files: mounted views can still write
  // thumbnails/history until the browser and MCP transport have both closed.
  t.after(async () => {
    try { await closeBrowser(); }
    finally { try { closeServer(); await closeClient(); } finally { await rm(temporary, { recursive: true, force: true }); } }
  });
  const localPython = path.join(repo, '.venv/bin/python');
  const python = process.env.PYTHON_BIN || (existsSync(localPython) ? localPython : 'python3');
  const documents = path.join(temporary, 'parts');
  await mkdir(documents);
  const source = path.join(documents, 'fixture.step');
  const env = { ...process.env, PYTHONPATH: path.join(repo, 'packages/cadgen/src'), CADGEN_CACHE_DIR: path.join(temporary, 'cache'), CADGEN_DAEMON: '0', CADGEN_STATE_DIR: path.join(temporary, 'state'), CADGEN_MCP_UI_CACHE_DIR: path.join(temporary, 'ui-cache') };
  const save = (width: number) => run(python, ['-c', `from build123d import Box, export_step; export_step(Box(${width},20,30), ${JSON.stringify(source)})`], { env });
  await save(10);
  await copyFile(source, path.join(documents, 'related.step'));
  await writeFile(path.join(documents, 'notes.txt'), 'This is not a CAD file.');
  const ui = path.join(appDir, 'dist/index.html');
  const serverDirectory = path.join(temporary, 'plugin');
  await mkdir(serverDirectory);
  // Deliberately launch outside the document's directory: host metadata, not
  // the plugin install directory, authorizes the native file entrypoint.
  const transport = new StdioClientTransport({ command: python, args: ['-m', 'cadgen.cli', 'mcp', '--ui', ui], cwd: serverDirectory, env: env as Record<string, string>, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'cad-browser-test', version: '1.0.0' });
  closeClient = () => client.close();
  try { await client.connect(transport); }
  catch (error) { throw new Error(`${String(error)}\nMCP stderr: ${stderr}`, { cause: error }); }
  const descriptor = (await client.listTools()).tools.find(tool => tool.name === 'cad_open');
  const resourceUri = (descriptor?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri;
  assert.ok(resourceUri, 'CAD advertises its current UI resource');
  const resource = await client.readResource({ uri: resourceUri }).catch(error => { throw new Error(`${String(error)}\nMCP stderr: ${stderr}`, { cause: error }); });
  const html = resource.contents[0];
  assert.ok('text' in html);
  const calls: string[] = [];
  const catalogRequests: string[] = [];
  const catalogStates: unknown[] = [];
  const homeRequests: unknown[] = [];
  let hostFile = source;
  const tool = async (params: Record<string, unknown>) => {
    calls.push(String(params.name));
    const requestPath = (params.arguments as { path?: string })?.path;
    if (requestPath?.startsWith('/__cad/catalog')) catalogRequests.push(requestPath);
    const result = await client.callTool({ ...params, _meta: { 'openai/resource': { path: hostFile } } } as Parameters<typeof client.callTool>[0]);
    if (requestPath?.startsWith('/__cad/catalog')) {
      const body = (result.structuredContent as { body?: string } | undefined)?.body;
      if (body) { try { catalogStates.push(JSON.parse(Buffer.from(body, 'base64').toString()).entries); } catch {} }
    }
    return result;
  };
  let initialOpen: { document: { id: string; path: string } } | undefined;
  const home = await client.callTool({ name: 'cad_open', arguments: {} });
  assert.notEqual(home.isError, true, JSON.stringify(home));
  const bundle = await build({ stdin: { contents: `
    import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
    import { z } from 'zod';
    const frame = document.querySelector('iframe');
    const homeMode = new URLSearchParams(location.search).has('home');
    const bridge = new AppBridge(null, {name:'CAD test host',version:'1.0.0'}, {
      serverTools:{}, updateModelContext:{text:{}, image:{}, structuredContent:{}},
      experimental:{'openai/modelContext':{}, ...(!new URLSearchParams(location.search).has('fallback') ? {'openai/files':{}} : {})}
    });
    window.attachments = [];
    window.openedNative = null;
    bridge.setRequestHandler(z.object({method:z.literal('openai/files/open'),params:z.object({path:z.string()})}), async request => {
      if (window.failNativeOpen) throw new Error('File opening unavailable');
      window.openedNative = request.params.path; return {};
    });
    window.openRelated = async () => {
      const response = await fetch('/open-related', {method:'POST'});
      await bridge.sendToolInput({arguments:{file:{name:'related.step',resourceUri:'host-resource://related'}}});
      await bridge.sendToolResult(await response.json());
    };
    bridge.oncalltool = async params => {
      const response = await fetch(homeMode ? '/home-tool' : '/tool', {method:'POST',body:JSON.stringify(params)});
      return response.json();
    };
    bridge.onupdatemodelcontext = async params => { window.attachments = params.content || []; return {}; };
    bridge.oninitialized = async () => {
      await bridge.sendToolInput({arguments:homeMode ? {} : {file:{name:'fixture.step',resourceUri:'host-resource://fixture'}}});
      await bridge.sendToolResult(homeMode ? ${JSON.stringify(home)} : await (await fetch('/initial-open', {method:'POST'})).json());
    };
    await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
    window.setTheme = theme => bridge.setHostContext({theme, platform:'desktop'});
    window.setTheme('light');
    frame.src = '/viewer';
  `, resolveDir: appDir }, bundle: true, format: 'esm', write: false });
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/viewer') {
        response.setHeader('Content-Type', 'text/html');
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src data: blob:; style-src 'unsafe-inline'; font-src data:; img-src data: blob:");
        response.end(html.text);
      }
      else if (request.url === '/host.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].text); }
      else if (request.url === '/initial-open' && request.method === 'POST') {
        // A model opening precedes native host metadata; both retain the same document.
        const result = await client.callTool({ name: 'cad_open', arguments: { path: source } });
        initialOpen = result.structuredContent as typeof initialOpen;
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
      }
      else if (request.url === '/open-related' && request.method === 'POST') {
        hostFile = path.join(documents, 'related.step');
        const result = await client.callTool({ name: 'cad_open', arguments: { file: { name: 'related.step', resourceUri: 'host-resource://related' } } });
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
      }
      else if (request.url === '/home-tool') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const params = JSON.parse(Buffer.concat(chunks).toString());
        homeRequests.push(params);
        const result = await client.callTool(params);
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
      }
      else if (request.url === '/tool') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const result = await tool(JSON.parse(Buffer.concat(chunks).toString()));
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
      } else { response.setHeader('Content-Type', 'text/html'); response.end('<style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style><iframe sandbox="allow-scripts allow-same-origin" allow="clipboard-write"></iframe><script type="module" src="/host.js"></script>'); }
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: String(error) }] })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  closeServer = () => { server.closeAllConnections(); server.close(); };
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' && !process.env.CAD_TEST_SWIFTSHADER ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  closeBrowser = () => browser.close();
  const page = await browser.newPage({ viewport: { width: 1600, height: 760 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${address.port}/?home`);
    const viewer = page.frameLocator('iframe');
    await expect(viewer.getByText('Open a CAD file to see it here.', { exact: true })).toBeVisible();
    await expect(viewer.getByRole('img', { name: 'CAD', exact: true })).toBeVisible();
    await expect(viewer.getByRole('img', { name: 'CAD', exact: true })).toHaveAttribute('src', /^data:image\/png/);
    await expect(viewer.locator('meta[name=description]')).toHaveAttribute('content', 'Give your agent CAD superpowers.');
    await expect(viewer.locator('link[rel=icon]')).toHaveAttribute('href', /^data:image\/svg\+xml/);
    const logoBounds = await viewer.getByRole('img', { name: 'CAD', exact: true }).boundingBox();
    const headingBounds = await viewer.getByRole('heading', { name: 'Recent', exact: true }).boundingBox();
    assert.ok(logoBounds && headingBounds && logoBounds.x <= 40 && headingBounds.y > logoBounds.y + logoBounds.height);
    await expect(viewer.getByRole('button', { name: 'Refresh recent models', exact: true })).toHaveCount(0);
    await expect(viewer.getByRole('region', { name: 'Pinned', exact: true })).toHaveCount(0);
    await expect(viewer.getByRole('link', { name: /^CAD version / })).toHaveAttribute('href', /github.com\/earthtojake\/text-to-cad\/releases\/tag\/v/);
    await expect(viewer.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute('href', 'https://github.com/earthtojake/text-to-cad');
    await expect(viewer.getByRole('link', { name: 'Discord', exact: true })).toHaveAttribute('href', 'https://discord.gg/5FGB9DwJYU');
    if (process.env.CAD_EXTENSION_EMPTY_SCREENSHOT) await page.screenshot({ path: process.env.CAD_EXTENSION_EMPTY_SCREENSHOT });
    const openModel = viewer.getByRole('button', { name: 'Open Model', exact: true });
    await openModel.click();
    const modelPath = viewer.getByRole('textbox', { name: 'Model path', exact: true });
    await expect(modelPath).toBeFocused();
    await modelPath.fill('fixture.step');
    await modelPath.press('Enter');
    await expect(viewer.getByRole('alert')).toHaveText('Enter the full absolute path to the model.');
    assert.equal(await page.evaluate(() => (window as any).openedNative), null);
    await modelPath.fill(path.join(documents, 'notes.txt'));
    await modelPath.press('Enter');
    await expect(viewer.getByRole('alert')).toHaveText('Choose a STEP, STL, GLB or 3MF model.');
    await modelPath.press('Escape');
    await expect(openModel).toBeFocused();
    await openModel.click();
    await modelPath.fill(`"${source}"`);
    if (process.env.CAD_EXTENSION_OPEN_MODEL_SCREENSHOT) await page.screenshot({ path: process.env.CAD_EXTENSION_OPEN_MODEL_SCREENSHOT });
    await page.evaluate(() => { (window as any).failNativeOpen = true; });
    await modelPath.press('Enter');
    await expect(viewer.getByRole('alert')).toContainText('File opening unavailable');
    await expect(modelPath).toHaveValue(`"${source}"`);
    await page.evaluate(() => { (window as any).failNativeOpen = false; });
    await modelPath.press('Enter');
    await expect(modelPath).toHaveCount(0);
    assert.equal(await page.evaluate(() => (window as any).openedNative), source);
    assert.ok(homeRequests.every((request: any) => ['cad_handshake', 'cad_library'].includes(request.name)));
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await viewer.getByRole('region', { name: 'Features', exact: true }).waitFor();
    const select = viewer.getByRole('button', { name: 'Select Base extrude', exact: true });
    // Reloads can replace a selected document between separate Playwright actions.
    // Take one nonblocking step against the current DOM per poll, so a removed
    // attachment action cannot consume the poll's entire timeout.
    const attachCurrentSelection = () => viewer.locator('body').evaluate(body => {
      const row = body.querySelector<HTMLButtonElement>('button[aria-label="Select Base extrude"]');
      if (!row || row.disabled) return;
      if (row.getAttribute('aria-pressed') !== 'true') { row.click(); return; }
      const add = [...body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Add To Prompt');
      if (add && !add.disabled) add.click();
    });
    assert.ok(initialOpen?.document.path === source);
    // The same basename outside the first document's directory has distinct
    // authority. Later native metadata cannot redirect an existing document ID.
    const otherDirectory = path.join(temporary, 'elsewhere');
    await mkdir(otherDirectory);
    const sameName = path.join(otherDirectory, 'fixture.step');
    await copyFile(source, sameName);
    const otherOpen = await client.callTool({ name: 'cad_open', arguments: { path: sameName } });
    assert.notEqual(otherOpen.isError, true, JSON.stringify(otherOpen));
    const otherDocument = (otherOpen.structuredContent as { document: { id: string; path: string } }).document;
    assert.notEqual(otherDocument.id, initialOpen.document.id);
    assert.equal(otherDocument.path, sameName);
    const original = await client.callTool({ name: 'cad_request', arguments: { apiVersion: 2, document: initialOpen.document, path: `/__cad/catalog?file=${encodeURIComponent(source)}`, method: 'GET' }, _meta: { 'openai/resource': { path: sameName } } });
    assert.notEqual(original.isError, true, JSON.stringify(original));
    const originalCatalog = JSON.parse(Buffer.from((original.structuredContent as { body: string }).body, 'base64').toString());
    assert.ok(originalCatalog.entries.some((entry: any) => entry.file === source && !entry.catalogPending));
    assert.ok(originalCatalog.entries.every((entry: any) => entry.file === source));
    const bottomActions = viewer.locator('[data-viewport-bottom-actions]');
    const promptAction = bottomActions.getByRole('button', { name: 'Add To Prompt', exact: true });
    await expect(bottomActions.getByRole('button')).toHaveCount(1);
    await expect(promptAction).toBeEnabled({ timeout: 30_000 });
    await promptAction.click();
    await page.waitForFunction(() => (window as any).attachments.some((part: any) => part.type === 'image'));
    assert.equal(await page.evaluate(() => (window as any).attachments.some((part: any) => part.text?.includes('fixture.step#'))), false, 'an unselected view includes no geometry selectors');
    await select.click(); await promptAction.click();
    await page.waitForFunction(() => (window as any).attachments.some((part: any) => part.text?.includes('fixture.step#')));
    await expect(viewer.getByText('Added to prompt', { exact: true })).toHaveCount(0);
    const attachments = await page.evaluate(() => (window as any).attachments);
    assert.ok(attachments.some((part: any) => part.type === 'text' && part.text.includes(`${source}#`)), 'selected references preserve the canonical absolute document path');
    assert.ok(calls.includes('cad_request'));
    assert.equal(await viewer.getByRole('button', { name: /^(Show|Hide) files$/ }).count(), 0);
    assert.equal(await viewer.getByRole('button', { name: /^Browse / }).count(), 0);
    assert.equal(await viewer.getByRole('tree').count(), 0);
    assert.equal(await viewer.locator('input[type="file"]').count(), 0);
    await expect(viewer.getByRole('button', { name: 'Take snapshot', exact: true })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'Display settings', exact: true })).toBeVisible();
    await viewer.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(viewer.getByRole('button', { name: 'Add To Prompt', exact: true })).toHaveCount(0);
    await viewer.getByRole('button', { name: 'Exit preview', exact: true }).click();
    await expect(select).toHaveAttribute('aria-pressed', 'true');
    await save(15);
    const initialRevision = attachments.find((part: any) => part.text?.includes('fixture.step#')).text;
    // A new reference must bind the geometry the viewer actually displays, not
    // merely observe that the backend catalog noticed a saved file.
    await expect.poll(async () => {
      await attachCurrentSelection();
      return page.evaluate(() => (window as any).attachments.filter((part: any) => part.text?.includes('Document revision:')).at(-1)?.text);
    }, { timeout: 30_000 }).not.toBe(initialRevision);
    assert.equal(await page.evaluate(() => (window as any).attachments.find((part: any) => part.text?.includes('fixture.step#')).text), initialRevision, 'existing references retain their original revision');
    await page.evaluate(() => (window as any).openRelated());
    await viewer.getByRole('region', { name: 'Features', exact: true }).waitFor();
    await expect.poll(async () => {
      await attachCurrentSelection();
      return page.evaluate(() => (window as any).attachments.filter((part: any) => part.text?.includes('Document revision:')).at(-1)?.text || '');
    }, { timeout: 30_000 }).toMatch(/related\.step/);
    assert.ok(catalogRequests.length > 0);
    assert.ok(catalogRequests.every(request => new URL(request, 'http://cad.local').searchParams.get('file')), 'catalog polling is always scoped to an opened file');
    assert.deepEqual(errors, []);
    if (process.env.CAD_EXTENSION_SCREENSHOT) {
      await page.screenshot({ path: process.env.CAD_EXTENSION_SCREENSHOT });
    }
    await page.evaluate(() => (window as any).setTheme('dark'));
    await page.setViewportSize({ width: 320, height: 640 });
    await expect(viewer.locator('html')).toHaveClass(/dark/);
    await expect.poll(async () => {
      const buttons = await bottomActions.getByRole('button').all();
      const bounds = await Promise.all(buttons.map(button => button.boundingBox()));
      return bounds.length === 1 && bounds.every(box => box && box.x >= 0 && box.x + box.width <= 320 && box.y + box.height <= 640);
    }).toBe(true);
    if (process.env.CAD_EXTENSION_MOBILE_SCREENSHOT) await page.screenshot({ path: process.env.CAD_EXTENSION_MOBILE_SCREENSHOT });
    await page.setViewportSize({ width: 1000, height: 760 });
    // Navigation mounts a fresh bridge/app instance with the global entrypoint result.
    await page.goto(`http://127.0.0.1:${address.port}/?home`);
    await expect(viewer.getByRole('heading', { name: 'Recent', exact: true })).toBeVisible();
    await expect(openModel).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Open related.step', exact: true })).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Open related.step', exact: true }).locator('img')).toBeVisible();
    const previewData = await viewer.getByRole('button', { name: 'Open related.step', exact: true }).locator('img').getAttribute('src');
    assert.ok(previewData?.startsWith('data:image/png;base64,'));
    const preview = PNG.sync.read(Buffer.from(previewData.split(',')[1], 'base64'));
    let solidPixels = 0;
    const backdrop = [...preview.data.subarray(0, 3)];
    for (let offset = 0; offset < preview.data.length; offset += 4) {
      if (backdrop.some((channel, index) => Math.abs(channel - preview.data[offset + index]) > 35)) solidPixels++;
    }
    assert.ok(solidPixels / (preview.width * preview.height) > 0.1, 'the saved preview contains shaded model surfaces, not only edges');
    await viewer.getByRole('searchbox', { name: 'Search models' }).fill('related');
    assert.equal(await viewer.getByRole('button', { name: 'Open fixture.step', exact: true }).count(), 0);
    await viewer.getByRole('button', { name: 'Pin related.step', exact: true }).focus();
    await viewer.getByRole('button', { name: 'Pin related.step', exact: true }).press('Space');
    await expect(viewer.getByRole('region', { name: 'Pinned', exact: true }).getByRole('button', { name: 'Unpin related.step', exact: true })).toBeVisible();
    await viewer.getByRole('searchbox', { name: 'Search models' }).fill('');
    await expect(viewer.getByRole('region', { name: 'Recent', exact: true }).getByRole('button', { name: 'Open related.step', exact: true })).toHaveCount(0);
    await viewer.getByRole('button', { name: 'Open related.step', exact: true }).click();
    await page.waitForFunction(() => (window as any).openedNative?.endsWith('/related.step'));
    assert.equal(await viewer.getByRole('tree').count(), 0);
    assert.equal(await viewer.locator('input[type="file"]').count(), 0);
    assert.equal(await viewer.getByRole('navigation').count(), 0);
    assert.ok(homeRequests.every((request: any) => ['cad_handshake', 'cad_library'].includes(request.name)), 'home reads extension history without requesting a cwd catalog');
    await viewer.getByRole('searchbox', { name: 'Search models' }).fill('');
    if (process.env.CAD_EXTENSION_HOME_SCREENSHOT) await page.screenshot({ path: process.env.CAD_EXTENSION_HOME_SCREENSHOT });
    await page.evaluate(() => (window as any).setTheme('dark'));
    await expect(viewer.locator('html')).toHaveClass(/dark/);
    if (process.env.CAD_EXTENSION_HOME_DARK_SCREENSHOT) await page.screenshot({ path: process.env.CAD_EXTENSION_HOME_DARK_SCREENSHOT });
    // Another file tab can update history while this home stays mounted.
    const later = path.join(documents, 'later.step');
    await copyFile(source, later);
    const recorded = await client.callTool({ name: 'cad_open', arguments: { file: { name: 'later.step', resourceUri: 'host-resource://later' } }, _meta: { 'openai/resource': { path: later } } });
    assert.notEqual(recorded.isError, true, JSON.stringify(recorded));
    await expect(viewer.getByRole('button', { name: 'Open later.step', exact: true })).toBeVisible({ timeout: 15_000 });
    await viewer.getByRole('button', { name: 'Remove later.step from recents', exact: true }).click();
    await expect(viewer.getByRole('button', { name: 'Open later.step', exact: true })).toHaveCount(0);
    // Hosts lacking native file opening get an explicitly labeled local preview.
    await page.goto(`http://127.0.0.1:${address.port}/?home&fallback`);
    await viewer.getByRole('button', { name: 'Preview related.step here', exact: true }).click();
    await viewer.getByRole('region', { name: 'Features', exact: true }).waitFor();
    await expect(viewer.getByRole('button', { name: 'Back to recent models', exact: true })).toBeVisible();
    await viewer.getByRole('button', { name: 'Back to recent models', exact: true }).click();
    await expect(viewer.getByRole('heading', { name: 'Recent', exact: true })).toBeVisible();
    await openModel.click();
    await modelPath.fill(source);
    await modelPath.press('Enter');
    await viewer.getByRole('region', { name: 'Features', exact: true }).waitFor();
    await expect(viewer.getByRole('button', { name: 'Back to recent models', exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
  } catch (error) {
    throw new Error(`${String(error)}\nBrowser errors: ${errors.join('\n')}\nCatalog states: ${JSON.stringify(catalogStates.slice(-3))}\nMCP stderr: ${stderr.slice(-3000)}\n${await page.frameLocator('iframe').locator('body').innerText()}`, { cause: error });
  }
});
