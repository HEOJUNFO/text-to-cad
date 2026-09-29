import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const appDir = path.join(repo, 'apps/chatgpt');

test('built UI opens a STEP through MCP, attaches a selection, observes saves, and follows host file switching, and opens a quiet global home', { timeout: 120_000 }, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'cad-mcp-browser-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const localPython = path.join(repo, '.venv/bin/python');
  const python = process.env.PYTHON_BIN || (existsSync(localPython) ? localPython : 'python3');
  const source = path.join(temporary, 'fixture.step');
  const env = { ...process.env, PYTHONPATH: path.join(repo, 'packages/cadgen/src'), CADGEN_CACHE_DIR: path.join(temporary, 'cache'), CADGEN_DAEMON: '0' };
  const save = (width: number) => run(python, ['-c', `from build123d import Box, export_step; export_step(Box(${width},20,30), ${JSON.stringify(source)})`], { env });
  await save(10);
  await copyFile(source, path.join(temporary, 'related.step'));
  await writeFile(path.join(temporary, 'notes.txt'), 'This is not a CAD file.');
  const ui = path.join(appDir, 'dist/index.html');
  // Deliberately launch outside the document's directory: host metadata, not
  // the plugin install directory, authorizes the native file entrypoint.
  const transport = new StdioClientTransport({ command: python, args: ['-m', 'cadgen.cli', 'mcp', '--ui', ui], cwd: repo, env: env as Record<string, string>, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'cad-browser-test', version: '1.0.0' });
  t.after(() => client.close());
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
  const homeRequests: unknown[] = [];
  let hostFile = source;
  const tool = async (params: Record<string, unknown>) => {
    calls.push(String(params.name));
    const requestPath = (params.arguments as { path?: string })?.path;
    if (requestPath?.startsWith('/__cad/catalog')) catalogRequests.push(requestPath);
    return client.callTool({ ...params, _meta: { 'openai/resource': { path: hostFile } } } as Parameters<typeof client.callTool>[0]);
  };
  const opened = await client.callTool({ name: 'cad_open', arguments: { file: { name: 'fixture.step', resourceUri: 'host-resource://fixture' } } });
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  const home = await client.callTool({ name: 'cad_open', arguments: {} });
  assert.notEqual(home.isError, true, JSON.stringify(home));
  const bundle = await build({ stdin: { contents: `
    import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
    const frame = document.querySelector('iframe');
    const homeMode = new URLSearchParams(location.search).has('home');
    const bridge = new AppBridge(null, {name:'CAD test host',version:'1.0.0'}, {
      serverTools:{}, updateModelContext:{text:{}, image:{}, structuredContent:{}},
      experimental:{'openai/modelContext':{}}
    });
    window.attachments = [];
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
      await bridge.sendToolResult(homeMode ? ${JSON.stringify(home)} : ${JSON.stringify(opened)});
    };
    await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
    bridge.setHostContext({theme:'light', platform:'desktop'});
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
      else if (request.url === '/open-related' && request.method === 'POST') {
        hostFile = path.join(temporary, 'related.step');
        const result = await client.callTool({ name: 'cad_open', arguments: { file: { name: 'related.step', resourceUri: 'host-resource://related' } } });
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
      }
      else if (request.url === '/home-tool') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        homeRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
        // Empty home must not request a catalog or scan the server's working directory.
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'The empty home must not request CAD services.' }] }));
      }
      else if (request.url === '/tool') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const result = await tool(JSON.parse(Buffer.concat(chunks).toString()));
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
      } else { response.setHeader('Content-Type', 'text/html'); response.end('<style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style><iframe sandbox="allow-scripts allow-same-origin" allow="clipboard-write"></iframe><script type="module" src="/host.js"></script>'); }
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: String(error) }] })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' && !process.env.CAD_TEST_SWIFTSHADER ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${address.port}`);
    const viewer = page.frameLocator('iframe');
    await viewer.getByRole('region', { name: 'Features', exact: true }).waitFor();
    const select = viewer.getByRole('button', { name: 'Select Base extrude', exact: true });
    await select.click();
    await viewer.getByRole('button', { name: 'Add to prompt', exact: true }).click();
    await page.waitForFunction(() => (window as any).attachments.length > 0);
    const attachments = await page.evaluate(() => (window as any).attachments);
    assert.match(JSON.stringify(attachments), /fixture\.step/);
    assert.ok(calls.includes('cad_request'));
    assert.equal(await viewer.getByRole('button', { name: /^(Show|Hide) files$/ }).count(), 0);
    assert.equal(await viewer.getByRole('button', { name: /^Browse / }).count(), 0);
    assert.equal(await viewer.getByRole('tree').count(), 0);
    assert.equal(await viewer.locator('input[type="file"]').count(), 0);
    await expect(viewer.getByRole('button', { name: 'Take snapshot', exact: true })).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Display settings', exact: true })).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
    await save(15);
    const initialRevision = attachments.find((part: any) => part.text?.includes('Document revision:')).text;
    // A new reference must bind the geometry the viewer actually displays, not
    // merely observe that the backend catalog noticed a saved file.
    await expect.poll(async () => {
      await select.click();
      await viewer.getByRole('button', { name: 'Add to prompt', exact: true }).click();
      return page.evaluate(() => (window as any).attachments.filter((part: any) => part.text?.includes('Document revision:')).at(-1)?.text);
    }, { timeout: 30_000 }).not.toBe(initialRevision);
    assert.equal(await page.evaluate(() => (window as any).attachments[0].text), attachments[0].text, 'existing references retain their original revision');
    await page.evaluate(() => (window as any).openRelated());
    await viewer.getByRole('region', { name: 'Features', exact: true }).waitFor();
    await expect.poll(async () => {
      await select.click();
      await viewer.getByRole('button', { name: 'Add to prompt', exact: true }).click();
      return page.evaluate(() => (window as any).attachments.at(-1)?.text || '');
    }, { timeout: 30_000 }).toMatch(/related\.step/);
    assert.ok(catalogRequests.length > 0);
    assert.ok(catalogRequests.every(request => new URL(request, 'http://cad.local').searchParams.get('file')), 'catalog polling is always scoped to an opened file');
    assert.deepEqual(errors, []);
    if (process.env.CAD_EXTENSION_SCREENSHOT) {
      await page.screenshot({ path: process.env.CAD_EXTENSION_SCREENSHOT });
    }
    // Navigation mounts a fresh bridge/app instance with the global entrypoint result.
    await page.goto(`http://127.0.0.1:${address.port}/?home`);
    await expect(viewer.getByRole('heading', { name: 'Create or open a part', exact: true })).toBeVisible();
    await expect(viewer.getByText('Ask the composer to create or modify a part.', { exact: false })).toBeVisible();
    await expect(viewer.getByText('Open a STEP, STL, GLB or 3MF file, then choose CAD.', { exact: true })).toBeVisible();
    await expect(viewer.getByText('Select geometry, then use Add to prompt', { exact: false })).toBeVisible();
    assert.equal(await viewer.getByRole('button', { name: /^(Show|Hide) files$/ }).count(), 0);
    assert.equal(await viewer.getByRole('button', { name: /^Browse / }).count(), 0);
    assert.equal(await viewer.getByRole('tree').count(), 0);
    assert.equal(await viewer.locator('input[type="file"]').count(), 0);
    assert.equal(await viewer.getByRole('heading', { name: 'CAD', exact: true }).count(), 0);
    assert.equal(await viewer.getByRole('navigation').count(), 0);
    if (process.env.CAD_EXTENSION_HOME_SCREENSHOT) {
      await page.screenshot({ path: process.env.CAD_EXTENSION_HOME_SCREENSHOT });
    }
    assert.deepEqual(homeRequests, [], 'empty global home makes no catalog or other CAD service requests');
    assert.deepEqual(errors, []);
  } catch (error) {
    throw new Error(`${String(error)}\nBrowser errors: ${errors.join('\n')}\nMCP stderr: ${stderr.slice(-3000)}\n${await page.frameLocator('iframe').locator('body').innerText()}`, { cause: error });
  }
});
