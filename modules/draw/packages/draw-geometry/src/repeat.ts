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

// REPEATS — the PLACEMENT algebra behind §12.4's radial / grid / mirror
// repeat objects. Pure math, zero deps, host-free: a source's page-space
// anchor table plus a spec in, one AFFINE PER INSTANCE out. The bundle
// applies them through `insertPath` and owns everything about documents.
//
// WHY AFFINES AND NOT OFFSETS. Pattern Editing v1's lattice needed only
// a translation per tile, so `commands/pattern.ts` carries an
// `offsetTable(table, dx, dy)`. A repeat cannot: a radial instance is
// ROTATED about the ring centre and a mirror instance is REFLECTED about
// an axis. So the placement is a full 2×2 + translation and the source
// table is mapped through it.
//
// TWO CONVENTIONS, both the engine's and both easy to get backwards:
//   · `Affine` is `[a, b, c, d, tx, ty]` with `x' = a·x + c·y + tx` and
//     `y' = b·x + d·y + ty` (the IDML `ItemTransform` column pairs).
//   · PAGE SPACE HAS Y DOWN. So a POSITIVE rotation angle turns +x
//     toward +y, which reads CLOCKWISE on screen. Every angle here is
//     in DEGREES in that frame, and the specs say so rather than
//     leaving the reader to discover it from a failing test.
//
// WINDING: a reflection reverses contour orientation. That is SAFE for
// a compound source under the engine's non-zero fill because EVERY
// contour of the source flips together, so a hole stays a hole — the
// relative winding is what non-zero reads, and `orientForNonZeroHoles`
// (compound.ts) is deliberately NOT re-run on a mirrored instance.

import { composeAffine, type Affine } from "./affine";
import type { AnchorTable, Vec2 } from "./types";

/** Which placement algebra a repeat uses. */
export type RepeatKind = "radial" | "grid" | "mirror";

/** Page bounds as the engine reports them: `[top, left, bottom, right]`
 *  (the `draw-tools` `Bounds` convention, repeated here so geometry
 *  stays dependency-free in both directions). */
export type RepeatBounds = readonly [number, number, number, number];

/** One placed instance. `index` 0 is always the SOURCE itself with the
 *  IDENTITY matrix — it is already on the page and is never re-emitted,
 *  but it is part of the list so a caller can reason about "instance 3
 *  of 6" the way the panel and the catalog both count. */
export interface RepeatPlacement {
  index: number;
  /** Grid column, radial spoke, or 1 for the mirror image. */
  col: number;
  /** Grid row; 0 for radial and mirror. */
  row: number;
  matrix: Affine;
}

const DEG = Math.PI / 180;

// -------------------------------------------------------- the affines

/** Translation. */
export function affineTranslate(dx: number, dy: number): Affine {
  return [1, 0, 0, 1, dx, dy];
}

/** Rotation by `deg` about `about`. Positive turns +x toward +y, i.e.
 *  CLOCKWISE on a y-down page. */
export function affineRotate(deg: number, about: Vec2): Affine {
  const r = deg * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const [cx, cy] = about;
  return [
    cos,
    sin,
    -sin,
    cos,
    cx - (cos * cx - sin * cy),
    cy - (sin * cx + cos * cy),
  ];
}

/** Reflection about the LINE through `about` whose direction is `deg`.
 *  `deg = 90` is a VERTICAL axis (a left↔right flip); `deg = 0` is a
 *  HORIZONTAL axis (a top↔bottom flip). */
export function affineReflect(deg: number, about: Vec2): Affine {
  const r = 2 * deg * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const [cx, cy] = about;
  return [
    cos,
    sin,
    sin,
    -cos,
    cx - (cos * cx + sin * cy),
    cy - (sin * cx - cos * cy),
  ];
}

/** Map a page-space anchor table through `m` — anchors AND both
 *  handles, contour bookkeeping preserved verbatim. */
export function transformAnchorTable(
  table: AnchorTable,
  m: Affine,
): AnchorTable {
  const p = (v: readonly [number, number]): [number, number] => [
    m[0] * v[0] + m[2] * v[1] + m[4],
    m[1] * v[0] + m[3] * v[1] + m[5],
  ];
  return {
    anchors: table.anchors.map((a) => ({
      anchor: p(a.anchor),
      left: p(a.left),
      right: p(a.right),
    })),
    subpathStarts: [...table.subpathStarts],
    subpathOpen: table.subpathOpen ? [...table.subpathOpen] : undefined,
  };
}

/** The AXIS-ALIGNED bounds of `bounds` mapped through `m` — the four
 *  corners transformed, then re-hulled. A rotated instance therefore
 *  reports a LARGER box than the source, which is exactly what the
 *  artboard fit has to test. */
export function transformBounds(bounds: RepeatBounds, m: Affine): RepeatBounds {
  const [top, left, bottom, right] = bounds;
  const corners: [number, number][] = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];
  let t = Infinity;
  let l = Infinity;
  let b = -Infinity;
  let r = -Infinity;
  for (const [x, y] of corners) {
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    t = Math.min(t, py);
    b = Math.max(b, py);
    l = Math.min(l, px);
    r = Math.max(r, px);
  }
  return [t, l, b, r];
}

/** The centre of a bounds rect. */
export function boundsCenter(bounds: RepeatBounds): Vec2 {
  const [top, left, bottom, right] = bounds;
  return [(left + right) / 2, (top + bottom) / 2];
}

// ------------------------------------------------------------- radial

export interface RadialSpec {
  /** Instances INCLUDING the source — Illustrator counts the original,
   *  and so does this, so `count: 6` emits FIVE copies. */
  count: number;
  radiusPt: number;
  /** Where the SOURCE sits on the ring, in degrees (y-down frame). */
  startDeg: number;
  /** The arc the instances span. `360` (or more) closes the ring. */
  sweepDeg: number;
  /** Rotate each instance to face along the arc. `false` slides the
   *  artwork around the ring without turning it. */
  rotateInstances: boolean;
  /** The ring centre in page space (see {@link radialCenterFor}). */
  center: Vec2;
}

/** The angular step between instances. A CLOSED ring divides the sweep
 *  by the count (so the last instance does not land on the first); a
 *  partial arc divides by `count - 1`, so the first and last instances
 *  sit exactly on the arc's ends. */
export function radialStepDeg(count: number, sweepDeg: number): number {
  const n = Math.max(1, Math.round(count));
  if (n < 2) return 0;
  return Math.abs(sweepDeg) >= 360 ? sweepDeg / n : sweepDeg / (n - 1);
}

/** A point on the ring. */
export function radialPointAt(
  center: Vec2,
  radiusPt: number,
  deg: number,
): Vec2 {
  const r = deg * DEG;
  return [center[0] + radiusPt * Math.cos(r), center[1] + radiusPt * Math.sin(r)];
}

/** The ring centre that leaves the SOURCE exactly where it is: the
 *  source sits ON the circle at `startDeg`, so the centre is one radius
 *  back along that direction. Nothing the user drew moves — the ring is
 *  derived from the artwork, not the artwork from the ring. */
export function radialCenterFor(
  sourceCenter: Vec2,
  radiusPt: number,
  startDeg: number,
): Vec2 {
  const r = startDeg * DEG;
  return [
    sourceCenter[0] - radiusPt * Math.cos(r),
    sourceCenter[1] - radiusPt * Math.sin(r),
  ];
}

/** The radial placements, index 0 = the source (identity). */
export function radialPlacements(spec: RadialSpec): RepeatPlacement[] {
  const count = Math.max(1, Math.round(spec.count));
  const step = radialStepDeg(count, spec.sweepDeg);
  const out: RepeatPlacement[] = [
    { index: 0, col: 0, row: 0, matrix: [1, 0, 0, 1, 0, 0] },
  ];
  const p0 = radialPointAt(spec.center, spec.radiusPt, spec.startDeg);
  for (let k = 1; k < count; k++) {
    let matrix: Affine;
    if (spec.rotateInstances) {
      matrix = affineRotate(k * step, spec.center);
    } else {
      const pk = radialPointAt(
        spec.center,
        spec.radiusPt,
        spec.startDeg + k * step,
      );
      matrix = affineTranslate(pk[0] - p0[0], pk[1] - p0[1]);
    }
    out.push({ index: k, col: k, row: 0, matrix });
  }
  return out;
}

// --------------------------------------------------------------- grid

export interface GridSpec {
  columns: number;
  rows: number;
  /** Distance between cell ORIGINS — the caller adds the source size to
   *  its spacing, so a NEGATIVE spacing is a real geometric overlap
   *  (the pattern-v1 convention, kept). */
  stepX: number;
  stepY: number;
  /** Mirror every ODD column about its own cell centre. */
  flipColumns: boolean;
  /** Mirror every ODD row about its own cell centre. */
  flipRows: boolean;
  /** The SOURCE cell's centre in page space — the flip axes run through
   *  each destination cell's centre, which is this point stepped. */
  cellCenter: Vec2;
}

/** The `columns × rows` placements in ROW-MAJOR order, index 0 = the
 *  source cell (0, 0). */
export function gridPlacements(spec: GridSpec): RepeatPlacement[] {
  const columns = Math.max(1, Math.round(spec.columns));
  const rows = Math.max(1, Math.round(spec.rows));
  const out: RepeatPlacement[] = [];
  let index = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const dx = col * spec.stepX;
      const dy = row * spec.stepY;
      let matrix: Affine = affineTranslate(dx, dy);
      const cell: Vec2 = [spec.cellCenter[0] + dx, spec.cellCenter[1] + dy];
      if (spec.flipColumns && col % 2 === 1) {
        matrix = composeAffine(affineReflect(90, cell), matrix);
      }
      if (spec.flipRows && row % 2 === 1) {
        matrix = composeAffine(affineReflect(0, cell), matrix);
      }
      out.push({ index: index++, col, row, matrix });
    }
  }
  return out;
}

// ------------------------------------------------------------- mirror

export interface MirrorSpec {
  /** The axis DIRECTION in degrees. `90` = a vertical axis (left↔right
   *  flip); `0` = a horizontal axis (top↔bottom flip). */
  angleDeg: number;
  /** A point the axis passes through (see {@link mirrorOriginFor}). */
  origin: Vec2;
}

/** The axis normal, `(sin θ, −cos θ)`: a positive offset moves a
 *  VERTICAL axis (θ = 90°) to the RIGHT and a HORIZONTAL axis (θ = 0°)
 *  UP the page. */
export function mirrorAxisNormal(angleDeg: number): Vec2 {
  const r = angleDeg * DEG;
  return [Math.sin(r), -Math.cos(r)];
}

/** Put the axis `offsetPt` off the source's centre along the normal —
 *  so the default (half the source's width) lands it exactly on the
 *  source's edge, which is where Illustrator's mirror handle starts. */
export function mirrorOriginFor(
  center: Vec2,
  angleDeg: number,
  offsetPt: number,
): Vec2 {
  const n = mirrorAxisNormal(angleDeg);
  return [center[0] + n[0] * offsetPt, center[1] + n[1] * offsetPt];
}

/** The mirror placements: the source, then its ONE reflection. */
export function mirrorPlacements(spec: MirrorSpec): RepeatPlacement[] {
  return [
    { index: 0, col: 0, row: 0, matrix: [1, 0, 0, 1, 0, 0] },
    {
      index: 1,
      col: 1,
      row: 0,
      matrix: affineReflect(spec.angleDeg, spec.origin),
    },
  ];
}

// ------------------------------------------------------ the artboard fit

/** Split placements into the ones whose transformed source bounds land
 *  FULLY inside `page` and the ones that do not. A `null` page (an
 *  unreadable rect — the honest degrade) keeps everything and the
 *  caller warns. The source (index 0) is ALWAYS kept: it is already on
 *  the page and dropping it would be a lie about what was placed.
 *
 *  This exists because `pathAnchors` / `elementGeometry` are PAGE-KEYED
 *  (RFI C-23): an item at page coordinates outside the page rect is
 *  created and then answers NOTHING to either door. A radial repeat is
 *  the easiest way in this bundle to produce one. */
export function fitPlacementsToPage(
  placements: readonly RepeatPlacement[],
  bounds: RepeatBounds,
  page: { width: number; height: number } | null,
): { placed: RepeatPlacement[]; dropped: RepeatPlacement[] } {
  if (!page) return { placed: [...placements], dropped: [] };
  const placed: RepeatPlacement[] = [];
  const dropped: RepeatPlacement[] = [];
  for (const p of placements) {
    if (p.index === 0) {
      placed.push(p);
      continue;
    }
    const [top, left, bottom, right] = transformBounds(bounds, p.matrix);
    const fits =
      left >= 0 && top >= 0 && right <= page.width && bottom <= page.height;
    (fits ? placed : dropped).push(p);
  }
  return { placed, dropped };
}

/** The union of every placement's transformed bounds — the repeat's
 *  full EXTENT, which is what a clip frame defaults to. */
export function repeatExtent(
  placements: readonly RepeatPlacement[],
  bounds: RepeatBounds,
): RepeatBounds {
  let t = Infinity;
  let l = Infinity;
  let b = -Infinity;
  let r = -Infinity;
  for (const p of placements) {
    const [pt, pl, pb, pr] = transformBounds(bounds, p.matrix);
    t = Math.min(t, pt);
    l = Math.min(l, pl);
    b = Math.max(b, pb);
    r = Math.max(r, pr);
  }
  if (!Number.isFinite(t)) return bounds;
  return [t, l, b, r];
}

/** A closed rectangular contour for `bounds`, as an anchor table — the
 *  clip frame's geometry (corner anchors, no handles). */
export function rectAnchorTable(bounds: RepeatBounds): AnchorTable {
  const [top, left, bottom, right] = bounds;
  const at = (x: number, y: number) => ({
    anchor: [x, y] as [number, number],
    left: [x, y] as [number, number],
    right: [x, y] as [number, number],
  });
  return {
    anchors: [at(left, top), at(right, top), at(right, bottom), at(left, bottom)],
    subpathStarts: [0],
    subpathOpen: [false],
  };
}
