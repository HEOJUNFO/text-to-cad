import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { serveStepHarness } from '../harness/stepScenario.mjs';

// Fixes from a QA pass over the STEP renderer, each pinned in a real browser over the committed
// fixture (`__fixtures__/step`, served by `renderers/harness/stepScenario.mjs`): the two-part
// `hinge_block`, and its base staged alone as the single-part STEP cadgen writes.

let harness, lone;
const cleanups = [];
before(async () => {
  const lifetime = { after: cleanup => cleanups.push(cleanup) };
  [harness, lone] = await Promise.all([serveStepHarness(lifetime), serveStepHarness(lifetime, { singlePart: true })]);
});
after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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

async function open(server) {
  const view = await server.open();
  const { page, pane } = view;
  await pane.locator('[aria-busy="false"] > div > canvas').first().waitFor();
  await page.waitForFunction(() => window.cadHarness.a.controller?.readState().loading === false);
  await pane.getByRole('region', { name: 'Features', exact: true }).waitFor();
  await page.evaluate(() => window.cadHarness.a.controller.setDisplaySettings({ axes: { enabled: false } }));
  await page.waitForTimeout(400);
  await settle(page);
  const box = await pane.locator('[data-cad-surface] canvas').first().boundingBox();
  return {
    ...view, box,
    at: projector(await page.evaluate(() => window.__cadCamera()), box),
    state: () => page.evaluate(() => window.cadHarness.a.controller.readState()),
    tool: name => pane.locator('[data-cad-toolbar]').getByRole('button', { name, exact: true }),
    tools: () => pane.locator('[data-cad-toolbar]').getByRole('button')
      .evaluateAll(buttons => buttons.map(button => `${button.getAttribute('aria-label')}:${button.getAttribute('aria-pressed')}`)),
    displayPanel: () => page.locator('[data-tool-panel][aria-label="Display settings"]'),
  };
}
const pressed = async view => (await view.tools()).filter(tool => tool.endsWith(':true')).map(tool => tool.split(':')[0]);
const selection = async view => { const { selectedPartIds, selectedReferenceIds } = await view.state(); return { selectedPartIds, selectedReferenceIds }; };
// A single press is held for the double-click window before it acts; wait it out, and a frame.
const afterPress = async page => { await page.waitForTimeout(600); await settle(page); };

test('a press on the model under Display leaves Display the tool and picks nothing, and the camera still orbits', async () => {
  const view = await open(harness);
  const { page, pane, at, box, errors } = view;
  const emptySpace = [box.x + 30, box.y + box.height - 30];

  // From Select, with nothing selected: a press on the base picks nothing and keeps Display up.
  await view.tool('Display').click();
  await view.displayPanel().waitFor();
  assert.deepEqual(await pressed(view), ['Display']);
  await page.mouse.click(...at([6, 6, 5]));
  await afterPress(page);
  assert.deepEqual(await pressed(view), ['Display'], 'a press on the model never trades Display for Select');
  assert.equal(await view.displayPanel().isVisible(), true, 'and its panel stays up');
  assert.deepEqual(await selection(view), { selectedPartIds: [], selectedReferenceIds: [] }, 'and picks nothing');
  // A double-click on the model neither copies nor isolates.
  await page.mouse.dblclick(...at([6, 6, 5]));
  await afterPress(page);
  assert.deepEqual([await pressed(view), (await view.state()).isolatedPartIds || []], [['Display'], []]);

  // Beside the model too. (Putting Display up leaves Select, which drops any selection — the
  // design system's Select row — so there is none here to keep; a press must not make one.)
  await page.mouse.click(...emptySpace);
  await afterPress(page);
  assert.deepEqual(await pressed(view), ['Display']);
  assert.deepEqual(await selection(view), { selectedPartIds: [], selectedReferenceIds: [] });
  // Escape puts Display down and brings back Select, whose presses pick again.
  await page.keyboard.press('Escape');
  await view.displayPanel().waitFor({ state: 'hidden' });
  assert.deepEqual(await pressed(view), ['Select']);
  await page.mouse.click(...at([6, 6, 5]));
  await page.waitForFunction(() => { const state = window.cadHarness.a.controller.readState();
    return state.selectedPartIds.length + state.selectedReferenceIds.length > 0; });

  // From Measure: the same press under Display neither measures nor returns to Select.
  await view.tool('Measure').click();
  await view.tool('Display').click();
  await view.displayPanel().waitFor();
  await page.mouse.click(...at([6, 6, 5]));
  await afterPress(page);
  assert.deepEqual(await pressed(view), ['Display']);
  assert.deepEqual(await selection(view), { selectedPartIds: [], selectedReferenceIds: [] });

  // Orbiting is the camera's and still works under Display: a drag over the model turns the view.
  const before = await page.evaluate(() => window.__cadCamera().position);
  await page.mouse.move(...at([6, 6, 5]));
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(previous => window.__cadCamera().position.some((value, index) => Math.abs(value - previous[index]) > 1e-3), before,
    { timeout: 5000 });
  await afterPress(page);
  assert.deepEqual([await pressed(view), await selection(view)], [['Display'], { selectedPartIds: [], selectedReferenceIds: [] }]);
  assert.deepEqual(errors, []);
});

test('a single-part STEP names a picked face after its part, never after the XCAF label entry its file carries for a name', async () => {
  const view = await open(lone);
  const { page, pane, at, errors } = view;
  const reference = pane.getByRole('region', { name: 'Reference details', exact: true });
  // The staging is what cadgen writes: one part, named `=>[0:1:1:2]` in the view.
  assert.equal(lone.fixture.view.occurrences[0].name, '=>[0:1:1:2]');
  assert.equal(await view.tool('Explode').count(), 0, 'a single part: no Explode, so this is the lone-part view');
  await page.mouse.click(...at([6, 6, 5]));
  await page.waitForFunction(() => /\.f\d+$/.test(window.cadHarness.a.controller.readState().selectedReferenceIds.join()));
  const face = (await view.state()).selectedReferenceIds[0].split('|').at(-1);
  const ordinal = face.replace(/^.*\.f/, '');
  assert.match((await reference.innerText()).replace(/\s+/g, ' '), new RegExp(`^hinge_base · face ${ordinal} Type Face`),
    'the heading is the part, named after the file, and the kind');
  // A second face: the picker's name and every one of its entries read the same way.
  await page.keyboard.down('Shift');
  await page.mouse.click(...at([10, 0, 0]));
  await page.keyboard.up('Shift');
  await page.waitForFunction(() => window.cadHarness.a.controller.readState().selectedReferenceIds.length === 2);
  const picker = reference.getByRole('combobox', { name: 'Inspect selected reference' });
  assert.match((await picker.innerText()).replace(/\s+/g, ' '), /^hinge_base · face \d+ 2\/2$/);
  await picker.click();
  const options = await page.getByRole('option').allInnerTexts();
  assert.equal(options.length, 2);
  assert.ok(options.every(option => /^hinge_base · face \d+$/.test(option.trim())), `the picker's entries: ${options}`);
  await page.keyboard.press('Escape');
  assert.doesNotMatch(await pane.innerText(), /=>\[|0:1:1:2/, 'the raw label is nowhere on screen');
  assert.deepEqual(errors, []);
});
