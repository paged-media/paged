// The SHAPE TOOLS' geometry (image ADR 476, WP5.11): Rectangle, Ellipse,
// Polygon, Line and Custom Shape, drawn by a drag in image px. Pure
// functions over draw's geometry (`@paged-media/draw-geometry`: the
// same rectangle, ellipse, polygon and SVG path code the draw module
// draws with), so nothing here is a second copy of a shape.
//
// The drag follows Photoshop: from one corner to the other; Shift
// constrains to a square / circle / regular box (and the Line to 45°);
// Alt draws from the centre outwards.

import {
  ellipseToPath,
  parsePathData,
  rectToPath,
  regularPolygonPath,
  starPath,
  type AnchorTable,
} from "@paged-media/draw-geometry";

import { geometryOf, type Geometry } from "./vector-engine";

export type ShapeKind = "rectangle" | "ellipse" | "polygon" | "line" | "custom";

/** The shape tools' options (Photoshop's defaults). */
export interface ShapeOptions {
  /** Rectangle: the corner radius, px. */
  radius: number;
  /** Polygon: the number of sides (3–100). */
  sides: number;
  /** Polygon: indent the sides by this percent to make a star (0 = a
   *  plain polygon). */
  starIndent: number;
  /** Line: its weight, px. */
  weight: number;
  /** Custom Shape: the shape's id in `CUSTOM_SHAPES`. */
  custom: string;
}

export const SHAPE_DEFAULTS: ShapeOptions = {
  radius: 0,
  sides: 5,
  starIndent: 0,
  weight: 1,
  custom: "arrow",
};

/** A small built-in Custom Shape library: SVG path data in a 100×100
 *  box, scaled into the drag. */
export const CUSTOM_SHAPES: Record<string, string> = {
  arrow: "M0 35 L60 35 L60 10 L100 50 L60 90 L60 65 L0 65 Z",
  heart:
    "M50 90 C20 70 0 50 0 30 C0 12 14 0 30 0 C40 0 47 5 50 12 C53 5 60 0 70 0 C86 0 100 12 100 30 C100 50 80 70 50 90 Z",
  check: "M0 55 L15 40 L38 62 L85 10 L100 25 L38 92 Z",
  speech:
    "M10 0 L90 0 C95.5 0 100 4.5 100 10 L100 60 C100 65.5 95.5 70 90 70 L40 70 L15 95 L20 70 L10 70 C4.5 70 0 65.5 0 60 L0 10 C0 4.5 4.5 0 10 0 Z",
  cross:
    "M35 0 L65 0 L65 35 L100 35 L100 65 L65 65 L65 100 L35 100 L35 65 L0 65 L0 35 L35 35 Z",
};

/** The drag's box: `[x0, y0, x1, y1]`, normalised, after Shift (a square)
 *  and Alt (from the centre). */
export function dragBox(
  from: readonly [number, number],
  to: readonly [number, number],
  mods: { shift: boolean; alt: boolean },
): [number, number, number, number] {
  let dx = to[0] - from[0];
  let dy = to[1] - from[1];
  if (mods.shift) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  const [x0, y0, x1, y1] = mods.alt
    ? [from[0] - dx, from[1] - dy, from[0] + dx, from[1] + dy]
    : [from[0], from[1], from[0] + dx, from[1] + dy];
  return [
    Math.min(x0, x1),
    Math.min(y0, y1),
    Math.max(x0, x1),
    Math.max(y0, y1),
  ];
}

/** Scale an anchor table from its own `[minX, minY, maxX, maxY]` into the
 *  box. */
function fitInto(
  t: AnchorTable,
  src: [number, number, number, number],
  box: [number, number, number, number],
): AnchorTable {
  const sx = (box[2] - box[0]) / Math.max(src[2] - src[0], 1e-9);
  const sy = (box[3] - box[1]) / Math.max(src[3] - src[1], 1e-9);
  const m = (p: readonly [number, number]): [number, number] => [
    box[0] + (p[0] - src[0]) * sx,
    box[1] + (p[1] - src[1]) * sy,
  ];
  return {
    anchors: t.anchors.map((a) => ({
      anchor: m(a.anchor),
      left: m(a.left),
      right: m(a.right),
    })),
    subpathStarts: [...t.subpathStarts],
    subpathOpen: [...(t.subpathOpen ?? [])],
  };
}

/** The Line: a filled band of `weight` px around the segment (Photoshop's
 *  Line tool draws a shape, not a stroke). Shift constrains to 45°. */
function lineBand(
  from: readonly [number, number],
  to: readonly [number, number],
  weight: number,
  shift: boolean,
): AnchorTable {
  let [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  if (shift) {
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const l = Math.hypot(dx, dy);
    dx = l * Math.cos(a);
    dy = l * Math.sin(a);
  }
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { anchors: [], subpathStarts: [], subpathOpen: [] };
  const w = Math.max(weight, 0.01) / 2;
  const [nx, ny] = [(-dy / len) * w, (dx / len) * w];
  const pts: [number, number][] = [
    [from[0] + nx, from[1] + ny],
    [from[0] + dx + nx, from[1] + dy + ny],
    [from[0] + dx - nx, from[1] + dy - ny],
    [from[0] - nx, from[1] - ny],
  ];
  return {
    anchors: pts.map((p) => ({ anchor: p, left: p, right: p })),
    subpathStarts: [0],
    subpathOpen: [false],
  };
}

/** The shape a drag from `from` to `to` (image px) draws, as geometry
 *  whose one component has operation `op`. Null when the drag is too
 *  small to enclose anything. */
export function shapeGeometry(
  kind: ShapeKind,
  from: readonly [number, number],
  to: readonly [number, number],
  mods: { shift: boolean; alt: boolean },
  opts: ShapeOptions,
  op = 1,
): Geometry | null {
  let table: AnchorTable;
  if (kind === "line") {
    table = lineBand(from, to, opts.weight, mods.shift);
  } else {
    const box = dragBox(from, to, mods);
    const [x0, y0, x1, y1] = box;
    const [w, h] = [x1 - x0, y1 - y0];
    if (w < 0.5 || h < 0.5) return null;
    switch (kind) {
      case "rectangle":
        table = rectToPath(x0, y0, w, h, opts.radius, opts.radius);
        break;
      case "ellipse":
        table = ellipseToPath((x0 + x1) / 2, (y0 + y1) / 2, w / 2, h / 2);
        break;
      case "polygon": {
        const sides = Math.min(100, Math.max(3, Math.round(opts.sides)));
        const unit =
          opts.starIndent > 0
            ? starPath({
                cx: 0,
                cy: 0,
                radius1: 1,
                radius2: 1 - Math.min(99, opts.starIndent) / 100,
                points: sides,
              })
            : regularPolygonPath(0, 0, 1, sides);
        table = fitInto(unit, boundsOf(unit), box);
        break;
      }
      case "custom": {
        const d = CUSTOM_SHAPES[opts.custom] ?? CUSTOM_SHAPES.arrow;
        const unit = parsePathData(d);
        table = fitInto(unit, [0, 0, 100, 100], box);
        break;
      }
    }
  }
  if (table.anchors.length < 2) return null;
  const g = geometryOf(table);
  // One component: the first subpath carries the operation, the rest
  // (a custom shape's holes) continue it.
  g.subpaths.forEach((s, i) => {
    s.op = i === 0 ? op : 0xffff;
    s.rule = i === 0 ? 1 : 0;
  });
  return g;
}

function boundsOf(t: AnchorTable): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const a of t.anchors) {
    x0 = Math.min(x0, a.anchor[0]);
    y0 = Math.min(y0, a.anchor[1]);
    x1 = Math.max(x1, a.anchor[0]);
    y1 = Math.max(y1, a.anchor[1]);
  }
  return [x0, y0, x1, y1];
}
