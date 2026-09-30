import { describe, expect, it } from "vitest";

/**
 * Two keyboard traps the sweep found by eye, held by a scan of every renderer component:
 *
 * 1. A control revealed on hover (`opacity-0 group-hover:opacity-100`) that has no focus twin
 *    (`focus-visible:opacity-100` or `group-focus-within:opacity-100`) is invisible while the
 *    keyboard is on it.
 * 2. A `<button>`, `<Button>` or `role="button"` that removes the outline (`outline-none`,
 *    `outline-hidden`) and draws no ring of its own (`focus-visible:`, `focus:ring`, `ring-`) has
 *    no visible focus at all.
 *
 * The scan reads source text, so it knows class strings and opening tags, not what a parent
 * merges over them. Where the override lives elsewhere, the entry is in ALLOWED with the reason.
 */
const sources = import.meta.glob("../../../src/renderer/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** `file:line` → why it is fine. A fixed site comes off the list; an entry that no longer matches fails. */
const ALLOWED: Record<string, string> = {
  "components/ai-elements/attachments.tsx:345": "the remove button is overridden at Composer.tsx:605 (opacity-60, focus-visible:opacity-100 and a ring)",
  "components/ai-elements/attachments.tsx:351": "the remove button is overridden at Composer.tsx:605 (opacity-60, focus-visible:opacity-100 and a ring)",
  "components/ai-elements/queue.tsx:129": "fixed on amy/fix42-session; remove this entry at merge",
};

/** `src/renderer/` onward, and the 1-based line of `offset`. */
const where = (path: string, source: string, offset: number) =>
  `${path.replace(/^.*\/src\/renderer\//, "")}:${source.slice(0, offset).split("\n").length}`;

/** The opening tag starting at `start` (a `<`), through its closing `>` outside any `{…}` or string. */
function openingTag(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0 && source[i - 1] !== "=") return source.slice(start, i + 1);
  }
  return source.slice(start);
}

/** Every string literal that looks like a class list, with its offset. */
function* classStrings(source: string): Generator<{ text: string; offset: number }> {
  for (const match of source.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
    yield { text: match[1] ?? match[2] ?? match[3] ?? "", offset: match.index };
  }
}

const tokens = (text: string) => text.split(/\s+/);

function hoverOnlyReveals(path: string, source: string): string[] {
  const found: string[] = [];
  for (const { text, offset } of classStrings(source)) {
    const list = tokens(text);
    if (!list.includes("opacity-0") || !list.includes("group-hover:opacity-100")) continue;
    if (list.some((t) => /^(focus-visible|focus-within|focus|group-focus-within|group-focus-visible):opacity-100$/.test(t))) continue;
    found.push(where(path, source, offset));
  }
  return found;
}

function ringlessButtons(path: string, source: string): string[] {
  const found: string[] = [];
  const starts = new Set<number>();
  for (const match of source.matchAll(/<(?:button|Button)\b/g)) starts.add(match.index);
  for (const match of source.matchAll(/role="button"/g)) {
    const start = source.lastIndexOf("<", match.index);
    if (start >= 0) starts.add(start);
  }
  for (const start of starts) {
    const tag = openingTag(source, start);
    if (!/(?<![\w:-])outline-(?:none|hidden)\b/.test(tag)) continue;
    if (/focus-visible:|focus:ring|(?<![\w-])ring-/.test(tag)) continue;
    found.push(where(path, source, start));
  }
  return found;
}

function scan(find: (path: string, source: string) => string[]): string[] {
  return Object.entries(sources).flatMap(([path, source]) => find(path, source));
}

describe("keyboard focus is visible (source scan of src/renderer)", () => {
  it("the scan itself sees the patterns it is looking for", () => {
    expect(hoverOnlyReveals("a.tsx", '<i className="opacity-0 group-hover:opacity-100" />')).toEqual(["a.tsx:1"]);
    expect(hoverOnlyReveals("a.tsx", '<i className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />')).toEqual([]);
    expect(ringlessButtons("a.tsx", '<button className="outline-none hover:bg-accent" />')).toEqual(["a.tsx:1"]);
    expect(ringlessButtons("a.tsx", '<Button className={cn("outline-none", on && "x")} onClick={() => go()}>')).toEqual(["a.tsx:1"]);
    expect(ringlessButtons("a.tsx", '<div role="button" className="outline-none focus-visible:ring-2" />')).toEqual([]);
  });

  it("no control is revealed on hover alone", () => {
    const hits = scan(hoverOnlyReveals).filter((site) => !(site in ALLOWED));
    expect(hits, "add a focus-visible:opacity-100 (or group-focus-within:opacity-100) beside group-hover:opacity-100").toEqual([]);
  });

  it("no button removes its outline without drawing a ring", () => {
    const hits = scan(ringlessButtons).filter((site) => !(site in ALLOWED));
    expect(hits, "add focus-visible:ring-[3px] focus-visible:ring-ring/50 (the kit's button ring)").toEqual([]);
  });

  it("every allowlist entry still matches something", () => {
    const live = new Set([...scan(hoverOnlyReveals), ...scan(ringlessButtons)]);
    expect(Object.keys(ALLOWED).filter((site) => !live.has(site))).toEqual([]);
  });
});
