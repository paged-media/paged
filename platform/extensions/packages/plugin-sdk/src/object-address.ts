/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// ADR 131 — the TypeScript mirror of core's address grammar and selector
// syntax (`paged_wire::Address`). Core owns the grammar; this file must
// parse and format exactly what core does, and both run the same corpus
// once core exports it (until then: test/object-address.spec.ts).
//
// Plus the SEAM to today's wire: `toElementId` / `fromElementId` map the
// address forms the protocol-69 wire can carry (`ElementId`) and nothing
// else. When core's `Set { address, path, value }` lands, addresses travel
// as strings and this seam shrinks to the read side.

import type {
  ElementId,
  PageItemKind,
  ParsedAddress,
  StyleFamily,
} from "@paged-media/plugin-api";

const ITEM_KINDS: Record<string, PageItemKind> = {
  textFrame: "textFrame",
  rectangle: "rectangle",
  oval: "oval",
  polygon: "polygon",
  graphicLine: "graphicLine",
  group: "group",
  // aliases (parse, never emitted)
  textframe: "textFrame",
  rect: "rectangle",
  graphicline: "graphicLine",
};
export const PAGE_ITEM_KINDS: readonly PageItemKind[] = [
  "textFrame",
  "rectangle",
  "oval",
  "polygon",
  "graphicLine",
  "group",
];
const FAMILIES = new Set<StyleFamily>(["paragraph", "character", "object", "cell", "table"]);
const ID_KINDS = new Set(["spread", "layer", "table", "guide", "section", "hyperlink", "textVariable"]);
const REST_KINDS = new Set(["swatch", "gradient", "colorGroup", "numberingList", "condition", "conditionSet"]);

// ------------------------------------------------------------- id escaping

// Core's protocol-71 grammar (`paged_wire::address`): `<rest>` runs to the
// end of the address and may contain anything, so a plain `<id>` (and a
// self id such as `Color/Red`) needs no escaping. `%` escapes ONLY where an
// id must stop at a delimiter — the `@` ending a story id in
// `storyRange:` / `field:`, the `/` ending a table id in `cell:` and the
// plugin id / kind in `plugin:`, the `>` of the ` > ` ending a master in a
// master-scoped item — and `%` itself, in exactly those places.

/** Core's `enc`: `%` and the delimiters as `%XX` (UTF-8 bytes). */
function enc(id: string, delims: string): string {
  let out = "";
  for (const ch of id) {
    if (ch === "%" || delims.includes(ch)) {
      for (const b of new TextEncoder().encode(ch)) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    } else {
      out += ch;
    }
  }
  return out;
}

/** Core's `dec`: undo `enc`; a `%` not followed by two hex digits is kept
 *  literally (lenient, like core). */
function dec(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const out: number[] = [];
  const hex = (b: number): number | null => {
    const c = String.fromCharCode(b);
    return /^[0-9A-Fa-f]$/.test(c) ? parseInt(c, 16) : null;
  };
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x25 && i + 2 < bytes.length) {
      const h = hex(bytes[i + 1]!);
      const l = hex(bytes[i + 2]!);
      if (h !== null && l !== null) {
        out.push(h * 16 + l);
        i += 2;
        continue;
      }
    }
    out.push(bytes[i]!);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(out));
  } catch {
    return text;
  }
}

const uint = (s: string): number | null => (/^[0-9]+$/.test(s) && Number(s) <= 0xffffffff ? Number(s) : null);

/** `<a>..<b>` with `b > a` → the pair, or null. */
function parseRange(text: string): { start: number; end: number } | null {
  const dots = text.indexOf("..");
  if (dots < 0) return null;
  const start = uint(text.slice(0, dots));
  const end = uint(text.slice(dots + 2));
  // A zero-length range is a caret: the paragraph it stands in (core's
  // grammar, v0.71.2). A reversed range is refused.
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

const MASTER_SCOPE = " > ";

// ------------------------------------------------------------- addresses

/** Parse an address (ADR 131); `null` when it is not one. Never throws. */
export function parseAddress(text: string): ParsedAddress | null {
  if (typeof text !== "string" || text.length === 0) return null;
  if (text === "doc") return { kind: "doc" };
  if (text.startsWith("$h:")) {
    const name = text.slice(3);
    return name.length > 0 ? { kind: "handle", name } : null;
  }
  const colon = text.indexOf(":");
  if (colon < 0) return null;
  const head = text.slice(0, colon);
  const rest = text.slice(colon + 1);
  if (rest.length === 0) return null;

  const itemKind = ITEM_KINDS[head];
  if (itemKind) return { kind: "item", itemKind, id: rest };
  if (head === "frame") return { kind: "frame", id: rest };
  if (REST_KINDS.has(head)) return { kind: head as "swatch", name: rest };
  if (head === "textvariable") return { kind: "textVariable", id: rest };
  if (head === "page") {
    if (!rest.startsWith("#")) return { kind: "page", id: rest };
    const n = uint(rest.slice(1));
    return n !== null && n >= 1 ? { kind: "pageIndex", index: n } : null;
  }
  if (head === "master") {
    const gt = rest.indexOf(MASTER_SCOPE);
    if (gt < 0) return { kind: "master", id: rest };
    const item = parseAddress(rest.slice(gt + MASTER_SCOPE.length));
    if (gt === 0 || !item || (item.kind !== "item" && item.kind !== "frame")) return null;
    return { kind: "onMaster", master: dec(rest.slice(0, gt)), item };
  }
  if (head === "story" || head === "storyRange" || head === "storyrange") {
    const rangeRequired = head !== "story";
    const at = rest.lastIndexOf("@");
    if (at >= 0 && (rangeRequired || rest.slice(at + 1).includes(".."))) {
      if (at === 0) return null;
      const r = parseRange(rest.slice(at + 1));
      return r ? { kind: "storyRange", story: dec(rest.slice(0, at)), start: r.start, end: r.end } : null;
    }
    return rangeRequired ? null : { kind: "story", id: rest };
  }
  if (head === "field") {
    const at = rest.lastIndexOf("@");
    if (at <= 0) return null;
    const offset = uint(rest.slice(at + 1));
    return offset === null ? null : { kind: "field", story: dec(rest.slice(0, at)), offset };
  }
  if (head === "cell") {
    const slash = rest.lastIndexOf("/");
    if (slash <= 0) return null;
    const rc = rest.slice(slash + 1);
    const comma = rc.indexOf(",");
    if (comma < 0) return null;
    const row = uint(rc.slice(0, comma));
    const col = uint(rc.slice(comma + 1));
    return row === null || col === null ? null : { kind: "cell", table: dec(rest.slice(0, slash)), row, col };
  }
  if (head === "style") {
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    const family = rest.slice(0, slash) as StyleFamily;
    const name = rest.slice(slash + 1);
    return FAMILIES.has(family) && name.length > 0 ? { kind: "style", family, name } : null;
  }
  if (head === "plugin") {
    const a = rest.indexOf("/");
    const b = a < 0 ? -1 : rest.indexOf("/", a + 1);
    if (a <= 0 || b < 0 || b === a + 1 || b === rest.length - 1) return null;
    return { kind: "plugin", plugin: dec(rest.slice(0, a)), objectKind: dec(rest.slice(a + 1, b)), id: rest.slice(b + 1) };
  }
  if (ID_KINDS.has(head)) return { kind: head, id: rest } as ParsedAddress;
  return null;
}

/** Format a parsed address in its CANONICAL form (aliases never emitted). */
export function formatAddress(a: ParsedAddress): string {
  switch (a.kind) {
    case "doc":
      return "doc";
    case "handle":
      return `$h:${a.name}`;
    case "item":
      return `${a.itemKind}:${a.id}`;
    case "pageIndex":
      return `page:#${a.index}`;
    case "storyRange":
      return `storyRange:${enc(a.story, "@")}@${a.start}..${a.end}`;
    case "field":
      return `field:${enc(a.story, "@")}@${a.offset}`;
    case "cell":
      return `cell:${enc(a.table, "/")}/${a.row},${a.col}`;
    case "style":
      return `style:${a.family}/${a.name}`;
    case "swatch":
    case "gradient":
    case "colorGroup":
    case "numberingList":
    case "condition":
    case "conditionSet":
      return `${a.kind}:${a.name}`;
    case "onMaster":
      return `master:${enc(a.master, ">")}${MASTER_SCOPE}${formatAddress(a.item)}`;
    case "plugin":
      return `plugin:${enc(a.plugin, "/")}/${enc(a.objectKind, "/")}/${a.id}`;
    default:
      return `${a.kind}:${a.id}`;
  }
}

/** Canonicalise an address string; `null` when it does not parse. */
export function normalizeAddress(text: string): string | null {
  const p = parseAddress(text);
  return p ? formatAddress(p) : null;
}

/** The QUALIFIED kind an address belongs to for schema/routing purposes:
 *  `frame` for every page item, `story` for ranges, `page` for `page:#n`,
 *  `plugin:<id>/<kind>` for plugin objects. */
export function addressKindOf(a: ParsedAddress): string {
  switch (a.kind) {
    case "item":
    case "frame":
    case "onMaster":
      return "frame";
    case "pageIndex":
      return "page";
    case "storyRange":
      return "story";
    case "plugin":
      return `plugin:${a.plugin}/${a.objectKind}`;
    default:
      return a.kind;
  }
}

// ------------------------------------------------------- wire seam (v69)

/** The `ElementId` today's wire carries for an address, or `null` when the
 *  wire has no form for it (layers, swatches, pages, the document… — the
 *  forms core's `Set` will carry as strings). Tables and cells need their
 *  owning story, which only a resolver knows: see core-objects.ts. */
export function toElementId(a: ParsedAddress): ElementId | null {
  if (a.kind === "item") return { kind: a.itemKind, id: a.id } as ElementId;
  if (a.kind === "storyRange") {
    return { kind: "storyRange", id: { story_id: a.story, start: a.start, end: a.end } };
  }
  return null;
}

/** The canonical address of a wire `ElementId` (total, ADR 131). */
export function fromElementId(id: ElementId): string {
  switch (id.kind) {
    case "storyRange":
      return formatAddress({ kind: "storyRange", story: id.id.story_id, start: id.id.start, end: id.id.end });
    case "table":
      return formatAddress({ kind: "table", id: id.id.table_id });
    case "tableCell":
      return formatAddress({ kind: "cell", table: id.id.table_id, row: id.id.row, col: id.id.col });
    default:
      return formatAddress({ kind: "item", itemKind: id.kind, id: id.id });
  }
}

// ------------------------------------------------------------- selectors

export type SelectorHead =
  | { type: "address"; address: ParsedAddress }
  | { type: "kind"; kind: string }
  | { type: "any" };

export interface SelectorPredicate {
  key: string;
  op: "=" | "!=" | "^=" | "*=";
  value: string;
}

export interface SelectorStep {
  /** How this step relates to the previous one (absent on the first). */
  combinator?: "child" | "descendant";
  head: SelectorHead;
  predicates: SelectorPredicate[];
  /** `:nth(n)`, 1-based. */
  nth?: number;
}

export interface ParsedSelector {
  steps: SelectorStep[];
}

/** Kind words a selector step may name (ADR 131 plus the other named
 *  resource kinds). `plugin:<id>/<kind>` is checked separately. */
export const SELECTOR_KINDS = new Set<string>([
  ...PAGE_ITEM_KINDS,
  "frame",
  "page",
  "spread",
  "layer",
  "story",
  "table",
  "cell",
  "style",
  "style:paragraph",
  "style:character",
  "style:object",
  "style:cell",
  "style:table",
  "swatch",
  "master",
  "gradient",
  "colorGroup",
  "numberingList",
  "condition",
  "conditionSet",
  "section",
  "hyperlink",
  "guide",
  "textVariable",
  // Placeholder fields (`field:<story>@<offset>`): core's selector kind;
  // without it `field` / `story > field` failed to parse and answered [].
  "field",
]);

/** Split a selector into step tokens and combinators, respecting brackets
 *  and quotes. A step address with a SPACE in it (`swatch:My Red`) cannot
 *  appear in a selector — use `swatch[name="My Red"]`. */
function tokenize(text: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let depth = 0;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\" && i + 1 < text.length) cur += text[++i];
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"' && depth > 0) {
      quote = true;
      cur += ch;
    } else if (ch === "[") {
      depth++;
      cur += ch;
    } else if (ch === "]") {
      if (depth === 0) return null;
      depth--;
      cur += ch;
    } else if (ch === " " && depth === 0) {
      if (cur) tokens.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (quote || depth !== 0) return null;
  if (cur) tokens.push(cur);
  return tokens;
}

function parseStep(token: string): Omit<SelectorStep, "combinator"> | null {
  let rest = token;
  let nth: number | undefined;
  const nthMatch = /:nth\((\d+)\)$/.exec(rest);
  if (nthMatch) {
    nth = Number(nthMatch[1]);
    if (nth < 1) return null;
    rest = rest.slice(0, nthMatch.index);
  }
  const bracket = rest.indexOf("[");
  const headText = bracket < 0 ? rest : rest.slice(0, bracket);
  let preds = bracket < 0 ? "" : rest.slice(bracket);
  let head: SelectorHead;
  if (headText === "*") head = { type: "any" };
  else if (SELECTOR_KINDS.has(headText)) head = { type: "kind", kind: headText };
  else if (/^plugin:[^/]+\/[A-Za-z][A-Za-z0-9_-]*$/.test(headText)) head = { type: "kind", kind: headText };
  else {
    const address = parseAddress(headText);
    if (!address) return null;
    head = { type: "address", address };
  }
  const predicates: SelectorPredicate[] = [];
  while (preds.length > 0) {
    const m = /^\[([^\]=!^*"]+?)(=|!=|\^=|\*=)("((?:[^"\\]|\\.)*)"|([^\]"]*))\]/.exec(preds);
    if (!m) return null;
    const value = m[4] !== undefined ? m[4].replace(/\\(.)/g, "$1") : m[5]!;
    predicates.push({ key: m[1]!.trim(), op: m[2] as SelectorPredicate["op"], value });
    preds = preds.slice(m[0].length);
  }
  const step: Omit<SelectorStep, "combinator"> = { head, predicates };
  if (nth !== undefined) step.nth = nth;
  return step;
}

/** Parse a selector (ADR 131); `null` when it is not one. Never throws. */
export function parseSelector(text: string): ParsedSelector | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  // The master-scoped address form contains " > " itself.
  const whole = parseAddress(text);
  if (whole && whole.kind === "onMaster") {
    return { steps: [{ head: { type: "address", address: whole }, predicates: [] }] };
  }
  const tokens = tokenize(text.trim());
  if (!tokens || tokens.length === 0) return null;
  const steps: SelectorStep[] = [];
  let pending: SelectorStep["combinator"] | undefined;
  for (const tok of tokens) {
    if (tok === ">") {
      if (steps.length === 0 || pending === "child") return null;
      pending = "child";
      continue;
    }
    const step = parseStep(tok);
    if (!step) return null;
    if (steps.length > 0) {
      steps.push({ combinator: pending ?? "descendant", ...step });
    } else {
      steps.push(step as SelectorStep);
    }
    pending = undefined;
  }
  if (pending) return null;
  return { steps };
}
