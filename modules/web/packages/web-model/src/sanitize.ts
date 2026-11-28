/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// Pure HTML sanitization for the PASTE-INGEST lane — the enforcement
// twin of `diagnoseHtml`. The linter only *reports* a policy violation;
// when HTML is brought in from OUTSIDE the editor (clipboard, a paste),
// the platform's "page JavaScript never executes" rule (§6.1) must be
// ENFORCED, not merely diagnosed: a pasted `<script>` or `onclick=` is
// stripped on the way in so it can never reach the source at all.
//
// Like the linter, this is a SCANNER not a parser — zero dependencies,
// no DOM APIs, and it must never crash on malformed input. It removes
// exactly three classes of executable surface (the same three the
// sandboxed preview + `sandbox=""` already neutralize, made permanent
// in the stored source):
//
//   · `<script>…</script>` elements (open tag → matching close, body
//     and all) — and a stray/orphan `<script>`/`</script>` tag;
//   · inline event-handler attributes (`on…=` — onclick, onload, …)
//     on any tag, value stripped — found by splitting the tag the way a
//     browser does, so `<svg/onload=…>` and `src="a"onerror=…` count;
//   · `javascript:` URLs in `href`/`src`/any attribute value.
//
// Everything else passes through BYTE-FOR-BYTE. `removed` names each
// class that was actually stripped (deduplicated, stable order) so the
// paste affordance can report what it cleaned ("removed 2 <script>
// blocks, 1 event handler").

/** A label for one class of removed executable surface. */
export type SanitizeRemoval =
  "<script> element" | "event-handler attribute" | "javascript: URL";

export interface SanitizeResult {
  /** The sanitized HTML — identical to the input when nothing matched. */
  html: string;
  /** Which classes of executable surface were stripped (deduplicated,
   *  in first-seen order). Empty when the input was already clean. */
  removed: SanitizeRemoval[];
}

/** A `<script …>` open tag or a `</script …>` close tag, case-insensitive,
 *  tolerant of whitespace. A tag the input ends inside (no closing `>`)
 *  counts too: whatever is appended after the fragment would complete it. */
const SCRIPT_OPEN = /<\s*script\b[^>]*(?:>|$)/i;
const SCRIPT_CLOSE = /<\s*\/\s*script\b[^>]*(?:>|$)/i;
const SCRIPT_PAIRED = new RegExp(
  SCRIPT_OPEN.source + "[\\s\\S]*?" + SCRIPT_CLOSE.source,
  "i",
);
const SCRIPT_OPEN_ALL = new RegExp(SCRIPT_OPEN.source, "gi");
const SCRIPT_CLOSE_ALL = new RegExp(SCRIPT_CLOSE.source, "gi");

/** An inline event-handler attribute: `on<name>=` with a quoted,
 *  apostrophe-quoted, bare or EMPTY value; a quote the input never closes
 *  takes the rest of the input with it. `\son` so we match a real
 *  attribute boundary (`data-online` is mid-name, never matched), never
 *  a substring of another attribute name. CONSERVATIVE by design — any
 *  `on<word>=` at an attribute boundary is stripped (the same scan
 *  `diagnoseHtml` flags); the browser would run it if it WERE a handler,
 *  so removing a rare non-standard `on…` attribute is the safe posture. */
const EVENT_ATTR =
  /\son[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|"[^"]*$|'[^']*$|[^\s"'>]*)/gi;

/** What a browser drops or decodes before it reads a URL's scheme: C0
 *  controls and spaces, written literally or as a character reference.
 *  (Only tab, LF and CR are dropped INSIDE a scheme; matching the wider
 *  set there too only neutralizes more.) */
const URL_PAD =
  "(?:[\\0-\\x20]|&#0*(?:[1-9]|[12][0-9]|3[0-2]);?" +
  "|&#x0*(?:[1-9a-f]|1[0-9a-f]|20);?|&(?:tab|newline);)*";

/** One scheme character, literal or as a character reference (the `i`
 *  flag covers the literal's case; the references name both cases). */
function schemeChar(c: string): string {
  const codes = [...new Set([c.toLowerCase(), c.toUpperCase()])].map((x) =>
    x.charCodeAt(0),
  );
  const alts = [c === ":" ? ":|&colon;" : c];
  for (const code of codes) {
    alts.push(`&#0*${code};?`, `&#x0*${code.toString(16)};?`);
  }
  return `(?:${alts.join("|")})`;
}

/** A URL scheme as the browser reads it, tolerant of the padding and the
 *  character references it resolves first (`java\tscript:`,
 *  `&#106;avascript:`). */
function schemeSource(scheme: string): string {
  return URL_PAD + [...`${scheme}:`].map(schemeChar).join(URL_PAD);
}

const JS_SCHEME = schemeSource("javascript");

/** A `javascript:` scheme inside an attribute VALUE (quoted, bare, or
 *  quoted and never closed). We match the WHOLE attribute and neutralize
 *  its value rather than guess where the URL ends. This is the scan for
 *  text OUTSIDE a tag the input shows whole (a fragment that begins inside
 *  one); inside a tag `scanTagAttributes` finds the attribute whatever
 *  separates it from its neighbour. */
const JS_URL_ATTR = new RegExp(
  "(\\s[a-zA-Z][a-zA-Z0-9-]*\\s*=\\s*)(" +
    `"${JS_SCHEME}[^"]*(?:"|$)` +
    `|'${JS_SCHEME}[^']*(?:'|$)` +
    `|${JS_SCHEME}[^\\s"'>]*)`,
  "gi",
);

/** The schemes that run script or carry a document of their own. */
export type ExecutableScheme = "javascript" | "vbscript" | "data";

const SCHEME_AT_START: Array<[ExecutableScheme, RegExp]> = (
  ["javascript", "vbscript", "data"] as const
).map((scheme) => [scheme, new RegExp("^" + schemeSource(scheme), "i")]);

/** The executable scheme a RAW attribute value (character references not
 *  yet decoded, as it stands in the markup) starts with, or `null`. */
export function executableScheme(rawValue: string): ExecutableScheme | null {
  for (const [scheme, re] of SCHEME_AT_START) {
    if (re.test(rawValue)) return scheme;
  }
  return null;
}

/** One attribute of an open tag, by position in the scanned text. */
export interface TagAttribute {
  /** The tag's name, lower-cased. */
  tag: string;
  /** The attribute's name, lower-cased. */
  name: string;
  /** Start of the name. */
  start: number;
  /** End of the attribute: past the name, or past the value and its
   *  closing quote. */
  end: number;
  /** The value without its quotes: `[valueStart, valueEnd)`; both `-1`
   *  for an attribute without `=`. */
  valueStart: number;
  valueEnd: number;
  /** The quote the value opens with, `""` for a bare value. */
  quote: '"' | "'" | "";
}

const WS = new Set([" ", "\t", "\n", "\f", "\r"]);

function isAsciiLetter(c: string | undefined): boolean {
  return c !== undefined && /^[A-Za-z]$/.test(c);
}

/**
 * The attributes of every open tag in `html`, split the way a browser's
 * tokenizer splits them: whitespace AND `/` separate attributes
 * (`<svg/onload=…>`), a quoted value ends at its quote whatever follows
 * (`src="a"onerror=…`), a bare value runs to whitespace or `>`, and a
 * quote the input never closes takes the rest of the input.
 *
 * Still a scanner, not a parser: EVERY `<` followed by a letter is read
 * as a tag start, also inside a comment, a raw-text element or another
 * tag's quoted value, because what precedes a fragment decides which of
 * them the browser honours. Overlapping readings are all returned. An
 * attribute position is tokenized once, so the scan is linear.
 */
export function scanTagAttributes(html: string): TagAttribute[] {
  const out: TagAttribute[] = [];
  const n = html.length;
  const seen = new Uint8Array(n + 1);
  let lt = html.indexOf("<");
  for (; lt !== -1; lt = html.indexOf("<", lt + 1)) {
    if (!isAsciiLetter(html[lt + 1])) continue;
    let p = lt + 1;
    while (p < n && !WS.has(html[p]) && html[p] !== "/" && html[p] !== ">") p++;
    const tag = html.slice(lt + 1, p).toLowerCase();
    for (;;) {
      while (p < n && (WS.has(html[p]) || html[p] === "/")) p++;
      if (p >= n || html[p] === ">" || seen[p] === 1) break;
      seen[p] = 1;
      const start = p;
      p++; // a leading `=` belongs to the name
      while (
        p < n &&
        !WS.has(html[p]) &&
        html[p] !== "/" &&
        html[p] !== ">" &&
        html[p] !== "="
      )
        p++;
      const name = html.slice(start, p).toLowerCase();
      let q = p;
      while (q < n && WS.has(html[q])) q++;
      if (html[q] !== "=") {
        out.push({
          tag,
          name,
          start,
          end: p,
          valueStart: -1,
          valueEnd: -1,
          quote: "",
        });
        continue;
      }
      q++;
      while (q < n && WS.has(html[q])) q++;
      const c = html[q];
      if (c === '"' || c === "'") {
        const close = html.indexOf(c, q + 1);
        const valueEnd = close === -1 ? n : close;
        p = close === -1 ? n : close + 1;
        out.push({
          tag,
          name,
          start,
          end: p,
          valueStart: q + 1,
          valueEnd,
          quote: c,
        });
      } else {
        p = q;
        while (p < n && !WS.has(html[p]) && html[p] !== ">") p++;
        out.push({
          tag,
          name,
          start,
          end: p,
          valueStart: q,
          valueEnd: p,
          quote: "",
        });
      }
    }
  }
  return out;
}

/** An inline event handler: `on<letters>` with a value. */
export function isEventHandlerAttribute(a: TagAttribute): boolean {
  return a.valueStart !== -1 && /^on[a-z]+$/.test(a.name);
}

/** Step 2 and 3 inside tags: drop handler attributes and empty the value
 *  of `javascript:` URLs, whatever separates the attributes. */
function sanitizeTags(html: string, removed: Set<SanitizeRemoval>): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let handler = false;
  let url = false;
  for (const a of scanTagAttributes(html)) {
    if (isEventHandlerAttribute(a)) {
      // Take the whitespace before it too, so the tag closes up.
      let start = a.start;
      while (start > 0 && WS.has(html[start - 1])) start--;
      edits.push({ start, end: a.end, text: "" });
      handler = true;
    } else if (
      a.valueStart !== -1 &&
      JS_AT_START.test(html.slice(a.valueStart, a.valueEnd))
    ) {
      edits.push({
        start: a.valueStart - a.quote.length,
        end: a.end,
        text: a.quote + a.quote,
      });
      url = true;
    }
  }
  if (edits.length === 0) return html;
  // The classes in the pass's order, not the markup's.
  if (handler) removed.add("event-handler attribute");
  if (url) removed.add("javascript: URL");
  edits.sort((x, y) => x.start - y.start || y.end - x.end);
  let out = "";
  let at = 0;
  for (const e of edits) {
    // Overlapping readings: the earlier, longer edit covers the later.
    if (e.start < at) {
      if (e.end > at) at = e.end;
      continue;
    }
    out += html.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + html.slice(at);
}

const JS_AT_START = new RegExp("^" + JS_SCHEME, "i");

/** Passes after which a removal can still have joined its neighbours into
 *  a new construct. Every pass that changes the text shortens it, so the
 *  loop ends on its own; the cap bounds the cost on hostile input. */
const MAX_PASSES = 64;

/**
 * Strip every executable surface from an HTML fragment brought in from
 * outside the editor. Pure and total: garbage input never throws, and a
 * fragment with nothing to strip returns byte-identical with an empty
 * `removed`. Idempotent — the passes repeat until the text is a fixed
 * point, so a removal can never leave a new construct behind.
 *
 * Order matters: `<script>` bodies are excised FIRST (so handler/URL
 * scanning never runs over removed script text), then event handlers,
 * then `javascript:` URLs.
 */
export function sanitizeHtml(html: string): SanitizeResult {
  if (typeof html !== "string" || html.length === 0) {
    return { html: typeof html === "string" ? html : "", removed: [] };
  }
  const removed = new Set<SanitizeRemoval>();
  let out = html;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = sanitizePass(out, removed);
    if (next === out) return { html: out, removed: [...removed] };
    out = next;
  }
  // Not settled within the cap: refuse the fragment rather than hand back
  // text that may still carry executable surface.
  return sanitizePass(out, removed) === out
    ? { html: out, removed: [...removed] }
    : { html: "", removed: [...removed] };
}

function sanitizePass(html: string, removed: Set<SanitizeRemoval>): string {
  let out = html;

  // 1) <script>…</script> — paired removal, then orphan tags. Loop so
  //    multiple blocks all go; a non-greedy body match keeps adjacent
  //    blocks separate.
  while (SCRIPT_PAIRED.test(out)) {
    out = out.replace(SCRIPT_PAIRED, "");
    removed.add("<script> element");
  }
  // Orphan open or close tags (an unterminated `<script>` at the end, a
  // stray `</script>`): drop the tag, keep any trailing text honest.
  if (SCRIPT_OPEN.test(out) || SCRIPT_CLOSE.test(out)) {
    out = out.replace(SCRIPT_OPEN_ALL, "").replace(SCRIPT_CLOSE_ALL, "");
    removed.add("<script> element");
  }

  // 2) and 3) inside every tag, split as the browser splits it.
  out = sanitizeTags(out, removed);

  // 2) inline event-handler attributes at any whitespace boundary: what
  //    is left outside a whole tag (a fragment that begins inside one).
  EVENT_ATTR.lastIndex = 0;
  if (EVENT_ATTR.test(out)) {
    EVENT_ATTR.lastIndex = 0;
    out = out.replace(EVENT_ATTR, "");
    removed.add("event-handler attribute");
  }

  // 3) javascript: URLs in attribute values — neutralize the value to an
  //    empty string rather than dropping the attribute (keeps the
  //    surrounding markup well-formed: `href=""` not a dangling `href`).
  JS_URL_ATTR.lastIndex = 0;
  if (JS_URL_ATTR.test(out)) {
    JS_URL_ATTR.lastIndex = 0;
    out = out.replace(JS_URL_ATTR, (_m, prefix: string, value: string) => {
      const quote = value.startsWith('"')
        ? '"'
        : value.startsWith("'")
          ? "'"
          : "";
      return `${prefix}${quote}${quote}`;
    });
    removed.add("javascript: URL");
  }

  return out;
}
