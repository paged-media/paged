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
//     on any tag, value stripped;
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
 *  controls and spaces anywhere, written literally or as a character
 *  reference. */
const URL_PAD =
  "(?:[\\0-\\x20]|&#0*(?:9|10|13|32);?|&#x0*(?:9|a|d|20);?|&(?:tab|newline);)*";

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

const JS_SCHEME = URL_PAD + [..."javascript:"].map(schemeChar).join(URL_PAD);

/** A `javascript:` scheme inside an attribute VALUE (quoted, bare, or
 *  quoted and never closed), tolerant of the padding and character
 *  references the browser resolves before parsing the scheme (e.g.
 *  `java\tscript:` or `&#106;avascript:`). We match the WHOLE attribute
 *  and neutralize its value rather than guess where the URL ends. */
const JS_URL_ATTR = new RegExp(
  "(\\s[a-zA-Z][a-zA-Z0-9-]*\\s*=\\s*)(" +
    `"${JS_SCHEME}[^"]*(?:"|$)` +
    `|'${JS_SCHEME}[^']*(?:'|$)` +
    `|${JS_SCHEME}[^\\s"'>]*)`,
  "gi",
);

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

  // 2) inline event-handler attributes, anywhere in an open tag.
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
