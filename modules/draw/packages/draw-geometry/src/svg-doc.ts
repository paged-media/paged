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

// A minimal SVG document reader/writer — the interchange layer over the
// path/shape lowering. The reader walks a hand-rolled XML tree (no DOM
// dep: draw-geometry has zero deps and must stay host-free), flattens `g`
// transforms (translate/scale/matrix/rotate/skewX/skewY), reads the
// presentation attrs (fill/stroke/stroke-width/fill-rule) + a basic
// `style=""` shorthand, and yields a list of `DrawShape` (an anchor table
// + resolved style). The writer is the inverse: shapes → `<svg>` with one
// `<path>` per shape carrying its fill/stroke.
//
// Gradients are paint since D-58's gradient part (engine ADR 1007):
// `<linearGradient>` / `<radialGradient>` with their stops' colour and
// opacity, resolved into the document frame (see "gradients" below).
//
// Out of scope (honest deferrals — see DESIGN notes / commit message):
// patterns as paint, a radial gradient's focal point, `<text>`,
// `<image>`, `<use>`/`<defs>`/`<symbol>`, clip-paths/masks, CSS
// stylesheets. Unknown elements are skipped (their children are still
// walked so a wrapping element never drops content).

import type { AnchorTriple, AnchorTable, Vec2 } from "./types";
import {
  applyAffine,
  composeAffine,
  IDENTITY_AFFINE,
  type Affine,
} from "./affine";
import { parsePathData, serializePathData } from "./svg-path";
import {
  rectToPath,
  ellipseToPath,
  circleToPath,
  lineToPath,
  polyToPath,
} from "./svg-shapes";

// ------------------------------------------------------------- model

export type FillRule = "nonzero" | "evenodd";

/** The resolved presentation style of a shape. `null` paint = `none`;
 *  `undefined` = inherit/default (the writer omits it). */
export interface SvgStyle {
  /** Fill colour as a CSS string (`"#ff0000"`, `"red"`, `"none"`→null). */
  fill?: string | null;
  /** Stroke colour, same convention. */
  stroke?: string | null;
  /** Stroke width in user units (post-transform-scale applied). */
  strokeWidth?: number;
  fillRule?: FillRule;
  /** The fill's gradient when `fill` is a `url(#…)` to one (then `fill`
   *  is its first stop's colour, for readers that know no gradients). */
  fillGradient?: SvgGradient;
  /** The stroke's gradient, the same way. */
  strokeGradient?: SvgGradient;
}

/** One imported shape: its geometry (cubic anchor table, transforms
 *  already flattened into the coordinates) + resolved style. */
export interface DrawShape {
  anchors: AnchorTable;
  style: SvgStyle;
}

/** The parsed document: its viewport box (when declared) + the shapes. */
export interface SvgDocument {
  width?: number;
  height?: number;
  /** `viewBox` as `[minX, minY, width, height]` when present. */
  viewBox?: [number, number, number, number];
  shapes: DrawShape[];
}

// --------------------------------------------------------- XML walk
//
// A tiny non-validating XML tokenizer → element tree. Handles tags,
// attributes (single/double quoted), self-closing, comments, CDATA,
// `<?xml?>`/`<!DOCTYPE>` prologues, and entity refs in attribute values.
// Text content is ignored (SVG geometry lives in attributes).

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

function parseXml(src: string): XmlNode | null {
  let i = 0;
  const n = src.length;
  const root: XmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    i = lt + 1;
    // Comment / CDATA / prologue — skip wholesale.
    if (src.startsWith("!--", i)) {
      const end = src.indexOf("-->", i);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith("![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src[i] === "!" || src[i] === "?") {
      const end = src.indexOf(">", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    // Closing tag.
    if (src[i] === "/") {
      const end = src.indexOf(">", i);
      if (end === -1) break;
      if (stack.length > 1) stack.pop();
      i = end + 1;
      continue;
    }
    // Opening (or self-closing) tag — read up to the matching `>`.
    const end = src.indexOf(">", i);
    if (end === -1) break;
    let raw = src.slice(i, end);
    const selfClose = raw.endsWith("/");
    if (selfClose) raw = raw.slice(0, -1);
    const node = parseTag(raw);
    i = end + 1;
    if (!node) continue;
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  // The SVG root is the first <svg> child of #root.
  return root.children.find((c) => localName(c.tag) === "svg") ?? null;
}

const localName = (tag: string): string => {
  const colon = tag.indexOf(":");
  return (colon === -1 ? tag : tag.slice(colon + 1)).toLowerCase();
};

function parseTag(raw: string): XmlNode | null {
  let j = 0;
  const m = raw.length;
  const skipWs = () => {
    while (j < m && /\s/.test(raw[j])) j++;
  };
  skipWs();
  const nameStart = j;
  while (j < m && !/[\s/]/.test(raw[j])) j++;
  const tag = raw.slice(nameStart, j);
  if (!tag) return null;
  const attrs: Record<string, string> = {};
  while (j < m) {
    skipWs();
    if (j >= m) break;
    const aStart = j;
    while (j < m && raw[j] !== "=" && !/\s/.test(raw[j])) j++;
    const name = raw.slice(aStart, j).trim();
    skipWs();
    if (raw[j] === "=") {
      j++;
      skipWs();
      const quote = raw[j];
      if (quote === '"' || quote === "'") {
        j++;
        const vStart = j;
        while (j < m && raw[j] !== quote) j++;
        const value = raw.slice(vStart, j);
        j++;
        if (name) attrs[name.toLowerCase()] = decodeEntities(value);
      } else {
        // Unquoted value (lenient).
        const vStart = j;
        while (j < m && !/\s/.test(raw[j])) j++;
        if (name)
          attrs[name.toLowerCase()] = decodeEntities(raw.slice(vStart, j));
      }
    } else if (name) {
      attrs[name.toLowerCase()] = "";
    }
  }
  return { tag, attrs, children: [] };
}

// --------------------------------------------------- transforms

const num = (s: string | undefined, fallback = 0): number => {
  if (s === undefined) return fallback;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : fallback;
};

/** One SVG number, anchored where the scan stands: an optional sign,
 *  digits with an optional fraction (or a bare fraction), an optional
 *  exponent. Sticky, so it never skips over junk to find one. */
const SVG_NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/**
 * Read an SVG number LIST — a transform function's arguments, a
 * `points` attribute, a `viewBox`.
 *
 * Whitespace and commas separate numbers, but they are not the only
 * thing that does: in SVG's number grammar a SIGN starts the next number
 * with no separator before it, and so does a second decimal point.
 * `10-5` is the two numbers 10 and −5, and `.5.5` is 0.5 twice. That is
 * the spelling a minifier writes whenever a coordinate is negative, and
 * the one the path parser (svg-path.ts) has always read. Splitting on
 * separators and `parseFloat`-ing the pieces reads `10-5` as the single
 * number 10 and silently loses the −5.
 *
 * So each separator-delimited piece is scanned for as many numbers as it
 * holds, back to back. What a piece holds AFTER its numbers is ignored,
 * and a piece that does not start with a number at all is one `NaN`
 * (`parseFloat`'s answer) — both exactly as lenient as before; a caller
 * that cannot use a `NaN` filters it.
 */
function parseNumberList(text: string): number[] {
  const out: number[] = [];
  for (const piece of text.split(/[\s,]+/)) {
    if (piece.length === 0) continue;
    let at = 0;
    while (at < piece.length) {
      SVG_NUMBER.lastIndex = at;
      const found = SVG_NUMBER.exec(piece);
      if (found === null) break;
      out.push(parseFloat(found[0]));
      at = SVG_NUMBER.lastIndex;
    }
    if (at === 0) out.push(parseFloat(piece));
  }
  return out;
}

/** Parse a `transform="..."` attribute into a single composed affine
 *  (functions apply left-to-right, i.e. the leftmost is outermost). */
export function parseTransform(value: string): Affine {
  let m: Affine = IDENTITY_AFFINE;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const fn = match[1].toLowerCase();
    const args = parseNumberList(match[2]);
    const t = transformFn(fn, args);
    if (t) m = composeAffine(m, t);
  }
  return m;
}

function transformFn(fn: string, a: number[]): Affine | null {
  switch (fn) {
    case "translate":
      return [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    case "scale": {
      const sx = a[0] ?? 1;
      const sy = a.length > 1 ? a[1] : sx;
      return [sx, 0, 0, sy, 0, 0];
    }
    case "matrix":
      if (a.length >= 6) return [a[0], a[1], a[2], a[3], a[4], a[5]];
      return null;
    case "rotate": {
      const rad = ((a[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rot: Affine = [cos, sin, -sin, cos, 0, 0];
      if (a.length >= 3) {
        // rotate(angle, cx, cy) = T(c)·R·T(−c)
        const cx = a[1];
        const cy = a[2];
        return composeAffine(composeAffine([1, 0, 0, 1, cx, cy], rot), [
          1,
          0,
          0,
          1,
          -cx,
          -cy,
        ]);
      }
      return rot;
    }
    case "skewx": {
      const rad = ((a[0] ?? 0) * Math.PI) / 180;
      return [1, 0, Math.tan(rad), 1, 0, 0];
    }
    case "skewy": {
      const rad = ((a[0] ?? 0) * Math.PI) / 180;
      return [1, Math.tan(rad), 0, 1, 0, 0];
    }
    default:
      return null;
  }
}

/** Apply an affine to every coordinate of an anchor table (in place on a
 *  fresh copy), so the imported geometry is already in the document frame
 *  (transforms flattened — the engine never re-applies a `g`). */
function transformTable(table: AnchorTable, m: Affine): AnchorTable {
  if (m === IDENTITY_AFFINE) return table;
  const anchors: AnchorTriple[] = table.anchors.map((a) => ({
    anchor: applyAffine(m, a.anchor[0], a.anchor[1]),
    left: applyAffine(m, a.left[0], a.left[1]),
    right: applyAffine(m, a.right[0], a.right[1]),
  }));
  return {
    anchors,
    subpathStarts: [...table.subpathStarts],
    subpathOpen: table.subpathOpen ? [...table.subpathOpen] : undefined,
  };
}

// ----------------------------------------------------------- style

function parseStyleShorthand(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of style.split(";")) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const key = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

/** Read a presentation property: the inline `style=""` declaration wins
 *  over the matching attribute (CSS specificity). */
function presentation(
  attrs: Record<string, string>,
  styleMap: Record<string, string>,
  name: string,
): string | undefined {
  return styleMap[name] ?? attrs[name];
}

const normalizePaint = (v: string | undefined): string | null | undefined => {
  if (v === undefined) return undefined;
  const t = v.trim().toLowerCase();
  if (t === "none") return null;
  if (t === "" || t === "transparent") return null;
  return v.trim();
};

/** Resolve a shape's style by merging inherited style with its own
 *  attrs/`style`. Returns the resolved style + the inheritable subset to
 *  pass down to children. */
function resolveStyle(
  attrs: Record<string, string>,
  inherited: SvgStyle,
): SvgStyle {
  const styleMap = attrs.style ? parseStyleShorthand(attrs.style) : {};
  const fillRaw = presentation(attrs, styleMap, "fill");
  const strokeRaw = presentation(attrs, styleMap, "stroke");
  const swRaw = presentation(attrs, styleMap, "stroke-width");
  const frRaw = presentation(attrs, styleMap, "fill-rule");

  const style: SvgStyle = { ...inherited };
  const fill = normalizePaint(fillRaw);
  if (fill !== undefined) style.fill = fill;
  const stroke = normalizePaint(strokeRaw);
  if (stroke !== undefined) style.stroke = stroke;
  if (swRaw !== undefined) {
    const w = parseFloat(swRaw);
    if (Number.isFinite(w)) style.strokeWidth = w;
  }
  if (frRaw !== undefined) {
    const fr = frRaw.trim().toLowerCase();
    if (fr === "evenodd" || fr === "nonzero") style.fillRule = fr;
  }
  return style;
}

// ----------------------------------------------------- shape readers

function shapeFromElement(node: XmlNode, style: SvgStyle): AnchorTable | null {
  const a = node.attrs;
  switch (localName(node.tag)) {
    case "path": {
      const d = a.d;
      if (!d) return null;
      const t = parsePathData(d);
      return t.anchors.length ? t : null;
    }
    case "rect": {
      const t = rectToPath(
        num(a.x),
        num(a.y),
        num(a.width),
        num(a.height),
        num(a.rx, NaNto0(a.rx)),
        num(a.ry, NaNto0(a.ry)),
      );
      return t.anchors.length ? t : null;
    }
    case "circle": {
      const t = circleToPath(num(a.cx), num(a.cy), num(a.r));
      return t.anchors.length ? t : null;
    }
    case "ellipse": {
      const t = ellipseToPath(num(a.cx), num(a.cy), num(a.rx), num(a.ry));
      return t.anchors.length ? t : null;
    }
    case "line": {
      // A bare line with no stroke is invisible; keep it anyway (the
      // importer decides). Default stroke so it isn't dropped silently.
      if (style.stroke === undefined) style.stroke = "#000000";
      return lineToPath(num(a.x1), num(a.y1), num(a.x2), num(a.y2));
    }
    // Fewer than two points lower to NO geometry (`polyToPath` answers
    // an empty table), and no geometry is no shape — the same rule the
    // four cases above apply. An empty table pushed as a shape would
    // count as one in the importer's "no shapes in <file>" check.
    case "polyline": {
      const t = polyToPath(parsePoints(a.points ?? ""), false);
      return t.anchors.length ? t : null;
    }
    case "polygon": {
      const t = polyToPath(parsePoints(a.points ?? ""), true);
      return t.anchors.length ? t : null;
    }
    default:
      return null;
  }
}

const NaNto0 = (s: string | undefined): number => {
  if (s === undefined) return 0;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
};

function parsePoints(s: string): Vec2[] {
  const nums = parseNumberList(s).filter((x) => Number.isFinite(x));
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

// ----------------------------------------------------- gradients
//
// D-58 (the gradient part) — `<linearGradient>` / `<radialGradient>` as
// paint. A `fill="url(#id)"` (or `stroke`) resolves against every gradient
// the document declares, at any depth (`<defs>` or not), with `href` /
// `xlink:href` inheritance of stops and attributes. The gradient's
// geometry is resolved into the SAME document frame the shape's anchors
// are flattened into (its `gradientUnits`, `gradientTransform` and the
// shape's own transform applied), so a consumer reads it beside the
// geometry without knowing any of SVG's coordinate rules. Each stop keeps
// its `stop-color` and `stop-opacity`. The paint's `fill` / `stroke`
// string is the first stop's colour, so a reader that knows no gradients
// still paints something representative.

/** One stop of an SVG gradient: offset 0..1, a CSS colour, opacity 0..1. */
export interface SvgGradientStop {
  offset: number;
  color: string;
  opacity: number;
}

/** A gradient paint resolved into the document frame. A linear one runs
 *  from `start` to `end`; a radial one is centred on `center` with
 *  `radius` (a focal point is not kept). */
export type SvgGradient =
  | {
      kind: "linear";
      start: Vec2;
      end: Vec2;
      stops: SvgGradientStop[];
    }
  | {
      kind: "radial";
      center: Vec2;
      radius: number;
      stops: SvgGradientStop[];
    };

/** A gradient element as declared (before it meets a shape). */
interface GradientDef {
  tag: "lineargradient" | "radialgradient";
  attrs: Record<string, string>;
  stops: SvgGradientStop[];
}

function parseOffset(v: string | undefined): number {
  if (v === undefined) return 0;
  const t = v.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, t.endsWith("%") ? n / 100 : n));
}

function parseOpacity(v: string | undefined): number {
  if (v === undefined) return 1;
  const t = v.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, t.endsWith("%") ? n / 100 : n));
}

/** Every gradient element of the tree by `id`, with its own stops. */
function collectGradients(root: XmlNode): Map<string, GradientDef> {
  const out = new Map<string, GradientDef>();
  const visit = (node: XmlNode): void => {
    const name = localName(node.tag);
    if (name === "lineargradient" || name === "radialgradient") {
      const stops: SvgGradientStop[] = [];
      let last = 0;
      for (const c of node.children) {
        if (localName(c.tag) !== "stop") continue;
        const style = c.attrs.style ? parseStyleShorthand(c.attrs.style) : {};
        // Offsets never decrease (SVG clamps a smaller one up).
        const offset = Math.max(last, parseOffset(c.attrs.offset));
        last = offset;
        const colorRaw = (
          style["stop-color"] ??
          c.attrs["stop-color"] ??
          "black"
        ).trim();
        stops.push({
          offset,
          color: colorRaw === "" ? "black" : colorRaw,
          opacity: parseOpacity(
            style["stop-opacity"] ?? c.attrs["stop-opacity"],
          ),
        });
      }
      const id = node.attrs.id;
      if (id) out.set(id, { tag: name, attrs: node.attrs, stops });
    }
    for (const c of node.children) visit(c);
  };
  visit(root);
  return out;
}

/** `#id` of a `url(#id)` paint, or null. */
function paintUrl(v: string | undefined): string | null {
  if (v === undefined) return null;
  const m = /^\s*url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/i.exec(v);
  return m ? m[1] : null;
}

/** A gradient's attributes and stops with its `href` chain folded in
 *  (own values win; stops come from the first in the chain that has any). */
function inheritGradient(
  id: string,
  defs: Map<string, GradientDef>,
): GradientDef | null {
  const chain: GradientDef[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const d = defs.get(cur);
    if (!d) break;
    chain.push(d);
    const href = d.attrs.href ?? d.attrs["xlink:href"];
    cur = href?.startsWith("#") ? href.slice(1) : undefined;
  }
  if (chain.length === 0) return null;
  const attrs: Record<string, string> = {};
  for (const d of [...chain].reverse()) Object.assign(attrs, d.attrs);
  const stops = chain.find((d) => d.stops.length > 0)?.stops ?? [];
  return { tag: chain[0].tag, attrs, stops };
}

/** A gradient length: a number, or a percentage of `ref`. Bounding-box
 *  units take fractions, so a percentage there is of 1. */
function gradLength(
  v: string | undefined,
  fallback: number,
  ref: number,
): number {
  if (v === undefined) return fallback;
  const t = v.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return fallback;
  return t.endsWith("%") ? (n / 100) * ref : n;
}

function tableBox(table: AnchorTable): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const a of table.anchors) {
    for (const p of [a.anchor, a.left, a.right]) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

/** Resolve gradient `id` for a shape whose geometry (in its own user
 *  space) is `table` and whose user space maps to the document by `m`. */
function resolveGradient(
  id: string,
  defs: Map<string, GradientDef>,
  table: AnchorTable,
  m: Affine,
): SvgGradient | null {
  const g = inheritGradient(id, defs);
  if (!g || g.stops.length === 0) return null;
  const a = g.attrs;
  const bbox = (a.gradientunits ?? "objectBoundingBox") !== "userSpaceOnUse";
  // Gradient space → user space: the box (bounding-box units), then the
  // gradient's own transform.
  let toUser: Affine = IDENTITY_AFFINE;
  if (bbox) {
    const [x0, y0, x1, y1] = tableBox(table);
    toUser = [x1 - x0, 0, 0, y1 - y0, x0, y0];
  }
  if (a.gradienttransform) {
    toUser = composeAffine(toUser, parseTransform(a.gradienttransform));
  }
  const toDoc = composeAffine(m, toUser);
  const map = (x: number, y: number): Vec2 => applyAffine(toDoc, x, y);
  const stops = g.stops.map((s) => ({ ...s }));
  if (g.tag === "lineargradient") {
    const ref = bbox ? 1 : 100;
    return {
      kind: "linear",
      start: map(gradLength(a.x1, 0, ref), gradLength(a.y1, 0, ref)),
      end: map(gradLength(a.x2, bbox ? 1 : 100, ref), gradLength(a.y2, 0, ref)),
      stops,
    };
  }
  const ref = bbox ? 1 : 100;
  const cx = gradLength(a.cx, bbox ? 0.5 : 50, ref);
  const cy = gradLength(a.cy, bbox ? 0.5 : 50, ref);
  const r = gradLength(a.r, bbox ? 0.5 : 50, ref);
  const center = map(cx, cy);
  // One radius in the document frame: the mapped x and y radii averaged
  // (a non-uniform box stretches the circle into an ellipse, which the
  // engine's radial approximates the same way).
  const rx = applyAffine(toDoc, cx + r, cy);
  const ry = applyAffine(toDoc, cx, cy + r);
  const radius =
    (Math.hypot(rx[0] - center[0], rx[1] - center[1]) +
      Math.hypot(ry[0] - center[0], ry[1] - center[1])) /
    2;
  return { kind: "radial", center, radius, stops };
}

/** A shape's style with its `url(#…)` paints resolved: the gradient in
 *  the document frame, and its first stop as the plain colour. A `url`
 *  to nothing paints nothing (SVG's fallback-less reference). */
function withGradients(
  style: SvgStyle,
  defs: Map<string, GradientDef>,
  table: AnchorTable,
  m: Affine,
): SvgStyle {
  const out: SvgStyle = { ...style };
  delete out.fillGradient;
  delete out.strokeGradient;
  for (const key of ["fill", "stroke"] as const) {
    const id = paintUrl(out[key] ?? undefined);
    if (!id) continue;
    const g = resolveGradient(id, defs, table, m);
    if (g) {
      out[key] = g.stops[0]!.color;
      if (key === "fill") out.fillGradient = g;
      else out.strokeGradient = g;
    } else {
      out[key] = null;
    }
  }
  return out;
}

// ----------------------------------------------------------- reader

/** Parse an SVG document (as text) into shapes with flattened transforms
 *  and resolved styles. Returns `null` when no `<svg>` root is found. */
export function parseSvgDocument(src: string): SvgDocument | null {
  const root = parseXml(src);
  if (!root) return null;

  const shapes: DrawShape[] = [];
  const gradients = collectGradients(root);
  const walk = (node: XmlNode, parentM: Affine, inherited: SvgStyle): void => {
    const own = node.attrs.transform
      ? parseTransform(node.attrs.transform)
      : IDENTITY_AFFINE;
    const m = own === IDENTITY_AFFINE ? parentM : composeAffine(parentM, own);
    const style = resolveStyle(node.attrs, inherited);
    const name = localName(node.tag);

    if (name === "g" || name === "svg" || name === "a") {
      for (const child of node.children) walk(child, m, style);
      return;
    }
    if (name === "lineargradient" || name === "radialgradient") return;
    const table = shapeFromElement(node, style);
    if (table) {
      shapes.push({
        anchors: transformTable(table, m),
        style: withGradients(style, gradients, table, m),
      });
    }
    // Some containers (e.g. unknown wrappers) may still hold geometry.
    for (const child of node.children) walk(child, m, style);
  };

  // The root <svg>'s own transform (rare) + inherited defaults.
  walk(root, IDENTITY_AFFINE, {});

  const ra = root.attrs;
  const doc: SvgDocument = { shapes };
  if (ra.width !== undefined) {
    const w = parseFloat(ra.width);
    if (Number.isFinite(w)) doc.width = w;
  }
  if (ra.height !== undefined) {
    const h = parseFloat(ra.height);
    if (Number.isFinite(h)) doc.height = h;
  }
  if (ra.viewbox !== undefined) {
    const vb = parseNumberList(ra.viewbox).filter((x) => Number.isFinite(x));
    if (vb.length === 4) doc.viewBox = [vb[0], vb[1], vb[2], vb[3]];
  }
  return doc;
}

// ----------------------------------------------------------- writer

export interface SvgWriteOptions {
  /** Coordinate precision for emitted path data (default 3). */
  precision?: number;
  /** Explicit `width`/`height` for the root (else derived from bounds). */
  width?: number;
  height?: number;
}

function styleAttrs(style: SvgStyle): string {
  const parts: string[] = [];
  if (style.fill === null) parts.push(`fill="none"`);
  else if (style.fill !== undefined) parts.push(`fill="${esc(style.fill)}"`);
  if (style.stroke === null) parts.push(`stroke="none"`);
  else if (style.stroke !== undefined)
    parts.push(`stroke="${esc(style.stroke)}"`);
  if (style.strokeWidth !== undefined)
    parts.push(`stroke-width="${style.strokeWidth}"`);
  if (style.fillRule !== undefined) parts.push(`fill-rule="${style.fillRule}"`);
  return parts.length ? " " + parts.join(" ") : "";
}

/** The `<linearGradient>` / `<radialGradient>` element for `g`, in the
 *  document frame (`userSpaceOnUse`), with id `id`. */
function gradientElement(
  id: string,
  g: SvgGradient,
  precision: number,
): string {
  const f = (v: number) => Number(v.toFixed(precision)).toString();
  const stops = g.stops
    .map((s) => {
      const op =
        s.opacity < 1 ? ` stop-opacity="${Number(s.opacity.toFixed(4))}"` : "";
      return `      <stop offset="${Number(s.offset.toFixed(4))}" stop-color="${esc(s.color)}"${op}/>`;
    })
    .join("\n");
  const head =
    g.kind === "linear"
      ? `    <linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(g.start[0])}" y1="${f(g.start[1])}" x2="${f(g.end[0])}" y2="${f(g.end[1])}">`
      : `    <radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f(g.center[0])}" cy="${f(g.center[1])}" r="${f(g.radius)}">`;
  const tail =
    g.kind === "linear" ? "    </linearGradient>" : "    </radialGradient>";
  return `${head}\n${stops}\n${tail}`;
}

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Serialize shapes into an SVG document string. Each shape becomes one
 *  `<path d=... fill=... stroke=...>`. The viewport defaults to the
 *  shapes' bounding box (origin-anchored) when no explicit size given. */
export function serializeSvgDocument(
  shapes: readonly DrawShape[],
  options: SvgWriteOptions = {},
): string {
  const precision = options.precision ?? 3;
  const defs: string[] = [];
  const paths = shapes
    .map((s) => {
      const d = serializePathData(s.anchors, precision);
      if (!d) return null;
      const style: SvgStyle = { ...s.style };
      if (s.style.fillGradient) {
        const id = `g${defs.length + 1}`;
        defs.push(gradientElement(id, s.style.fillGradient, precision));
        style.fill = `url(#${id})`;
      }
      if (s.style.strokeGradient) {
        const id = `g${defs.length + 1}`;
        defs.push(gradientElement(id, s.style.strokeGradient, precision));
        style.stroke = `url(#${id})`;
      }
      return `  <path d="${d}"${styleAttrs(style)}/>`;
    })
    .filter((p): p is string => p !== null);
  if (defs.length > 0) paths.unshift(`  <defs>\n${defs.join("\n")}\n  </defs>`);

  let { width, height } = options;
  if (width === undefined || height === undefined) {
    const bb = boundsOf(shapes);
    width = width ?? Math.max(1, Math.ceil(bb.maxX));
    height = height ?? Math.max(1, Math.ceil(bb.maxY));
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">\n` +
    paths.join("\n") +
    (paths.length ? "\n" : "") +
    `</svg>\n`
  );
}

function boundsOf(shapes: readonly DrawShape[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of shapes) {
    for (const a of s.anchors.anchors) {
      for (const p of [a.anchor, a.left, a.right]) {
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] > maxY) maxY = p[1];
      }
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}
