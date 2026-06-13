// A minimal SVG document reader/writer — the interchange layer over the
// path/shape lowering. The reader walks a hand-rolled XML tree (no DOM
// dep: draw-geometry has zero deps and must stay host-free), flattens `g`
// transforms (translate/scale/matrix/rotate/skewX/skewY), reads the
// presentation attrs (fill/stroke/stroke-width/fill-rule) + a basic
// `style=""` shorthand, and yields a list of `DrawShape` (an anchor table
// + resolved style). The writer is the inverse: shapes → `<svg>` with one
// `<path>` per shape carrying its fill/stroke.
//
// Out of scope (honest deferrals — see DESIGN notes / commit message):
// gradients/patterns as paint (only solid colours + none), `<text>`,
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
        if (name) attrs[name.toLowerCase()] = decodeEntities(raw.slice(vStart, j));
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

/** Parse a `transform="..."` attribute into a single composed affine
 *  (functions apply left-to-right, i.e. the leftmost is outermost). */
export function parseTransform(value: string): Affine {
  let m: Affine = IDENTITY_AFFINE;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const fn = match[1].toLowerCase();
    const args = match[2]
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map((s) => parseFloat(s));
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
        return composeAffine(
          composeAffine([1, 0, 0, 1, cx, cy], rot),
          [1, 0, 0, 1, -cx, -cy],
        );
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

function shapeFromElement(
  node: XmlNode,
  style: SvgStyle,
): AnchorTable | null {
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
    case "polyline":
      return polyToPath(parsePoints(a.points ?? ""), false);
    case "polygon":
      return polyToPath(parsePoints(a.points ?? ""), true);
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
  const nums = s
    .split(/[\s,]+/)
    .map((x) => parseFloat(x))
    .filter((x) => Number.isFinite(x));
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

// ----------------------------------------------------------- reader

/** Parse an SVG document (as text) into shapes with flattened transforms
 *  and resolved styles. Returns `null` when no `<svg>` root is found. */
export function parseSvgDocument(src: string): SvgDocument | null {
  const root = parseXml(src);
  if (!root) return null;

  const shapes: DrawShape[] = [];
  const walk = (node: XmlNode, parentM: Affine, inherited: SvgStyle): void => {
    const own = node.attrs.transform
      ? parseTransform(node.attrs.transform)
      : IDENTITY_AFFINE;
    const m =
      own === IDENTITY_AFFINE ? parentM : composeAffine(parentM, own);
    const style = resolveStyle(node.attrs, inherited);
    const name = localName(node.tag);

    if (name === "g" || name === "svg" || name === "a") {
      for (const child of node.children) walk(child, m, style);
      return;
    }
    const table = shapeFromElement(node, style);
    if (table) {
      shapes.push({ anchors: transformTable(table, m), style });
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
    const vb = ra.viewbox
      .split(/[\s,]+/)
      .map((x) => parseFloat(x))
      .filter((x) => Number.isFinite(x));
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
  if (style.fillRule !== undefined)
    parts.push(`fill-rule="${style.fillRule}"`);
  return parts.length ? " " + parts.join(" ") : "";
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
  const paths = shapes
    .map((s) => {
      const d = serializePathData(s.anchors, precision);
      if (!d) return null;
      return `  <path d="${d}"${styleAttrs(s.style)}/>`;
    })
    .filter((p): p is string => p !== null);

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
