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

// Live shapes (engine ADR 10XX, editor ADR 310) — the geometry the
// on-canvas widgets and the Polygon tool draw with. The ENGINE owns the
// shape (`paged_model::live_shape`): it redraws a polygon's anchors from
// its sides and inset and an oval's wedge from its pie angles. This file
// is the editor's twin of that geometry for what the engine cannot draw
// for it: the tool's preview, the widgets' positions, and the outline a
// drag previews before it commits. It follows the engine's definitions
// exactly (the first point at twelve o'clock, clockwise on the page; a
// pie counter-clockwise from three o'clock), which the specs pin.

/** `[top, left, bottom, right]`, the wire's bounds order. */
export type Box = readonly [number, number, number, number];
export type Pt = readonly [number, number];

/** The engine's limits (`paged_model::live_shape`). */
export const MIN_SIDES = 3;
export const MAX_SIDES = 100;
export const MAX_STAR_INSET = 99;

export interface PolygonShape {
  sides: number;
  /** Percent; 0 is the plain polygon. */
  starInset: number;
}

/** A shape with its parameters clamped as the engine clamps them. */
export function clampShape(sides: number, starInset: number): PolygonShape {
  const s = Number.isFinite(sides) ? Math.round(sides) : 6;
  const i = Number.isFinite(starInset) ? starInset : 0;
  return {
    sides: Math.min(MAX_SIDES, Math.max(MIN_SIDES, s)),
    starInset: Math.min(MAX_STAR_INSET, Math.max(0, i)),
  };
}

/** The shape's points on the unit circle: the first at twelve o'clock,
 *  clockwise on a y-down page, a star's inner points between them. */
export function unitPolygon(shape: PolygonShape): Pt[] {
  const { sides, starInset } = clampShape(shape.sides, shape.starInset);
  const star = starInset > 0;
  const count = star ? sides * 2 : sides;
  const inner = 1 - starInset / 100;
  const out: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const t = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const r = star && i % 2 === 1 ? inner : 1;
    out.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return out;
}

/** The shape inscribed in the ellipse of `circle` (its outer points on
 *  the ellipse) — how the Polygon tool draws a shape in its drag box. */
export function polygonInCircle(circle: Box, shape: PolygonShape): Pt[] {
  const [top, left, bottom, right] = circle;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const rx = (right - left) / 2;
  const ry = (bottom - top) / 2;
  return unitPolygon(shape).map(([x, y]) => [cx + x * rx, cy + y * ry]);
}

/** The bounding box of some points. */
export function pointsBox(points: readonly Pt[]): Box {
  let top = Infinity;
  let left = Infinity;
  let bottom = -Infinity;
  let right = -Infinity;
  for (const [x, y] of points) {
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return [top, left, bottom, right];
}

/** The ellipse box of a live shape whose points fill `fit` (the engine's
 *  `circle_box`): a change of sides or inset keeps it. */
export function circleBoxOf(fit: Box, shape: PolygonShape): Box {
  const [uTop, uLeft, uBottom, uRight] = pointsBox(unitPolygon(shape));
  const sx = (fit[3] - fit[1]) / (uRight - uLeft);
  const sy = (fit[2] - fit[0]) / (uBottom - uTop);
  const x = (u: number) => fit[1] + (u - uLeft) * sx;
  const y = (u: number) => fit[0] + (u - uTop) * sy;
  return [y(-1), x(-1), y(1), x(1)];
}

/** The shape fitted to `fit` (its points' box is `fit`) — the engine's
 *  `polygon_anchors`. */
export function polygonInBox(fit: Box, shape: PolygonShape): Pt[] {
  return polygonInCircle(circleBoxOf(fit, shape), shape);
}

// --------------------------------------------------------------- pies

/** The start angle as the engine stores it: `[0, 360)`. */
export function normalizeStart(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return r >= 360 ? 0 : r + 0;
}

/** The end angle as the engine stores it: `(0, 360]` (0 stays 0). */
export function normalizeEnd(deg: number): number {
  const r = normalizeStart(deg);
  return r === 0 && deg !== 0 ? 360 : r;
}

/** Degrees swept counter-clockwise from `start` to `end`, `[0, 360)`;
 *  0 is the whole ellipse. */
export function pieSweep(start: number, end: number): number {
  return ((((end - start) % 360) + 360) % 360) % 360;
}

/** The point at `deg` (counter-clockwise from three o'clock) on the
 *  ellipse inscribed in `box`. */
export function ellipsePoint(box: Box, deg: number): Pt {
  const [top, left, bottom, right] = box;
  const t = (deg * Math.PI) / 180;
  return [
    (left + right) / 2 + ((right - left) / 2) * Math.cos(t),
    (top + bottom) / 2 - ((bottom - top) / 2) * Math.sin(t),
  ];
}

/** The angle of `p` seen from the centre of the ellipse in `box`, in the
 *  ellipse's own parameter (so a point on the ellipse answers the angle
 *  `ellipsePoint` put it at), `[0, 360)`. */
export function ellipseAngleAt(box: Box, p: Pt): number {
  const [top, left, bottom, right] = box;
  const rx = Math.max((right - left) / 2, 1e-9);
  const ry = Math.max((bottom - top) / 2, 1e-9);
  const u = (p[0] - (left + right) / 2) / rx;
  const v = -(p[1] - (top + bottom) / 2) / ry;
  return normalizeStart((Math.atan2(v, u) * 180) / Math.PI);
}

/** The pie's outline as an SVG path in the coordinates of `box` (the
 *  centre, the arc counter-clockwise from `start` to `end`, closed); the
 *  whole ellipse for a zero sweep. */
export function pieOutlinePath(box: Box, start: number, end: number): string {
  const [top, left, bottom, right] = box;
  const rx = (right - left) / 2;
  const ry = (bottom - top) / 2;
  const sweep = pieSweep(start, end);
  const f = (n: number) => +n.toFixed(4);
  if (sweep === 0) {
    const [x0, y0] = ellipsePoint(box, 0);
    const [x1, y1] = ellipsePoint(box, 180);
    return `M${f(x0)} ${f(y0)} A${f(rx)} ${f(ry)} 0 1 0 ${f(x1)} ${f(y1)} A${f(rx)} ${f(ry)} 0 1 0 ${f(x0)} ${f(y0)} Z`;
  }
  const c: Pt = [(left + right) / 2, (top + bottom) / 2];
  const a = ellipsePoint(box, start);
  const b = ellipsePoint(box, start + sweep);
  // Counter-clockwise on the page is SVG's sweep-flag 0 (y down).
  const large = sweep > 180 ? 1 : 0;
  return `M${f(c[0])} ${f(c[1])} L${f(a[0])} ${f(a[1])} A${f(rx)} ${f(ry)} 0 ${large} 0 ${f(b[0])} ${f(b[1])} Z`;
}

/** A polygon's points as a closed SVG path. */
export function polygonPath(points: readonly Pt[]): string {
  const f = (n: number) => +n.toFixed(4);
  return (
    points
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${f(x)} ${f(y)}`)
      .join(" ") + " Z"
  );
}

// ------------------------------------------------------------ corners

/** The four corners in the engine's slot order with their property
 *  suffixes: top-left, top-right, bottom-right, bottom-left. */
export const CORNERS = [
  { suffix: "TopLeft", sx: 1, sy: 1 },
  { suffix: "TopRight", sx: -1, sy: 1 },
  { suffix: "BottomRight", sx: -1, sy: -1 },
  { suffix: "BottomLeft", sx: 1, sy: -1 },
] as const;
export type CornerSuffix = (typeof CORNERS)[number]["suffix"];

/** The corner options a widget cycles through (Alt-click), in
 *  Illustrator's order: rounded, inverted rounded, chamfer (InDesign's
 *  bevel); then InDesign's inset and fancy. */
export const CORNER_CYCLE = [
  "RoundedCorner",
  "InverseRoundedCorner",
  "BeveledCorner",
  "InsetCorner",
  "FancyCorner",
] as const;

/** The option after `option` in the cycle (`None` starts it). */
export function nextCornerOption(option: string): string {
  const i = CORNER_CYCLE.indexOf(option as (typeof CORNER_CYCLE)[number]);
  return CORNER_CYCLE[(i + 1) % CORNER_CYCLE.length]!;
}

/** The point of `box`'s corner `index` (CORNERS order). */
export function cornerPoint(box: Box, index: number): Pt {
  const [top, left, bottom, right] = box;
  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ][index] as unknown as Pt;
}

/** Where a corner's widget sits: inside the corner along its diagonal,
 *  at the radius (the centre of a rounded corner's arc) or at `minOffset`
 *  when the corner is square or tighter than that. */
export function cornerWidgetPoint(
  box: Box,
  index: number,
  radius: number,
  minOffset: number,
): Pt {
  const [x, y] = cornerPoint(box, index);
  const { sx, sy } = CORNERS[index]!;
  const r = Math.min(Math.max(radius, minOffset), maxCornerRadius(box));
  return [x + sx * r, y + sy * r];
}

/** The largest radius a corner of `box` takes: half its shorter side. */
export function maxCornerRadius(box: Box): number {
  return Math.max(0, Math.min(box[3] - box[1], box[2] - box[0]) / 2);
}

/** The radius a drag of corner `index`'s widget to `p` asks for: the
 *  pointer's distance in along the corner's diagonal, clamped to
 *  `[0, maxCornerRadius]`. */
export function cornerRadiusAt(box: Box, index: number, p: Pt): number {
  const [x, y] = cornerPoint(box, index);
  const { sx, sy } = CORNERS[index]!;
  const along = ((p[0] - x) * sx + (p[1] - y) * sy) / 2;
  return Math.min(maxCornerRadius(box), Math.max(0, along));
}

// ------------------------------------------------------ polygon widgets

/** The side-count widget's place: right of the shape's box, at its
 *  middle (Illustrator's polygon widget sits on the box's side). */
export function sidesWidgetPoint(box: Box, offset: number): Pt {
  return [box[3] + offset, (box[0] + box[2]) / 2];
}

/** The side count a vertical drag of `dy` (page pt, down positive) at a
 *  zoom of `scale` makes of `start`: one side per `stepPx` screen pixels,
 *  up adds. */
export function sidesFromDrag(
  start: number,
  dy: number,
  scale: number,
  stepPx = 12,
): number {
  const steps = Math.round((-dy * scale) / stepPx);
  return Math.min(MAX_SIDES, Math.max(MIN_SIDES, Math.round(start) + steps));
}

/** The star inset a drag of the inner-point widget to `p` makes, for a
 *  shape whose ellipse is `circle` and whose first inner point is the
 *  widget: the pointer's distance from the centre, in the ellipse's own
 *  scale, as a fraction of the outer radius. */
export function starInsetAt(circle: Box, p: Pt): number {
  const [top, left, bottom, right] = circle;
  const rx = Math.max((right - left) / 2, 1e-9);
  const ry = Math.max((bottom - top) / 2, 1e-9);
  const u = (p[0] - (left + right) / 2) / rx;
  const v = (p[1] - (top + bottom) / 2) / ry;
  const r = Math.hypot(u, v);
  return Math.min(MAX_STAR_INSET, Math.max(0, Math.round((1 - r) * 1000) / 10));
}

/** An affine `[a, b, c, d, tx, ty]` applied to a point. */
export function applyAffine(
  m: readonly number[] | null | undefined,
  p: Pt,
): Pt {
  if (!m) return p;
  return [
    m[0]! * p[0] + m[2]! * p[1] + m[4]!,
    m[1]! * p[0] + m[3]! * p[1] + m[5]!,
  ];
}

/** The inverse of {@link applyAffine}; the identity for a singular one. */
export function inverseAffine(
  m: readonly number[] | null | undefined,
  p: Pt,
): Pt {
  if (!m) return p;
  const det = m[0]! * m[3]! - m[1]! * m[2]!;
  if (Math.abs(det) < 1e-12) return p;
  const x = p[0] - m[4]!;
  const y = p[1] - m[5]!;
  return [(m[3]! * x - m[2]! * y) / det, (-m[1]! * x + m[0]! * y) / det];
}

/** The scale an affine applies to lengths (the square root of its
 *  determinant's magnitude): a screen tolerance in the item's own space
 *  is `px / (zoom × this)`. */
export function affineScale(m: readonly number[] | null | undefined): number {
  if (!m) return 1;
  return Math.sqrt(Math.abs(m[0]! * m[3]! - m[1]! * m[2]!)) || 1;
}
