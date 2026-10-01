/**
 * What the navbar's right end links to, in every app: the running version (its release notes and
 * how to update), the source, the community and a new issue. `@text-to-cad/ui/links` — pure, with
 * no imports, so a host's own build configuration and its unit tests read the same defaults the
 * navbar draws.
 *
 * A host supplies the version it runs and hands `viewerLinks(...)` to its `ViewerHost.links`. It
 * may point the links elsewhere (the web reads its build's environment), say what it found when
 * it checked for a newer release (`latest`), and say how a link is followed (`open`, for a page
 * in a frame that cannot open one itself). Nothing here fetches or navigates.
 */

export const TEXT_TO_CAD_LINKS = Object.freeze({
  x: "https://x.com/earthtojake",
  github: "https://github.com/earthtojake/text-to-cad",
  discord: "https://discord.gg/5FGB9DwJYU",
  issues: "https://github.com/earthtojake/text-to-cad/issues/new",
  install: Object.freeze({
    // `add` rather than `update`: both refresh what is installed, but only `add` picks up a skill
    // that is NEW in a release, because `update` walks the lockfile. Skills only: the skill text
    // tells the agent when and how to install or upgrade cadgen.
    command: "npx skills add earthtojake/text-to-cad",
    // The same update, handed to an agent instead of run in a terminal: one short line, read at a
    // glance in a menu and pasted into a chat where the agent already knows the rest of the job.
    prompt: "Update the text-to-cad skills with `npx skills add earthtojake/text-to-cad`."
  })
});

/** A version as the navbar shows and compares it: `v0.7.4`, or a `refs/tags/` ref, is `0.7.4`. */
export function releaseVersion(value = "") {
  return String(value ?? "").trim().replace(/^refs\/tags\//iu, "").replace(/^v(?=\d)/iu, "");
}

/** A release's notes on its repository: `0.7.4` is tagged `v0.7.4`. */
export function releaseNotesUrl(repository, version) {
  const bare = releaseVersion(version);
  const base = String(repository || "").trim().replace(/\/+$/u, "");
  return bare && base ? `${base}/releases/tag/${encodeURIComponent(`v${bare}`)}` : "";
}

/** The longest address a new issue is opened at: GitHub turns one away not far past 8 KB. */
export const ISSUE_URL_MAX = 6000;

/**
 * A new issue on `issues` (`ViewerLinks.issues`), filled in as `?title=…&body=…`; "" without
 * `issues`. The body is `body`, then `about` as a list ("- CAD: 0.7.5", each label with a value),
 * then `details`, fenced. The address never passes `max` characters: `details` gives way first,
 * from its end, then `body`, each cut marked. Nothing is sent: the person reads the issue, says
 * what they were doing and submits it.
 *
 * @param {string | undefined} issues
 * @param {{ title?: string, body?: string, about?: Record<string, string | undefined>, details?: string }} [issue]
 * @param {number} [max]
 */
export function issueUrl(issues, { title = "", body = "", about = {}, details = "" } = {}, max = ISSUE_URL_MAX) {
  const base = String(issues || "").trim();
  if (!base) return "";
  const address = (text) => {
    const query = new URLSearchParams();
    if (title) query.set("title", title);
    if (text) query.set("body", text);
    const search = query.toString();
    return search ? `${base}${base.includes("?") ? "&" : "?"}${search}` : base;
  };
  const list = Object.entries(about).filter(([, value]) => value).map(([label, value]) => `- ${label}: ${value}`).join("\n");
  const head = [body, list && `**Environment**\n\n${list}`].filter(Boolean).join("\n\n");
  // A fence longer than any run of backticks in the log, so nothing in it closes the block.
  const fenced = (log) => {
    const fence = "`".repeat(Math.max(3, ...Array.from(log.matchAll(/`+/gu), ([run]) => run.length + 1)));
    return `${head}\n\n**Details**\n\n${fence}\n${log}\n${fence}`;
  };
  // The longest cut of `text` whose address fits, found by halves: an address only grows with its
  // text, and no more of it than `max` characters can ever fit.
  const fit = (text, compose) => {
    if (text.length <= max && address(compose(text)).length <= max) return compose(text);
    let low = 0, high = Math.min(text.length - 1, max);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (address(compose(cut(text, middle))).length <= max) low = middle; else high = middle - 1;
    }
    return low ? compose(cut(text, low)) : null;
  };
  const log = String(details || "");
  const text = (log ? fit(log, fenced) : null) ?? fit(head, (kept) => kept) ?? "";
  return address(text).length <= max ? address(text) : base;
}

/** The first `length` characters of `text`, marked as cut — never between a surrogate pair's halves. */
function cut(text, length) {
  const code = text.charCodeAt(length - 1);
  return `${text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length)}\n… (truncated)`;
}

/**
 * The navbar's links for a host running `version`: the defaults, with whatever the host changes.
 *
 * @param {object} options
 * @param {string} options.version The version this host runs.
 * @param {string} [options.x]
 * @param {string} [options.github]
 * @param {string} [options.discord]
 * @param {string} [options.issues] Where a new issue is opened; "" offers none.
 * @param {string} [options.release] This version's release notes; by default its tag on `github`.
 * @param {{ command?: string, prompt?: string, message?: string }} [options.install]
 *   How this host updates, in place of the skills' update: see `ViewerLinks.install`.
 * @param {{ version: string, url: string, newer: boolean } | null} [options.latest]
 *   The newest release, for a host that checked, and whether it is newer than `version`.
 * @param {(url: string) => Promise<void>} [options.open]
 */
export function viewerLinks({ version, x = TEXT_TO_CAD_LINKS.x, github = TEXT_TO_CAD_LINKS.github, discord = TEXT_TO_CAD_LINKS.discord,
  issues = TEXT_TO_CAD_LINKS.issues, release, install = TEXT_TO_CAD_LINKS.install, latest = null, open } = {}) {
  const bare = releaseVersion(version);
  return {
    version: bare, x, github, discord, issues, install, latest,
    release: release || releaseNotesUrl(github, bare),
    ...(open ? { open } : {})
  };
}
