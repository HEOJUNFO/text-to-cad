import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Render the real shared tree surfaces with a tiny in-memory assembly. Geometry
// inference and viewport picking have separate contract tests; this exercises
// browser layout and scrolling, which jsdom cannot measure.
test('file and model trees share insets, the model tree in denser rows, while model disclosure, isolation and one-shot reveal remain independent', async t => {
  const { outputFiles } = await build({ stdin: {
    resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'jsx', contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ModelingTree from '../../../dist/renderers/step/components/workbench/ModelingTree.js';
import { FileTree } from '../../../dist/file-viewer/navigation/FileTree.js';
const leaves = Array.from({length:70}, (_, i) => ({id:'o'+i,nodeType:'part',displayName:'Part '+i,leafPartIds:['o'+i],children:[]}));
const group = {id:'group',nodeType:'assembly',displayName:'Subassembly',leafPartIds:['o0','o1'],children:leaves.slice(0,2)};
const root = {id:'__step_model__',nodeType:'assembly',displayName:'Document',leafPartIds:leaves.map(n=>n.id),children:[group,...leaves.slice(2)]};
// Seventy DIFFERENT parts: each its own component. One component placed seventy times under
// numbered names would fold into a single "Part (70)" row (foldRepeatedParts), and this spec is
// about seventy rows.
const descriptor = {components:Object.fromEntries(leaves.map(n=>['c'+n.id,{}])),occurrences:leaves.map(n=>({id:n.id,component:'c'+n.id,name:n.displayName}))};
const baseSource = {rootName:'Files',listings:{'':[{path:'part.step',name:'part.step',kind:'file'}]},load(){},revision:0,paths:async()=>['part.step'],platform:'linux',capabilities:new Set(),onAction(){}};
const events = {selected:[],requested:[]};
function App(){
 const [expanded,setExpanded]=useState([]),[files,setFiles]=useState(new Set()),[selected,setSelected]=useState([]),[hidden,setHidden]=useState([]),[focused,setFocused]=useState([]),[tick,setTick]=useState(0),[reveal,setReveal]=useState(0);
 const toggle=id=>setExpanded(current=>current.includes(id)?current.filter(n=>n!==id):[...current,id]);
 const choose=id=>{events.selected.push(id);setSelected([id]);};
 window.treeTest={events,refresh:()=>setTick(n=>n+1),select:id=>{setSelected([id]);setReveal(n=>n+1);},isolate:()=>{setExpanded(['group']);setFocused(['o0']);}};
 return <div style={{display:'flex',gap:20,padding:16}}>
  <section data-testid="files" style={{height:360,width:280}}><FileTree source={{...baseSource,expanded:files,setExpanded:setFiles}} activePath="part.step" onOpen={()=>{}}/></section>
  {/* As the tool stack holds it: a bounded column in which the Features panel gives way and scrolls, the Reference under it. */}
  <section data-testid="model" style={{height:360,width:320,display:'flex',flexDirection:'column',gap:8}}><ModelingTree active disabled={false}
    modeling={{descriptor,results:{},error:'',retryFailed(){}}} stepRoot={root} selectedPartIds={selected}
    activeTreeNodeScrollKey={reveal} onRequestRecognition={ids=>{events.requested=ids;}}
    partControls={{isAssemblyView:true,expandedTreeNodeIds:expanded,onToggleTreeNode:toggle,hiddenPartIds:hidden,
      focusedNodeIds:focused,selectableNodeIds:focused.length?['o0']:null,onSelectTreeNode:choose,
      onTogglePartVisibility:id=>setHidden(current=>current.includes(id)?current.filter(n=>n!==id):[...current,id]),
      showAllHiddenParts:()=>setHidden([]),onExitAllIsolate:()=>setFocused([])}}
    selectionDetails={selected.length?{title:'Ref',content:<p>Selected {selected[0]} ({tick})</p>}:null}/></section>
 </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic' });
  const css = await readFile(new URL('../../../dist/styles.css', import.meta.url));
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('content-type', 'text/javascript'); response.end(outputFiles[0].contents); }
    else if (request.url === '/styles.css') { response.setHeader('content-type', 'text/css'); response.end(css); }
    else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/app.js"></script>'); }
  });
  let browser;
  t.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const model = page.getByTestId('model');
  const part = model.getByRole('button', { name: 'Select Part 2', exact: true });
  await part.waitFor();
  assert.equal(await model.getByRole('button', { name: 'Select Document', exact: true }).count(), 0);
  const modelHeight = (await part.boundingBox()).height;
  const fileHeight = await page.getByTestId('files').locator('[data-path="part.step"]').evaluate(node => node.getBoundingClientRect().height);
  // The model tree is dense (24px rows, 11px text); the host's file tree keeps its 28px rows.
  assert.equal(modelHeight, 24);
  assert.equal(fileHeight, 28);
  assert.equal(await part.evaluate(node => getComputedStyle(node).fontSize), '11px');
  // Its disclosure column is 16px wide, a row tall.
  const disclosure = await model.getByRole('button', { name: 'Expand Subassembly', exact: true }).boundingBox();
  assert.deepEqual([disclosure.width, disclosure.height], [16, 24]);
  const modelInsets = await part.evaluate(node => {
    const row = node.parentElement.getBoundingClientRect();
    const list = node.closest('[aria-label="Model"]').parentElement;
    const bounds = list.getBoundingClientRect();
    return {left:row.left-bounds.left,right:bounds.left+list.clientWidth-row.right};
  });
  const fileInsets = () => page.getByTestId('files').locator('[data-path="part.step"]').evaluate(node => {
    const row = node.getBoundingClientRect();
    const list = node.closest('[role="tree"]');
    const bounds = list.getBoundingClientRect();
    return {left:row.left-bounds.left,right:bounds.left+list.clientWidth-row.right};
  });
  assert.deepEqual(modelInsets, {left:4,right:4});
  // Both trees scroll in the chrome's one scroll region, never a native scroller.
  for (const [name, scroller] of [['model', model.locator('[aria-label="Model"]')], ['files', page.getByTestId('files').getByRole('tree')]]) {
    assert.equal(await scroller.evaluate(node => Boolean(node.closest('[data-slot=scroll-area]'))), true, `the ${name} tree scrolls in a ScrollArea`);
  }
  // Its bar is the thin overlay one, shown while the pointer is over a region that overflows.
  await part.hover();
  const bar = model.locator('[data-slot=scroll-area-scrollbar][data-orientation=vertical]');
  await bar.waitFor();
  assert.ok((await bar.boundingBox()).width <= 8, 'a thin bar');
  assert.deepEqual(await fileInsets(), modelInsets, 'selected file rows must share the model tree horizontal inset');
  await page.getByTestId('files').getByRole('textbox', {name:'Filter files'}).fill('part');
  await page.getByTestId('files').getByRole('option').waitFor();
  assert.deepEqual(await fileInsets(), modelInsets, 'filtered rows retain the same horizontal inset');
  await page.getByTestId('files').getByRole('button', {name:'Clear filter'}).click();
  // A row's actions (Hide, Isolate) float over its right end rather than taking width from it: the
  // name runs the row's full width and fades out under them, with nothing drawn behind the buttons.
  await part.hover();
  const rowLayout = await part.evaluate(node => {
    const row = node.closest('li'), actions = row.querySelector('[data-row-actions]');
    const [name, box, own] = [node.getBoundingClientRect(), actions.getBoundingClientRect(), node.parentElement.getBoundingClientRect()];
    return { position: getComputedStyle(actions).position, blur: getComputedStyle(actions).backdropFilter, mask: getComputedStyle(node).maskImage, opacity: getComputedStyle(actions).opacity,
      nameRight: name.right, rowRight: own.right, actionsLeft: box.left, actionsRight: box.right };
  });
  assert.equal(rowLayout.position, 'absolute');
  assert.equal(rowLayout.blur, 'none', 'no backing behind the actions');
  assert.match(rowLayout.mask, /linear-gradient/, `the name fades out under the actions: ${JSON.stringify(rowLayout)}`);
  assert.ok(rowLayout.nameRight > rowLayout.actionsLeft, `the name runs under the actions: ${JSON.stringify(rowLayout)}`);
  assert.ok(Math.abs(rowLayout.actionsRight - rowLayout.rowRight) <= 1, `the actions sit at the row's right end: ${JSON.stringify(rowLayout)}`);
  const beforeHide = await part.boundingBox();
  await model.getByRole('button', { name: 'Hide Part 2', exact: true }).click();
  await model.getByRole('button', { name: 'Show all', exact: true }).waitFor();
  assert.equal((await part.boundingBox()).y, beforeHide.y, 'show/hide must not insert a header row');
  await model.getByRole('button', { name: 'Show all', exact: true }).click();
  await model.getByRole('button', { name: 'Expand Subassembly', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.treeTest.events.selected), [], 'disclosure must not select');
  await model.getByRole('button', { name: 'Select Part 0', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.treeTest.events.selected), ['o0']);
  assert.equal(await model.getByRole('button', { name: 'Select Part 0', exact: true }).evaluate(node => getComputedStyle(node).fontWeight), '400');
  await page.evaluate(() => window.treeTest.isolate());
  await page.waitForFunction(() => document.querySelector('[aria-label="Select Subassembly"]')?.disabled);
  assert.equal(await model.getByRole('button', { name: 'Select Part 0', exact: true }).isEnabled(), true, 'isolated descendant survives an excluded ancestor');
  assert.equal(await model.getByRole('button', { name: 'Select Part 1', exact: true }).isEnabled(), false);
  // Isolation says so at the top of the tree, and its Exit ends it.
  await model.getByRole('status', { name: 'Isolation' }).getByRole('button', { name: 'Exit', exact: true }).click();
  await page.evaluate(() => window.treeTest.select('o69'));
  const scrollPosition = () => page.evaluate(() => {
    const node = document.querySelector('[aria-label="Model"]').closest('[data-slot=scroll-area-viewport]');
    return node?.scrollTop;
  });
  await page.waitForFunction(() => {
    const node = document.querySelector('[aria-label="Model"]').closest('[data-slot=scroll-area-viewport]');
    return node?.scrollTop > 100;
  });
  await page.evaluate(() => {
    const node = document.querySelector('[aria-label="Model"]').closest('[data-slot=scroll-area-viewport]');
    node.scrollTop = 0;
    window.treeTest.refresh();
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await scrollPosition(), 0, 'ordinary rerenders must not lock scroll to the selection');
  await model.getByRole('button', { name: 'Collapse Subassembly', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await scrollPosition(), 0, 'other expansion changes must not repeat the reveal');

  // The Model search box: a flat ranked view sharing row sizing and insets with
  // the tree, whose hits can reach into a still-collapsed subassembly (Part 1 is
  // one of Subassembly's children, and Subassembly is collapsed from the step above).
  await model.getByRole('textbox', { name: 'Filter model' }).fill('part 1');
  const searchResults = model.locator('[aria-label="Model search results"]');
  await searchResults.waitFor();
  const firstRow = searchResults.locator('li[data-search-row]').first();
  const firstHit = firstRow.getByRole('button', { name: /^Select / });
  assert.equal(await firstHit.getAttribute('aria-label'), 'Select Part 1', 'query "part 1" must rank the nested Part 1 first');
  assert.equal((await firstHit.boundingBox()).height, 24, 'search hits are the tree\'s dense rows');
  const searchInsets = await firstHit.evaluate(node => {
    const row = node.parentElement.getBoundingClientRect();
    const list = node.closest('[aria-label="Model search results"]').parentElement;
    const bounds = list.getBoundingClientRect();
    return {left:row.left-bounds.left,right:bounds.left+list.clientWidth-row.right};
  });
  assert.deepEqual(searchInsets, modelInsets, 'search result rows retain the same horizontal inset as tree rows');
  await firstHit.click();
  assert.equal((await page.evaluate(() => window.treeTest.events.selected)).at(-1), 'o1');
  await model.getByRole('button', { name: 'Clear filter' }).click();
  await model.getByRole('button', { name: 'Collapse Subassembly', exact: true }).waitFor();
  assert.equal(await model.getByRole('button', { name: 'Select Part 1', exact: true }).getAttribute('aria-pressed'), 'true');

  assert.deepEqual(errors, []);
});

// A large assembly, every row open: the tree mounts only the rows in view (and a margin), yet
// lays out exactly as the whole tree would — the same total height, every row where it would
// sit — and a pick, a search cursor and the parts on screen under Faces all work through it.
test('a tree of thousands of rows mounts only the rows in view, laid out as the whole tree, and reveal, search, re-renders and topology requests hold', async t => {
  const GROUPS = 30, PARTS = 100;
  const { outputFiles } = await build({ stdin: {
    resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'jsx', contents: `
import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ModelingTree from '../../../dist/renderers/step/components/workbench/ModelingTree.js';
const groups = Array.from({length:${GROUPS}}, (_, g) => {
  const parts = Array.from({length:${PARTS}}, (_, i) => ({id:'o'+g+'_'+i,nodeType:'part',displayName:'Part '+g+'-'+i,leafPartIds:['o'+g+'_'+i],children:[]}));
  return {id:'g'+g,nodeType:'assembly',displayName:'Group '+g,leafPartIds:parts.map(p=>p.id),children:parts};
});
const leaves = groups.flatMap(g=>g.children);
const root = {id:'__step_model__',nodeType:'assembly',displayName:'Document',leafPartIds:leaves.map(n=>n.id),children:groups};
// Every part its own component, so no repeat folds rows away.
const descriptor = {components:Object.fromEntries(leaves.map(n=>['c'+n.id,{}])),occurrences:leaves.map(n=>({id:n.id,component:'c'+n.id,name:n.displayName}))};
const modeling = {descriptor,results:{},error:'',retryFailed(){}};
const events = {selected:[],topology:[]};
window.treeTest = {events, order:groups.flatMap(g=>['Group '+g.id.slice(1), ...g.children.map(p=>p.displayName)])};
function App(){
  const [selected,setSelected]=useState([]),[reveal,setReveal]=useState(0),[mode,setMode]=useState('all'),[tick,setTick]=useState(0),[details,setDetails]=useState(0);
  const expanded=useMemo(()=>groups.map(g=>g.id),[]);
  const partControls=useMemo(()=>({isAssemblyView:true,expandedTreeNodeIds:expanded,onToggleTreeNode(){},hiddenPartIds:[],focusedNodeIds:[],selectableNodeIds:null,
    onSelectTreeNode:id=>{events.selected.push(id);setSelected([id]);}}),[expanded]);
  const onLoadTopology=useMemo(()=>ids=>{events.topology.push(...ids);},[]);
  Object.assign(window.treeTest,{refresh:()=>setTick(n=>n+1),details:()=>setDetails(n=>n+1),select:id=>{setSelected([id]);setReveal(n=>n+1);},setMode});
  const selectionDetails=useMemo(()=>details?{title:'Ref',content:<p>Details {details}</p>}:null,[details]);
  return <section data-testid="model" data-tick={tick} style={{height:420,width:320,display:'flex',flexDirection:'column',gap:8,padding:16}}>
    <ModelingTree active disabled={false} mode={mode} modeling={modeling} stepRoot={root} selectedPartIds={selected}
      activeTreeNodeScrollKey={reveal} onLoadTopology={onLoadTopology} partControls={partControls} selectionDetails={selectionDetails}/>
  </section>;
}
createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic' });
  const css = await readFile(new URL('../../../dist/styles.css', import.meta.url));
  // Counts the renders of every row component, through React's own devtools hook.
  const hook = `<script>(() => {
    const counts = { ModelingRow: 0, ModelingSearchRow: 0, ModelingTree: 0 };
    window.__renders = counts;
    const nameOf = f => (f.type && (f.type.displayName || f.type.name)) || '';
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject() { return 1; }, checkDCE() {}, onScheduleFiberRoot() {},
      onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, setStrictMode() {},
      onCommitFiberRoot(_id, root) { const stack = [root.current];
        while (stack.length) { const f = stack.pop(); if (typeof f.type === 'function') { const n = nameOf(f);
          if (n in counts && (!f.alternate || f.alternate.memoizedProps !== f.memoizedProps)) counts[n]++; }
          if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling); } } };
  })();</script>`;
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('content-type', 'text/javascript'); response.end(outputFiles[0].contents); }
    else if (request.url === '/styles.css') { response.setHeader('content-type', 'text/css'); response.end(css); }
    else { response.setHeader('content-type', 'text/html'); response.end(`<!doctype html><link rel="stylesheet" href="/styles.css">${hook}<div id="root"></div><script type="module" src="/app.js"></script>`); }
  });
  let browser;
  t.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const model = page.getByTestId('model');
  await model.getByRole('button', { name: 'Select Part 0-0', exact: true }).waitFor();
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const order = await page.evaluate(() => window.treeTest.order);
  assert.equal(order.length, GROUPS * (PARTS + 1));
  // Where every mounted row is, against where the whole tree would put it: its place in the
  // tree order times the row height, and at that row's indent.
  const layout = () => page.evaluate(() => {
    const list = document.querySelector('[aria-label="Model"]'), scroller = list.closest('[data-tool-panel-body]');
    const top = list.getBoundingClientRect().top;
    return { listHeight: list.getBoundingClientRect().height, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, scrollTop: scroller.scrollTop,
      rows: [...list.querySelectorAll(':scope > li')].map(li => ({ label: li.querySelector('button[aria-pressed]').getAttribute('aria-label').replace(/^Select /, ''),
        top: li.getBoundingClientRect().top - top, height: li.getBoundingClientRect().height, level: li.getAttribute('aria-level') })) };
  });
  const check = (state, where) => {
    assert.equal(state.listHeight, order.length * 24, `${where}: the list is every row tall`);
    // The panel body holds the list and its 4px padding above and below: nothing else.
    assert.equal(state.scrollHeight, order.length * 24 + 8, `${where}: the scroll range is the whole tree's`);
    assert.ok(state.rows.length > 0 && state.rows.length <= 60, `${where}: ${state.rows.length} rows mounted`);
    for (const row of state.rows) {
      const at = order.indexOf(row.label);
      assert.equal(row.top, at * 24, `${where}: ${row.label} sits where the whole tree puts it`);
      assert.equal(row.height, 24);
      assert.equal(row.level, row.label.startsWith('Group') ? '1' : '2');
    }
    // What is on screen is mounted, contiguously.
    const first = Math.floor(state.scrollTop / 24), last = Math.min(order.length - 1, Math.floor((state.scrollTop + state.clientHeight) / 24));
    const mounted = new Set(state.rows.map(row => row.label));
    for (let at = first; at <= last; at += 1) assert.ok(mounted.has(order[at]), `${where}: ${order[at]} is on screen and mounted`);
  };
  check(await layout(), 'top');
  const indent = await model.getByRole('button', { name: 'Select Part 0-1', exact: true }).evaluate(node => node.parentElement.style.paddingLeft);
  assert.equal(indent, '12px', 'a part under its group is indented one level');
  for (const fraction of [0.37, 0.5, 0.999, 0.02]) {
    await page.evaluate(fraction => { const scroller = document.querySelector('[aria-label="Model"]').closest('[data-tool-panel-body]'); scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * fraction; }, fraction);
    await frames();
    check(await layout(), `scrolled to ${fraction}`);
  }

  // A parent re-rendered with the same props renders nothing; one that changes only the details
  // renders the tree, but not one row.
  await frames();
  const before = await page.evaluate(() => ({ ...window.__renders }));
  assert.ok(before.ModelingRow > 0 && before.ModelingTree > 0, `the counts see the rows and the tree: ${JSON.stringify(before)}`);
  await page.evaluate(() => window.treeTest.refresh()); await frames();
  const same = await page.evaluate(() => ({ ...window.__renders }));
  assert.deepEqual([same.ModelingTree - before.ModelingTree, same.ModelingRow - before.ModelingRow], [0, 0], 'unchanged props: no tree or row render');
  await page.evaluate(() => window.treeTest.details()); await frames();
  const detailed = await page.evaluate(() => ({ ...window.__renders }));
  assert.ok(detailed.ModelingTree > same.ModelingTree, 'the tree rendered for its details');
  assert.equal(detailed.ModelingRow - same.ModelingRow, 0, 'and no row did');

  // A pick far down the tree scrolls its row into view.
  await page.evaluate(() => { document.querySelector('[aria-label="Model"]').closest('[data-tool-panel-body]').scrollTop = 0; });
  await frames();
  await page.evaluate(() => window.treeTest.select('o27_93'));
  await page.waitForFunction(() => {
    const row = document.querySelector('[aria-label="Select Part 27-93"]'), scroller = document.querySelector('[aria-label="Model"]')?.closest('[data-tool-panel-body]');
    if (!row || !scroller) return false;
    const box = row.getBoundingClientRect(), view = scroller.getBoundingClientRect();
    return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
  });
  assert.equal(await model.getByRole('button', { name: 'Select Part 27-93', exact: true }).getAttribute('aria-pressed'), 'true');
  await frames();
  check(await layout(), 'revealed');

  // Search: two hundred ranked hits in the same rows; the cursor walks them from the keyboard,
  // each step in view, and Enter selects the hit under it.
  const search = model.getByRole('textbox', { name: 'Filter model' });
  await search.fill('part 1');
  const results = model.locator('[aria-label="Model search results"]');
  await results.waitFor();
  const hits = await results.evaluate(list => ({ height: list.getBoundingClientRect().height, mounted: list.querySelectorAll(':scope > li').length }));
  assert.equal(hits.height, 200 * 24, 'every hit is a row of the list');
  assert.ok(hits.mounted <= 60, `${hits.mounted} hits mounted`);
  await search.focus();
  for (let step = 0; step < 45; step += 1) await page.keyboard.press('ArrowDown');
  await frames();
  const cursor = await results.evaluate(list => {
    const rows = [...list.querySelectorAll(':scope > li')];
    const row = rows.find(li => li.firstElementChild?.classList.contains('bg-accent/30'));
    const scroller = list.closest('[data-tool-panel-body]'), box = row.getBoundingClientRect(), view = scroller.getBoundingClientRect();
    return { id: row.dataset.searchRow, top: box.top - list.getBoundingClientRect().top, visible: box.top >= view.top - 1 && box.bottom <= view.bottom + 1 };
  });
  assert.equal(cursor.top, 45 * 24, 'the cursor is the 46th hit');
  assert.ok(cursor.visible, 'and it is in view');
  await page.keyboard.press('Enter');
  assert.equal(`model:${(await page.evaluate(() => window.treeTest.events.selected)).at(-1)}`, cursor.id, 'Enter selects the hit under the cursor');
  await search.fill('');
  await model.locator('[aria-label="Model"]').waitFor();

  // Under Faces, the parts whose rows are on screen ask for their topology, once each, and a
  // scroll asks for the parts it brings on screen.
  await page.evaluate(() => { document.querySelector('[aria-label="Model"]').closest('[data-tool-panel-body]').scrollTop = 0; window.treeTest.events.topology.length = 0; window.treeTest.setMode('faces'); });
  await page.waitForFunction(() => window.treeTest.events.topology.length > 0);
  await frames();
  const onScreen = async () => page.evaluate(() => {
    const scroller = document.querySelector('[aria-label="Model"]').closest('[data-tool-panel-body]'), view = scroller.getBoundingClientRect();
    return [...document.querySelectorAll('[aria-label="Model"] > li[data-tree-part]')].filter(li => { const box = li.getBoundingClientRect(); return box.bottom > view.top && box.top < view.bottom; })
      .map(li => li.dataset.treePart.replace(/^model:/, ''));
  });
  const firstScreen = await onScreen();
  assert.deepEqual([...(await page.evaluate(() => window.treeTest.events.topology))].sort(), [...firstScreen].sort(), 'the parts on screen, and only those');
  await page.evaluate(() => { const scroller = document.querySelector('[aria-label="Model"]').closest('[data-tool-panel-body]'); scroller.scrollTop = scroller.scrollHeight / 2; });
  await frames(); await frames();
  const secondScreen = await onScreen();
  const requested = await page.evaluate(() => window.treeTest.events.topology);
  assert.equal(new Set(requested).size, requested.length, 'no part is asked for twice');
  assert.deepEqual([...requested].sort(), [...new Set([...firstScreen, ...secondScreen])].sort(), 'the scroll asked for what it brought on screen');
  await page.evaluate(() => window.treeTest.refresh()); await frames();
  assert.equal((await page.evaluate(() => window.treeTest.events.topology)).length, requested.length, 'a re-render asks for nothing');
  assert.deepEqual(errors, []);
});
