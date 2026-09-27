import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PNG } from 'pngjs';
import { serveStepHarness } from '../harness/stepScenario.mjs';
import { TOOL_STACK_DEFAULT_WIDTH } from '../../../dist/renderers/kit/tools/toolStackLayout.js';

// The STEP renderer end to end in a real browser, over the committed two-part
// fixture (`__fixtures__/step`): a coloured base with a bore, a coloured arm, one
// revolute mate, one named pose and one routine. Everything under `renderers/step`
// serves STEP alone, and none of it had a browser test until this one — written
// against the renderer as it is, so the move onto the shared shell has a net.
//
// The rule these assertions are built on: a claim that something REACHED THE
// SCREEN reads the drawn frame — a screenshot of the live canvas — never
// `controller.capture()`, which renders a fresh frame before reading and so
// cannot see a missing repaint.

let harness;
const cleanups = [];
before(async () => { harness = await serveStepHarness({ after: cleanup => cleanups.push(cleanup) }); });
after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
/** The last thing the viewport actually DREW. */
const frame = async (pane) => { await settle(pane.page()); return PNG.sync.read(await pane.locator('[aria-busy] > div > canvas').first().screenshot({ style: '[data-slot=popover-content], [data-slot=dropdown-menu-content], [data-slot=dropdown-menu-sub-content], [data-cad-tool-groups] { visibility: hidden !important; }' })); };
// A canvas screenshot also catches what is drawn OVER the canvas: the tool strip
// along the top, the tool stack's panels under it (hidden for the shot: they change with
// every tool and selection) and the view cube in the bottom-right corner. None is the
// model, so every measurement of the picture is taken in the band between them.
const MODEL = { y0: 55, y1: 570 };
function differing(left, right, { x0 = 0, y0 = 0, x1 = left.width, y1 = left.height } = MODEL) {
  let count = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const offset = (y * left.width + x) * 4;
    if ([0, 1, 2].some(channel => Math.abs(left.data[offset + channel] - right.data[offset + channel]) > 2)) count += 1;
  }
  return count;
}
/** How many pixels of a region are not the backdrop: what is drawn there. */
function painted(image, { x0 = 0, y0 = 0, x1 = image.width, y1 = image.height } = MODEL) {
  const backdrop = [image.data[0], image.data[1], image.data[2]];
  let count = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const offset = (y * image.width + x) * 4;
    if ([0, 1, 2].reduce((sum, channel) => sum + Math.abs(image.data[offset + channel] - backdrop[channel]), 0) > 12) count += 1;
  }
  return count;
}
const coverage = image => painted(image) / (image.width * (MODEL.y1 - MODEL.y0));
/**
 * Where each part is ON SCREEN, by its own colour: the base is authored blue
 * (#3A6EA5) and the arm orange (#D9772B), so a shaded pixel still belongs to
 * exactly one of them. This is what makes "the parts moved apart" a measurement
 * rather than a guess about total ink.
 */
function partBoxes(image) {
  const boxes = { base: null, arm: null };
  for (let y = MODEL.y0; y < MODEL.y1; y += 1) for (let x = 0; x < image.width; x += 1) {
    const offset = (y * image.width + x) * 4;
    const [red, green, blue] = [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
    if (red + green + blue < 40) continue;
    const part = blue > red + 25 && blue > green + 10 ? 'base' : red > blue + 25 && red > green + 10 ? 'arm' : '';
    if (!part) continue;
    const box = boxes[part] || (boxes[part] = { x0: x, x1: x, y0: y, y1: y, count: 0 });
    box.x0 = Math.min(box.x0, x); box.x1 = Math.max(box.x1, x);
    box.y0 = Math.min(box.y0, y); box.y1 = Math.max(box.y1, y);
    box.count += 1;
  }
  return boxes;
}
/** World point -> page coordinates, from the camera the viewport publishes. */
function projector(camera, box) {
  const sub = (a, b) => a.map((value, index) => value - b[index]);
  const norm = vector => { const length = Math.hypot(...vector); return vector.map(value => value / length); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const forward = norm(sub(camera.target, camera.position));
  const right = norm(cross(forward, camera.up));
  const up = cross(right, forward);
  const halfWidth = camera.halfHeight * (box.width / box.height);
  return point => {
    const offset = sub(point, camera.target);
    return [box.x + (dot(offset, right) / halfWidth * 0.5 + 0.5) * box.width,
      box.y + (0.5 - dot(offset, up) / camera.halfHeight * 0.5) * box.height];
  };
}
const translations = page => page.evaluate(() => Object.fromEntries(window.__cadDisplayRecords().map(record => [record.partId, record.matrix.slice(12, 15)])));
/**
 * A label and its control on one line, measured where they are drawn: the label to the left of
 * its control, their centres level, and the control running to the panel's right edge.
 */
async function assertPairedRow(section, label, control) {
  const [sectionBox, labelBox, controlBox] = await Promise.all([
    section.locator('[data-tool-panel-body]').boundingBox(), section.getByText(label, { exact: true }).boundingBox(), control.boundingBox()]);
  assert.ok(labelBox.x + labelBox.width <= controlBox.x, 'the label sits beside its control');
  assert.ok(Math.abs((labelBox.y + labelBox.height / 2) - (controlBox.y + controlBox.height / 2)) <= 2, 'on one line');
  assert.ok(sectionBox.x + sectionBox.width - (controlBox.x + controlBox.width) <= 12,
    `and the control is right-aligned: ${JSON.stringify({ sectionBox, controlBox })}`);
}
/**
 * The drawn frame once it satisfies `reached`, or a failure naming what it never
 * did. A repaint can land a frame or two after the state that asked for it, so a
 * single shot is a race; a poll that runs out is still the missing-repaint bug.
 */
async function frameWhen(view, reached, what) {
  let last;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    last = await view.frame();
    if (reached(last)) return last;
    await view.page.waitForTimeout(200);
  }
  throw new assert.AssertionError({ message: `the drawn frame never ${what}`, actual: false, expected: true, operator: '==' });
}

async function open(options) {
  const view = await harness.open(options);
  const { page, pane } = view;
  await pane.locator('[aria-busy="false"] > div > canvas').first().waitFor();
  await page.waitForFunction(() => window.cadHarness.a.controller?.readState().loading === false);
  // A STEP opens in Select, so its Features panel is in the tool stack before anything is
  // located on screen. The stack floats over the viewport: it never narrows it.
  await pane.getByRole('region', { name: 'Features', exact: true }).waitFor();
  // The world axes are drawn into the same canvas and the X one is the red the
  // arm is authored in, so they would answer to a question about the arm's pixels.
  await page.evaluate(() => window.cadHarness.a.controller.setDisplaySettings({ axes: { enabled: false } }));
  await page.waitForTimeout(400);
  await settle(page);
  const box = await pane.locator('[data-cad-surface] canvas').first().boundingBox();
  return {
    ...view, box,
    at: projector(await page.evaluate(() => window.__cadCamera()), box),
    state: () => page.evaluate(() => window.cadHarness.a.controller.readState()),
    display: patch => page.evaluate(next => window.cadHarness.a.controller.setDisplaySettings(next), patch),
    // Display is not a tool: its settings button sits beside Fullscreen at the viewport's top right.
    tool: name => name === 'Display' ? pane.getByRole('button', { name: 'Display settings', exact: true })
      : pane.locator(name === 'Reset' ? '[data-cad-camera-controls]' : '[data-cad-toolbar]').getByRole('button', { name, exact: true }),
    tools: () => pane.locator('[data-cad-toolbar]').getByRole('button')
      .evaluateAll(buttons => buttons.map(button => `${button.getAttribute('aria-label')}:${button.getAttribute('aria-pressed')}`)),
    // The nav row's panel toggles, in order, each with whether its panel is the open one. A STEP
    // declares none of its own: the file tree's is the only one.
    panels: () => pane.locator('[data-file-panel]')
      .evaluateAll(buttons => buttons.map(button => `${button.getAttribute('aria-label')}:${button.getAttribute('aria-pressed')}`)),
    toggle: id => id === 'cad-display' ? pane.getByRole('button', { name: 'Display settings', exact: true }) : pane.locator(`[data-file-panel="${id}"]`),
    // The tool stack's panels on screen, top to bottom, by their accessible names.
    stack: () => pane.locator('[data-cad-tool-stack] [data-tool-panel]').evaluateAll(panels => panels
      .filter(panel => panel.getClientRects().length > 0).map(panel => panel.getAttribute('aria-label'))),
    // The Select tool's mode, as its button draws it.
    selectMode: () => pane.locator('[data-cad-toolbar]').getByRole('button', { name: 'Select', exact: true }).locator('[data-select-mode]').getAttribute('data-select-mode'),
    // Select's modes are a menu in the Features filter row (`SelectionModes.jsx`); the strip opens no menu.
    chooseSelectMode: async name => {
      // The mode menu steps aside while the filter box has focus.
      await page.evaluate(() => document.activeElement instanceof HTMLInputElement && document.activeElement.blur());
      await pane.getByRole('button', { name: /^Select mode: / }).click();
      await page.locator('[role=menu][aria-label="Select mode"]').getByRole('menuitemradio', { name, exact: true }).click();
      await page.locator('[role=menu]').waitFor({ state: 'detached' });
    },
    section: name => pane.getByRole('region', { name, exact: true }),
    // Display's settings: a popover, portaled out of the viewer.
    displayPanel: () => page.locator('[data-display-popover]'),
    rows: () => pane.locator('[aria-label="Modeling tree"]').getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))
      .filter(label => label?.startsWith('Select ') || label?.startsWith('Expand ') || label?.startsWith('Collapse '))),
    frame: () => frame(pane),
    // What the pointer looks like over the model. Read from the INTERACTIVE
    // canvas: a tool sets the cursor on the viewport host and the canvas
    // inherits it, which three's OrbitControls used to break by pinning
    // `cursor: auto` on the canvas inline (`kit/viewport/useViewerRuntime.js`).
    cursor: () => page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="one"] [aria-busy] > div > canvas')).cursor),
    waitCursor: value => page.waitForFunction(wanted => getComputedStyle(
      document.querySelector('[data-testid="one"] [aria-busy] > div > canvas')).cursor === wanted, value),
  };
}


test('a STEP opens in Select with the tools its sidecar earns and Display last, its Features in the tool stack, and paints both authored colours', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  assert.deepEqual(await view.tools(), ['Select:true', 'Draw:false', 'Measure:false', 'Explode:false', 'Clip:false', 'Position:false', 'Animate:false'],
    'Position and Animate because the sidecar bound; Display, an independent settings popover, is the last button');
  // The nav row has no panel of the file's: its controls are the tool stack's. The file tree's
  // toggle is the only one, and a file opened directly opens with nothing beside it.
  assert.deepEqual(await view.panels(), ['Show files:false']);
  assert.equal(await pane.locator('[data-file-panel-container]').count(), 0, 'no panel column beside the file');
  assert.equal(await view.displayPanel().count(), 0, 'Display is never where a file opens');
  // Select is the tool, so the stack shows its Features: no tabs, and nothing of Position's.
  assert.deepEqual(await view.stack(), ['Features']);
  assert.equal(await pane.getByRole('tab').count(), 0, 'no tabs anywhere');
  assert.equal(await pane.getByRole('combobox', { name: 'Pose', exact: true }).isVisible(), false);
  const [stack, toolbar] = await Promise.all([pane.getByRole('region', { name: 'Features', exact: true }).boundingBox(),
    pane.locator('[data-cad-toolbar]').boundingBox()]);
  assert.ok(Math.abs(stack.x - toolbar.x) <= 1 && stack.y >= toolbar.y + toolbar.height, 'Features hangs under the toolbar, at its left edge');
  // The stack floats over the viewport: the canvas is the viewer's whole width.
  assert.equal(view.box.width, (await pane.locator('[data-cad-scene-backdrop]').boundingBox()).width);
  const opened = await view.frame();
  assert.ok(coverage(opened) > 0.2, `the opening frame is the model: ${coverage(opened)}`);
  const boxes = partBoxes(opened);
  assert.ok(boxes.base?.count > 2000 && boxes.arm?.count > 1000, `both parts are drawn, each in its own colour: ${JSON.stringify(boxes)}`);
  assert.deepEqual(await view.rows(), ['Expand base', 'Select base', 'Expand arm', 'Select arm']);
  // Its cap is half the stack's own height (the area under the strip), and a cap is never a
  // floor: two rows are two rows tall.
  const featuresPanel = pane.getByRole('region', { name: 'Features', exact: true });
  const stackHeight = await pane.locator('[data-cad-tool-stack]').evaluate(node => node.clientHeight);
  const fit = await featuresPanel.evaluate(node => ({ cap: node.style.maxHeight, height: node.getBoundingClientRect().height,
    rows: node.querySelector('[data-tool-panel-body]').scrollHeight, filter: node.querySelector('[data-slot=tree-filter]').getBoundingClientRect().height }));
  assert.equal(fit.cap, `${Math.round(stackHeight / 2)}px`, 'the tree opens capped at half the stack');
  assert.ok(Math.abs(fit.height - (fit.filter + fit.rows + 2)) <= 1, `and is its filter row and its rows: ${JSON.stringify(fit)}`);
  // It folds to its filter row by the chevron at that row's end, and unfolds as it was.
  // (Recognition is unavailable in this harness: a part opens onto one supplied feature.)
  await page.evaluate(() => {
    window.Worker = class {
      constructor(url) { if (!String(url).includes('modelingTree.worker')) throw new Error('No worker'); }
      postMessage() { queueMicrotask(() => this.onmessage?.({ data: { tree: [{
        id: 'feature:box', kind: 'extrude', label: 'Box', faces: [1, 2, 3], edges: [1], children: [], complete: true
      }] } })); }
      terminate() {}
    };
  });
  await pane.getByRole('button', { name: 'Expand base', exact: true }).click();
  await pane.getByRole('button', { name: 'Select Box', exact: true }).waitFor();
  await pane.getByRole('button', { name: 'Collapse base', exact: true }).waitFor();
  const openedRows = await view.rows();
  const fold = featuresPanel.locator('[data-slot=tree-filter]').getByRole('button', { name: 'Collapse features', exact: true });
  assert.equal(await fold.locator('[data-chevron]').getAttribute('data-chevron'), 'up', 'open: the chevron points up, to fold');
  await fold.click();
  assert.equal(await pane.locator('[aria-label="Modeling tree"]').isVisible(), false);
  const foldedBox = await featuresPanel.boundingBox();
  assert.ok(Math.abs(foldedBox.height - fit.filter - 2) <= 1, 'folded to its filter row');
  assert.equal(await pane.getByRole('textbox', { name: 'Filter model', exact: true }).isVisible(), true);
  const unfold = featuresPanel.getByRole('button', { name: 'Expand features', exact: true });
  assert.deepEqual([await unfold.getAttribute('aria-expanded'), await unfold.locator('[data-chevron]').getAttribute('data-chevron')], ['false', 'down'],
    'folded: the chevron points down, to open');
  // Pulling the folded panel's bottom edge down opens it again, at the height it is pulled to.
  const handle = await pane.getByRole('separator', { name: 'Resize features', exact: true }).boundingBox();
  assert.ok(Math.abs(handle.y + handle.height / 2 - (foldedBox.y + foldedBox.height)) <= 1, 'the height handle stays on the folded edge');
  await page.mouse.move(handle.x + 40, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 40, handle.y + handle.height / 2 + 200, { steps: 8 });
  await page.mouse.up();
  await featuresPanel.getByRole('button', { name: 'Collapse features', exact: true }).waitFor();
  assert.deepEqual(await view.rows(), openedRows, 'the tree kept its expansion while folded');
  assert.ok(Math.abs(await page.evaluate(() => window.cadHarness.preferences.getSnapshot().toolStack.heights.tree) - (foldedBox.height + 200)) <= 1,
    'and its cap is that height');
  await page.evaluate(width => window.cadHarness.preferences.update({ toolStack: { width, heights: {}, collapsed: {} } }), TOOL_STACK_DEFAULT_WIDTH);
  assert.deepEqual(errors, []);
});

test('Select picks parts and faces, a selection lives only under Select, and the Reference panel measures what is picked', async () => {
  const view = await open();
  const { page, pane, at, errors } = view;
  const reference = pane.getByRole('region', { name: 'Reference details', exact: true });

  // Hover lights the part under the pointer, and lets go when it leaves.
  const still = await view.frame();
  await page.mouse.move(...at([6, 6, 5]));
  // Over a part the pointer says it can be picked; over the backdrop it does not.
  await view.waitCursor('pointer');
  await frameWhen(view, shot => differing(still, shot) > 2000, 'lit the hovered part');
  await page.mouse.move(view.box.x + 20, view.box.y + view.box.height - 20);
  await view.waitCursor('auto');
  assert.equal(differing(still, await view.frame()), 0, 'and is exactly as it was once the pointer leaves');

  // No Reference until something is picked: it comes with the selection.
  assert.deepEqual(await view.stack(), ['Features']);
  await page.mouse.click(...at([6, 6, 5]));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.length === 1);
  assert.deepEqual((await view.state()).selectedPartIds, ['o1.1']);
  // Headed by the part's name; the id is a row, what a copy carries.
  assert.match((await reference.innerText()).replace(/\s+/g, ' '), /^base .*Type Component.*ID o1\.1.*Size 20 × 20 × 10 mm.*Color #3A6EA5/);
  assert.equal(await reference.locator('[data-reference-count]').count(), 0, 'one reference has no i/N');
  // Compact rows in the panel's one face: every value is the UI font at the panel's size, never
  // monospace; and a component's facts fit the panel's default height without scrolling. (At the
  // stack's narrow default width a long value wraps; a person who widens it gets one line a fact.)
  await page.evaluate(() => window.cadHarness.preferences.update({ toolStack: { width: 240, heights: {}, collapsed: {} } }));
  await page.waitForFunction(() => document.querySelector('[data-testid="one"] [aria-label="Reference details"]')?.getBoundingClientRect().width === 240);
  const faces = await reference.locator('[data-tool-panel-body] *').evaluateAll(nodes => [...new Set(nodes
    .filter(node => !node.childElementCount && node.textContent.trim())
    .map(node => `${getComputedStyle(node).fontFamily} | ${getComputedStyle(node).fontSize}`))]);
  assert.equal(faces.length, 1, `one face and size: ${faces.join(' / ')}`);
  assert.doesNotMatch(faces[0], /mono/i);
  assert.match(faces[0], /\| 11px$/);
  const rowHeights = await reference.locator('[data-info-row]').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
  assert.ok(rowHeights.length >= 4 && rowHeights.every(height => height <= 19), `compact rows: ${rowHeights}`);
  assert.equal(await reference.locator('[data-tool-panel-body]').evaluate(body => body.scrollHeight <= body.clientHeight), true, 'a component fits without scrolling');
  // The Reference is the next panel of the stack, under Features, the stack's width.
  assert.deepEqual(await view.stack(), ['Features', 'Reference details']);
  const [features, pinned] = await Promise.all([pane.getByRole('region', { name: 'Features', exact: true }).boundingBox(), reference.boundingBox()]);
  assert.ok(pinned.y >= features.y + features.height && pinned.y - (features.y + features.height) <= 10, `directly under Features: ${pinned.y} vs ${features.y + features.height}`);
  assert.equal(pinned.width, features.width, 'the width of every stack item');
  // The Features filter row is a heading's height, dense: its buttons sit exactly where a heading's
  // do, 5px down from their panel's top.
  const featuresPanel = pane.getByRole('region', { name: 'Features', exact: true });
  const [chevron, clear] = await Promise.all([featuresPanel.getByRole('button', { name: 'Collapse features', exact: true }).boundingBox(),
    reference.getByRole('button', { name: 'Clear selection', exact: true }).boundingBox()]);
  assert.equal(Math.round(chevron.y - features.y), 5, 'the filter row\'s chevron');
  assert.equal(Math.round(clear.y - pinned.y), 5, 'the Reference heading\'s X');
  assert.equal(chevron.height, clear.height);
  assert.equal(await pane.getByRole('textbox', { name: 'Filter model', exact: true }).evaluate(node => getComputedStyle(node).fontSize), '11px');
  assert.equal(await pane.getByRole('button', { name: 'Select base', exact: true }).getAttribute('aria-pressed'), 'true', 'the tree row follows the viewport');
  await page.keyboard.down('Shift');
  await page.mouse.click(...at([15, 0, 4]));
  await page.keyboard.up('Shift');
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.length === 2);
  // Two references: the heading is a picker, the browsed one's name and its place, and no count line.
  const picker = reference.getByRole('combobox', { name: 'Inspect selected reference' });
  assert.match((await picker.innerText()).replace(/\s+/g, ' '), /^arm 2\/2$/);
  // Its text is flush with the rows' labels.
  const [nameBox, labelBox] = await Promise.all([picker.locator('[data-reference-label] > span').first().boundingBox(),
    reference.getByText('Type', { exact: true }).boundingBox()]);
  assert.ok(Math.abs(nameBox.x - labelBox.x) <= 1, `the picker's text aligns with the row labels: ${nameBox.x} vs ${labelBox.x}`);
  // Hovering it is quiet in either theme — no fill — and moves nothing in the heading.
  for (const dark of [false, true]) {
    await page.evaluate(on => document.documentElement.classList.toggle('dark', on), dark);
    await page.mouse.move(view.box.x + view.box.width - 40, view.box.y + 40);
    const [still, stillName] = await Promise.all([picker.boundingBox(), picker.locator('[data-reference-label]').boundingBox()]);
    await picker.hover();
    await page.waitForTimeout(150);
    assert.equal(await picker.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)', `no hover fill (${dark ? 'dark' : 'light'})`);
    assert.deepEqual([await picker.boundingBox(), await picker.locator('[data-reference-label]').boundingBox()], [still, stillName], 'hovering moves nothing');
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  assert.doesNotMatch(await reference.innerText(), /Selection ·|references|Total/);
  // The bottom action is the Select tool’s: it copies, and says what in words, never the IDs.
  await pane.getByRole('button', { name: /^Copy References/ }).waitFor();
  assert.equal(await pane.getByRole('button', { name: /^Copy Reference\b/ }).count(), 0, 'one action, pluralised');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.length === 0);

  // A selection exists only under Select, and so do its panels: another tool takes both away,
  // and Select brings the tree back as it was.
  await page.mouse.click(...at([6, 6, 5]));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.length === 1);
  await view.tool('Measure').click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.length === 0);
  assert.deepEqual(await view.stack(), ['Measure controls'], 'Measure shows its own panel: no Features and no Reference');
  await view.tool('Select').click();
  assert.deepEqual(await view.stack(), ['Features']);
  await pane.getByRole('button', { name: 'Select arm', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.length === 1);
  assert.deepEqual((await view.state()).selectedPartIds, ['o1.2']);
  // The Reference's X clears the selection, and the panel goes with it.
  await reference.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.length === 0);
  assert.deepEqual(await view.stack(), ['Features']);

  // What the host can drive: selectors in, selection out, and a clear.
  await page.evaluate(() => window.cadHarness.a.controller.select({ selectors: ['o1.2'] }));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.join() === 'o1.2');
  const live = await view.state();
  assert.deepEqual([live.selectedReferenceIds, live.hiddenPartIds, live.isolatedPartIds], [[], [], []]);
  // The selection in the prompt grammar the live contract reads (what `viewer-state` hands an
  // agent): a selector of the document on screen, never the renderer's own copy vocabulary.
  assert.deepEqual(live.selection, [{ resource: live.resource, target: { kind: 'cad-selector', selectors: ['o1.2'] }, label: 'arm' }]);
  await page.evaluate(() => window.cadHarness.a.controller.clearSelection());
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.length === 0);
  // And what it delivers: the snapshot carries the file, the references carry the selection.
  await page.evaluate(() => window.cadHarness.a.controller.select({ selectors: ['o1.1'] }));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.length === 1);
  await pane.getByRole('button', { name: 'Take snapshot', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.captures.length === 1);
  const captured = await page.evaluate(() => window.cadHarness.captures[0]);
  assert.equal(captured.type, 'image/png');
  assert.ok(captured.size > 100);
  assert.deepEqual(captured.references.map(reference => reference.target),
    [{ kind: 'cad-selector', selectors: ['o1.1'] }], 'the snapshot carries the selection as its references');
  assert.deepEqual(errors, []);
});

test('the Select tool has four modes with their own icons, a menu in the Features filter row: each sets the tree, locked, and the connected options are the ones that apply', async () => {
  const view = await open();
  const { page, pane, at, errors } = view;
  // Recognition is unavailable in this harness: supply one feature per part, so what the tree
  // shows under a part (and whether a part can open at all) does not hang on a failed worker.
  await page.evaluate(() => {
    window.Worker = class {
      constructor(url) { if (!String(url).includes('modelingTree.worker')) throw new Error('No worker'); }
      postMessage() { queueMicrotask(() => this.onmessage?.({ data: { tree: [{
        id: 'feature:box', kind: 'extrude', label: 'Box', faces: [1, 2, 3], edges: [1], children: [], complete: true
      }] } })); }
      terminate() {}
    };
  });
  // Select's mode is one button in the Features filter row, beside the fold chevron, showing
  // the mode in hand; its menu holds the modes and the options. The strip opens no menu, and
  // the modes are never a panel of their own.
  const features = pane.getByRole('region', { name: 'Features', exact: true });
  const modeButton = features.getByRole('button', { name: /^Select mode: / });
  const menu = page.locator('[role=menu][aria-label="Select mode"]');
  const openMenu = async () => { await modeButton.click(); await menu.waitFor(); };
  const options = () => menu.getByRole('menuitemcheckbox').evaluateAll(items => items.map(item => `${item.textContent}${item.getAttribute('aria-checked') === 'true' ? '*' : ''}`));
  // Locked rows: the chevron a row shows while the mode holds the tree, open or shut.
  const locks = () => pane.locator('[aria-label="Modeling tree"] [data-disclosure-locked]').evaluateAll(marks => marks.map(mark => mark.dataset.disclosureLocked));
  assert.deepEqual(await view.stack(), ['Features'], 'no panel for the modes');
  assert.deepEqual(await features.locator('[data-slot=tree-filter] button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))),
    ['Select mode: All', 'Collapse features'], 'the mode button sits beside the fold chevron');
  // All is the plain pointer, and the tree is the person's own: open the base.
  assert.equal(await view.selectMode(), 'all');
  await pane.getByRole('button', { name: 'Expand base', exact: true }).click();
  // Opening a part loads its topology, so its feature follows once recognised.
  await pane.getByRole('button', { name: 'Select Box', exact: true }).waitFor();
  assert.deepEqual(await view.rows(), ['Collapse base', 'Select base', 'Select Box', 'Expand arm', 'Select arm']);
  await openMenu();
  assert.deepEqual(await menu.getByRole('menuitemradio').allInnerTexts(), ['All', 'Parts', 'Faces', 'Edges'], 'an assembly offers Parts');
  assert.deepEqual(await options(), ['Group edges', 'Group faces'], 'under All both connected options apply, after the modes');
  // A row shows its mode's own glyph at full size (All: the pointer); the strip shows the pointer
  // badged in its corner with the mode's glyph, and the bare pointer for All.
  const glyphs = root => root.locator('svg[data-mode-glyph]').evaluateAll(icons => icons.map(icon => icon.dataset.modeGlyph));
  const badges = root => root.locator('svg[data-tool-icon-base]').evaluateAll(icons => icons.map(icon =>
    `${icon.dataset.toolIconBase}:${icon.querySelector('[data-tool-icon-badge]')?.dataset.toolIconBadge ?? ''}`));
  assert.deepEqual(await glyphs(menu), ['select', 'parts', 'faces', 'edges']);
  assert.deepEqual(await badges(menu), [], 'no composite in the menu');
  assert.deepEqual(await badges(view.tool('Select')), ['select:'], 'the strip\'s composite: the bare pointer under All');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  await view.tool('Select').click();
  assert.equal(await view.tool('Select').getAttribute('aria-pressed'), 'true', 'a second press keeps Select');
  assert.equal(await page.locator('[role=menu]').count(), 0, 'and opens nothing');

  // Parts: every part a row, none open, and nothing opens.
  await view.chooseSelectMode('Parts');
  assert.equal(await view.selectMode(), 'parts', 'the strip shows the mode in hand');
  assert.equal(await modeButton.getAttribute('aria-label'), 'Select mode: Parts', 'and so does the button');
  assert.equal(await modeButton.locator('svg.lucide-sliders-horizontal').count(), 1, 'the button is the sliders icon; the strip shows the mode');
  assert.deepEqual(await badges(view.tool('Select')), ['select:parts']);
  await openMenu();
  assert.deepEqual(await options(), [], 'a part pick grows by nothing: no options');
  await page.keyboard.press('Escape');
  assert.deepEqual(await view.rows(), ['Select base', 'Select arm'], 'no disclosure to press, and no feature under a part');
  assert.deepEqual(await locks(), ['shut', 'shut']);
  // Nothing names the mode under the strip: the icon does.
  assert.equal(await pane.locator('[data-cad-toolbar]').innerText(), '');
  await page.mouse.click(...at([15, 0, 4]));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.join() === 'o1.2');
  await page.keyboard.press('Escape');

  // Faces: everything open and locked, and each part's faces are loaded as its row shows.
  await view.chooseSelectMode('Faces');
  assert.equal(await view.selectMode(), 'faces');
  // Each part's features, shown as its row came on screen, and nothing to press.
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="one"] [aria-label="Modeling tree"] button[aria-label="Select Box"]').length === 2);
  assert.deepEqual(await view.rows(), ['Select base', 'Select Box', 'Select arm', 'Select Box']);
  assert.deepEqual(await locks(), ['open', 'open']);
  // The far wall of the bore, the fixture's one cylindrical face: its part was loaded by the tree.
  await page.mouse.click(...at([-2.34, 1.88, 4]));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedReferenceIds.length === 1);
  assert.match((await pane.getByRole('region', { name: 'Reference details', exact: true }).innerText()).replace(/\s+/g, ' '),
    /Type Face · Cylindrical.*Diameter Ø 6 mm.*Radius R 3 mm/, 'the panel measures the face, not the part');
  assert.equal((await view.state()).selectedPartIds.length, 0, 'the Faces mode does not fall back to the part');

  // The connected options are independent of the mode and of each other; one that has no effect
  // under the mode is not in the menu, and keeps its choice for when it does.
  await openMenu();
  assert.deepEqual(await options(), ['Group faces'], 'under Faces, only Group faces applies');
  await menu.getByRole('menuitemcheckbox', { name: 'Group faces', exact: true }).click();
  assert.deepEqual(await options(), ['Group faces*']);
  assert.equal(await menu.isVisible(), true, 'ticking an option leaves the menu open');
  await menu.getByRole('menuitemradio', { name: 'Edges', exact: true }).click();
  await menu.waitFor({ state: 'detached' });
  assert.equal(await view.selectMode(), 'edges');
  await openMenu();
  assert.deepEqual(await options(), ['Group edges'], 'under Edges, only Group edges');
  await menu.getByRole('menuitemcheckbox', { name: 'Group edges', exact: true }).click();
  await menu.getByRole('menuitemradio', { name: 'All', exact: true }).click();
  await menu.waitFor({ state: 'detached' });
  await openMenu();
  assert.deepEqual(await options(), ['Group edges*', 'Group faces*'], 'both kept, and both at once');
  await page.keyboard.press('Escape');

  // All: the tree the person left — the base open, the arm shut — and unlocked.
  assert.equal(await view.selectMode(), 'all');
  assert.deepEqual(await locks(), []);
  assert.deepEqual(await view.rows(), ['Collapse base', 'Select base', 'Select Box', 'Expand arm', 'Select arm']);
  assert.deepEqual(errors, []);
});

test('under Faces or Edges, one press on a part whose faces are not loaded loads that part alone and picks what is under the pointer', async () => {
  const view = await open();
  const { page, pane, at, errors } = view;
  const reference = pane.getByRole('region', { name: 'Reference details', exact: true });
  const mode = name => view.chooseSelectMode(name);
  const selected = () => page.evaluate(() => window.cadHarness.a.controller.readState().selectedReferenceIds);
  // The tree loads a part's faces as its row comes on screen. With a filter that matches
  // nothing, no row is on screen, so under Faces no part has its faces loaded.
  await pane.getByRole('textbox', { name: 'Filter model', exact: true }).fill('zzz');
  await mode('Faces');
  assert.deepEqual([(await view.state()).selectedPartIds, await view.rows()], [[], []]);
  // One press on the base's top face: the base's topology loads — the Features panel says so
  // while it does — and that face is picked, with no second press. The load is quick here, so
  // what the panel showed is recorded as it is drawn.
  await page.evaluate(() => {
    window.__sawLoading = [];
    new MutationObserver(() => {
      for (const status of document.querySelectorAll('[data-testid="one"] [aria-label="Features"] [role=status]')) {
        if (status.textContent === 'Loading…') window.__sawLoading.push(window.cadHarness.a.controller.readState().selectedReferenceIds.length);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.mouse.click(...at([6, 6, 5]));
  await page.waitForFunction(() => /^topology\|o1\.1\|face\|o1\.1\.f\d+$/.test(window.cadHarness.a.controller.readState().selectedReferenceIds.join()));
  const face = (await selected())[0].split('|').at(-1);
  assert.deepEqual(await page.evaluate(() => window.__sawLoading.slice(0, 1)), [0], 'the Features panel said it was loading, before anything was picked');
  assert.equal(await pane.getByRole('region', { name: 'Features', exact: true }).getByText('Loading…').count(), 0, 'and stops once the face is picked');
  assert.equal(await pane.locator('[data-cad-toolbar] [role=status]').count(), 0, 'nothing under the strip says so');
  // Named by its part as the tree names it and its kind, never by its raw id; the id is a row.
  assert.match((await reference.innerText()).replace(/\s+/g, ' '), new RegExp(`^base · face ${face.replace(/^.*\.f/, '')} Type Face · Planar ID ${face.replace(/\./g, '\\.')}`),
    'the Reference names the face under the pointer');
  assert.deepEqual((await view.state()).selectedPartIds, [], 'the mode never falls back to the part');
  // Edges likewise, on the arm, whose topology is still not loaded (the panel says so again):
  // its top edge over the +x face.
  const sawBefore = await page.evaluate(() => window.__sawLoading.length);
  await mode('Edges');
  await page.mouse.click(...at([20, 0, 4]));
  await page.waitForFunction(() => /^topology\|o1\.2\|edge\|o1\.2\.e\d+$/.test(window.cadHarness.a.controller.readState().selectedReferenceIds.join()));
  assert.ok(await page.evaluate(() => window.__sawLoading.length) > sawBefore, 'only the pressed part had loaded');
  const edge = (await selected())[0].split('|').at(-1);
  assert.match((await reference.innerText()).replace(/\s+/g, ' '), new RegExp(`^arm · edge ${edge.replace(/^.*\.e/, '')} Type Edge.*ID ${edge.replace(/\./g, '\\.')}`));
  assert.deepEqual(errors, []);
});

test('viewport picks individual faces and edges while feature rows retain grouped selection', async () => {
  const view = await open();
  const {page, pane, at, errors} = view;
  // Recognition is unavailable in this harness. Supply a multi-face feature so
  // this tests the distinction between tree grouping and exact viewport hits.
  await page.evaluate(() => {
    window.Worker = class {
      constructor(url) { if (!String(url).includes('modelingTree.worker')) throw new Error('No worker'); }
      postMessage() { queueMicrotask(() => this.onmessage?.({data:{tree:[{
        id:'feature:box',kind:'extrude',label:'Grouped faces',faces:[1,2,3,4,5,6,7],edges:[1,2,3],children:[],complete:true
      }]}})); }
      terminate() {}
    };
  });
  await pane.getByRole('button', {name:'Expand base',exact:true}).click();
  const feature = pane.getByRole('button', {name:'Select Grouped faces',exact:true});
  await feature.click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedReferenceIds.length > 1);
  await page.mouse.click(...at([6,6,5]));
  await page.waitForFunction(() => {
    const ids = window.cadHarness.a.controller.readState().selectedReferenceIds;
    return ids.length === 1 && /\.f\d+$/.test(ids[0]);
  });
  const face = (await view.state()).selectedReferenceIds[0];
  await page.mouse.click(...at([10,6,5]));
  await page.waitForFunction(() => {
    const ids = window.cadHarness.a.controller.readState().selectedReferenceIds;
    return ids.length === 1 && /\.e\d+$/.test(ids[0]);
  });
  await page.keyboard.down('Shift');
  await page.mouse.click(...at([6,6,5]));
  await page.keyboard.up('Shift');
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedReferenceIds.length === 2);
  assert.ok((await view.state()).selectedReferenceIds.includes(face), 'Shift adds only the clicked face');
  await feature.click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedReferenceIds.length > 2);
  assert.deepEqual(errors, []);
});

test('collapsing selected topology and leaving isolation clear the reference action', async () => {
  const view = await open();
  const {page, pane, at, errors} = view;
  const action = pane.getByRole('button', {name:/^Copy Reference/});
  // Recognition is unavailable in this harness. Supply a multi-face feature so
  // this tests the distinction between tree grouping and exact viewport hits.
  await page.evaluate(() => {
    window.Worker = class {
      constructor(url) { if (!String(url).includes('modelingTree.worker')) throw new Error('No worker'); }
      postMessage() { queueMicrotask(() => this.onmessage?.({data:{tree:[{
        id:'feature:box',kind:'extrude',label:'Grouped faces',faces:[1,2,3,4,5,6,7],edges:[1,2,3],children:[],complete:true
      }]}})); }
      terminate() {}
    };
  });
  // Under All, an open part's faces are what a press picks; collapsing it unloads them. Its
  // faces are there once its feature row is: opening a part loads its topology.
  const faces = pane.getByRole('button', {name:'Select Grouped faces',exact:true});
  await pane.getByRole('button', {name:'Expand base',exact:true}).click();
  await faces.waitFor();
  await page.mouse.click(...at([6,6,5]));
  await action.waitFor();
  await pane.getByRole('button', {name:'Collapse base',exact:true}).click();
  await action.waitFor({state:'detached'});
  assert.deepEqual((await view.state()).selectedReferenceIds, [], 'collapsed topology is not a hidden selection');
  await pane.getByRole('button', {name:'Expand base',exact:true}).click();
  await faces.waitFor();
  await page.mouse.click(...at([6,6,5]));
  await action.waitFor();
  await pane.getByRole('button', {name:'Select base',exact:true}).dblclick();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().isolatedPartIds.length === 1);
  await action.waitFor({state:'detached'});
  await page.mouse.click(...at([6,6,5]));
  await action.waitFor();
  await pane.getByRole('status', {name:'Isolation'}).getByRole('button', {name:'Exit',exact:true}).click();
  await action.waitFor({state:'detached'});
  assert.deepEqual((await view.state()).selectedReferenceIds, [], 'isolation exit clears its topology selection');
  await pane.getByRole('button', {name:'Expand base',exact:true}).click();
  await page.waitForTimeout(300);
  assert.equal(await action.count(), 0, 'reopening the part does not resurrect old selection');
  assert.deepEqual(errors, []);
});

test('the Features tree searches as a second view: typing ranks matches and expands nothing, and picking a hit reveals it when the search ends', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  const search = pane.getByRole('textbox', { name: 'Filter model', exact: true });
  await search.fill('arm');
  await page.waitForFunction(() => document.querySelector('[data-testid="one"] [aria-label="Features"]').innerText.includes('1 match'));
  assert.deepEqual(await view.rows(), ['Select arm'], 'a flat ranked list, with no disclosure of its own');
  await pane.getByRole('button', { name: 'Select arm', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.join() === 'o1.2');
  await search.fill('');
  await page.waitForFunction(() => !document.querySelector('[data-testid="one"] [aria-label="Features"]').innerText.includes('match'));
  assert.deepEqual(await view.rows(), ['Expand base', 'Select base', 'Expand arm', 'Select arm'], 'the tree comes back as it was');
  assert.equal(await pane.getByRole('button', { name: 'Select arm', exact: true }).getAttribute('aria-pressed'), 'true', 'and the hit is revealed, selected');
  assert.equal(await search.getAttribute('placeholder'), 'Filter…');

  // Typing into a FOLDED panel's filter opens the panel, and keeps every key typed: real key events,
  // each landing in the box while the panel unfolds under it. (The chevron steps aside while the
  // box has focus.)
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  const features = pane.getByRole('region', { name: 'Features', exact: true });
  await features.getByRole('button', { name: 'Collapse features', exact: true }).click();
  await features.getByRole('button', { name: 'Expand features', exact: true }).waitFor();
  assert.equal(await pane.locator('[aria-label="Modeling tree"]').isVisible(), false);
  await search.focus();
  await page.keyboard.type('ba');
  await page.waitForFunction(() => document.querySelector('[data-testid="one"] [aria-label="Features"]').innerText.includes('match'));
  assert.equal(await search.inputValue(), 'ba', 'no keystroke lost');
  assert.equal(await features.getAttribute('data-collapsed'), null, 'the panel opened');
  assert.equal(await pane.locator('[aria-label="Modeling tree"]').isVisible(), true);
  assert.ok((await view.rows()).includes('Select base'), `the search shows the base: ${await view.rows()}`);
  // While the box has focus its trailing buttons step aside; blurred, they are back.
  assert.equal(await pane.getByRole('button', { name: /^Select mode: / }).isVisible(), false, 'the mode menu yields while typing');
  await search.fill('');
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await pane.getByRole('button', { name: /^Select mode: / }).waitFor();
  assert.deepEqual(errors, []);
});

// What the one part menu offers, in order, ending in the framing group. That group is
// the viewer's ONLY zoom control — the old Inspector's percentage readout and its menu are
// gone — so it is here, on every tree row, and on the empty-space menu below. It cannot
// contradict the tool in hand: every item returns to Select before it acts.
const ZOOM_SECTION = ['Zoom to fit', 'Zoom to selection'];
const PART_MENU = ['Add to prompt', 'Copy Reference', 'Select', 'Isolate', 'Hide others', 'Hide',
  'Expand', 'Collapse', 'Expand all', 'Collapse all', ...ZOOM_SECTION];

test('hiding a part takes it off the screen, and the viewport menus offer what they can do', async () => {
  const view = await open();
  const { page, pane, at, box, errors } = view;
  const opened = await view.frame();
  await pane.getByRole('button', { name: 'Hide arm', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().hiddenPartIds.join() === 'o1.2');
  const hidden = await view.frame();
  assert.equal(partBoxes(hidden).arm, null, 'a hidden part is off the screen, not merely off a list');
  assert.ok(partBoxes(hidden).base.count > partBoxes(opened).base.count * 0.9, 'and the rest of the model is still drawn');
  await pane.getByRole('button', { name: 'Reveal arm', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().hiddenPartIds.length === 0);
  const away = () => page.mouse.move(view.box.x + 20, view.box.y + view.box.height - 20);
  await away();
  await frameWhen(view, shot => differing(opened, shot) === 0, 'came back to what hiding the arm took away');
  // Hover runs the other way too: resting on a tree row lights its part.
  await pane.getByRole('button', { name: 'Select arm', exact: true }).hover();
  await frameWhen(view, shot => differing(opened, shot) > 2000, 'lit the part under the hovered row');
  await away();
  await frameWhen(view, shot => differing(opened, shot) === 0, 'and let go of it');

  await page.mouse.click(...at([6, 6, 5]), { button: 'right' });
  await page.getByRole('menu').waitFor();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), PART_MENU,
    'the node menu: what can be done to the part under the pointer, then the tree');
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });
  // Empty space asks about the model as a whole. Nothing is hidden here, so besides
  // the framing group all it can offer is the tree.
  await page.mouse.click(box.x + 30, box.y + box.height - 30, { button: 'right' });
  await page.getByRole('menu').waitFor();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Expand all', 'Collapse all', ...ZOOM_SECTION]);
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });

  // A tree row carries that same menu, item for item; the viewport's belongs to Select alone.
  await pane.getByRole('button', { name: 'Select base', exact: true }).click({ button: 'right' });
  await page.getByRole('menu').waitFor();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), PART_MENU);
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });
  await away();
  for (const tool of ['Measure', 'Position', 'Animate', 'Draw']) {
    await view.tool(tool).click();
    await page.mouse.click(...at([6, 6, 5]), { button: 'right' });
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole('menu').count(), 0, `${tool} opens no viewport menu over a part`);
    await page.mouse.click(box.x + 30, box.y + box.height - 30, { button: 'right' });
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole('menu').count(), 0, `${tool} opens no viewport menu over empty space`);
    // The browser's own menu is still kept off the canvas, and a secondary drag still pans.
    // (The viewer stops the event's propagation as it prevents it, so what it left
    // behind is read from the event itself rather than from a later listener.)
    assert.equal(await page.evaluate(() => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      document.querySelector('[data-testid="one"] [aria-busy] > div > canvas').dispatchEvent(event);
      return event.defaultPrevented;
    }), true, `${tool} still suppresses the native menu`);
    // And a secondary DRAG is still a pan. (Not under Draw: that tool locks the
    // view on purpose and the editor takes the drag, which its own test asserts.)
    if (tool === 'Draw') continue;
    const before = await page.evaluate(() => window.__cadCamera().target);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    await page.waitForFunction(target => window.__cadCamera().target.some((value, index) => Math.abs(value - target[index]) > 1e-3), before,
      { timeout: 5000 });
  }
  // The tree is Select's: under another tool it is off screen, and Select brings it back to act
  // from — Isolate, which has no selection of its own to make.
  assert.deepEqual(await view.tools(), ['Select:false', 'Draw:true', 'Measure:false', 'Explode:false', 'Clip:false', 'Position:false', 'Animate:false']);
  assert.equal(await pane.getByRole('button', { name: 'Select arm', exact: true }).isVisible(), false);
  await view.tool('Select').click();
  await pane.getByRole('button', { name: 'Select arm', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Isolate', exact: true }).click();
  await page.getByRole('menu').waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().isolatedPartIds.join() === 'o1.2');
  assert.deepEqual(await view.tools(), ['Select:true', 'Draw:false', 'Measure:false', 'Explode:false', 'Clip:false', 'Position:false', 'Animate:false']);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
});

test('the context menu frames the model and the selection, from the viewport and from a tree row', async () => {
  const view = await open();
  const { page, pane, at, box, errors } = view;
  const menuItem = name => page.getByRole('menuitem', { name, exact: true });
  const openMenu = async (gesture) => { await gesture(); await page.getByRole('menu').waitFor(); };
  const dismiss = async () => { await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'detached' }); };
  const choose = async (gesture, name) => {
    await openMenu(gesture);
    await menuItem(name).click();
    await page.getByRole('menu').waitFor({ state: 'detached' });
  };
  // Every claim below is read off the DRAWN frame: how wide the arm is in the pane.
  // The camera eases, so each one waits for the picture to arrive rather than sleeping.
  const armWidth = image => { const arm = partBoxes(image).arm; return arm ? arm.x1 - arm.x0 : 0; };
  const emptySpace = () => page.mouse.click(box.x + 30, box.y + box.height - 30, { button: 'right' });
  const overPart = () => page.mouse.click(...at([6, 6, 5]), { button: 'right' });
  const treeRow = name => () => pane.getByRole('button', { name, exact: true }).click({ button: 'right' });

  // With nothing selected the item that needs a selection is off — in all three places
  // the menu is rendered, because the three are one definition.
  for (const gesture of [emptySpace, overPart, treeRow('Select base')]) {
    await openMenu(gesture);
    assert.equal(await menuItem('Zoom to fit').getAttribute('aria-disabled'), null, 'Zoom to fit always acts');
    assert.equal(await menuItem('Zoom to selection').getAttribute('aria-disabled'), 'true',
      'Zoom to selection is off with nothing selected');
    await dismiss();
  }

  // Zoom to fit, asked for over empty space, really pulls the camera back to the model.
  await page.evaluate(() => { const c = window.cadHarness.a.controller;
    return c.setCamera({ ...c.readState().camera, zoom: 2.4 }); });
  const zoomedIn = armWidth(await frameWhen(view, shot => armWidth(shot) > 0, 'drew the arm zoomed in'));
  await choose(emptySpace, 'Zoom to fit');
  const fitted = armWidth(await frameWhen(view, shot => armWidth(shot) > 0 && armWidth(shot) < zoomedIn * 0.75,
    'pulled back to the whole model'));
  assert.ok(coverage(await view.frame()) > 0.2, 'and the model is on screen, not off it');

  // With a selection, Zoom to selection frames THAT and fills the pane with it.
  await pane.getByRole('button', { name: 'Select arm', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.join() === 'o1.2');
  await openMenu(overPart);
  assert.equal(await menuItem('Zoom to selection').getAttribute('aria-disabled'), null, 'a selection enables it');
  await menuItem('Zoom to selection').click();
  await page.getByRole('menu').waitFor({ state: 'detached' });
  await frameWhen(view, shot => coverage(shot) > 0.9, 'filled the pane with what was selected');
  // A selected part wears the selection ink, so its own colour only comes back once the
  // selection is dropped — which moves no camera. THEN the arm can be measured, and it
  // is the arm that the camera was put on.
  await page.evaluate(() => window.cadHarness.a.controller.clearSelection());
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.length === 0);
  const framedSelection = armWidth(await frameWhen(view, shot => armWidth(shot) > fitted * 1.3,
    `framed the selected arm rather than the model (${fitted} wide at the model fit)`));

  // And from a tree row, which frames the model again.
  await choose(treeRow('Select base'), 'Zoom to fit');
  await frameWhen(view, shot => armWidth(shot) > 0 && armWidth(shot) < framedSelection * 0.9,
    `framed the whole model again from ${framedSelection}`);
  assert.deepEqual(errors, []);
});

test('every Display control reaches the drawn frame: the five modes, edges, the clip plane on each axis, explode, and the surface styles that take the model away', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  // Display is a popover from its button in the viewport's top-right bar, not a tool: Select's
  // panels stay where they are, and it opens under its button, end-aligned with it.
  await view.toggle('cad-display').click();
  const panel = view.displayPanel();
  await panel.waitFor();
  await panel.evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
  assert.deepEqual(await view.stack(), ['Features'], 'the stack is as it was');
  assert.deepEqual(await view.tools(), ['Select:true', 'Draw:false', 'Measure:false', 'Explode:false', 'Clip:false', 'Position:false', 'Animate:false']);
  const [displayBox, button, backdrop] = await Promise.all([panel.boundingBox(), view.tool('Display').boundingBox(),
    pane.locator('[data-cad-scene-backdrop]').boundingBox()]);
  assert.ok(displayBox.y >= button.y + button.height && displayBox.x + displayBox.width <= backdrop.x + backdrop.width,
    `under its button, inside the viewer: ${JSON.stringify({ displayBox, button })}`);
  assert.ok(Math.abs(displayBox.x + displayBox.width - (button.x + button.width)) <= 16, 'end-aligned with its button');
  assert.ok(displayBox.y + displayBox.height <= backdrop.y + backdrop.height, 'never taller than the viewer');
  const solid = await view.frame();
  await page.evaluate(() => { window.openingCanvas = document.querySelector('[data-testid="one"] [aria-busy] > div > canvas'); });

  // Each preset draws a different picture, and none of them replaces the canvas.
  const frames = { solid };
  for (const [mode, label] of [['render', 'Render'], ['xray', 'X-ray'], ['hidden-line', 'Hidden line'], ['wireframe', 'Wireframe']]) {
    if (!await panel.isVisible()) await view.tool('Display').click();
    await panel.getByRole('combobox', { name: 'Mode', exact: true }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
    assert.equal(await panel.isVisible(), true);
    await page.waitForFunction(wanted => {
      const state = window.cadHarness.a.controller.readState();
      return state.display.mode === wanted && !state.loading;
    }, mode);
    frames[mode] = await frameWhen(view, shot => differing(solid, shot) > 60_000, `redrew the model for ${label}`);
  }
  // Each is its own picture, not merely "not Solid".
  for (const [left, right] of [['render', 'xray'], ['xray', 'hidden-line'], ['hidden-line', 'wireframe']]) {
    assert.ok(differing(frames[left], frames[right]) > 20_000, `${left} and ${right} are different pictures`);
  }
  assert.ok(coverage(frames['hidden-line']) < 0.1 && coverage(solid) > 0.3,
    `hidden line is linework over the backdrop and Solid is filled: ${coverage(frames['hidden-line'])} vs ${coverage(solid)}`);
  assert.equal(await page.evaluate(() => window.openingCanvas === document.querySelector('[data-testid="one"] [aria-busy] > div > canvas')), true,
    'a preset edits the live canvas; it never replaces it');

  if (!await panel.isVisible()) await view.tool('Display').click();
  await panel.getByRole('combobox', { name: 'Mode', exact: true }).click();
  await page.getByRole('option', { name: 'Solid', exact: true }).click();
  assert.equal(await panel.isVisible(), true);
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.mode === 'solid');
  await page.waitForTimeout(500);

  // Edges off takes the linework away and leaves the surfaces.
  const withEdges = await view.frame();
  if (!await panel.isVisible()) await view.tool('Display').click();
  await page.getByRole('button', { name: 'Disable Edges', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.edges?.enabled === false);
  const noEdges = await frameWhen(view, shot => differing(withEdges, shot) > 6_000, 'dropped the linework');
  assert.ok(painted(noEdges) > painted(withEdges) * 0.9, 'and the surfaces stayed');
  await page.getByRole('button', { name: 'Enable Edges', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.edges?.enabled !== false);
  await page.waitForTimeout(400);

  // Cross-section: the part of the model past the plane stops being drawn, and the axis toggle
  // cuts across another axis instead.
  const whole = partBoxes(await view.frame());
  await view.toggle('cad-display').click();
  await panel.waitFor({ state: 'detached' });
  await view.tool('Clip').click();
  assert.equal((await view.state()).display.clip.enabled, false, 'opening Clip does not cut');
  const clipSlider = pane.getByRole('slider', { name: 'Clip amount', exact: true });
  // A press on the middle of its track takes the slider there: half the model is cut away.
  const cutHalf = async () => {
    const track = await pane.getByRole('region', { name: 'Clip controls', exact: true }).locator('[data-slot=slider]').boundingBox();
    await page.mouse.click(track.x + track.width / 2, track.y + track.height / 2);
  };
  await cutHalf();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.clip?.enabled === true);
  assert.ok(Math.abs(Number(await clipSlider.getAttribute('aria-valuenow')) - 50) <= 3, 'about half');
  const cut = await frameWhen(view, shot => partBoxes(shot).base.count < whole.base.count * 0.75, 'cut the model down');
  await pane.getByRole('radio', { name: 'Clip Y axis', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.clip?.axis === 'y');
  await cutHalf();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.clip?.enabled === true);
  const across = await frameWhen(view, shot => differing(cut, shot) > 30_000, 'cut across Y instead of X');
  assert.ok(partBoxes(across).base.count < whole.base.count * 0.95, 'and it is still a cut');
  await view.display({ clip: { enabled: false } });
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.clip?.enabled === false);
  await page.waitForTimeout(500);

  // Explode moves the two parts apart ON SCREEN, and does not re-frame the camera.
  const framed = await page.evaluate(() => window.__cadCamera().zoomPercent);
  const together = partBoxes(await view.frame());
  const gap = boxes => boxes.arm.x0 - boxes.base.x1;
  await view.tool('Explode').click();
  await page.getByRole('slider', { name: 'Explode amount' }).press('End');
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.exploded?.enabled === true);
  // The separation eases over a second (EXPLODED_VIEW_ANIMATION_DURATION_MS).
  await frameWhen(view, shot => gap(partBoxes(shot)) - gap(together) > 80, 'separated the parts on screen');
  assert.equal(await page.evaluate(() => window.__cadCamera().zoomPercent), framed, 'explode never re-frames');
  await view.display({ exploded: { enabled: false } });
  await page.waitForFunction(() => window.__cadDisplayRecords().every(record => Math.abs(record.matrix[12] - (record.partId === 'o1.2' ? 15 : 0)) < 0.01));
  await page.waitForTimeout(400);

  await page.getByRole('button', { name: 'Close explode controls' }).click();
  assert.equal(await page.getByRole('region', { name: 'Clip controls' }).count(), 0, 'Clip went with its cut, Explode having taken the tool');
  await view.toggle('cad-display').click();
  await panel.waitFor();

  // Surface style: STEP's two extra styles both take the shaded surfaces away.
  // Hidden keeps them as occluders — the grid behind the model stops showing
  // through — where Off removes them from the scene and lets it through. They are
  // also what Hidden line and Wireframe are made of; both remain directly editable.
  const shaded = partBoxes(await view.frame());
  const styled = {};
  assert.deepEqual(await (async () => {
    await panel.getByRole('combobox', { name: 'Surface style', exact: true }).click();
    await page.getByRole('listbox').waitFor();
    const names = await page.getByRole('option').allTextContents();
    await page.keyboard.press('Escape');
    return names;
  })(), ['Shaded', 'Flat', 'Hidden', 'Off'], 'the Style menu exposes the CLI surface styles');
  for (const [style, label] of [['hidden', 'Hidden'], ['off', 'Off']]) {
    await view.display({ surfaces: { enabled: true, style } });
    await page.waitForFunction(wanted => window.cadHarness.a.controller.readState().display.surfaces?.style === wanted, style);
    const shot = await frameWhen(view, frame => partBoxes(frame).arm === null, `took the shaded surfaces away for ${label}`);
    styled[style] = { boxes: partBoxes(shot), painted: painted(shot) };
    assert.ok(styled[style].boxes.base === null || styled[style].boxes.base.count < shaded.base.count * 0.15,
      `${label} draws no shaded surface: ${JSON.stringify(styled[style].boxes.base)}`);
  }
  assert.ok(styled.hidden.painted < styled.off.painted * 0.5,
    `Hidden still occludes what is behind it: ${styled.hidden.painted} vs ${styled.off.painted}`);
  assert.deepEqual(errors, []);
});


test('persistent tools open neutral, stack beneath the toolbar, and toggle off without resetting other tools', async () => {
  const view = await open();
  const { pane, page, errors } = view;
  const explode = view.tool('Explode'), clip = view.tool('Clip');
  const stack = pane.locator('[data-model-tool-panels]');
  const explodePanel = stack.getByRole('region', { name: 'Explode controls' });
  const clipPanel = stack.getByRole('region', { name: 'Clip controls' });
  const selected = async (...names) => assert.deepEqual(await pane.getByRole('group', { name: 'Interaction tools' })
    .locator('button[aria-pressed=true]').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), names);
  await explode.click();
  await selected('Explode');
  assert.equal(await pane.getByRole('group', { name: 'Interaction tools' }).getByRole('separator').count(), 0);
  const amount = explodePanel.getByRole('slider', { name: 'Explode amount' });
  assert.equal(await amount.getAttribute('aria-valuenow'), '0');
  assert.equal((await view.state()).display.exploded.enabled, false);
  await amount.press('End');
  await clip.click();
  await selected('Explode', 'Clip');
  assert.equal((await view.state()).display.clip.enabled, false);
  const slider = clipPanel.getByRole('slider', { name: 'Clip amount' });
  for (const axis of ['X', 'Y', 'Z']) {
    await clipPanel.getByRole('radio', { name: `Clip ${axis} axis` }).click();
    assert.equal(Number(await slider.getAttribute('aria-valuemin')), 0);
    assert.equal(Number(await slider.getAttribute('aria-valuemax')), 100);
    assert.equal(Number(await slider.getAttribute('aria-valuenow')), 0);
    assert.equal((await view.state()).display.clip.enabled, false, 'axis selection stays neutral');
  }
  await slider.press('ArrowRight');
  assert.equal((await view.state()).display.clip.enabled, true, 'moving the slider enables clipping');
  await slider.press('Home');
  assert.equal((await view.state()).display.clip.enabled, false, 'the neutral boundary removes clipping');
  await clipPanel.getByRole('radio', { name: 'Clip X axis' }).click();
  // The body is the axis and ONE slider: no typed value, no Flip. A press mid-track sets half.
  assert.equal(await clipPanel.getByLabel('Clip amount value').count(), 0);
  assert.equal(await clipPanel.getByRole('checkbox', { name: 'Flip' }).count(), 0);
  const track = await clipPanel.locator('[data-slot=slider]').boundingBox();
  await page.mouse.click(track.x + track.width / 2, track.y + track.height / 2);
  assert.ok(Math.abs(Number(await slider.getAttribute('aria-valuenow')) - 50) <= 3);
  assert.equal((await view.state()).display.clip.enabled, true);
  // Neither panel folds: a heading of its name, the amount, and the X.
  for (const [panel, name] of [[explodePanel, 'Explode'], [clipPanel, 'Clip']]) {
    const heading = panel.locator('[data-tool-panel-heading]');
    assert.equal((await heading.getByRole('heading').innerText()).trim(), name);
    assert.match((await heading.innerText()).replace(/\s+/g, ' ').trim(), new RegExp(`^${name} \\d+%$`), `${name}: its amount beside its name`);
    assert.deepEqual(await heading.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), [`Close ${name.toLowerCase()} controls`]);
    assert.equal(await heading.getByRole('heading').evaluate(node => getComputedStyle(node).fontSize), '11px');
  }
  const [first, second, canvas, strip] = await Promise.all([explodePanel.boundingBox(), clipPanel.boundingBox(),
    pane.locator('[aria-busy] > div > canvas').first().boundingBox(), pane.getByRole('group', { name: 'Interaction tools' }).boundingBox()]);
  // The stack's one width: a five-tool strip's by default (`toolStackLayout.js`), narrower than this
  // file's seven-tool strip.
  assert.equal(first.width, TOOL_STACK_DEFAULT_WIDTH);
  assert.ok(strip.width > first.width);
  assert.ok(Math.abs(first.x - canvas.x - 8) < 2 && Math.abs(first.y - strip.y - strip.height - 8) < 2, 'under the strip, 8px in from the viewer');
  assert.ok(second.y >= first.y + first.height && second.x === first.x);
  const [axisBox, sliderBox] = await Promise.all([clipPanel.getByRole('radiogroup', { name: 'Clip axis' }).boundingBox(), clipPanel.locator('[data-slot=slider]').boundingBox()]);
  assert.ok(axisBox.x + axisBox.width <= sliderBox.x && Math.abs(axisBox.y + axisBox.height / 2 - (sliderBox.y + sliderBox.height / 2)) <= 2,
    'the axis sits left of the slider, on one row');
  assert.ok(second.height < 70, `Clip is a heading and one row: ${second.height}`);
  assert.equal(await clipPanel.evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await view.tool('Select').click();
  await selected('Select', 'Explode', 'Clip');
  assert.equal(await clipPanel.isVisible(), true);
  // Select's Features lead the stack, above the kept panels, and every item is one width.
  assert.deepEqual(await view.stack(), ['Features', 'Explode controls', 'Clip controls']);
  assert.deepEqual(new Set(await pane.locator('[data-cad-tool-stack] [data-tool-panel]').evaluateAll(panels => panels
    .filter(panel => panel.getClientRects().length).map(panel => panel.getBoundingClientRect().width))), new Set([TOOL_STACK_DEFAULT_WIDTH]));
  assert.equal(await amount.getAttribute('aria-valuenow'), '100');
  await clip.click();
  await clipPanel.waitFor({ state: 'detached' });
  await selected('Select', 'Explode');
  assert.equal((await view.state()).display.clip.enabled, false, 'repeat press removes applied Clip');
  assert.equal(await amount.getAttribute('aria-valuenow'), '100');
  await explodePanel.getByRole('button', { name: 'Close explode controls' }).click();
  await explodePanel.waitFor({ state: 'detached' });
  assert.equal((await view.state()).display.exploded.enabled, false);
  // A neutral Clip is the tool in hand, not an effect retained beside Select.
  await clip.click(); await selected('Clip');
  assert.equal((await view.state()).display.clip.enabled, false, 'reopening starts neutral');
  assert.equal((await view.state()).display.clip.invert, false);
  await clip.click(); await clipPanel.waitFor({ state: 'detached' });
  await selected('Select');
  await explode.click(); await explode.click();
  await explodePanel.waitFor({ state: 'detached' });
  await selected('Select');
  assert.deepEqual(errors, []);
});

test('a short viewer: the stack never runs past it — the capped panels give way, and then the column scrolls rather than cutting a panel', async () => {
  const view = await open();
  const { page, pane, at, errors } = view;
  // Every persistent panel up: Features and a Reference under Select, a measurement, an applied
  // Explode and an applied Clip.
  await pane.getByRole('button', { name: 'Expand base', exact: true }).click();
  await pane.getByRole('button', { name: 'Expand arm', exact: true }).click();
  await view.tool('Measure').click();
  for (const point of [[0, 0, 5], [15, 0, 4]]) {
    await page.mouse.move(...at(point)); await page.waitForTimeout(220);
    await page.mouse.click(...at(point)); await page.waitForTimeout(220);
  }
  await page.getByRole('region', { name: 'Measurements' }).waitFor();
  await view.tool('Explode').click();
  await pane.getByRole('slider', { name: 'Explode amount' }).press('ArrowRight');
  await view.tool('Clip').click();
  await pane.getByRole('slider', { name: 'Clip amount' }).press('ArrowRight');
  await view.tool('Select').click();
  // Under All an open part's face is what a press picks: either way, a Reference.
  await page.mouse.click(...at([6, 6, 5]));
  await page.waitForFunction(() => { const state = window.cadHarness.a.controller.readState(); return state.selectedPartIds.length + state.selectedReferenceIds.length > 0; });
  assert.deepEqual(await view.stack(), ['Features', 'Reference details', 'Measure controls', 'Explode controls', 'Clip controls']);
  // Then the viewer gets short.
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.waitForTimeout(400);
  const scroller = pane.locator('[data-tool-stack-scroller]');
  const [scrollBox, backdrop] = await Promise.all([scroller.boundingBox(), pane.locator('[data-cad-scene-backdrop]').boundingBox()]);
  assert.ok(scrollBox.y + scrollBox.height <= backdrop.y + backdrop.height - 8 + 1,
    `the column ends inside the viewer: ${scrollBox.y + scrollBox.height} vs ${backdrop.y + backdrop.height}`);
  // The capped panels have given way (the tree scrolls inside itself) before the column scrolls.
  const features = pane.getByRole('region', { name: 'Features', exact: true });
  assert.equal(await features.locator('[data-tool-panel-body]').evaluate(body => body.scrollHeight > body.clientHeight + 1 || body.clientHeight < 200), true);
  // Nothing is cut: the last panel's slider can be scrolled fully into view.
  await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForTimeout(100);
  const [slider, visible] = await Promise.all([pane.getByRole('slider', { name: 'Clip amount' }).boundingBox(), scroller.boundingBox()]);
  assert.ok(slider.y >= visible.y - 1 && slider.y + slider.height <= visible.y + visible.height + 1,
    `the Clip slider is reachable: ${JSON.stringify({ slider, visible })}`);
  assert.deepEqual(errors, []);
});

test('Position drives the mate and repaints, a named pose jumps, the Position knob is never the camera, and the grid keeps the size the rest pose gave it', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  // Position shows its panel in the tool stack, in place of Select's, and enables the joint handles.
  await view.tool('Position').click();
  const panel = pane.getByRole('region', { name: 'Position controls', exact: true });
  assert.deepEqual(await view.stack(), ['Position controls']);
  assert.deepEqual(await panel.getByRole('heading').allInnerTexts(), ['Position'], 'headed Position');
  const slider = page.getByLabel('hinge slider value', { exact: true });
  const preset = panel.getByRole('combobox', { name: 'Pose', exact: true });
  // ONE panel, whose first row is the named pose — a label beside its dropdown — then the joint.
  // The pose and the joints are no sections of their own.
  await assertPairedRow(panel, 'Pose', preset);
  for (const heading of ['Pose', 'Joints', 'Kinematics']) {
    assert.equal(await panel.getByRole('heading', { name: heading, exact: true }).count(), 0, `no ${heading} heading inside Position`);
  }
  // Sized like the tree: its content's height, capped at half the stack, with a height handle.
  const positionFit = await panel.evaluate(node => ({ cap: node.style.maxHeight, stack: node.closest('[data-cad-tool-stack]').clientHeight,
    scrolls: node.querySelector('[data-tool-panel-body]').scrollHeight > node.querySelector('[data-tool-panel-body]').clientHeight }));
  assert.equal(positionFit.cap, `${Math.round(positionFit.stack / 2)}px`);
  assert.equal(positionFit.scrolls, false);
  assert.equal(await pane.getByRole('separator', { name: 'Resize position controls', exact: true }).count(), 1);
  // A compact value field: 24px tall and about five characters wide.
  const field = await slider.boundingBox();
  assert.ok(field.height <= 24 && field.width <= 60, `a compact value field: ${JSON.stringify(field)}`);
  assert.equal((await preset.innerText()).trim(), 'Default');
  assert.equal(await slider.inputValue(), '0.00°');

  await page.mouse.move(view.box.x + 20, view.box.y + view.box.height - 20);
  await page.waitForTimeout(300);
  const rest = await view.frame();
  const restArm = (await translations(page))['o1.2'];
  await slider.fill('60');
  await slider.press('Enter');
  await page.waitForFunction(() => Math.abs(window.__cadDisplayRecords().find(record => record.partId === 'o1.2').matrix[13]) > 1);
  // The DRAWN frame moved, not just the matrix: a pose that never asks for a
  // repaint leaves the viewport sitting on the picture before it.
  const posed = await frameWhen(view, shot => differing(rest, shot) > 20_000, 'repainted for the mate the slider drove');

  // The grid runs out past the model and is sized from the REST pose, so
  // swinging the arm cannot rescale it. (The Render studio's floor is held to
  // the same rule at the end of this test, where a mode change cannot disturb
  // the frames compared here.)
  const guides = { x0: 0, x1: Math.floor(rest.width * 0.08) };
  assert.ok(painted(rest, guides) > 500, `the compared strip holds grid lines: ${painted(rest, guides)}`);
  assert.equal(differing(rest, posed, guides), 0, 'the guides beside the model are untouched by a pose');

  // A named pose is a full configuration, applied as a jump.
  await preset.click();
  await page.getByRole('option', { name: 'open', exact: true }).click();
  await page.waitForFunction(() => /^90(\.0+)?°$/.test(document.querySelector('input[aria-label="hinge slider value"]').value));
  assert.equal((await preset.innerText()).trim(), 'open');
  await panel.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.waitForFunction(() => /^0(\.0+)?°$/.test(document.querySelector('input[aria-label="hinge slider value"]').value));
  await page.waitForTimeout(400);
  assert.deepEqual((await translations(page))['o1.2'], restArm, 'Reset puts the mate back where it started');
  await page.mouse.move(view.box.x + 20, view.box.y + view.box.height - 20);
  await frameWhen(view, shot => differing(rest, shot) === 0, 'came back to the rest pose after Reset');

  // The Position tool: one knob, on the mate's axis, and dragging it is never the camera.
  await page.waitForFunction(() => window.__cadJointHandles().length === 1);
  const [knob] = await page.evaluate(() => window.__cadJointHandles());
  assert.equal(knob.id, 'hinge');
  const pivot = view.at([10, 0, 0]);
  assert.ok(Math.hypot(view.box.x + knob.pivotX - pivot[0], view.box.y + knob.pivotY - pivot[1]) < 4,
    `the knob's pivot is the mate's axis on screen: ${JSON.stringify([knob.pivotX, knob.pivotY])} vs ${JSON.stringify(pivot)}`);
  const camera = await page.evaluate(() => window.__cadCamera());
  // `travel` is the arc the knob may be dragged along, from limit to limit, so
  // following it is a drag toward a value rather than a guess at which way the
  // mate's axis turns on screen.
  assert.ok(knob.travel.length > 8, 'a revolute knob carries its arc');
  await page.mouse.move(view.box.x + knob.x, view.box.y + knob.y);
  await page.mouse.down();
  for (const [x, y] of knob.travel.slice(1, 9)) {
    await page.mouse.move(view.box.x + x, view.box.y + y);
    await settle(page);
  }
  await page.waitForFunction(() => window.__cadJointHandles()[0].value > 15);
  const held = (await page.evaluate(() => window.__cadJointHandles()))[0].value;
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal((await page.evaluate(() => window.__cadJointHandles()))[0].value, held, 'nothing eases behind the drag');
  const after = await page.evaluate(() => window.__cadCamera());
  for (const key of ['position', 'target']) {
    after[key].forEach((value, index) => assert.ok(Math.abs(value - camera[key][index]) < 1e-9, `a knob drag never moves the camera: ${key}[${index}]`));
  }
  await frameWhen(view, shot => differing(rest, shot) > 20_000, 'showed the pose the knob dragged to');
  assert.equal(Number.parseFloat(await slider.inputValue()), Math.round(held * 10) / 10, 'the Position slider follows the knob');

  // The Render studio's floor is the same ground as the grid: sized and centred
  // from the REST placement. Entering Render builds the studio against the scene
  // as it stands, so entering it POSED is the case that used to size the floor
  // from the swung arm's box. It must be the floor a model at rest gets.
  const studioFloor = async () => {
    await page.evaluate(() => window.cadHarness.a.controller.setRenderMode(true));
    await page.waitForFunction(() => window.__cadStage()?.studioGround && window.cadHarness.a.controller.readState().renderMode === 'render');
    const stage = await page.evaluate(() => window.__cadStage());
    await page.evaluate(() => window.cadHarness.a.controller.setRenderMode(false));
    await page.waitForFunction(() => !window.__cadStage()?.studioGround);
    return stage;
  };
  await slider.fill('60');
  await slider.press('Enter');
  await page.waitForFunction(() => Math.abs(window.__cadDisplayRecords().find(record => record.partId === 'o1.2').matrix[13]) > 1);
  const posedStage = await studioFloor();
  await panel.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.waitForFunction(() => /^0(\.0+)?°$/.test(document.querySelector('input[aria-label="hinge slider value"]').value));
  const restStage = await studioFloor();
  const boxShift = Math.max(...[0, 1, 2].flatMap(axis => [
    Math.abs(posedStage.bounds.min[axis] - restStage.bounds.min[axis]), Math.abs(posedStage.bounds.max[axis] - restStage.bounds.max[axis])]));
  assert.ok(boxShift > 1, `the studio was built against a posed box that differs from rest: ${JSON.stringify({ posed: posedStage.bounds, rest: restStage.bounds })}`);
  assert.deepEqual(posedStage.studioGround, restStage.studioGround, 'a pose never resizes or slides the studio floor');
  assert.deepEqual(errors, []);
});

test('Position persists across tools, its tool shows its panel, and Animate can take over', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  const rest = await translations(page);
  // Found by its name, visible or not: its values outlast its being on screen.
  const position = pane.locator('[data-tool-panel][aria-label="Position controls"]');
  const setPose = async () => {
    await view.tool('Position').click();
    const input = position.getByLabel('hinge slider value', { exact: true });
    await input.fill('60'); await input.press('Enter');
    await page.waitForFunction(y => Math.abs(window.__cadDisplayRecords().find(record => record.partId === 'o1.2').matrix[13] - y) > 1, rest['o1.2'][1]);
  };
  await setPose();
  const posed = await translations(page);
  await view.tool('Select').click();
  assert.equal(await position.isVisible(), false, 'its panel goes with the tool');
  await settle(page);
  assert.deepEqual(await translations(page), posed, 'switching tools preserves the pose');
  await view.tool('Measure').click();
  assert.deepEqual(await translations(page), posed, 'Measure inspects the posed model');
  await setPose();
  await view.tool('Select').click();
  await pane.getByRole('button', { name: 'Select arm', exact: true }).click();
  await settle(page);
  assert.deepEqual(await translations(page), posed, 'tree selection keeps the pose');
  await setPose();
  await view.tool('Animate').click();
  assert.equal(await view.tool('Animate').getAttribute('aria-pressed'), 'true');
  await page.waitForFunction(y => Math.abs(window.__cadDisplayRecords().find(record => record.partId === 'o1.2').matrix[13] - y) > 1, rest['o1.2'][1]);
  // Leaving Animate hands the pose back to Position as Position left it: the routine played
  // from the model at rest, and never threw the joint value away.
  await view.tool('Select').click();
  await page.waitForFunction(([x, y, z]) => {
    const [px, py, pz] = window.__cadDisplayRecords().find(record => record.partId === 'o1.2').matrix.slice(12, 15);
    return Math.hypot(px - x, py - y, pz - z) < 1e-3;
  }, posed['o1.2']);
  await position.getByLabel('hinge slider value', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await position.getByLabel('hinge slider value', { exact: true }).inputValue(), '60.0°');
  assert.deepEqual(errors, []);
});

test('Animate takes up paused, its panel\'s transport plays and pauses the routine, and leaving restores the pose', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  await page.mouse.move(view.box.x + 20, view.box.y + view.box.height - 20);
  await page.waitForTimeout(300);
  const rest = await view.frame();
  const restArm = (await translations(page))['o1.2'];
  await view.tool('Animate').click();
  const panel = pane.getByRole('region', { name: 'Animate controls', exact: true });
  await panel.waitFor();
  assert.deepEqual(await view.tools(), ['Select:false', 'Draw:false', 'Measure:false', 'Explode:false', 'Clip:false', 'Position:false', 'Animate:true']);
  // Autoplay is off by default: taken up, the routine waits, at rest.
  await panel.getByRole('button', { name: 'Play animation', exact: true }).waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual((await translations(page))['o1.2'], restArm, 'nothing plays until its play button is pressed');
  // The transport is the panel's: no playbar under the model outside fullscreen. One routine:
  // the panel's body is the play button and the time slider, with no Routine row.
  assert.equal(await pane.getByRole('toolbar', { name: 'Animation playback' }).count(), 0);
  assert.deepEqual(await panel.locator('[data-tool-panel-body]').getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))),
    ['Play animation']);
  assert.equal(await panel.getByRole('slider', { name: 'Animation time', exact: true }).count(), 1);
  assert.equal(await panel.getByRole('combobox', { name: 'Routine', exact: true }).count(), 0);

  await panel.getByRole('button', { name: 'Play animation' }).click();
  await page.waitForFunction(() => window.__cadDisplayRecords().find(record => record.partId === 'o1.2').matrix[1] > 0.2);
  await frameWhen(view, shot => differing(rest, shot) > 20_000, 'showed the playing routine');
  await panel.getByRole('button', { name: 'Pause animation' }).click();
  assert.equal(await panel.getByRole('button', { name: 'Play animation', exact: true }).isVisible(), true);
  // A second press on the tool in hand changes nothing: it neither plays nor puts Animate down.
  const paused = (await translations(page))['o1.2'];
  await view.tool('Animate').click();
  await page.waitForTimeout(300);
  assert.equal(await panel.getByRole('button', { name: 'Play animation', exact: true }).isVisible(), true, 'still paused');
  assert.deepEqual((await translations(page))['o1.2'], paused);
  assert.equal(await view.tool('Animate').getAttribute('aria-pressed'), 'true');
  await panel.getByRole('button', { name: 'Play animation' }).click();
  assert.equal(await panel.getByRole('button', { name: 'Pause animation', exact: true }).isVisible(), true);
  await panel.getByRole('button', { name: 'Pause animation' }).click();

  // Leaving Animate releases the routine: the model goes back to the pose it
  // was in, to the pixel.
  await view.tool('Select').click();
  await panel.waitFor({ state: 'detached' });
  await page.waitForTimeout(600);
  assert.deepEqual((await translations(page))['o1.2'], restArm);
  await frameWhen(view, shot => differing(rest, shot) === 0, 'came back to the rest pose exactly');

  assert.deepEqual(errors, []);
});

test('Measure reads a distance between two picks; Draw lays ink over a STEP; and the mode survives a remount that fits the camera afresh', async () => {
  const view = await open();
  const { page, pane, at, errors } = view;

  // Measure snaps onto exact topology, which arrives with the tree's frontier.
  await pane.getByRole('button', { name: 'Expand base', exact: true }).click();
  await pane.getByRole('button', { name: 'Expand arm', exact: true }).click();
  await view.tool('Measure').click();
  // Measure's panel is up as soon as it is the tool, empty: a heading with its snapping menu, and
  // a hint row for a body until there is something measured.
  const measurePanel = pane.getByRole('region', { name: 'Measure controls', exact: true });
  await measurePanel.waitFor();
  assert.equal((await measurePanel.locator('[data-measure-hint]').innerText()).trim(), 'Pick two points to measure');
  assert.equal((await measurePanel.locator('[data-tool-panel-heading] h3').innerText()).trim(), 'Measure');
  assert.equal(await view.tool('Measure').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[role=menu]').count(), 0, 'the strip opens no menu');
  // Its snapping: one sliders button in its heading, before the X (the panel does not fold), naming
  // the mode in hand; its menu is four plain rows, each its mode's own glyph at full size (All the
  // ruler). The strip's button is the ruler badged with the mode in hand, as Select's is.
  assert.deepEqual(await measurePanel.locator('[data-tool-panel-heading] button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))),
    ['Measure snapping: All', 'Close measure controls']);
  assert.equal(await measurePanel.getByRole('button', { name: /^Measure snapping: / }).locator('svg.lucide-sliders-horizontal').count(), 1);
  const snapping = page.locator('[role=menu][aria-label="Measure snapping"]');
  const snap = async name => {
    await measurePanel.getByRole('button', { name: /^Measure snapping: / }).click();
    await snapping.getByRole('menuitemradio', { name, exact: true }).click();
    await snapping.waitFor({ state: 'detached' });
  };
  await measurePanel.getByRole('button', { name: /^Measure snapping: / }).click();
  assert.deepEqual(await snapping.getByRole('menuitemradio').allInnerTexts(), ['All', 'Points', 'Edges', 'Faces']);
  assert.equal(await snapping.locator('[data-slot=dropdown-menu-label], [role=heading], [role=separator]').count(), 0, 'no heading and no sublabels');
  const measureIcons = root => root.locator('svg[data-tool-icon-base]').evaluateAll(icons => icons.map(icon =>
    `${icon.dataset.toolIconBase}:${icon.querySelector('[data-tool-icon-badge]')?.dataset.toolIconBadge ?? ''}`));
  assert.deepEqual(await snapping.locator('svg[data-mode-glyph]').evaluateAll(icons => icons.map(icon => icon.dataset.modeGlyph)),
    ['measure', 'points', 'edges', 'faces']);
  assert.deepEqual(await measureIcons(snapping), [], 'no composite in the menu');
  const measureMode = () => view.tool('Measure').locator('[data-measure-mode]').getAttribute('data-measure-mode');
  assert.equal(await measureMode(), 'all');
  await snapping.getByRole('menuitemradio', { name: 'Edges', exact: true }).click();
  await snapping.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('[data-testid="one"] [data-cad-toolbar] [data-measure-mode]')?.getAttribute('data-measure-mode') === 'edges');
  assert.deepEqual(await measureIcons(view.tool('Measure')), ['measure:edges'], 'the strip follows the chosen mode');
  assert.equal(await measurePanel.getByRole('button', { name: /^Measure snapping: / }).getAttribute('aria-label'), 'Measure snapping: Edges');
  await snap('All');
  assert.equal(await measureMode(), 'all');
  assert.equal(await view.tool('Measure').getAttribute('aria-pressed'), 'true', 'choosing a mode keeps Measure armed');
  // Measure says what the pointer does over the model: a crosshair, not Select's hand.
  await page.mouse.move(...at([0, 0, 5]));
  await view.waitCursor('crosshair');
  const measurements = page.getByRole('region', { name: 'Measurements' });
  assert.equal(await measurements.count(), 0, 'no results until something is measured');
  const measure = async (from, to) => {
    for (const point of [from, to]) {
      await page.mouse.move(...at(point));
      await page.waitForTimeout(220);
      await page.mouse.click(...at(point));
      await page.waitForTimeout(220);
    }
  };
  await measure([0, 0, 5], [15, 0, 4]);
  await measurements.waitFor();
  assert.match(await measurements.innerText(), /\d+\.\d+ mm/, 'the row reads a length');
  assert.equal(await measurePanel.locator('[data-measure-hint]').count(), 0, 'the hint gives way to the results');
  await measure([0, 10, 0], [15, -4, 4]);
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Measurements"] [role="listitem"]').length === 2);
  assert.equal(await page.getByRole('button', { name: /^Clear all$/i }).count(), 0, 'no Clear all footer: the tool and the panel X clear');
  // Each ruler goes on its own; the last one leaves the panel empty, and Measure keeps picking.
  await measurements.getByRole('button', { name: 'Delete measurement 2', exact: true }).click();
  assert.equal(await measurements.getByRole('listitem').count(), 1);
  await measurements.getByRole('button', { name: 'Delete measurement 1', exact: true }).click();
  await measurements.waitFor({ state: 'detached' });
  assert.equal(await measurePanel.isVisible(), true, 'the empty panel stays while Measure is the tool');
  assert.equal(await view.tool('Measure').getAttribute('aria-pressed'), 'true', 'removing the last ruler leaves Measure armed');
  await measure([0, 0, 5], [15, 0, 4]);
  await measurements.waitFor();
  await view.tool('Select').click();
  assert.equal(await measurements.isVisible(), true, 'completed rulers persist under another pointer tool');
  assert.equal(await view.tool('Measure').getAttribute('aria-pressed'), 'true');
  assert.equal(await view.tool('Select').getAttribute('aria-pressed'), 'true');
  // A mode in the kept panel takes Measure up again, results and all.
  await snap('Points');
  assert.equal(await measurements.getByRole('listitem').count(), 1, 'choosing a mode preserves measurements');
  assert.equal(await view.tool('Select').getAttribute('aria-pressed'), 'false');
  await snap('All');
  await measure([0, 10, 0], [15, -4, 4]);
  assert.equal(await measurements.getByRole('listitem').count(), 2);
  await view.tool('Measure').click();
  await measurePanel.waitFor({ state: 'detached' });
  assert.equal(await view.tool('Measure').getAttribute('aria-pressed'), 'false', 'a press on the armed tool clears it and puts it down');
  assert.equal(await view.tool('Select').getAttribute('aria-pressed'), 'true');
  // Armed and empty, a second press puts it down too, like Explode and Clip.
  await view.tool('Measure').click();
  await measurePanel.waitFor();
  await view.tool('Measure').click();
  await measurePanel.waitFor({ state: 'detached' });
  assert.equal(await view.tool('Select').getAttribute('aria-pressed'), 'true');
  await view.tool('Measure').click();
  await measure([0, 0, 5], [15, 0, 4]);
  await measurements.waitFor();
  await view.tool('Select').click();
  await view.tool('Measure').click();
  await measurements.waitFor({ state: 'detached' });
  assert.equal(await view.tool('Select').getAttribute('aria-pressed'), 'true', 'clearing retained results keeps the current pointer tool');
  await view.tool('Measure').click();
  await measure([0, 0, 5], [15, 0, 4]);
  await measurements.waitFor();
  await page.getByRole('button', { name: 'Close measure controls' }).click();
  await measurements.waitFor({ state: 'detached' });
  assert.equal(await view.tool('Measure').getAttribute('aria-pressed'), 'false');

  // Draw is a kit tool, and it works over a STEP like any other frame.
  const filterInset = await pane.getByRole('region', { name: 'Features', exact: true }).evaluate(node =>
    node.querySelector('[data-slot=tree-filter] input').getBoundingClientRect().left - node.getBoundingClientRect().left);
  await view.tool('Draw').click();
  await pane.locator('[data-cad-drawing-overlay] canvas.excalidraw__canvas.interactive').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="one"] [data-drawing-ready]'));
  // Its tools are a panel in the stack while Draw is up; choosing one keeps it there.
  const drawingPanel = pane.locator('[data-tool-panel][aria-label="Drawing controls"]');
  // One grid of controls, 24px columns spread across the stack's width: the tools, then the colour,
  // the stroke width, undo, redo and clear, with no rule between them and no inset beyond the other
  // panels' rows.
  await drawingPanel.waitFor();
  assert.equal(await drawingPanel.locator('hr, [role=separator], [data-slot=dropdown-menu-separator]').count(), 0, 'no rule in the panel');
  assert.equal(await drawingPanel.locator('.border-t').count(), 0);
  const controls = drawingPanel.locator('[data-drawing-controls]');
  assert.deepEqual(await controls.locator('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))),
    ['Select and move drawings', 'Pan view', 'Pen', 'Line', 'Arrow', 'Rectangle', 'Ellipse', 'Text', 'Fill area', 'Eraser', 'Color', 'Stroke width', 'Undo', 'Redo', 'Clear drawing'],
    'every control in one container');
  const flow = await controls.evaluate(node => {
    const panelLeft = node.closest('[data-tool-panel]').getBoundingClientRect().left;
    const own = node.getBoundingClientRect();
    const boxes = [...node.querySelectorAll('button')].map(button => button.getBoundingClientRect());
    const lines = [...new Set(boxes.map(box => Math.round(box.top)))];
    return { display: getComputedStyle(node).display, justify: getComputedStyle(node).justifyContent, lines: lines.length,
      size: [...new Set(boxes.map(box => `${box.width}x${box.height}`))], rightGap: own.right - Math.max(...boxes.map(box => box.right)),
      starts: lines.map(top => Math.min(...boxes.filter(box => Math.round(box.top) === top).map(box => box.left)) - panelLeft) };
  });
  assert.deepEqual([flow.display, flow.justify], ['grid', 'space-between']);
  assert.ok(flow.lines >= 2, `the grid wraps to the stack's width: ${JSON.stringify(flow)}`);
  assert.ok(flow.rightGap <= 1, `its columns spread to the panel's right edge: ${JSON.stringify(flow)}`);
  assert.deepEqual(flow.size, ['24x24'], 'the buttons keep their size');
  assert.deepEqual(new Set(flow.starts), new Set([filterInset]), `every line starts at the Features filter row's inset: ${JSON.stringify(flow.starts)} vs ${filterInset}`);
  await drawingPanel.getByRole('button', { name: 'Line', exact: true }).click();
  assert.equal(await drawingPanel.isVisible(), true);
  await page.waitForFunction(() => document.querySelector('[aria-label="Draw"] [data-drawing-tool]')?.getAttribute('data-drawing-tool') === 'line');

  await page.mouse.move(...at([-5, 0, 5]));
  await page.mouse.down();
  await page.mouse.move(...at([15, 0, 5]), { steps: 8 });
  await page.mouse.up();
  const ink = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="one"] [data-cad-drawing-overlay] canvas.excalidraw__canvas.static');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0, red = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] <= 200) continue;
      opaque += 1;
      if (data[index] > 200 && data[index + 1] < 100) red += 1;
    }
    return { opaque, red };
  });
  assert.ok(ink.red > 50, `a neon stroke over a STEP: ${JSON.stringify(ink)}`);
  const drawingMenu = drawingPanel;
  await drawingMenu.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-testid="one"] [data-cad-drawing-overlay] canvas.excalidraw__canvas.static');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return !pixels.some((value, index) => index % 4 === 3 && value > 200);
  });
  assert.equal(await drawingMenu.isVisible(), true);
  await drawingMenu.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-testid="one"] [data-cad-drawing-overlay] canvas.excalidraw__canvas.static');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 200);
  });
  assert.equal(await drawingMenu.isVisible(), true);
  await drawingMenu.getByRole('button', { name: 'Color', exact: true }).click();
  await drawingMenu.getByRole('radio', { name: 'Neon red', exact: true }).click();
  assert.equal(await drawingMenu.isVisible(), true);
  await drawingMenu.getByRole('button', { name: 'Clear drawing', exact: true }).click();
  assert.equal(await drawingMenu.isVisible(), true, 'the panel stays with its tool');

  await view.tool('Select').click();
  await pane.locator('[data-cad-drawing-overlay]').waitFor({ state: 'detached' });
  await view.tool('Draw').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="one"] [data-drawing-ready]'));
  assert.equal(await pane.getByRole('button', { name: /Copy drawing|Add drawing to prompt/ }).count(), 0, 'leaving Draw clears its drawing');
  await view.tool('Select').click();

  // What the file remembers: the display settings, in its record. Never the camera: a remount
  // frames the model afresh.
  await view.toggle('cad-display').click();
  await view.displayPanel().waitFor();
  await view.display({ mode: 'wireframe' });
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.mode === 'wireframe');
  await page.evaluate(() => window.cadHarness.a.controller.setCamera({ ...window.cadHarness.a.controller.readState().camera, position: [60, -20, 25], target: [4, 1, 0], zoom: 1.3 }));
  await page.waitForTimeout(600);
  const before = await view.state();
  await page.evaluate(() => window.cadHarness.mounted(false));
  await pane.locator('[data-slot="cad-file-view"]').waitFor({ state: 'detached' });
  const records = await page.evaluate(() => window.cadHarness.state.renderers);
  assert.deepEqual(Object.keys(records), [JSON.stringify(['hinge_block.step', 'step'])], 'one record per file, keyed [path, renderer id]');
  assert.equal(Object.values(records)[0].camera, null, 'the record keeps no camera');
  await page.evaluate(() => window.cadHarness.mounted(true));
  await pane.locator('[aria-busy="false"] > div > canvas').first().waitFor();
  await page.waitForFunction(() => window.cadHarness.a.controller?.readState().loading === false);
  await page.waitForTimeout(600);
  const restored = await view.state();
  assert.equal(restored.display.mode, 'wireframe');
  assert.ok(Math.hypot(...before.camera.target.map((value, index) => value - restored.camera.target[index])) > 1,
    `the moved camera is not restored: ${JSON.stringify([before.camera.target, restored.camera.target])}`);
  assert.equal(restored.camera.zoom, 1, 'the remount fits at its own zoom');
  assert.equal(await view.displayPanel().count(), 0, 'Display popover is transient across remounts');
  assert.deepEqual(errors, []);
});

// A STEP is published in PIECES, and each piece lands in a scene the viewport already
// holds: same object, same identity, more in it. The only thing that tells the viewport
// so is `viewport.commitScene()` from the scene sync, and everything the viewport sizes
// from the model — the ground, the depth range and the framing — is re-read THEN.
//
// The committed two-component fixture cannot show this, and neither can any package
// whose second publish is its LAST: the end of a load changes what the viewport is
// mounted with, so it re-adopts the scene for reasons of its own and a deleted commit
// costs nothing. `stageProgressiveFixture` serves the same two shapes as twenty-five
// components, held one batch at a time, so the MIDDLE publish is an in-place change
// with nothing else moving — and it is the one that brings the base.
test('a package that arrives in pieces re-sizes its ground, its depth range and its framing on a publish in the middle of the load', async (t) => {
  const staged = [];
  const staggered = await serveStepHarness({ after: cleanup => staged.push(cleanup) }, { progressive: true });
  t.after(async () => { for (const cleanup of staged.reverse()) await cleanup(); });
  const { page, errors, pane } = await staggered.open({ timeout: 60000 });
  await pane.locator('[aria-busy] > div > canvas').first().waitFor();
  const read = async () => ({ stage: await page.evaluate(() => window.__cadStage()), camera: await page.evaluate(() => window.__cadCamera()) });
  const span = bounds => [0, 1, 2].map(axis => Math.round(bounds.max[axis] - bounds.min[axis]));
  const publishes = () => page.evaluate(() => [window.__cadMeshCost.publishCount, window.__cadMeshCost.loadedComponents, window.__cadMeshCost.final]);

  // BATCH ONE: eight arms, all at the origin, so this box is one arm's whichever eight
  // of them got there first. The rest of the package is still downloading.
  await page.waitForFunction(() => window.__cadMeshCost?.loadedComponents === 8, null, { timeout: 60000 });
  await page.waitForFunction(() => window.__cadStage?.()?.bounds);
  const first = await read();
  const firstFrame = await frame(pane);
  assert.deepEqual(await publishes(), [1, 8, false], 'one publish, and the load is not over');
  assert.deepEqual(span(first.stage.bounds), [10, 8, 8], 'the arm, and nothing else');

  // BATCH TWO, in the MIDDLE of the load: sixteen more components, one of them the base.
  // Nothing else about the viewport changed — same scene, same loading state, same camera
  // request — so every one of these follows from the commit and from nothing else.
  staggered.release('a');
  await page.waitForFunction(() => window.__cadMeshCost?.loadedComponents === 24, null, { timeout: 60000 });
  await page.waitForFunction(width => Math.round(window.__cadStage().bounds.max[0] - window.__cadStage().bounds.min[0]) > width, 10);
  const middle = await read();
  const middleFrame = await frame(pane);
  assert.deepEqual(await publishes(), [2, 24, false], 'a second publish, and STILL not the end of the load');
  assert.deepEqual(span(middle.stage.bounds), [20, 20, 10], 'the base is in the box the stage is fitted to');
  assert.ok(middle.stage.gridRadius > first.stage.gridRadius * 1.3,
    `the grid grew with the model (${first.stage.gridRadius} -> ${middle.stage.gridRadius})`);
  assert.ok(middle.stage.floorZ < first.stage.floorZ,
    `and the floor dropped to the model's new underside (${first.stage.floorZ} -> ${middle.stage.floorZ})`);
  assert.ok(middle.camera.far > first.camera.far,
    `the depth range was fitted again (far ${first.camera.far} -> ${middle.camera.far})`);
  // The FRAMING does not follow it, and must not: a model that jumped in the frame every
  // time a batch landed would be unusable while a large assembly loads. It is framed on
  // what arrived first, and once more when the scene is whole.
  assert.equal(middle.camera.halfHeight, first.camera.halfHeight, 'the camera held its frame while the model grew');
  // On the DRAWN frame: the base's own authored blue fills a frame it was barely in, and
  // the arm is drawn SMALLER than it was, because the camera pulled back.
  const before = partBoxes(firstFrame), after = partBoxes(middleFrame);
  const width = box => (box ? box.x1 - box.x0 : 0);
  assert.ok(after.base.count > (before.base?.count || 0) * 5,
    `the base is drawn (${before.base?.count || 0} -> ${after.base.count} pixels of its colour)`);
  assert.ok(width(after.arm) < width(before.arm) * 0.8,
    `and the arm shrank as the camera pulled back (${width(before.arm)}px -> ${width(after.arm)}px)`);
  assert.ok(differing(firstFrame, middleFrame) > 20000, 'the picture changed');

  // THE LAST COMPONENT is one more arm on top of the others, so it places nothing new —
  // but it makes the scene WHOLE, and that is when the camera frames it again, on the box
  // the middle publish had already given the stage.
  staggered.release('b');
  await page.waitForFunction(() => window.__cadMeshCost?.final === true, null, { timeout: 60000 });
  await page.waitForFunction(height => window.__cadCamera().halfHeight > height, first.camera.halfHeight);
  const whole = await read();
  assert.deepEqual(span(whole.stage.bounds), span(middle.stage.bounds), 'the box it was already fitted to');
  assert.ok(whole.camera.halfHeight > middle.camera.halfHeight * 1.3,
    `framed once more, now on the whole model (${middle.camera.halfHeight} -> ${whole.camera.halfHeight})`);
  const framed = partBoxes(await frame(pane));
  assert.ok(framed.base && framed.base.count < after.base.count * 0.8,
    `and it is drawn smaller for it: the base ran off the frame it now sits inside (${after.base.count} -> ${framed.base.count} pixels)`);

  // Reopening starts fresh even if the previous mounted camera was moved.
  await page.evaluate(() => window.cadHarness.a.controller.setCamera({
    ...window.cadHarness.a.controller.readState().camera, position: [90, -30, 38], target: [4, 1, 0], zoom: 1.6 }));
  await page.waitForTimeout(600);
  const chosen = await page.evaluate(() => window.__cadCamera());
  const chosenFrame = await frame(pane);
  assert.ok(chosen.position.some((value, index) => Math.abs(value - whole.camera.position[index]) > 1),
    'the camera the person set is somewhere the fit never puts it');
  const stored = await page.evaluate(() => JSON.parse(JSON.stringify(window.cadHarness.state)));

  // Reopened: a fresh page over the same package, held in pieces again, carrying what the last
  // session left for this file. (A remount would not do: the client still holds every component
  // it downloaded, so the package would arrive whole in ONE publish and never reach completion
  // as a second framing at all.)
  staggered.hold('a'); staggered.hold('b');
  const reopened = await staggered.open({ timeout: 60000, state: stored });
  await reopened.pane.locator('[aria-busy] > div > canvas').first().waitFor();
  await reopened.page.waitForFunction(() => window.__cadMeshCost?.loadedComponents === 8, null, { timeout: 60000 });
  staggered.release('a');
  await reopened.page.waitForFunction(() => window.__cadMeshCost?.loadedComponents === 24, null, { timeout: 60000 });
  staggered.release('b');
  await reopened.page.waitForFunction(() => window.__cadMeshCost?.final === true, null, { timeout: 60000 });
  await reopened.page.waitForFunction(() => window.cadHarness.a.controller?.readState().loading === false, null, { timeout: 60000 });
  await reopened.page.waitForTimeout(800);
  assert.deepEqual(await reopened.page.evaluate(() => [window.__cadMeshCost.publishCount, window.__cadMeshCost.final]),
    [3, true], 'it arrived in three publishes again, so completion really did reframe');
  const kept = await reopened.page.evaluate(() => window.__cadCamera());
  for (const key of ['position', 'target']) {
    whole.camera[key].forEach((value, index) => assert.ok(Math.abs(value - kept[key][index]) < 1e-6,
      `${key}[${index}] returns to the fit for the completed model`));
  }
  const reopenedFrame = await frame(reopened.pane);
  assert.ok(differing(chosenFrame, reopenedFrame) > 3000, 'reopening discards the previous camera');
  assert.deepEqual(reopened.errors, []);
  assert.deepEqual(errors, []);
});




test('the Display popover keeps controls together, resets optional sections, stays within the viewer and goes as a popover goes', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  const sheet = view.displayPanel();
  await view.tool('Display').click();
  await sheet.waitFor();
  assert.equal(await sheet.locator('[data-settings-sections]').count(), 1);
  assert.equal(await sheet.getByRole('combobox', { name: 'Mode', exact: true }).isVisible(), true);
  assert.equal(await sheet.getByRole('combobox', { name: 'Projection', exact: true }).isVisible(), true);
  for (const dismiss of ['Escape', 'trigger', 'section', 'outside']) {
    const mode = sheet.getByRole('combobox', { name: 'Mode', exact: true });
    const triggerBox = await mode.boundingBox();
    const headingBox = await sheet.getByRole('heading', { name: 'Display', exact: true }).boundingBox();
    await mode.click(); await page.getByRole('listbox').waitFor();
    if (dismiss === 'Escape') await page.keyboard.press('Escape');
    else {
      const target = dismiss === 'trigger' ? triggerBox
        : dismiss === 'section' ? headingBox
        : { x: 8, y: 80, width: 2, height: 2 };
      const point = [target.x + target.width / 2, target.y + target.height / 2];
      // Radix arms the listbox's outside-press listener a tick after it mounts, so a press that
      // lands in that tick is ignored; press again until the listbox goes.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await page.mouse.click(...point);
        if (await page.locator('[data-slot=select-content]').waitFor({ state: 'detached', timeout: 1000 }).then(() => true, () => false)) break;
      }
    }
    await page.locator('[data-slot=select-content]').waitFor({ state: 'detached' });
    assert.equal(await sheet.isVisible(), true, `dismissing a dropdown with ${dismiss} preserves its parent`);
  }
  assert.equal(await sheet.getByRole('region', { name: 'Surfaces', exact: true }).isVisible(), true);
  const headingSize = await sheet.getByRole('heading', { name: 'Display', exact: true }).locator('button').evaluate(el => getComputedStyle(el).fontSize);
  const controlSize = await sheet.getByRole('combobox', { name: 'Mode', exact: true }).evaluate(el => getComputedStyle(el).fontSize);
  assert.equal(headingSize, controlSize, 'Display headings match control text');
  // Its button is not on the strip: it sits in the top-right bar, left of Fullscreen.
  assert.equal((await view.tools()).some(tool => tool.startsWith('Display')), false, 'Display is not a tool');
  const [displayButton, fullscreenButton] = await Promise.all([view.tool('Display').boundingBox(),
    pane.getByRole('button', { name: 'Fullscreen', exact: true }).boundingBox()]);
  assert.ok(displayButton.x + displayButton.width <= fullscreenButton.x + 1 && Math.abs(displayButton.y - fullscreenButton.y) <= 1, 'left of Fullscreen, level with it');
  const initial = await sheet.boundingBox();
  const surface = await pane.locator('[data-cad-surface]').boundingBox();
  assert.ok(initial.width <= 280 && initial.height <= 520);
  assert.ok(initial.x >= surface.x && initial.y >= surface.y);
  assert.ok(initial.x + initial.width <= surface.x + surface.width + 1);
  assert.ok(initial.y + initial.height <= surface.y + surface.height + 1);
  // The popover's X takes the Display section heading's right end, Reset beside it on that row. It
  // does not fold: nothing about it is a panel of the stack.
  const displayHeading = sheet.locator('[data-settings-section="display"] [data-settings-section-heading]');
  const [resetBox, closeBox] = await Promise.all([displayHeading.getByRole('button', { name: 'Reset', exact: true }).boundingBox(),
    sheet.getByRole('button', { name: 'Close display settings', exact: true }).boundingBox()]);
  assert.ok(resetBox.x + resetBox.width <= closeBox.x && Math.abs(resetBox.y + resetBox.height / 2 - (closeBox.y + closeBox.height / 2)) <= 2,
    `Reset sits left of the X, on the heading's row: ${JSON.stringify({ resetBox, closeBox })}`);
  assert.ok(Math.abs(closeBox.x + closeBox.width - (initial.x + initial.width)) <= 6 && closeBox.y - initial.y <= 6, 'the X is at the top right');
  assert.equal(await sheet.getByRole('button', { name: /^(?:Collapse|Expand) display settings$/ }).count(), 0, 'it does not fold');
  await sheet.getByRole('combobox', { name: 'Mode', exact: true }).click();
  await page.getByRole('option', { name: 'Render', exact: true }).click();
  assert.equal(await sheet.isVisible(), true, 'choosing a preset keeps the sheet open');
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.mode === 'render');
  await sheet.getByRole('combobox', { name: 'Mode', exact: true }).click();
  await page.getByRole('option', { name: 'Solid', exact: true }).click();
  await sheet.getByRole('button', { name: 'Enable Lighting', exact: true }).click();
  const exposure = sheet.getByLabel('Exposure value', { exact: true });
  await exposure.fill('0.8'); await exposure.press('Enter');
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.lighting.exposure === 0.8);
  await sheet.getByRole('button', { name: 'Disable Lighting', exact: true }).click();
  assert.equal(await exposure.count(), 0);
  await sheet.getByRole('button', { name: 'Enable Lighting', exact: true }).click();
  assert.equal(await exposure.inputValue(), '0.0 EV', 'reopening resets to defaults');
  await sheet.getByRole('button', { name: 'Grid color', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Color opacity' }).fill('40');
  await page.getByRole('spinbutton', { name: 'Color opacity' }).press('Tab');
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.grid.opacity === 0.4);
  await page.keyboard.press('Escape');
  // Escape closes the color editor first — all the way, so the next Escape is the sheet's.
  await page.getByRole('spinbutton', { name: 'Color opacity' }).waitFor({ state: 'detached' });
  assert.equal(await sheet.isVisible(), true, 'and the sheet stays');
  await sheet.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.lighting?.enabled !== true);
  await page.keyboard.press('Escape'); await sheet.waitFor({ state: 'hidden' });
  // Its button toggles it; a quick run of presses always reaches the button.
  await view.tool('Display').click(); await view.tool('Display').click(); await view.tool('Display').click();
  await sheet.waitFor(); await page.keyboard.press('Escape'); await sheet.waitFor({ state: 'hidden' });
  // Its X puts it away.
  await view.tool('Display').click(); await sheet.waitFor();
  await sheet.getByRole('button', { name: 'Close display settings', exact: true }).click();
  await sheet.waitFor({ state: 'hidden' });
  assert.equal(await view.tool('Display').getAttribute('aria-pressed'), 'false');
  // A popover: a press anywhere outside it — the model included — puts it away, and Select, the
  // tool in hand throughout, is still the tool.
  await view.tool('Display').click(); await sheet.waitFor();
  const canvas = await pane.locator('[aria-busy] > div > canvas').first().boundingBox();
  const opened = await sheet.boundingBox();
  const outside = [canvas.x + canvas.width / 2, canvas.y + canvas.height - 80];
  assert.ok(outside[1] > opened.y + opened.height || outside[0] < opened.x, 'the press lands beside the popover, not in it');
  await page.mouse.click(...outside);
  await sheet.waitFor({ state: 'hidden' });
  assert.equal(await view.tool('Display').getAttribute('aria-pressed'), 'false');
  assert.equal(await view.tool('Select').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
});

test('neutral model tools leave with another tool; applied effects persist until cleared', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  const clip = pane.getByRole('region', { name: 'Clip controls', exact: true });
  const explode = pane.getByRole('region', { name: 'Explode controls', exact: true });
  await view.tool('Clip').click(); await clip.waitFor();
  assert.equal(await view.tool('Select').getAttribute('aria-pressed'), 'false');
  assert.equal(await view.tool('Clip').getAttribute('aria-pressed'), 'true');
  await view.tool('Select').click(); await clip.waitFor({ state: 'hidden' });
  await view.tool('Explode').click(); await explode.waitFor();
  assert.equal(await view.tool('Select').getAttribute('aria-pressed'), 'false');
  assert.equal(await view.tool('Explode').getAttribute('aria-pressed'), 'true');
  assert.equal((await view.state()).display.exploded.amount, 0);
  await view.tool('Measure').click(); await explode.waitFor({ state: 'hidden' });
  await view.tool('Clip').click();
  await view.tool('Explode').click(); await clip.waitFor({ state: 'hidden' });
  await page.getByRole('slider', { name: 'Explode amount' }).press('End');
  await view.tool('Select').click();
  assert.equal(await explode.isVisible(), true);
  await view.tool('Clip').click();
  const clipAmount = clip.getByRole('slider', { name: 'Clip amount', exact: true });
  await clipAmount.focus();
  await page.keyboard.press('PageUp');
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.clip.enabled === true);
  await view.tool('Measure').click();
  assert.equal(await clip.isVisible(), true);
  assert.equal(await explode.isVisible(), true);
  // Back to zero from the keyboard, the cut is gone and so is its panel.
  await clipAmount.focus();
  await page.keyboard.press('Home');
  await clip.waitFor({ state: 'hidden' });
  // A kept panel whose value is dragged THROUGH neutral stays under the pointer: dropping it
  // mid-drag lost the drag. It goes only once the pointer lets go at neutral.
  const thumb = page.getByRole('slider', { name: 'Explode amount' });
  const track = await explode.locator('[data-slot=slider-track]').boundingBox();
  const thumbBox = await thumb.boundingBox();
  const y = thumbBox.y + thumbBox.height / 2;
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(track.x - 30, y, { steps: 8 });
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.exploded.amount === 0);
  await page.waitForTimeout(100);
  assert.equal(await explode.isVisible(), true, 'the panel stays while the pointer holds its slider at 0');
  await page.mouse.move(track.x + track.width / 2, y, { steps: 8 });
  await page.mouse.up();
  assert.equal(await explode.isVisible(), true);
  assert.ok(Math.abs((await view.state()).display.exploded.amount - 0.5) < 0.1, 'and the drag carried on to where it was let go');
  const middle = await thumb.boundingBox();
  await page.mouse.move(middle.x + middle.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(track.x - 30, y, { steps: 8 });
  await page.mouse.up();
  await explode.waitFor({ state: 'hidden' });
  await view.tool('Select').click();
  await view.tool('Clip').click(); await view.tool('Clip').click(); await clip.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
});


test('Animate shows its panel — the routine, then play and pause; speed, Autoplay and loop in its settings — the choices outlast leaving the tool, and Autoplay starts the routine', async () => {
  const animation = harness.entry.sourceSidecar.animation;
  const original = animation.source;
  let view;
  try {
    animation.source += '\nclips.short = { ...clips.swing, label: "Short swing", duration: 2 };';
    view = await open();
  } finally { animation.source = original; }
  const { page, pane, errors } = view;
  const tool = view.tool('Animate');
  await tool.click();
  // Its panel leads the stack while it is the tool, headed "Animate", its settings button and the
  // chevron in the heading; the routine waits, Autoplay being off.
  const panel = pane.getByRole('region', { name: 'Animate controls', exact: true });
  await panel.waitFor();
  assert.deepEqual(await view.stack(), ['Animate controls']);
  const heading = panel.locator('[data-tool-panel-heading]');
  assert.equal((await heading.locator('h3').innerText()).trim(), 'Animate');
  assert.equal(await heading.locator('h3').evaluate(node => getComputedStyle(node).fontSize), '11px');
  // It does not fold: its X puts Animate down, back to Select.
  assert.deepEqual(await heading.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))),
    ['Animation settings', 'Close animate']);
  assert.equal(await page.getByRole('menu').count(), 0);
  const play = panel.getByRole('button', { name: 'Play animation', exact: true });
  const pause = panel.getByRole('button', { name: 'Pause animation', exact: true });
  await play.waitFor();
  assert.equal(await pane.getByRole('toolbar', { name: 'Animation playback' }).count(), 0, 'the playbar under the model is fullscreen\'s');
  // Two routines: the Routine dropdown alone across its row (it says what it is: no label), then
  // the transport row, the play button left of the time slider.
  const routine = panel.getByRole('combobox', { name: 'Routine', exact: true });
  const time = panel.getByRole('slider', { name: 'Animation time', exact: true });
  const [bodyBox, routineBox, playBox, timeBox] = await Promise.all([panel.locator('[data-tool-panel-body]').boundingBox(),
    routine.boundingBox(), play.boundingBox(), time.boundingBox()]);
  assert.equal(await panel.locator('[data-tool-panel-body]').getByText('Routine', { exact: true }).count(), 0, 'no label beside it');
  assert.ok(routineBox.width >= bodyBox.width - 16 - 1, `the dropdown takes its row: ${routineBox.width} of ${bodyBox.width}`);
  assert.ok(routineBox.height <= 24 + 1, 'a compact dropdown');
  assert.ok(playBox.y >= routineBox.y + routineBox.height - 1 && playBox.x + playBox.width <= timeBox.x, 'the transport follows: play, then the time slider');
  // Its settings: a Speed submenu (the speed in hand beside it), then Autoplay and Loop. Ticking a
  // checkbox leaves the menu open.
  const settingsButton = heading.getByRole('button', { name: 'Animation settings', exact: true });
  const settings = page.getByRole('menu', { name: 'Animation settings', exact: true });
  const openSettings = async () => { await settingsButton.click(); await settings.waitFor(); };
  const checks = () => settings.getByRole('menuitemcheckbox').evaluateAll(items => items.map(item => `${item.textContent}:${item.getAttribute('aria-checked')}`));
  const speedItem = () => settings.getByRole('menuitem', { name: /^Speed/ });
  await openSettings();
  assert.equal((await speedItem().innerText()).replace(/\s+/g, ''), 'Speed1×');
  assert.deepEqual(await checks(), ['Autoplay:false', 'Loop:true']);
  await settings.getByRole('menuitemcheckbox', { name: 'Loop', exact: true }).click();
  assert.deepEqual(await checks(), ['Autoplay:false', 'Loop:false'], 'the menu stays open');
  await speedItem().hover();
  const speeds = page.locator('[role=menu][aria-label="Speed"]');
  await speeds.getByRole('menuitemradio', { name: '2×', exact: true }).click();
  await settings.waitFor({ state: 'detached' });
  await routine.click();
  await page.getByRole('option', { name: 'Short swing', exact: true }).click();
  assert.equal(await time.getAttribute('aria-valuemax'), '2');
  // The panel's play and pause drive the playback.
  await play.click();
  await pause.waitFor();
  await pause.click();
  await play.waitFor();
  assert.equal(await tool.getAttribute('aria-pressed'), 'true');
  // The new routine brought its own loop; turn it off again, and turn Autoplay on, before leaving.
  await openSettings();
  assert.equal((await speedItem().innerText()).replace(/\s+/g, ''), 'Speed2×');
  if ((await checks()).includes('Loop:true')) await settings.getByRole('menuitemcheckbox', { name: 'Loop', exact: true }).click();
  await settings.getByRole('menuitemcheckbox', { name: 'Autoplay', exact: true }).click();
  assert.deepEqual(await checks(), ['Autoplay:true', 'Loop:false']);
  assert.deepEqual(await page.evaluate(() => window.cadHarness.preferences.getSnapshot().animation), { autoplay: true }, 'Autoplay is a viewer preference');
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'detached' });
  await heading.getByRole('button', { name: 'Close animate', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
  assert.deepEqual(await view.stack(), ['Features'], 'the X hands back to Select');
  assert.equal(await view.tool('Select').getAttribute('aria-pressed'), 'true');
  // Leaving Animate keeps what its panel chose; with Autoplay on, taking it up again plays that
  // routine, at that speed, without the loop.
  await tool.click();
  await pause.waitFor();
  assert.equal(await time.getAttribute('aria-valuemax'), '2', 'the routine is the one chosen');
  assert.equal((await routine.innerText()).trim(), 'Short swing');
  await openSettings();
  assert.equal((await speedItem().innerText()).replace(/\s+/g, ''), 'Speed2×');
  assert.deepEqual(await checks(), ['Autoplay:true', 'Loop:false']);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.cadHarness.preferences.update({ animation: { autoplay: false } }));
  assert.deepEqual(errors, []);
});


test('fullscreen works without animations, retains the navbar and restores the tool stack', async t => {
  const original = harness.entry.sourceSidecar.animation;
  t.after(() => { harness.entry.sourceSidecar.animation = original; });
  let view;
  try { harness.entry.sourceSidecar.animation = { language: 'javascript', source: 'export const clips = {};' }; view = await open(); }
  finally { harness.entry.sourceSidecar.animation = original; }
  const { page, pane, errors } = view;
  assert.equal(await view.tool('Animate').count(), 0);
  await pane.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  const bar = pane.getByRole('toolbar', { name: 'Orbit playback' });
  await bar.getByRole('button', { name: 'Pause orbit' }).click();
  assert.equal(await bar.getByRole('button', { name: 'Play orbit' }).isVisible(), true);
  assert.equal(await pane.locator('[data-file-panel="tree"]').isVisible(), true, 'navbar stays visible');
  assert.equal(await pane.locator('[data-cad-tool-stack]').isVisible(), false, 'the tool stack goes with the toolbar');
  assert.equal(await pane.getByRole('img', { name: 'View cube' }).count(), 0);
  await pane.getByRole('button', { name: 'Orbit settings', exact: true }).click();
  assert.equal(await page.getByRole('menuitemcheckbox', { name: 'Orbit', exact: true }).getAttribute('aria-checked'), 'false');
  await page.keyboard.press('Escape');
  await pane.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await bar.waitFor({ state: 'detached' });
  assert.deepEqual(await view.stack(), ['Features'], 'and comes back as it was');
  assert.deepEqual(errors, []);
});

test('fullscreen restores camera and retained tools without changing saved effects', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  await view.tool('Clip').click();
  const clipTrack = await pane.getByRole('region', { name: 'Clip controls', exact: true }).locator('[data-slot=slider]').boundingBox();
  await page.mouse.click(clipTrack.x + clipTrack.width / 2, clipTrack.y + clipTrack.height / 2);
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.clip.enabled === true);
  await view.tool('Explode').click();
  await page.getByRole('slider', { name: 'Explode amount' }).press('End');
  await page.evaluate(() => window.cadHarness.a.controller.setCamera({ ...window.cadHarness.a.controller.readState().camera, zoom: 1.6, target: [4, 5, 2] }));
  const saved = await view.state();
  const stack = await pane.getByRole('region', { name: 'Explode controls', exact: true }).boundingBox();
  await pane.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  assert.equal(await view.tool('Clip').count(), 0);
  assert.equal(await page.getByRole('region', { name: 'Clip controls', exact: true }).count(), 0);
  assert.deepEqual((await view.state()).display.clip, saved.display.clip);
  await pane.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await pane.getByRole('slider', { name: 'Clip amount', exact: true }).waitFor();
  assert.deepEqual((await view.state()).display.clip, saved.display.clip);
  assert.deepEqual((await view.state()).display.exploded, saved.display.exploded);
  assert.deepEqual(await pane.getByRole('region', { name: 'Explode controls', exact: true }).boundingBox(), stack);
  const restored = (await view.state()).camera;
  for (const key of ['position', 'target', 'up']) saved.camera[key].forEach((value, i) => assert.ok(Math.abs(value - restored[key][i]) < 1e-6, `restored ${key}`));
  assert.equal(restored.zoom, saved.camera.zoom);
  assert.deepEqual(errors, []);
});

test('no pick or tool opens or turns the host\'s panel column: Select and Position show their panels in the stack', async () => {
  const view = await open();
  const {page, pane, errors} = view;
  // Nothing is open beside the file, and a pick opens nothing: its Reference joins the stack.
  await page.mouse.click(...view.at([15, 0, 4]));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.join() === 'o1.2');
  assert.deepEqual(await view.panels(), ['Show files:false']);
  assert.deepEqual(await view.stack(), ['Features', 'Reference details']);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.length === 0);
  // With the file tree open, a pick and the Position tool leave it where it is.
  await view.toggle('tree').click();
  await pane.getByPlaceholder('Filter files…').waitFor();
  await settle(page);
  await page.waitForTimeout(300);
  const treeCanvas = await pane.locator('[data-cad-surface] canvas').first().boundingBox();
  assert.ok(treeCanvas.width < view.box.width, 'the tree column narrows the viewport, as the host\'s column does');
  await page.mouse.click(...projector(await page.evaluate(() => window.__cadCamera()), treeCanvas)([15, 0, 4]));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.join() === 'o1.2');
  assert.deepEqual(await view.panels(), ['Hide files:true'], 'the pick left the file tree open');
  await pane.getByRole('region', { name: 'Reference details', exact: true }).waitFor();
  await view.tool('Position').click();
  assert.deepEqual(await view.panels(), ['Hide files:true'], 'so did the Position tool');
  assert.deepEqual(await view.stack(), ['Position controls']);
  // Escape is the viewer's: it never closes the host's column.
  await pane.locator('[data-slot="cad-file-view"]').focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert.equal(await pane.getByPlaceholder('Filter files…').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('reference action uses its own viewport bottom inset', async () => {
  const view = await open();
  await view.page.evaluate(() => window.cadHarness.a.controller.select({ selectors: ['o1.2'] }));
  const action = await view.pane.getByRole('button', { name: /^Copy Reference/ }).boundingBox();
  const canvas = await view.pane.locator('[data-cad-surface]').boundingBox();
  assert.ok(action.y + action.height <= canvas.y + canvas.height - 12);
  assert.ok(action.y + action.height >= canvas.y + canvas.height - 60);
  assert.deepEqual(view.errors, []);
});

test('annotations live in the chat box: making one puts it there, and its dot is on the model only while the chat box holds it', async () => {
  const view = await open();
  const {page, pane} = view;
  // A chat box that keeps annotations apart from its text, as the desktop's does: it says which it holds.
  await page.evaluate(() => {
    window.__delivered = [];
    window.__held = [];
    const harness = window.cadHarness.a;
    const hold = ids => { window.__held = ids; harness.setPromptDestination({held: [...ids]}); };
    window.__hold = hold;
    hold([]);
    harness.host.promptContext.deliver = async context => {
      window.__delivered.push(context.parts.map(part => ({kind: part.kind, id: part.id,
        selectors: part.references?.flatMap(reference => reference.target.selectors), text: part.text})));
      hold([...new Set([...window.__held, ...context.parts.map(part => part.id)])]);
      return {status: 'added', partIds: context.parts.map(part => part.id)};
    };
    harness.host.promptContext.retract = ids => hold(window.__held.filter(id => !ids.includes(id)));
  });
  const delivered = () => page.evaluate(() => window.__delivered);
  const annotate = async (selector, note) => {
    await page.evaluate(value => window.cadHarness.a.controller.select({selectors: [value]}), selector);
    await pane.getByRole('button', {name: 'Annotate', exact: true}).click();
    const box = page.getByRole('textbox', {name: 'Annotation', exact: true});
    await box.fill(note);
    await box.press('Enter');
  };

  // Making an annotation puts it in the chat box at once; nothing is sent to the agent by it.
  await annotate('o1.2', 'make a hole in it');
  await page.waitForFunction(() => window.__delivered.length === 1);
  const [first] = (await delivered())[0];
  assert.deepEqual([first.kind, first.selectors, first.text], ['annotation', ['o1.2'], 'make a hole in it']);
  assert.equal(await pane.getByRole('toolbar', {name: 'Annotations'}).count(), 0, 'there is no bar over the model');
  assert.equal(await pane.getByRole('list', {name: 'Annotations'}).count(), 0, 'annotations are not listed in the panel');

  // It is a numbered dot on the model, over the part it was made on; pressing the dot opens its card there.
  const dot = pane.getByRole('button', {name: 'Annotation 1', exact: true});
  await dot.waitFor();
  const dotBox = await dot.boundingBox();
  const canvasBox = await pane.locator('[data-cad-surface] canvas').first().boundingBox();
  assert.ok(dotBox.x > canvasBox.x && dotBox.x < canvasBox.x + canvasBox.width && dotBox.y > canvasBox.y && dotBox.y < canvasBox.y + canvasBox.height,
    'the dot is on the model, inside the viewport');
  const card = pane.getByRole('dialog', {name: 'Annotation 1 details'});
  await dot.click();
  await card.waitFor();
  assert.match((await card.innerText()).replace(/\s+/g, ' '), /^Annotation 1: .+ make a hole in it/);
  const chip = card.locator('[data-annotation-chip="o1.2"]');

  // Pressing the chip selects that geometry again, whatever is selected now.
  await page.evaluate(() => window.cadHarness.a.controller.select({selectors:['o1.1']}));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.join() === 'o1.1');
  await chip.click();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.join() === 'o1.2');

  // An edit replaces the chat box's copy: the same annotation, delivered again. The box opens
  // focused with the caret at the end, so typing goes straight into the note.
  await card.getByRole('button', {name: 'Edit annotation 1'}).click();
  const edit = card.getByRole('textbox', {name: 'Edit annotation 1'});
  assert.equal(await edit.evaluate(element => document.activeElement === element), true, 'the edit box has focus');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('make a 6 mm hole in it');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__delivered.length === 2);
  const [edited] = (await delivered())[1];
  assert.deepEqual([edited.id, edited.text], [first.id, 'make a 6 mm hole in it']);

  // Escape leaves the note as it was; clicking away from the box saves what was typed.
  await card.getByRole('button', {name: 'Edit annotation 1'}).click();
  await page.keyboard.type(' now');
  await page.keyboard.press('Escape');
  assert.match(await card.innerText(), /make a 6 mm hole in it$/m);
  await card.getByRole('button', {name: 'Edit annotation 1'}).click();
  await page.keyboard.type(', deburred');
  await card.getByText(/^Annotation 1:/).click();
  await page.waitForFunction(() => window.__delivered.length === 3);
  assert.equal((await delivered())[2][0].text, 'make a 6 mm hole in it, deburred');
  await card.getByRole('button', {name: 'Close', exact: true}).click();
  await card.waitFor({state: 'detached'});

  // The chat box names an annotation (its chip was pressed there): its geometry is selected and its card opens.
  await page.evaluate(() => window.cadHarness.a.controller.select({selectors:['o1.1']}));
  await page.evaluate(id => window.cadHarness.a.openAnnotation(id), first.id);
  await card.waitFor();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.join() === 'o1.2');

  // Deleting it on the model takes it out of the chat box.
  await card.getByRole('button', {name: 'Delete annotation 1'}).click();
  await dot.waitFor({state: 'detached'});
  assert.deepEqual(await page.evaluate(() => window.__held), []);

  // Sending the prompt (or removing the annotations from the chat box) takes their dots off the model.
  await annotate('o1.1', 'add a fillet');
  await annotate('o1.2', 'and chamfer it');
  const second = pane.getByRole('button', {name: 'Annotation 2', exact: true});
  await second.waitFor();
  await page.evaluate(() => window.__hold([]));
  await dot.waitFor({state: 'detached'});
  await second.waitFor({state: 'detached'});

  // With no chat to put them in, there is nothing to annotate into.
  await page.evaluate(() => window.cadHarness.a.setPromptDestination({available: false, reason: 'No chat'}));
  await page.evaluate(() => window.cadHarness.a.controller.select({selectors: ['o1.2']}));
  assert.equal(await pane.getByRole('button', {name: 'Annotate', exact: true}).isDisabled(), true);
  assert.deepEqual(view.errors, []);
});

test('reference CTA, double clicks and copy shortcut deliver references silently', async () => {
  const view = await open();
  const {page, pane, at, errors} = view;
  await page.evaluate(() => {
    window.__clipboardWrites = [];
    window.__imageCopies = [];
    window.cadHarness.a.host.clipboard.writeImage = async pending => { const blob = await pending; window.__imageCopies.push({size:blob.size,type:blob.type}); };
    window.cadHarness.a.host.clipboard.writeText = async text => { window.__clipboardWrites.push(text); };
  });
  await page.evaluate(() => window.cadHarness.a.controller.select({selectors:['o1.2']}));
  const action = pane.getByRole('button', {name:/^Copy Reference\b/});
  await action.click();
  await page.waitForFunction(() => window.__clipboardWrites.length === 1);
  // Every copy carries the file's prefix, the one way copied text is shaped (`copyTextLines`).
  assert.equal(await page.evaluate(() => window.__clipboardWrites[0]), 'hinge_block.step#o1.2');
  assert.ok((await action.boundingBox()).height >= 44);
  assert.equal(await page.locator('[data-slot=toast]').count(), 0, 'copy completes silently');
  await action.press('Control+c');
  await page.waitForFunction(() => window.__clipboardWrites.length === 2);
  await page.mouse.dblclick(...at([6,6,5]));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().isolatedPartIds.join() === 'o1.1');
  assert.equal(await page.evaluate(() => window.__clipboardWrites.length), 2, 'component double-click isolates rather than copying');
  await pane.getByRole('button', {name:'Select base',exact:true}).dblclick();
  assert.deepEqual((await view.state()).isolatedPartIds, ['o1.1']);
  assert.equal(await page.evaluate(() => window.__clipboardWrites.length), 2, 'tree component double-click never copies');
  await view.tool('Select').click();
  await view.chooseSelectMode('Faces');
  await page.mouse.dblclick(...at([6,6,5]));
  await page.waitForFunction(() => window.__clipboardWrites.length === 3);
  const face = await page.evaluate(() => window.__clipboardWrites[2]);
  assert.match(face, /^hinge_block\.step#o1\.1\.f\d+$/, 'a double-click copies what the Copy Reference button would');
  // ...and leaves the face it copied selected: the two clicks it is made of do not toggle it off.
  await page.waitForTimeout(350);
  const faceId = (await view.state()).selectedReferenceIds;
  assert.equal(faceId.length, 1, `the double-clicked face is the selection: ${JSON.stringify(faceId)}`);
  await pane.getByRole('button', { name: /^Copy Reference\b/ }).click();
  await page.waitForFunction(() => window.__clipboardWrites.length === 4);
  assert.equal(await page.evaluate(() => window.__clipboardWrites[3]), face, 'the button copies the same face, the same way');
  // A second double-click on the now-selected face copies again and still leaves it selected.
  await page.mouse.dblclick(...at([6,6,5]));
  await page.waitForFunction(() => window.__clipboardWrites.length === 5);
  await page.waitForTimeout(350);
  assert.deepEqual((await view.state()).selectedReferenceIds, faceId);
  await page.evaluate(() => { window.__clipboardWrites.splice(3); });
  await page.waitForTimeout(350);
  await view.tool('Select').click();
  await view.chooseSelectMode('Edges');
  await page.mouse.dblclick(...at([10,6,5]));
  await page.waitForFunction(() => window.__clipboardWrites.length === 4);
  assert.match(await page.evaluate(() => window.__clipboardWrites[3]), /#o1\.1\.e\d+/);
  assert.deepEqual((await view.state()).isolatedPartIds, ['o1.1'], 'topology double-click keeps isolation');
  await page.mouse.dblclick(view.box.x + 30, view.box.y + view.box.height - 30);
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().isolatedPartIds.length === 0);
  assert.ok(partBoxes(await view.frame()).arm, 'double-clicking empty space restores the other component');
  assert.equal(await page.evaluate(() => window.__clipboardWrites.length), 4, 'empty-space double-click does not copy');
  // A tree row's own Copy Reference is the same copy, prefix included.
  await pane.getByRole('button', { name: 'Select arm', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy Reference', exact: true }).click();
  await page.waitForFunction(() => window.__clipboardWrites.length === 5);
  assert.equal(await page.evaluate(() => window.__clipboardWrites[4]), 'hinge_block.step#o1.2');
  // The Reference panel's own Copy copies the reference its heading shows: with two faces picked,
  // the one browsed to in its picker, alone, through the same file-prefixed path.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => { const state = window.cadHarness.a.controller.readState(); return state.selectedPartIds.length + state.selectedReferenceIds.length === 0; });
  await view.chooseSelectMode('Faces');
  await page.mouse.click(...at([6, 6, 5]));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedReferenceIds.length === 1);
  await page.waitForTimeout(350);
  await page.keyboard.down('Shift');
  await page.mouse.click(...at([15, 0, 4]));
  await page.keyboard.up('Shift');
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedReferenceIds.length === 2);
  const faces = (await view.state()).selectedReferenceIds.map(id => `hinge_block.step#${id.split('|').at(-1)}`);
  assert.ok(faces.every(ref => /#o1\.\d\.f\d+$/.test(ref)), `two faces: ${faces}`);
  const reference = pane.getByRole('region', { name: 'Reference details', exact: true });
  const referenceHeading = reference.locator('[data-tool-panel-heading]');
  assert.deepEqual(await referenceHeading.getByRole('button', { name: /^(?:Copy reference|Clear selection|Collapse .*|Expand .*)$/ })
    .evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), ['Copy reference', 'Clear selection'], 'Copy, then the X; it does not fold');
  const picker = reference.getByRole('combobox', { name: 'Inspect selected reference' });
  assert.match((await picker.innerText()).replace(/\s+/g, ' '), / 2\/2$/);
  await picker.click();
  await page.getByRole('option').first().click();
  await page.getByRole('listbox').waitFor({ state: 'detached' });
  assert.match((await picker.innerText()).replace(/\s+/g, ' '), / 1\/2$/, 'browsed to the first');
  const copy = referenceHeading.getByRole('button', { name: 'Copy reference', exact: true });
  await copy.click();
  await page.waitForFunction(() => window.__clipboardWrites.length === 6);
  assert.equal(await page.evaluate(() => window.__clipboardWrites[5]), faces[0], 'only the face on show, file-prefixed');
  assert.equal(await copy.locator('svg.lucide-check').count(), 1, 'a check says it was copied');
  await copy.locator('svg.lucide-copy').waitFor({ timeout: 3000 });
  assert.equal(await page.locator('[data-slot=toast]').count(), 0);
  await view.chooseSelectMode('All');
  await view.tool('Draw').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="one"] [data-drawing-ready]'));
  await page.mouse.move(view.box.x + 150, view.box.y + 150);
  await page.mouse.down();
  await page.mouse.move(view.box.x + 250, view.box.y + 200, {steps:8});
  await page.mouse.up();
  const drawingAction = pane.getByRole('button', {name:/^Copy Drawing/});
  await drawingAction.waitFor();
  await drawingAction.press('Control+c');
  await page.waitForFunction(() => window.__imageCopies.length === 1);
  assert.equal(await page.evaluate(() => window.__imageCopies[0].type), 'image/png');
  assert.ok(await page.evaluate(() => window.__imageCopies[0].size > 100));
  assert.equal(await page.locator('[data-slot=toast]').count(), 0);
  assert.deepEqual(errors, []);
});


test('toolbar tooltips wait for deliberate hover and never stick after selection or a second press', async () => {
  const view = await open();
  const { page } = view;
  const tips = page.getByRole('tooltip');
  const draw = view.tool('Draw'), measure = view.tool('Measure');
  await draw.hover();
  await page.waitForTimeout(150);
  assert.equal(await tips.count(), 0, 'passing over a tool does not flash a tooltip');
  await page.getByRole('tooltip', { name: 'Draw', exact: true }).waitFor();
  // Leaving toward the tip must dismiss it, rather than creating a hover bridge.
  const tipBox = await tips.boundingBox();
  await page.mouse.move(tipBox.x + tipBox.width / 2, tipBox.y + tipBox.height / 2);
  await tips.waitFor({ state: 'detached' });
  await measure.hover();
  await page.waitForTimeout(150);
  assert.equal(await tips.count(), 0, 'switching tools keeps the same hover delay');
  await page.getByRole('tooltip', { name: 'Measure', exact: true }).waitFor();
  await measure.click();
  await tips.waitFor({ state: 'detached' });
  // A second press puts Measure down again and opens nothing: no tool has a menu on the strip.
  await measure.click();
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(await tips.count(), 0, 'a second press does not bring the tip back');
  await page.mouse.move(view.box.x + 20, view.box.y + 150);
  await view.tool('Select').click();
  await page.mouse.move(view.box.x + 20, view.box.y + 150);
  await page.waitForTimeout(500);
  assert.equal(await tips.count(), 0, 'deselection never resurrects a previously open tooltip');
  // Display settings, like Fullscreen beside it, carries no tooltip; opening its popover by click
  // pins none either.
  const display = view.tool('Display');
  await display.hover();
  await page.waitForTimeout(700);
  assert.equal(await tips.count(), 0, 'the Display settings button has no tooltip');
  await display.click();
  await view.displayPanel().waitFor();
  await page.waitForTimeout(500);
  assert.equal(await tips.count(), 0, 'click focus does not pin a tooltip');
  await display.click();
  await view.displayPanel().waitFor({ state: 'detached' });
  await page.mouse.move(view.box.x + 20, view.box.y + 150);
  await view.pane.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  assert.equal(await tips.count(), 0, 'fullscreen hides editor tooltips');
  assert.deepEqual(view.errors, []);
});

test('animated Render bounds follow moving geometry without moving the camera or resizing the floor', async () => {
  const animation = harness.entry.sourceSidecar.animation;
  const original = animation.source;
  let view;
  try {
    animation.source = `export const clips = { swing: { label: "Approach", duration: 4, loop: true,
      update(t, m) { m.get("arm").translate([t * 8, -t * 8, t * 4]); } } };`;
    view = await open();
  } finally { animation.source = original; }
  const { page, pane } = view;
  await page.evaluate(() => { void window.cadHarness.a.controller.setRenderMode(true); });
  await page.waitForFunction(() => window.__cadStage()?.studioGround, null, { timeout: 10000 });
  const before = await page.evaluate(() => ({ camera: window.__cadCamera(), stage: window.__cadStage() }));
  await view.tool('Animate').click();
  // Autoplay is off: the panel's play button starts the routine.
  await pane.getByRole('region', { name: 'Animate controls', exact: true }).getByRole('button', { name: 'Play animation', exact: true }).click();
  await page.waitForFunction(() => window.__cadStage().bounds.max[0] > 35, null, { timeout: 10000 });
  await page.mouse.move(view.box.x + 20, view.box.y + 100);
  await pane.getByRole('button', { name: 'Pause animation', exact: true }).click();
  await settle(page);
  const after = await page.evaluate(() => ({ camera: window.__cadCamera(), stage: window.__cadStage(), records: window.__cadDisplayRecords() }));
  assert.ok(after.stage.bounds.max[0] > before.stage.bounds.max[0] + 10, 'live bounds include the translated arm');
  assert.deepEqual(after.stage.studioGround, before.stage.studioGround, 'ground footprint stays anchored at rest');
  for (const key of ['position', 'target', 'zoom']) {
    const actual = [].concat(after.camera[key]), expected = [].concat(before.camera[key]);
    assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) < 1e-8), `animation preserves ${key}`);
  }
  assert.ok(after.camera.near < before.camera.near, 'near plane follows the approaching part');
  const forward = after.camera.target.map((value, axis) => value - after.camera.position[axis]);
  const length = Math.hypot(...forward);
  const depths = [0, 1, 2, 3, 4, 5, 6, 7].map(mask => [0, 1, 2].reduce((sum, axis) => {
    const value = after.stage.bounds[(mask & (1 << axis)) ? 'max' : 'min'][axis];
    return sum + (value - after.camera.position[axis]) * forward[axis] / length;
  }, 0));
  assert.ok(Math.min(...depths) > after.camera.near && Math.max(...depths) < after.camera.far,
    'all corners of the moving model remain within the depth range');
  // The actual presented frame must still contain the moving arm.
  const shot = await view.frame();
  assert.ok(partBoxes(shot).arm?.count > 100, 'moving arm remains drawn in Render');
  assert.deepEqual(view.errors, []);
});

test('Fullscreen fills the viewer below the navbar, leaves the host\'s file tree as it is, and restores the tool stack from its exit control', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  // The host's column is the file tree here: fullscreen is the viewer's, and leaves it open and its
  // toggle live.
  await view.toggle('tree').click();
  const sheet = pane.locator('[data-file-panel-container="tree"]');
  await sheet.waitFor();
  const before = await sheet.boundingBox();
  await view.tool('Position').click();
  const viewportBefore = await pane.locator('[data-cad-surface] canvas').first().boundingBox();
  const toolbar = await pane.locator('[data-cad-tool-groups]').boundingBox();
  assert.ok(Math.abs(toolbar.x - viewportBefore.x - 8) < 2, 'toolbar is inset 8px from the viewport left');
  await pane.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await pane.getByRole('button', { name: 'Exit fullscreen', exact: true }).waitFor();
  assert.equal(await sheet.isVisible(), true, 'the file tree stays open');
  assert.deepEqual(await sheet.boundingBox(), before);
  assert.equal(await pane.locator('[data-file-panel]').evaluateAll(nodes => nodes.every(node => !node.disabled)), true, 'and its toggle stays live');
  assert.equal(await pane.locator('[data-cad-tool-stack]').isVisible(), false);
  const viewportDuring = await pane.locator('[data-cad-surface] canvas').first().boundingBox();
  assert.equal(viewportDuring.width, viewportBefore.width, 'the viewer keeps the width beside the column');
  assert.equal(await pane.locator('header [data-file-navigation-status]').count(), 1);
  assert.equal(await pane.locator('header').isVisible(), true);
  assert.equal(await pane.locator('[data-cad-toolbar]').isVisible(), false);
  assert.equal(await pane.getByLabel('View cube', { exact: true }).isVisible(), false);
  await page.mouse.move(viewportDuring.x + viewportDuring.width - 20, viewportDuring.y + 20);
  await pane.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await pane.getByRole('button', { name: 'Fullscreen', exact: true }).waitFor();
  assert.equal((await sheet.boundingBox()).width, before.width);
  assert.deepEqual(await view.stack(), ['Position controls'], 'the tool in hand shows its panel again');
  assert.equal(await pane.locator('[data-file-panel]').evaluateAll(nodes => nodes.every(node => !node.disabled)), true);
  assert.deepEqual(errors, []);
});

test('Fullscreen settings and playback share visibility while editor controls stay hidden; Escape preserves the tool stack', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  const sheet = pane.locator('[data-cad-tool-stack]');
  await view.tool('Position').click();
  await pane.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await sheet.waitFor({ state: 'hidden' });
  const bar = pane.getByRole('toolbar', { name: 'Animation playback' });
  await bar.getByRole('button', { name: 'Play animation', exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('[data-preview-controls] [role="slider"][aria-label="Animation time"]')?.getAttribute('aria-valuenow')) > 0.1);
  await bar.hover();
  await page.waitForTimeout(1200);
  assert.equal(await pane.locator('[data-preview-controls]').getAttribute('data-visible'), 'true');
  await pane.getByRole('button', { name: 'Animation settings', exact: true }).click();
  await page.getByRole('menu').waitFor();
  await page.waitForTimeout(1200);
  assert.equal(await pane.locator('[data-preview-controls]').getAttribute('data-visible'), 'true', 'open settings stay available');
  await page.keyboard.press('Escape');
  assert.equal(await sheet.isVisible(), false, 'menu dismissal does not exit Preview');
  const canvas = await pane.locator('[data-cad-surface] canvas').first().boundingBox();
  await page.mouse.move(canvas.x + 30, canvas.y + 100);
  await page.waitForFunction(() => document.querySelector('[data-preview-controls]')?.dataset.visible === 'false');
  assert.equal(await pane.locator('[data-preview-controls]').getAttribute('inert'), '');
  assert.equal(await pane.locator('[data-cad-toolbar]').isVisible(), false);
  await page.mouse.move(canvas.x + 40, canvas.y + 100);
  assert.equal(await pane.locator('[data-preview-controls]').getAttribute('data-visible'), 'true');
  assert.equal(await pane.locator('[data-cad-toolbar]').isVisible(), false);
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'visible' });
  assert.deepEqual(await view.stack(), ['Position controls']);
  assert.equal(await pane.getByRole('button', { name: 'Fullscreen', exact: true }).isVisible(), true);
  assert.deepEqual(errors, []);
});

test('Position is headed with its Reset and its X, offers Default beside a named pose, and marks its tool while posed', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  await view.tool('Position').click();
  const panel = pane.getByRole('region', { name: 'Position controls', exact: true });
  const preset = panel.getByRole('combobox', { name: 'Pose', exact: true });
  const heading = panel.locator('[data-tool-panel-heading]');
  const reset = heading.getByRole('button', { name: 'Reset', exact: true });
  const value = panel.getByLabel('hinge slider value', { exact: true });
  assert.equal((await heading.getByRole('heading').innerText()).trim(), 'Position');
  assert.equal((await preset.innerText()).trim(), 'Default');
  // The Pose row is a label beside its dropdown, above the joint values: a compact dropdown, right-aligned.
  await assertPairedRow(panel, 'Pose', preset);
  assert.equal((await preset.boundingBox()).height, 24, 'compact');
  assert.equal(await preset.evaluate(node => getComputedStyle(node).fontSize), '11px');
  // Its rows start where the heading's text does: no inset of their own.
  const [headingText, poseLabel] = await Promise.all([heading.getByRole('heading').boundingBox(), panel.getByText('Pose', { exact: true }).boundingBox()]);
  assert.ok(Math.abs(headingText.x - poseLabel.x) <= 1, `the rows align with the heading: ${headingText.x} vs ${poseLabel.x}`);
  const headerBox = await panel.locator('[data-position-header]').boundingBox();
  assert.ok((await value.boundingBox()).y >= headerBox.y + headerBox.height);
  const joint = panel.locator('[data-position-control]').first();
  const labelBox = await joint.getByText('hinge', { exact: true }).boundingBox();
  const valueBox = await value.boundingBox();
  const sliderBox = await joint.getByRole('slider', { name: 'hinge', exact: true }).boundingBox();
  // Every joint's slider thumb is named for its joint, not only its number field.
  assert.deepEqual(await panel.locator('[role=slider]').evaluateAll(thumbs => thumbs.filter(thumb => !thumb.getAttribute('aria-label')).length), 0,
    'no unnamed slider thumb');
  assert.ok(sliderBox.x + sliderBox.width < valueBox.x, 'numeric value sits beside the label/slider pair');
  assert.ok(sliderBox.y >= labelBox.y + labelBox.height - 4, 'slider is directly beneath its label');
  assert.equal((await reset.boundingBox()).width, 20, 'a small Reset in the heading');
  await preset.click();
  await page.getByRole('option', { name: 'open', exact: true }).click();
  assert.equal(await value.inputValue(), '90.0°');
  await preset.click();
  await page.getByRole('option', { name: 'Default', exact: true }).click();
  assert.equal(await value.inputValue(), '0.00°');
  assert.equal((await preset.innerText()).trim(), 'Default');
  // Posed off its default, the strip's Position icon carries a dot; Reset takes it away.
  const custom = view.tool('Position').locator('[data-position-custom]');
  assert.equal(await custom.count(), 0);
  await value.fill('25'); await value.press('Enter');
  assert.equal((await preset.innerText()).trim(), 'Custom');
  await custom.waitFor();
  await reset.click();
  assert.equal(await value.inputValue(), '0.00°');
  assert.equal((await preset.innerText()).trim(), 'Default');
  await custom.waitFor({ state: 'detached' });
  // It does not fold: Reset, then the X, which puts Position down and hands back to Select.
  assert.deepEqual(await heading.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), ['Reset', 'Close position']);
  await heading.getByRole('button', { name: 'Close position', exact: true }).click();
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await view.tool('Select').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await view.stack(), ['Features']);
  assert.deepEqual(errors, []);
});

test('Display opens over Draw and leaves it the tool, its panel, its overlay and its sketch', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  await view.tool('Draw').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="one"] [data-drawing-ready]'));
  const canvas = await pane.locator('canvas.excalidraw__canvas.interactive').boundingBox();
  await page.mouse.move(canvas.x + 300, canvas.y + 120);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 190, canvas.y + 170, { steps: 8 });
  await page.mouse.up();
  await pane.getByRole('button', { name: /Copy Drawing/i }).waitFor();
  const display = view.tool('Display');
  assert.equal(await display.isEnabled(), true, 'Display is available while drawing');
  const pressed = () => pane.getByRole('group', { name: 'Interaction tools' }).locator('button[aria-pressed="true"]').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  await display.click();
  await view.displayPanel().waitFor();
  assert.deepEqual(await pressed(), ['Draw'], 'Draw is still the tool');
  assert.equal(await pane.locator('[data-cad-drawing-overlay]').count(), 1, 'its overlay stays');
  assert.deepEqual(await view.stack(), ['Drawing controls'], 'and its panel');
  await page.keyboard.press('Escape');
  await view.displayPanel().waitFor({ state: 'hidden' });
  assert.equal(await display.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(await pressed(), ['Draw']);
  assert.equal(await pane.getByRole('button', { name: /Copy Drawing/i }).count(), 1, 'the sketch is kept');
  // A press on the drawing surface puts the popover away and leaves Draw as it was.
  await display.click();
  await view.displayPanel().waitFor();
  await page.mouse.click(canvas.x + 60, canvas.y + canvas.height - 60);
  await view.displayPanel().waitFor({ state: 'hidden' });
  assert.deepEqual(await pressed(), ['Draw']);
  assert.equal(await pane.getByRole('button', { name: /Copy Drawing/i }).count(), 1);
  assert.deepEqual(errors, []);
});

test('Draw history buttons track the SDK stacks, including empty canvas and discarded redo', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  await view.tool('Draw').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="one"] [data-drawing-ready]'));
  // Draw's tools, color and history are a stack panel while it is up.
  const panel = pane.locator('[data-tool-panel][aria-label="Drawing controls"]');
  await panel.waitFor();
  assert.deepEqual(await view.stack(), ['Drawing controls']);
  const undo = panel.getByRole('button', { name: 'Undo', exact: true });
  const redo = panel.getByRole('button', { name: 'Redo', exact: true });
  assert.equal(await undo.isEnabled(), false);
  assert.equal(await redo.isEnabled(), false);
  assert.equal(await panel.getByRole('button', { name: 'Select and move drawings', exact: true }).locator('svg.lucide-square-mouse-pointer').count(), 1);
  await panel.getByRole('button', { name: 'Line', exact: true }).click();
  const canvas = await pane.locator('canvas.excalidraw__canvas.interactive').boundingBox();
  const stroke = async offset => {
    await page.mouse.move(canvas.x + 300, canvas.y + 100 + offset);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 410, canvas.y + 150 + offset, { steps: 8 });
    await page.mouse.up();
  };
  const history = async (canUndo, canRedo) => page.waitForFunction(({ canUndo, canRedo }) => {
    const panel = document.querySelector('[data-testid="one"] [data-tool-panel][aria-label="Drawing controls"]');
    return panel?.querySelector('[aria-label="Undo"]')?.disabled === !canUndo
      && panel?.querySelector('[aria-label="Redo"]')?.disabled === !canRedo;
  }, { canUndo, canRedo });
  await stroke(0);
  await history(true, false);
  await undo.click();
  await history(false, true);
  await redo.click();
  await history(true, false);
  await panel.getByRole('button', { name: 'Clear drawing', exact: true }).click();
  await history(true, false);
  await undo.click();
  await history(true, true);
  await stroke(40);
  await history(true, false);
  // A second press puts Draw down, panel and all; taking it up again starts a fresh sketch.
  await view.tool('Draw').click();
  await panel.waitFor({ state: 'detached' });
  await view.tool('Draw').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="one"] [data-drawing-ready]'));
  await history(false, false);
  // Headed "Draw", it does not fold; its X puts Draw down and hands back to Select.
  const heading = panel.locator('[data-tool-panel-heading]');
  assert.equal((await heading.getByRole('heading').innerText()).trim(), 'Draw');
  assert.deepEqual(await heading.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), ['Close draw']);
  await heading.getByRole('button', { name: 'Close draw', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
  assert.equal(await view.tool('Select').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await view.stack(), ['Features']);
  assert.deepEqual(errors, []);
});

test('mobile: the tool stack and the file tree sheet overlay the scene, the tree starts folded and may take the whole column, and the full toolbar fits down to 320px', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  const resize = async width => {
    await page.setViewportSize({ width, height: 800 });
    await pane.evaluate((element, width) => { element.parentElement.style.width = `${width}px`; }, width);
    await page.waitForFunction(mobile => document.querySelector('[data-viewer-layout]')?.dataset.viewerLayout === (mobile ? 'mobile' : 'desktop'), width < 720);
    await settle(page);
  };
  for (const width of [719, 390, 320]) {
    await resize(width);
    // The same stack as on desktop, Select's Features over the scene; on a phone it starts folded
    // to its filter row: the model gets the screen.
    const features = pane.getByRole('region', { name: 'Features', exact: true });
    assert.equal(await features.getAttribute('data-collapsed'), '', `folded at ${width}px`);
    const filterRow = await features.locator('[data-slot=tree-filter]').boundingBox();
    assert.ok(Math.abs((await features.boundingBox()).height - filterRow.height - 2) <= 1, 'to its filter row');
    const scene = pane.locator('[data-cad-scene-backdrop]');
    const before = await scene.boundingBox();
    const toolbar = await pane.getByRole('group', { name: 'Interaction tools' }).boundingBox();
    const fullscreen = await pane.getByRole('button', { name: 'Fullscreen', exact: true }).boundingBox();
    const displayButton = await view.tool('Display').boundingBox();
    assert.ok(toolbar.x + toolbar.width <= displayButton.x && displayButton.x + displayButton.width <= fullscreen.x + 1,
      'toolbar leaves room for Display settings and Fullscreen, in that order');
    assert.ok(Math.abs(toolbar.y + toolbar.height / 2 - fullscreen.y - fullscreen.height / 2) < 1, 'fullscreen aligns with the toolbar');
    assert.ok(Math.abs(displayButton.y + displayButton.height / 2 - fullscreen.y - fullscreen.height / 2) < 1, 'and so does Display settings');
    const buttons = await pane.getByRole('group', { name: 'Interaction tools' }).locator('button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
    assert.equal(new Set(buttons).size, 1, `all seven tools fit one row at ${width}px`);
    assert.equal(await pane.getByRole('img', { name: 'View cube' }).count(), 0, 'no cube on mobile');
    await page.evaluate(() => {
      window.__panelLayoutFrames = [];
      const sample = () => {
        const root = document.querySelector('[data-viewer-layout]');
        const panel = root.querySelector('[data-mobile-panel]')?.getBoundingClientRect();
        const bounds = root.getBoundingClientRect();
        window.__panelLayoutFrames.push({ x: bounds.x, scroll: window.scrollX, width: document.documentElement.scrollWidth,
          panelWithin: !panel || (panel.left >= bounds.left && panel.right <= bounds.right) });
        if (window.__panelLayoutFrames.length < 45) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await view.toggle('tree').click();
    const sheet = pane.locator('[data-mobile-panel]');
    await sheet.waitFor();
    await sheet.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
    assert.equal((await scene.boundingBox()).width, before.width, 'opening the sheet never resizes the scene');
    const close = await sheet.getByRole('button', { name: 'Close panel' }).boundingBox();
    assert.equal(close.width, 20, 'compact sidebar close button');
    const box = await sheet.boundingBox();
    assert.ok(box.x >= before.x && box.x + box.width <= before.x + before.width);
    assert.equal(await sheet.locator('[data-slot=sheet-title]').evaluate(node => getComputedStyle(node).position), 'absolute', 'accessible name has no visible title row');
    await pane.getByPlaceholder('Filter files…').waitFor();
    await pane.getByRole('button', { name: 'Close panel' }).click();
    await sheet.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__panelLayoutFrames.length === 45);
    const frames = await page.evaluate(() => window.__panelLayoutFrames);
    assert.ok(frames.every(frame => frame.x === 0 && frame.scroll === 0 && frame.width === width && frame.panelWithin), `no sideways movement during opening/switching/closing: ${JSON.stringify(frames)}`);
  }
  // Opened on a phone, the tree may take the whole column (its default cap there); with a Reference
  // up too, both fit, and the page never scrolls sideways or down.
  await resize(390);
  const features = pane.getByRole('region', { name: 'Features', exact: true });
  await features.getByRole('button', { name: 'Expand features', exact: true }).click();
  await features.getByRole('button', { name: 'Collapse features', exact: true }).waitFor();
  const stackColumn = pane.locator('[data-cad-tool-stack]');
  assert.equal(await features.evaluate(node => node.style.maxHeight), `${await stackColumn.evaluate(node => node.clientHeight)}px`, 'capped at the whole column');
  await page.evaluate(() => window.cadHarness.a.controller.select({ selectors: ['o1.2'] }));
  const referencePanel = pane.getByRole('region', { name: 'Reference details', exact: true });
  await referencePanel.waitFor();
  const [openedTree, openedReference, columnBox] = await Promise.all([features.boundingBox(), referencePanel.boundingBox(), stackColumn.boundingBox()]);
  assert.ok(openedReference.y >= openedTree.y + openedTree.height && openedReference.y + openedReference.height <= columnBox.y + columnBox.height + 1,
    `both fit in the column: ${JSON.stringify({ openedTree, openedReference, columnBox })}`);
  assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth <= innerWidth, document.documentElement.scrollHeight <= innerHeight]), [true, true], 'no page overflow');
  await page.evaluate(() => window.cadHarness.a.controller.clearSelection());
  await referencePanel.waitFor({ state: 'detached' });
  // Display is a popover, not a panel of the stack: on mobile too it opens over the scene, within
  // it, and the stack keeps Select's Features.
  await view.tool('Display').click();
  const display = view.displayPanel();
  await display.waitFor();
  const [displayBox, sceneBox] = await Promise.all([display.boundingBox(), pane.locator('[data-cad-scene-backdrop]').boundingBox()]);
  assert.equal(await display.getAttribute('data-tool-panel'), null, 'not a stack panel');
  assert.deepEqual(await view.stack(), ['Features']);
  assert.ok(displayBox.x >= sceneBox.x && displayBox.x + displayBox.width <= sceneBox.x + sceneBox.width, `within the scene's width: ${JSON.stringify(displayBox)}`);
  assert.ok(displayBox.y + displayBox.height <= sceneBox.y + sceneBox.height + 1, 'and never taller than it');
  await view.tool('Display').click();
  await display.waitFor({ state: 'detached' });
  await resize(720);
  assert.equal(await pane.getByRole('region', { name: 'Features', exact: true }).getAttribute('data-collapsed'), null, 'open on desktop');
  assert.equal(await pane.locator('[data-mobile-panel]').count(), 0);
  assert.equal(await pane.locator('[data-file-panel-container]').count(), 0, 'a file opens nothing in the column on desktop either');
  assert.equal(await pane.getByRole('separator', { name: 'Resize tool panels' }).count(), 1);
  assert.equal(await pane.getByRole('button', { name: /^Orbit (left|right|up|down)$/ }).count(), 0);
  assert.equal(await pane.locator('[data-cad-camera-controls]').count(), 0);
  assert.deepEqual(errors, []);
});

test('reopening ignores a saved camera and fits the model at the default perspective', async () => {
  const view = await open();
  const initial = (await view.state()).camera;
  await view.page.evaluate(() => {
    const controller = window.cadHarness.a.controller;
    const camera = controller.readState().camera;
    controller.setCamera({ ...camera, position: camera.position.map(value => value * 2), target: [15, 20, 5], zoom: 3 });
  });
  assert.notDeepEqual((await view.state()).camera.position, initial.position);
  const stored = await view.page.evaluate(() => window.cadHarness.state);
  for (const record of Object.values(stored.renderers)) record.camera = { ...initial, target: [15, 20, 5], zoom: 3, position: initial.position.map(value => value * 2) };
  const reopened = await open({ state: stored });
  const actual = (await reopened.state()).camera;
  for (const property of ['position', 'target', 'zoom']) {
    const a = [actual[property]].flat(), b = [initial[property]].flat();
    assert.ok(a.every((value, index) => Math.abs(value - b[index]) < 1e-8), `${property} is fitted fresh`);
  }
  assert.deepEqual(reopened.errors, []);
});

test('navigation and tools share short tooltips without native titles or fullscreen hints', async () => {
  const view = await open();
  const { page, pane, errors } = view;
  await view.toggle('tree').hover();
  await page.getByRole('tooltip', { name: 'Files', exact: true }).waitFor();
  const navigationStyle = await page.locator('[data-slot="tooltip-content"]').first().getAttribute('class');
  await view.tool('Draw').hover();
  await page.getByRole('tooltip', { name: 'Draw', exact: true }).waitFor();
  const toolbarStyle = await page.locator('[data-slot="tooltip-content"]').first().getAttribute('class');
  assert.equal(toolbarStyle, navigationStyle);
  await pane.getByRole('button', { name: 'Fullscreen', exact: true }).hover();
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole('tooltip').count(), 0);
  // Display settings is Fullscreen's neighbour, and like it carries no hint.
  await view.tool('Display').hover();
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole('tooltip').count(), 0);
  await view.tool('Draw').hover();
  await page.getByRole('tooltip', { name: 'Draw', exact: true }).waitFor();
  await view.tool('Display').click();
  await view.displayPanel().waitFor();
  assert.equal(await page.getByRole('tooltip').count(), 0, 'pressing a trigger dismisses any hint');
  const titles = await pane.locator('[title]').evaluateAll(nodes => nodes.map(node => node.getAttribute('title')).filter(Boolean));
  assert.deepEqual(titles, [], 'the viewer no longer mixes native hints with styled tooltips');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole('tooltip').count(), 0, 'menu focus restoration does not resurrect a hint');
  // Tabbing IS navigation: the control a Tab lands on names itself.
  await view.tool('Position').focus();
  await page.keyboard.press('Tab');
  await page.getByRole('tooltip', { name: 'Animate', exact: true }).waitFor();
  await pane.getByRole('button', { name: 'File actions', exact: true }).click();
  await page.getByRole('menu', { name: 'File actions', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
});

test('mobile touch operates every STEP tool without hover or accidental pinch selections', async () => {
  const view = await open({ hasTouch: true, timeout: 10000 });
  const { page, pane, errors } = view;
  await page.setViewportSize({ width: 390, height: 844 });
  await pane.evaluate(element => { element.parentElement.style.width = '390px'; });
  await page.waitForFunction(() => document.querySelector('[data-viewer-layout]')?.dataset.viewerLayout === 'mobile');
  await page.waitForTimeout(700);
  const touch = await page.context().newCDPSession(page);
  const points = coords => coords.map(([x, y], id) => ({ x, y, id, radiusX: 3, radiusY: 3, force: 1 }));
  const gesture = async frames => {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(frames[0]) });
    for (const coords of frames.slice(1)) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(coords) });
      await settle(page);
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(page);
  };
  const slide = async slider => {
    const root = slider.locator('xpath=ancestor::*[@data-slot="slider"]');
    const box = await root.boundingBox();
    const thumb = await slider.boundingBox();
    await gesture([[[thumb.x + thumb.width / 2, thumb.y + thumb.height / 2]], [[box.x + box.width * .6, box.y + box.height / 2]]]);
  };
  const sceneBox = await pane.locator('[data-cad-scene-backdrop]').boundingBox();
  const project = projector(await page.evaluate(() => window.__cadCamera()), sceneBox);
  // Collapse nothing: on a phone the Features panel is on screen with Select, as on desktop.
  assert.deepEqual(await view.stack(), ['Features']);
  // Select's modes are a menu in the Features filter row, by touch as by pointer: the strip opens no menu.
  const tapMode = async name => {
    await pane.getByRole('button', { name: /^Select mode: / }).tap();
    await page.locator('[role=menu][aria-label="Select mode"]').getByRole('menuitemradio', { name, exact: true }).tap();
    await page.locator('[role=menu]').waitFor({ state: 'detached' });
  };
  await tapMode('Parts');
  await page.touchscreen.tap(...project([6, 6, 5]));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.length === 1);
  assert.equal(await pane.locator('[data-mobile-panel]').count(), 0, 'a touch pick opens no sheet over the model');
  assert.deepEqual(await view.stack(), ['Features', 'Reference details'], 'its Reference joins the stack');
  const copyAction = pane.getByRole('button', { name: /Copy Reference/ });
  await copyAction.waitFor();
  assert.ok((await copyAction.boundingBox()).width < 260, 'the mobile action hugs its content');
  assert.equal(await copyAction.locator('kbd').count(), 0, 'no desktop shortcut on mobile');
  await tapMode('Faces');
  // Under Faces, one tap on a part picks the face under it.
  await page.touchscreen.tap(...project([15, 0, 4]));
  await page.waitForFunction(() => /\|o1\.2\.f\d+$/.test(window.cadHarness.a.controller.readState().selectedReferenceIds.join()));
  await tapMode('All');
  await view.tool('Measure').tap();
  await page.getByRole('region', { name: 'Measure controls', exact: true }).waitFor();
  for (const point of [[0, 0, 5], [15, 0, 4]]) await page.touchscreen.tap(...project(point));
  await page.getByRole('region', { name: 'Measurements', exact: true }).waitFor();
  assert.match(await page.getByRole('region', { name: 'Measurements', exact: true }).innerText(), /\d+\.\d+ mm/);
  await page.getByRole('button', { name: 'Close measure controls' }).tap();

  // Starting a second finger cancels a pending pick, even before either finger moves.
  await view.tool('Select').tap();
  const onModel = project([6, 6, 5]);
  await gesture([[onModel, [onModel[0] + 35, onModel[1]]], [onModel, [onModel[0] + 36, onModel[1]]]]);
  await page.waitForTimeout(250);
  assert.equal((await view.state()).selectedPartIds.length, 0);
  const cameraBefore = (await view.state()).camera;
  await gesture([[[150, 420]], [[180, 440]], [[205, 460]]]);
  await page.waitForTimeout(400);
  assert.notDeepEqual((await view.state()).camera.position, cameraBefore.position, 'one finger orbits');
  assert.equal((await view.state()).selectedPartIds.length, 0, 'orbiting never picks');

  await view.tool('Explode').tap();
  await slide(page.getByRole('slider', { name: 'Explode amount' }));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.exploded.amount > 0);
  await page.getByRole('button', { name: 'Close explode controls' }).tap();
  await view.tool('Clip').tap();
  await slide(page.getByRole('slider', { name: 'Clip amount' }));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.clip.enabled);
  await page.getByLabel('Clip Y axis', { exact: true }).tap();
  assert.equal((await view.state()).display.clip.axis, 'y');
  await page.getByRole('button', { name: 'Close clip controls' }).tap();

  // The file tree sheet stays the person's on mobile: a selection never turns it or closes it.
  await view.toggle('tree').tap();
  await pane.getByPlaceholder('Filter files…').waitFor();
  await page.evaluate(() => window.cadHarness.a.controller.select({ selectors: ['o1.2'] }));
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedPartIds.join() === 'o1.2');
  await page.waitForTimeout(150);
  assert.equal(await pane.getByPlaceholder('Filter files…').isVisible(), true, 'the tree sheet stays');
  await pane.getByRole('button', { name: 'Close panel' }).tap();
  await pane.locator('[data-mobile-panel]').waitFor({ state: 'detached' });

  // Position shows its panel in the stack, and its knob drags a joint, not the camera.
  await view.tool('Position').tap();
  assert.equal(await pane.locator('[data-mobile-panel]').count(), 0);
  assert.deepEqual(await view.stack(), ['Position controls']);
  await page.waitForFunction(() => window.__cadJointHandles().length === 1);
  const [knob] = await page.evaluate(() => window.__cadJointHandles());
  const camera = (await view.state()).camera;
  await gesture([[[sceneBox.x + knob.x, sceneBox.y + knob.y]], ...knob.travel.slice(1, 9).map(([x, y]) => [[sceneBox.x + x, sceneBox.y + y]])]);
  await page.waitForFunction(() => Math.abs(window.__cadJointHandles()[0].value) > 1);
  assert.ok((await view.state()).camera.position.every((value, index) => Math.abs(value - camera.position[index]) < .01), 'joint touch dragging does not orbit (apart from residual camera damping)');
  const position = pane.getByRole('region', { name: 'Position controls', exact: true });
  await position.getByRole('combobox', { name: 'Pose', exact: true }).tap();
  await page.getByRole('option', { name: 'open', exact: true }).tap();
  await page.waitForFunction(() => Number.parseFloat(document.querySelector('input[aria-label="hinge slider value"]').value) === 90);
  await position.getByRole('button', { name: 'Reset', exact: true }).tap();
  await slide(position.getByRole('slider'));
  assert.notEqual(await position.getByLabel('hinge slider value', { exact: true }).inputValue(), '0.00°');

  await view.tool('Select').tap();
  const pinchBefore = (await view.state()).camera;
  await gesture([[[130, 450], [230, 450]], [[100, 450], [260, 450]], [[90, 450], [280, 450]]]);
  await page.waitForTimeout(300);
  assert.notEqual((await view.state()).camera.zoom, pinchBefore.zoom, 'two fingers pinch to zoom');
  const panBefore = (await view.state()).camera;
  await gesture([[[130, 450], [230, 450]], [[145, 470], [245, 470]], [[160, 480], [260, 480]]]);
  await page.waitForTimeout(300);
  assert.notDeepEqual((await view.state()).camera.target, panBefore.target, 'two fingers pan');
  assert.equal((await view.state()).selectedPartIds.length, 0, 'pinching and panning never select geometry');

  await view.tool('Draw').tap();
  await page.waitForFunction(() => document.querySelector('[data-drawing-ready]'));
  await gesture([[[110, 350]], [[125, 370]], [[150, 375]], [[175, 400]]]);
  await pane.getByRole('button', { name: /Copy Drawing|Add drawing/ }).waitFor();
  const draw = pane.locator('[data-tool-panel][aria-label="Drawing controls"]');
  await draw.getByRole('button', { name: 'Undo', exact: true }).tap();
  assert.equal(await draw.getByRole('button', { name: 'Redo', exact: true }).isEnabled(), true);
  await draw.getByRole('button', { name: 'Redo', exact: true }).tap();
  await draw.getByRole('button', { name: 'Line', exact: true }).tap();
  await gesture([[[90, 330]], [[190, 440]]]);

  await view.tool('Display').tap();
  const settings = view.displayPanel();
  await settings.waitFor();
  const mode = settings.getByRole('combobox', { name: 'Mode', exact: true });
  await mode.tap();
  await page.getByRole('option', { name: 'Wireframe', exact: true }).tap();
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().display.mode === 'wireframe');
  assert.equal(await settings.isVisible(), true, 'choosing an option keeps the popover');
  await settings.getByRole('button', { name: 'Reset', exact: true }).tap();
  // Draw is still the tool; a tap on its button again puts the popover away.
  assert.equal(await view.tool('Draw').getAttribute('aria-pressed'), 'true');
  await view.tool('Display').tap();
  await settings.waitFor({ state: 'hidden' });

  await view.tool('Animate').tap();
  const animatePanel = pane.getByRole('region', { name: 'Animate controls', exact: true });
  await animatePanel.getByRole('button', { name: 'Play animation', exact: true }).tap();
  await animatePanel.getByRole('button', { name: 'Pause animation', exact: true }).waitFor();
  // Its Speed is in the Animate panel's settings, by touch like everything else.
  await animatePanel.getByRole('button', { name: 'Animation settings', exact: true }).tap();
  await page.getByRole('menu', { name: 'Animation settings', exact: true }).getByRole('menuitem', { name: /^Speed/ }).tap();
  await page.locator('[role=menu][aria-label="Speed"]').getByRole('menuitemradio', { name: '2×', exact: true }).tap();
  await page.getByRole('menu', { name: 'Animation settings', exact: true }).waitFor({ state: 'detached' });
  await animatePanel.getByRole('button', { name: 'Pause animation', exact: true }).tap();
  await animatePanel.getByRole('button', { name: 'Play animation', exact: true }).waitFor();
  await pane.getByRole('button', { name: 'Fullscreen', exact: true }).tap();
  await page.getByRole('button', { name: 'Orbit settings', exact: true }).tap();
  await page.getByRole('menuitemcheckbox', { name: 'Orbit', exact: true }).tap();
  await page.touchscreen.tap(30, 700);
  await page.getByRole('button', { name: 'Exit fullscreen' }).tap();
  assert.deepEqual(errors, []);
});

test('freehand ink has the visual weight of a rectangle drawn at the same stroke width, and follows the width chosen', async () => {
  const view = await open();
  const { page, pane, box } = view;
  await view.tool('Draw').click();
  const ink = pane.locator('canvas.excalidraw__canvas.static');
  const panel = pane.locator('[data-tool-panel][aria-label="Drawing controls"]');
  await page.waitForFunction(() => document.querySelector('[data-drawing-ready]'));
  const drag = async (from, to, steps = 25) => {
    await page.mouse.move(box.x + from[0], box.y + from[1]);
    await page.mouse.down();
    await page.mouse.move(box.x + to[0], box.y + to[1], { steps });
    await page.mouse.up();
  };
  // Medium (the default): a pen stroke, and a rectangle whose top edge runs level with it below.
  await panel.getByRole('button', { name: 'Pen', exact: true }).click();
  await drag([400, 240], [540, 240]);
  await panel.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await drag([400, 300], [540, 370], 10);
  // Bold: the pen again, heavier.
  await panel.getByRole('button', { name: 'Stroke width', exact: true }).click();
  await panel.getByRole('radiogroup', { name: 'Stroke width', exact: true }).getByRole('radio', { name: 'Bold', exact: true }).click();
  await panel.getByRole('button', { name: 'Pen', exact: true }).click();
  await drag([400, 440], [540, 440]);
  await page.waitForTimeout(200);
  const shot = PNG.sync.read(await ink.screenshot());
  const thickness = y => {
    const samples = [];
    for (let x = 450; x < 500; x++) {
      let count = 0;
      for (let row = y - 12; row <= y + 12; row++) {
        const offset = (row * shot.width + x) * 4;
        if (shot.data[offset] > 180 && shot.data[offset + 1] < 110 && shot.data[offset + 2] < 150 && shot.data[offset + 3] > 100) count++;
      }
      samples.push(count);
    }
    return samples.sort((a, b) => a - b)[25];
  };
  const pen = thickness(240), rectangle = thickness(300), bold = thickness(440);
  assert.ok(pen > 0 && rectangle > 0 && bold > 0, `every stroke is visible: ${pen}, ${rectangle}, ${bold}`);
  assert.ok(Math.abs(pen - rectangle) <= 1, `the pen reads as heavy as a rectangle's edge: ${pen}px vs ${rectangle}px`);
  assert.ok(bold > pen, `Bold is heavier than Medium: ${bold}px vs ${pen}px`);
  assert.deepEqual(view.errors, []);
});
