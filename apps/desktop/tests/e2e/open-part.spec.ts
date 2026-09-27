import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { HardcoreApi } from "../../src/shared/ipc";

/**
 * The new-session screen's other door: a part to open rather than a prompt
 * to send. A folder with CAD files in it lists them under the composer;
 * clicking one creates the session (the fake agent, so nothing is asked of
 * anyone's login) and the file is the new session's first explorer tab,
 * with the tree beside it.
 *
 * No CAD runtime is required: what is asserted is that the tab exists and
 * is selected, not that the geometry rendered — the explorer suite owns
 * that. The native chooser cannot be driven from Playwright.
 */
declare const window: { hardcore: HardcoreApi };

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(appRoot, "../..");
const STEP = path.join(repoRoot, "tests/fixtures/cad/import-smoke.step");

let app: ElectronApplication;
let page: Page;
let base: string;
let project: string;

test.beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hardcore-open-part-")));
  project = path.join(base, "Parts project");
  fs.mkdirSync(path.join(project, "out"), { recursive: true });
  fs.writeFileSync(path.join(project, "README.md"), "# Parts\n");
  fs.writeFileSync(path.join(project, ".hidden"), "");
  fs.copyFileSync(STEP, path.join(project, "out", "bracket.step"));
  fs.copyFileSync(STEP, path.join(project, "housing.stl"));

  app = await electron.launch({
    args: [path.join(appRoot, "out/main/index.js"), `--user-data-dir=${path.join(base, "profile")}`],
    env: { ...process.env, NODE_ENV: "test", HARDCORE_FAKE_AGENT: path.join(appRoot, "tests/fake-agent/index.mjs") },
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => console.error(`[renderer] ${error.message}`));
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate((root) => window.hardcore.projects.addPath({ path: root }), project);
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test("the folder's parts are offered under the composer, CAD files only", async () => {
  await expect(page.getByRole("heading", { name: "What should we build in Parts project?" })).toBeVisible();
  const row = page.locator("[data-open-part]");
  await expect(row).toBeVisible();
  await expect(row.locator("[data-open-part-chip]")).toHaveText(["housing.stl", "bracket.step"]);
  await expect(row.getByRole("button", { name: "README.md" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Open file…" })).toBeVisible();
  // A draft still has no explorer.
  await expect(page.getByTestId("explorer")).toHaveCount(0);
});

test("clicking a part starts a session with that file as its first tab and the tree beside it", async () => {
  test.setTimeout(60_000);
  // The model chip is the sign the agent has been probed and a session can start.
  await expect(page.locator('[data-composer-row] [data-chip="model"]')).toBeVisible({ timeout: 30_000 });
  await page.locator("[data-open-part]").getByRole("button", { name: "bracket.step" }).click();

  await expect(page.locator("[data-session-view]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-explorer-ready=true]")).toBeVisible();
  await expect(page.getByTestId("explorer")).toBeVisible();
  const tab = page.getByRole("tab", { name: /bracket\.step/ });
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  // The folder is beside the part, expanded to it: folders, then parts,
  // then the README, and the dotfile last.
  const tree = page.getByTestId("explorer").getByRole("tree");
  await expect(tree).toBeVisible();
  await expect(tree.locator('[role="treeitem"]')).toHaveText([/out/, /bracket\.step/, /housing\.stl/, /README\.md/, /\.hidden/]);

  const sessions = await page.evaluate(() => window.hardcore.sessions.list({}));
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.projectId).toBe(project);
  // Nothing was sent: the session is untitled until the first prompt.
  expect(sessions[0]?.title).toBe("New session");
});

test("the row reads the folder again each time the screen is shown", async () => {
  fs.copyFileSync(STEP, path.join(project, "lid.step"));
  await page.getByTestId("sidebar").getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What should we build in Parts project?" })).toBeVisible();
  await expect(page.locator("[data-open-part] [data-open-part-chip]")).toHaveText(["housing.stl", "lid.step", "bracket.step"]);
});
