import assert from "node:assert/strict";
import test from "node:test";
import { ISSUE_URL_MAX, TEXT_TO_CAD_LINKS, issueUrl } from "../../../file-viewer/navigation/links.js";
import { alertIssueUrl } from "./reportIssue.js";

const ISSUES = TEXT_TO_CAD_LINKS.issues;
const read = (url) => new URL(url).searchParams;

test("Report Issue says what the card says: its title and failure, the file by name, the version and platform, then Details", () => {
  const alert = { title: "Couldn’t load the model", message: "“parts/gear.step” could not be loaded.",
    reason: "EOFError\nwhile reading the mesh", details: "File: parts/gear.step\nOperation: loading geometry\nEOFError" };
  const url = alertIssueUrl(ISSUES, alert, { file: "Users/ada/work/parts/gear.step", version: "0.7.5", platform: "darwin" });
  assert.ok(url.startsWith(`${ISSUES}?`));
  const query = read(url);
  assert.deepEqual([...query.keys()], ["title", "body"]);
  assert.equal(query.get("title"), "Couldn’t load the model: EOFError");
  assert.equal(query.get("body"), [
    "**What were you doing?**", "", "", "",
    "**Error**", "", "> **Couldn’t load the model**", "> “parts/gear.step” could not be loaded.", "> EOFError", "",
    "**Environment**", "", "- File: gear.step", "- CAD: 0.7.5", "- Platform: darwin", "",
    "**Details**", "", "```", "File: parts/gear.step", "Operation: loading geometry", "EOFError", "```"
  ].join("\n"));
  // Whatever it holds travels intact: nothing in it ends or splits the address.
  const tricky = alertIssueUrl(ISSUES, { title: "A & B #1?", reason: "50% + naïve “quotes” 🙂", details: "a ``` b" }, {});
  assert.doesNotMatch(tricky.slice(ISSUES.length), /[\s#]/u);
  assert.equal(read(tricky).get("title"), "A & B #1?: 50% + naïve “quotes” 🙂");
  assert.ok(read(tricky).get("body").endsWith("````\na ``` b\n````"), "a fence the log cannot close");
  assert.equal(issueUrl("https://tracker.test/new?template=bug.md", { title: "x" }), "https://tracker.test/new?template=bug.md&title=x");
});

test("a long diagnostic is cut from its end to keep the address under the cap; the rest of the issue stays whole", () => {
  const details = `File: parts/gear.step\n${Array.from({ length: 4000 }, (_, line) => `step ${line}: “surface” failed`).join("\n")}`;
  const url = alertIssueUrl(ISSUES, { title: "Couldn’t prepare the model", details }, { file: "gear.step", version: "0.7.5" });
  assert.ok(url.length <= ISSUE_URL_MAX, `${url.length} characters`);
  assert.ok(url.length > ISSUE_URL_MAX - 200, "and as much of it as fits");
  const body = read(url).get("body");
  assert.match(body, /^\*\*What were you doing\?\*\*[\s\S]*- File: gear\.step\n- CAD: 0\.7\.5\n\n\*\*Details\*\*\n\n```\nFile: parts\/gear\.step\nstep 0: /u);
  assert.ok(body.endsWith("\n… (truncated)\n```"));
  // Characters that encode long, and pairs that must not be split, fit the same way.
  const emoji = alertIssueUrl(ISSUES, { title: "T", details: "🙂".repeat(5000) });
  assert.ok(emoji.length <= ISSUE_URL_MAX);
  assert.ok(!read(emoji).get("body").includes("�"), "never cut between a surrogate pair's halves");
  // A message too long even without its diagnostic cuts the body itself.
  const huge = alertIssueUrl(ISSUES, { title: "T", message: "m".repeat(20000), details: "d" });
  assert.ok(huge.length <= ISSUE_URL_MAX);
  assert.match(read(huge).get("body"), /^\*\*What were you doing\?\*\*[\s\S]*m\n… \(truncated\)$/u);
});

test("a host with no tracker gets no address", () => {
  assert.equal(alertIssueUrl("", { title: "Broken" }), "");
  assert.equal(alertIssueUrl(undefined, { title: "Broken" }), "");
});
