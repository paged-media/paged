/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// A LIGHT, dependency-free syntax highlighter for the CodeEditor host
// widget (paged.web W-04). Not a parser — a tokenizer that emits HTML
// spans for the two languages the source panel needs (HTML + CSS),
// degrading to plain escaped text for anything else. The editor has
// NO CodeMirror/Prism/Shiki in its tree (checked 2026-06-07), and the
// brand line forbids dragging a heavy editor dep in for two textareas;
// this is the proportionate tool. The same span structure powers the
// real engine-backed diagnostics later — the SHAPE is what matters.
//
// Token classes map to `--code-*` token-layer colours (theme.css), so
// the highlighter reads native in both themes and never hardcodes hex.

export type CodeLanguage = "html" | "css" | "js" | "text";

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

export interface Token {
  /** Class suffix (`tag`, `attr`, `string`, `comment`, …) or null
   *  for plain text. */
  cls: string | null;
  text: string;
}

function wrap(tokens: Token[]): string {
  let out = "";
  for (const t of tokens) {
    const safe = escapeHtml(t.text);
    out += t.cls ? `<span class="code-${t.cls}">${safe}</span>` : safe;
  }
  return out;
}

// --- HTML ----------------------------------------------------------
// Tokenize comments, tags (with attr names + quoted values), and
// text. Deliberately tolerant: the scanner advances by largest match
// and falls back to a single plain char, so it never throws.
const HTML_RULE =
  /(<!--[\s\S]*?-->)|(<\/?[a-zA-Z][\w-]*)|([a-zA-Z-]+)(?==)|("[^"]*"|'[^']*')|(>)/g;

function tokenizeHtml(src: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  let inTag = false;
  HTML_RULE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HTML_RULE.exec(src)) !== null) {
    if (m.index > last) {
      tokens.push({ cls: null, text: src.slice(last, m.index) });
    }
    if (m[1]) {
      tokens.push({ cls: "comment", text: m[1] });
    } else if (m[2]) {
      tokens.push({ cls: "tag", text: m[2] });
      inTag = true;
    } else if (m[3]) {
      tokens.push({ cls: inTag ? "attr" : null, text: m[3] });
    } else if (m[4]) {
      tokens.push({ cls: "string", text: m[4] });
    } else if (m[5]) {
      tokens.push({ cls: "tag", text: m[5] });
      inTag = false;
    }
    last = HTML_RULE.lastIndex;
  }
  if (last < src.length) tokens.push({ cls: null, text: src.slice(last) });
  return tokens;
}

// --- CSS -----------------------------------------------------------
const CSS_RULE =
  /(\/\*[\s\S]*?\*\/)|([.#]?[-\w]+)(?=\s*\{)|([-\w]+)(?=\s*:)|(:[^;{}]+)(?=;|\})/g;

function tokenizeCss(src: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  CSS_RULE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CSS_RULE.exec(src)) !== null) {
    if (m.index > last)
      tokens.push({ cls: null, text: src.slice(last, m.index) });
    if (m[1]) tokens.push({ cls: "comment", text: m[1] });
    else if (m[2]) tokens.push({ cls: "selector", text: m[2] });
    else if (m[3]) tokens.push({ cls: "prop", text: m[3] });
    else if (m[4]) tokens.push({ cls: "value", text: m[4] });
    last = CSS_RULE.lastIndex;
  }
  if (last < src.length) tokens.push({ cls: null, text: src.slice(last) });
  return tokens;
}

// --- JavaScript ----------------------------------------------------
// Line and block comments, strings (template literals included, without
// nested `${}` tracking), keywords, numbers, and the name before a call
// or after a dot. Enough to read a script; not a parser.
const JS_KEYWORDS = new Set(
  "async await break case catch class const continue default delete do else export extends false finally for function if import in instanceof let new null of return switch this throw true try typeof undefined var void while yield".split(
    " ",
  ),
);
const JS_RULE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(\s*\()?/g;

/** The tokens of one JavaScript source string, in order; joined, their
 *  texts are the source. Comments and strings are matched whole, so a
 *  caller splitting by line splits the tokens' texts too. */
export function tokenizeJs(src: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  JS_RULE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JS_RULE.exec(src)) !== null) {
    if (m.index > last)
      tokens.push({ cls: null, text: src.slice(last, m.index) });
    if (m[1]) tokens.push({ cls: "comment", text: m[1] });
    else if (m[2]) tokens.push({ cls: "string", text: m[2] });
    else if (m[3]) tokens.push({ cls: "number", text: m[3] });
    else if (m[4]) {
      const word = m[4];
      tokens.push({
        cls: JS_KEYWORDS.has(word) ? "keyword" : m[5] ? "call" : null,
        text: word,
      });
      if (m[5]) tokens.push({ cls: null, text: m[5] });
    }
    last = JS_RULE.lastIndex;
  }
  if (last < src.length) tokens.push({ cls: null, text: src.slice(last) });
  return tokens;
}

/** Produce highlighted HTML for one source string. The output is
 *  rendered into a `<pre>` UNDERLAY beneath a transparent textarea, so
 *  metrics must match exactly — callers must use the same font/size on
 *  both. Always ends with a trailing newline guard so the last line's
 *  height is preserved. */
export function highlight(src: string, language: CodeLanguage): string {
  const tokens =
    language === "html"
      ? tokenizeHtml(src)
      : language === "css"
        ? tokenizeCss(src)
        : language === "js"
          ? tokenizeJs(src)
          : [{ cls: null, text: src }];
  // Trailing-newline guard: a textarea keeps height for a final empty
  // line; mirror it so the underlay doesn't shift.
  return wrap(tokens) + "\n";
}
