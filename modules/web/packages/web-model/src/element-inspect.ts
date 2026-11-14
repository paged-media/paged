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

// Source ↔ render INSPECTION (web ADR 416; the UX strategy's §7.6): what
// the panel says about one element of a web frame — where it is in the
// source (line, open tag, a selector path of its ancestors), which CSS
// rules of the frame's stylesheet apply to it, and which of its features a
// printed page cannot show.
//
// A scanner, not a parser (the `diagnose.ts` and `outline.ts` discipline):
// zero deps, no DOM, never throws on bad input. Selector matching covers
// what a frame's stylesheet mostly holds — type, class, id, universal and
// compound selectors joined by descendant or child combinators. A rule
// whose selector needs more (attribute selectors, pseudo-classes, sibling
// combinators) is listed as `unevaluated`, never claimed to match.

import { tagOutline, type TagOutlineEntry } from "./outline";

/** One element along a selector path. */
export interface ElementStep {
  tag: string;
  id: string | null;
  classes: string[];
}

export interface ElementInfo extends ElementStep {
  /** 1-based source line of the open tag. */
  line: number;
  /** The open tag as written. */
  openTag: string;
  /** Outermost first, the element itself last. */
  path: ElementStep[];
  /** `body > div.card > p.lead` — the path as a selector. */
  selector: string;
}

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const TAG =
  /<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/)?\s*>/g;

function attr(attrs: string, name: string): string | null {
  const re = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  );
  const m = re.exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

function stepOf(tag: string, attrs: string): ElementStep {
  const id = attr(attrs, "id");
  const cls = attr(attrs, "class");
  return {
    tag,
    id: id && id.trim() ? id.trim() : null,
    classes: cls ? cls.split(/\s+/).filter(Boolean) : [],
  };
}

/** A step as a compound selector: `div#main.card.wide`. */
export function stepSelector(step: ElementStep): string {
  return (
    step.tag +
    (step.id ? `#${step.id}` : "") +
    step.classes.map((c) => `.${c}`).join("")
  );
}

/**
 * The element of outline entry `index` of `html`: its line, its open tag and
 * the chain of elements it sits in. Null for an index the outline lacks.
 */
export function elementInfo(
  html: string,
  index: number,
  outline: readonly TagOutlineEntry[] = tagOutline(html),
): ElementInfo | null {
  const entry = outline[index];
  if (!entry || typeof html !== "string") return null;
  const stack: ElementStep[] = [];
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(html)) !== null) {
    const [, closing, rawTag, attrs = "", selfClosing] = m;
    const tag = rawTag.toLowerCase();
    if (m.index === entry.sourceStart && !closing) {
      const self = stepOf(tag, attrs);
      const path = [...stack, self];
      return {
        ...self,
        line: entry.line,
        openTag: html.slice(entry.sourceStart, entry.sourceEnd),
        path,
        selector: path.map(stepSelector).join(" > "),
      };
    }
    if (m.index > entry.sourceStart) break;
    if (VOID.has(tag) || selfClosing || tag === "script" || tag === "style")
      continue;
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
    } else stack.push(stepOf(tag, attrs));
  }
  return null;
}

/** One rule of a stylesheet. */
export interface CssRule {
  selector: string;
  /** The declarations as written, trimmed. */
  body: string;
  /** 1-based line of the selector in the CSS text. */
  line: number;
  /** The enclosing `@media` condition, if any. */
  media: string | null;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++)
    if (text[i] === "\n") line += 1;
  return line;
}

/** The style rules of `css`, in order, flattening `@media` blocks;
 *  `@font-face`, `@keyframes` and other at-rules' blocks are skipped. */
export function cssRules(css: string): CssRule[] {
  const out: CssRule[] = [];
  if (typeof css !== "string") return out;
  // Comments become spaces of the same length, so offsets keep their lines.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) =>
    c.replace(/[^\n]/g, " "),
  );
  const walk = (from: number, to: number, media: string | null) => {
    let i = from;
    while (i < to) {
      const open = text.indexOf("{", i);
      if (open < 0 || open >= to) return;
      const prelude = text.slice(i, open);
      // Find the matching close brace.
      let depth = 1;
      let j = open + 1;
      while (j < to && depth > 0) {
        if (text[j] === "{") depth += 1;
        else if (text[j] === "}") depth -= 1;
        j += 1;
      }
      const close = j - 1;
      const head = prelude.trim();
      const at = prelude.indexOf(head);
      if (head.startsWith("@media")) {
        walk(open + 1, close, head.slice(6).trim());
      } else if (!head.startsWith("@") && head.length > 0) {
        out.push({
          selector: head.replace(/\s+/g, " "),
          body: text.slice(open + 1, close).trim(),
          line: lineAt(text, i + Math.max(0, at)),
          media,
        });
      }
      i = j;
    }
  };
  walk(0, text.length, null);
  return out;
}

/** A compound selector we can evaluate, or null. */
function parseCompound(s: string): ElementStep | "any" | null {
  if (s === "*") return "any";
  const m = /^([a-zA-Z][a-zA-Z0-9-]*|\*)?((?:[.#][A-Za-z_][\w-]*)*)$/.exec(s);
  if (!m) return null;
  const tag = m[1] && m[1] !== "*" ? m[1].toLowerCase() : "";
  const parts = m[2] ?? "";
  const ids = [...parts.matchAll(/#([A-Za-z_][\w-]*)/g)].map((x) => x[1]);
  const classes = [...parts.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((x) => x[1]);
  if (!tag && ids.length === 0 && classes.length === 0) return null;
  return { tag, id: ids[0] ?? null, classes };
}

function stepMatches(step: ElementStep, c: ElementStep | "any"): boolean {
  if (c === "any") return true;
  if (c.tag && c.tag !== step.tag) return false;
  if (c.id && c.id !== step.id) return false;
  return c.classes.every((k) => step.classes.includes(k));
}

/** Does one selector (no commas) match the last element of `path`? `null`
 *  when the selector needs more than this matcher evaluates. */
export function selectorMatches(
  selector: string,
  path: readonly ElementStep[],
): boolean | null {
  const tokens = selector
    .trim()
    .replace(/\s*>\s*/g, " > ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const compounds: Array<ElementStep | "any"> = [];
  const combinators: Array<" " | ">"> = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === ">") {
      if (compounds.length === 0) return null;
      combinators.push(">");
      continue;
    }
    if (compounds.length > combinators.length) combinators.push(" ");
    const c = parseCompound(tok);
    if (c === null) return null;
    compounds.push(c);
  }
  if (compounds.length !== combinators.length + 1) return null;
  // Right to left: the last compound is the element itself.
  const match = (ci: number, pi: number): boolean => {
    if (pi < 0) return false;
    if (!stepMatches(path[pi], compounds[ci])) return false;
    if (ci === 0) return true;
    const comb = combinators[ci - 1];
    if (comb === ">") return match(ci - 1, pi - 1);
    for (let p = pi - 1; p >= 0; p--) if (match(ci - 1, p)) return true;
    return false;
  };
  return match(compounds.length - 1, path.length - 1);
}

export interface RuleMatch {
  rule: CssRule;
  /** `matched`: applies to the element; `unevaluated`: names the element's
   *  tag, class or id but needs more than this matcher reads. */
  status: "matched" | "unevaluated";
}

/** The rules of `css` that apply to the element at the end of `path`, in
 *  stylesheet order, and those that might (`unevaluated`). */
export function rulesFor(
  css: string,
  path: readonly ElementStep[],
): RuleMatch[] {
  const self = path[path.length - 1];
  if (!self) return [];
  const out: RuleMatch[] = [];
  for (const rule of cssRules(css)) {
    let matched = false;
    let unknown = false;
    for (const sel of rule.selector.split(",")) {
      const r = selectorMatches(sel, path);
      if (r === true) matched = true;
      else if (r === null) {
        // Mentions this element (its tag, an id or class of it): worth
        // listing as not evaluated.
        const names = [
          `\\b${self.tag}\\b`,
          ...(self.id ? [`#${self.id}\\b`] : []),
          ...self.classes.map((c) => `\\.${c}\\b`),
        ];
        if (names.some((n) => new RegExp(n).test(sel))) unknown = true;
      }
    }
    if (matched) out.push({ rule, status: "matched" });
    else if (unknown) out.push({ rule, status: "unevaluated" });
  }
  return out;
}

/** What a printed page cannot show, and why (codes the panel words). */
export type PrintNoteCode =
  "animation" | "transition" | "interaction" | "fixedPosition" | "pointer";

export interface PrintNote {
  code: PrintNoteCode;
  /** The CSS as written (`animation`, `:hover`, `position: fixed`). */
  feature: string;
  line: number;
}

const PRINT_NOTES: ReadonlyArray<{ code: PrintNoteCode; re: RegExp }> = [
  {
    code: "animation",
    re: /@keyframes\b|(?:^|[\s;{])animation(?:-[a-z-]+)?\s*:/g,
  },
  { code: "transition", re: /(?:^|[\s;{])transition(?:-[a-z-]+)?\s*:/g },
  {
    code: "interaction",
    re: /:(?:hover|focus(?:-within|-visible)?|active|visited)\b/g,
  },
  { code: "fixedPosition", re: /position\s*:\s*(?:fixed|sticky)\b/g },
  { code: "pointer", re: /(?:^|[\s;{])(?:cursor|pointer-events)\s*:/g },
];

/** The CSS a printed page cannot show — motion, interaction states, fixed
 *  or sticky positioning, pointer styling — each with its line. It is not
 *  an error: the publication draws the static page. */
export function printNotes(css: string): PrintNote[] {
  if (typeof css !== "string" || css.length === 0) return [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) =>
    c.replace(/[^\n]/g, " "),
  );
  const out: PrintNote[] = [];
  for (const { code, re } of PRINT_NOTES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const feature = m[0]
        .replace(/^[\s;{]/, "")
        .replace(/\s*:$/, "")
        .trim();
      out.push({ code, feature, line: lineAt(text, m.index) });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** The variable names `{{name}}` / `{{name | filter}}` placeholders of
 *  `text` use, first use first, each once (the template pass's grammar). */
export function placeholderNames(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const out: string[] = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    const name = (m[1] ?? "").split("|")[0]!.trim();
    if (NAME_RE.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
