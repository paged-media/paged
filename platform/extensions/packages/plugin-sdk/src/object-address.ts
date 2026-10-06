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
const ID_KINDS = new Set(["page", "spread", "layer", "master", "story", "table", "guide", "section", "hyperlink"]);
const REST_KINDS = new Set(["swatch", "gradient", "colorGroup", "numberingList", "condition", "conditionSet"]);

// ------------------------------------------------------------- id escaping

/** `id = 1*( %x21-7E except ":" "@" "/" "[" "]" "%" ) / pct-encoded`. */
const ID_SAFE = /^[\x21-\x7e]$/;
const ID_DELIMS = new Set([":", "@", "/", "[", "]", "%"]);

function encodeId(id: string): string {
  let out = "";
  for (const ch of id) {
    if (ID_SAFE.test(ch) && !ID_DELIMS.has(ch)) {
      out += ch;
    } else {
      for (const b of new TextEncoder().encode(ch)) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

function decodeId(text: string): string | null {
  if (text.length === 0) return null;
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "%") {
      const hex = text.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (ID_SAFE.test(ch) && !ID_DELIMS.has(ch)) {
      bytes.push(ch.charCodeAt(0));
    } else {
      return null;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

const UINT = /^(0|[1-9][0-9]*)$/;
const uint = (s: string): number | null => (UINT.test(s) ? Number(s) : null);

/** `<id>@<start>..<end>` → parts, or null. */
function parseRange(text: string): { id: string; start: number; end: number } | null {
  const m = /^(.+)@(\d+)\.\.(\d+)$/.exec(text);
  if (!m) return null;
  const id = decodeId(m[1]!);
  const start = uint(m[2]!);
  const end = uint(m[3]!);
  if (id === null || start === null || end === null || end <= start) return null;
  return { id, start, end };
}

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
  if (colon <= 0) return null;
  const head = text.slice(0, colon);
  const body = text.slice(colon + 1);
  if (body.length === 0) return null;

  if (head === "plugin") {
    const a = body.indexOf("/");
    if (a <= 0) return null;
    const b = body.indexOf("/", a + 1);
    if (b < 0) return null;
    const plugin = body.slice(0, a);
    const objectKind = body.slice(a + 1, b);
    const id = body.slice(b + 1);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(objectKind) || id.length === 0) return null;
    return { kind: "plugin", plugin, objectKind, id };
  }
  if (head === "master") {
    const gt = body.indexOf(" > ");
    if (gt >= 0) {
      const master = decodeId(body.slice(0, gt));
      const item = parseAddress(body.slice(gt + 3));
      if (master === null || !item || (item.kind !== "item" && item.kind !== "frame")) return null;
      return { kind: "onMaster", master, item };
    }
  }
  const itemKind = ITEM_KINDS[head];
  if (itemKind) {
    const id = decodeId(body);
    return id === null ? null : { kind: "item", itemKind, id };
  }
  if (head === "frame") {
    const id = decodeId(body);
    return id === null ? null : { kind: "frame", id };
  }
  if (head === "storyRange" || head === "storyrange") {
    const r = parseRange(body);
    return r ? { kind: "storyRange", story: r.id, start: r.start, end: r.end } : null;
  }
  if (head === "story" && /@\d+\.\.\d+$/.test(body)) {
    const r = parseRange(body);
    return r ? { kind: "storyRange", story: r.id, start: r.start, end: r.end } : null;
  }
  if (head === "page" && body.startsWith("#")) {
    const n = uint(body.slice(1));
    return n !== null && n >= 1 ? { kind: "pageIndex", index: n } : null;
  }
  if (head === "field") {
    const m = /^(.+)@(\d+)$/.exec(body);
    if (!m) return null;
    const story = decodeId(m[1]!);
    const offset = uint(m[2]!);
    return story !== null && offset !== null ? { kind: "field", story, offset } : null;
  }
  if (head === "cell") {
    const m = /^(.+)\/(\d+),(\d+)$/.exec(body);
    if (!m) return null;
    const table = decodeId(m[1]!);
    const row = uint(m[2]!);
    const col = uint(m[3]!);
    return table !== null && row !== null && col !== null ? { kind: "cell", table, row, col } : null;
  }
  if (head === "style") {
    const slash = body.indexOf("/");
    if (slash <= 0) return null;
    const family = body.slice(0, slash) as StyleFamily;
    const name = body.slice(slash + 1);
    return FAMILIES.has(family) && name.length > 0 ? { kind: "style", family, name } : null;
  }
  if (REST_KINDS.has(head)) {
    return { kind: head as "swatch", name: body };
  }
  if (ID_KINDS.has(head)) {
    const id = decodeId(body);
    return id === null ? null : ({ kind: head, id } as ParsedAddress);
  }
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
      return `${a.itemKind}:${encodeId(a.id)}`;
    case "frame":
      return `frame:${encodeId(a.id)}`;
    case "pageIndex":
      return `page:#${a.index}`;
    case "storyRange":
      return `storyRange:${encodeId(a.story)}@${a.start}..${a.end}`;
    case "field":
      return `field:${encodeId(a.story)}@${a.offset}`;
    case "cell":
      return `cell:${encodeId(a.table)}/${a.row},${a.col}`;
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
      return `master:${encodeId(a.master)} > ${formatAddress(a.item)}`;
    case "plugin":
      return `plugin:${a.plugin}/${a.objectKind}/${a.id}`;
    default:
      return `${a.kind}:${encodeId(a.id)}`;
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
