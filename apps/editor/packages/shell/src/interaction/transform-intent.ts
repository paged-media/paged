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

// What a committed canvas gesture did to the selection, as an INTENT
// (the interaction specification's `UXI-MUT-013`; editor ADR 1240,
// amendment 1): "move the selection by (dx, dy) pt", "resize it to w × h
// from an anchor", "rotate it by θ about its centre" — measured from the
// document's own geometry before the gesture and after its commit, in
// points, never in viewport pixels. A snap, a Shift constraint or the zoom
// therefore never leak into the record: the intent is what happened to the
// selection. THIS FILE IS PURE: no React, no DOM.
//
// The canvas measures (the `canvas-transform` session's targets, read
// before the gesture moved anything and after it committed) and ends its
// session with the intent; the coordinator hands committed sessions to
// whoever observes them (the actions recorder).

import {
  transformBounds,
  type Affine,
  type Bounds,
} from "@paged-media/helpers";

/** A resize or scale handle, or the box's centre (Alt: from the centre). */
export type TransformAnchor =
  | "north"
  | "south"
  | "east"
  | "west"
  | "northEast"
  | "northWest"
  | "southEast"
  | "southWest"
  | "center";

export const TRANSFORM_ANCHORS: readonly TransformAnchor[] = [
  "northWest",
  "north",
  "northEast",
  "east",
  "southEast",
  "south",
  "southWest",
  "west",
  "center",
];

/** The handle a box keeps fixed while `handle` is dragged. */
export const OPPOSITE_ANCHOR: Record<
  Exclude<TransformAnchor, "center">,
  TransformAnchor
> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
  northEast: "southWest",
  southWest: "northEast",
  northWest: "southEast",
  southEast: "northWest",
};

/** What a committed gesture did to the selection. Lengths in pt, angles in
 *  degrees clockwise on the page (y grows downward). */
export type TransformIntent =
  /** Moved by (dx, dy); `copy`: an Alt-drag that left the originals and
   *  placed a copy there. */
  | { kind: "move"; dx: number; dy: number; copy: boolean }
  /** One frame's own box made `width` × `height` (the sides the handle
   *  moved), `anchor` staying where it was. */
  | {
      kind: "resize";
      width?: number;
      height?: number;
      anchor: TransformAnchor;
    }
  /** The selection's box scaled to `width` × `height` (a group, several
   *  objects, Cmd on a frame), `anchor` staying where it was. */
  | {
      kind: "scale";
      width?: number;
      height?: number;
      anchor: TransformAnchor;
    }
  /** Turned by `angle` about the selection's centre. */
  | { kind: "rotate"; angle: number };

/** One target's geometry as `elementGeometry` answers it. */
export interface MeasuredGeometry {
  /** The object's own box, `[top, left, bottom, right]`, before its
   *  transform. */
  bounds: readonly number[];
  /** Its transform in the space of its page (null: identity). */
  itemTransform?: readonly number[] | null;
  /** Its page's origin inside the spread. */
  pageOrigin?: readonly number[] | null;
}

/** The gesture the canvas committed, and its targets before and after. */
export interface GestureMeasure {
  gesture: "translate" | "resize" | "scale" | "rotate";
  /** The dragged handle (resize, scale). */
  handle?: Exclude<TransformAnchor, "center"> | null;
  /** Alt was held: a translate copied, a resize or scale went from the
   *  centre. */
  alt: boolean;
  /** A translate that committed a copy (Alt, and the selection copies). */
  copied?: boolean;
  before: readonly MeasuredGeometry[];
  after: readonly MeasuredGeometry[];
}

const EPS = 1e-3;

/** pt to a thousandth: the engine stores single precision. */
export const roundPt = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

const affine = (v: readonly number[] | null | undefined): Affine | null =>
  v && v.length === 6 ? (v as unknown as Affine) : null;

/** A target's transform in its spread: its page's origin, then its own. */
function composedOf(g: MeasuredGeometry): Affine {
  const t = affine(g.itemTransform) ?? [1, 0, 0, 1, 0, 0];
  const o = g.pageOrigin;
  if (!o || o.length !== 2) return t;
  return [t[0], t[1], t[2], t[3], t[4] + o[0]!, t[5] + o[1]!];
}

/** A target's box in its spread, axis-aligned. */
function spreadBox(g: MeasuredGeometry): Bounds | null {
  if (g.bounds.length !== 4) return null;
  return transformBounds(g.bounds as unknown as Bounds, composedOf(g));
}

/** The axis-aligned box around `items`, spread space. */
export function unionBox(items: readonly MeasuredGeometry[]): Bounds | null {
  let out: [number, number, number, number] | null = null;
  for (const g of items) {
    const b = spreadBox(g);
    if (!b) continue;
    out = out
      ? [
          Math.min(out[0], b[0]),
          Math.min(out[1], b[1]),
          Math.max(out[2], b[2]),
          Math.max(out[3], b[3]),
        ]
      : [b[0], b[1], b[2], b[3]];
  }
  return out;
}

/** The turn of a transform, degrees clockwise (y down). */
function angleOf(m: Affine): number {
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
}

/** `deg` in (-180, 180]. */
function normalise(deg: number): number {
  let d = deg % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

const movesWidth = (h: TransformAnchor | null | undefined): boolean =>
  h === undefined || h === null || !(h === "north" || h === "south");
const movesHeight = (h: TransformAnchor | null | undefined): boolean =>
  h === undefined || h === null || !(h === "east" || h === "west");

/** The anchor a drag of `handle` keeps (Alt: the centre). */
export function anchorOf(
  handle: Exclude<TransformAnchor, "center"> | null | undefined,
  alt: boolean,
): TransformAnchor {
  if (alt || !handle) return "center";
  return OPPOSITE_ANCHOR[handle];
}

/** The size part of a resize or scale: the sides the handle moved that
 *  changed, or null when the box kept its size. */
function sizeOf(
  before: readonly [number, number],
  after: readonly [number, number],
  handle: TransformAnchor | null | undefined,
): { width?: number; height?: number } | null {
  const out: { width?: number; height?: number } = {};
  if (movesWidth(handle) && Math.abs(after[0] - before[0]) > EPS)
    out.width = roundPt(after[0]);
  if (movesHeight(handle) && Math.abs(after[1] - before[1]) > EPS)
    out.height = roundPt(after[1]);
  return out.width === undefined && out.height === undefined ? null : out;
}

/**
 * The intent of a committed gesture, or null when it changed nothing a
 * step could repeat (a drag that went nowhere, a target that answered no
 * geometry). `before` and `after` are the same targets, in order — for a
 * copy, `after` is the copies.
 */
export function measureTransformIntent(
  m: GestureMeasure,
): TransformIntent | null {
  if (m.before.length === 0 || m.after.length === 0) return null;
  if (m.gesture === "translate") {
    const a = unionBox(m.before);
    const b = unionBox(m.after);
    if (!a || !b) return null;
    const dx = roundPt(b[1] - a[1]);
    const dy = roundPt(b[0] - a[0]);
    if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return null;
    return { kind: "move", dx, dy, copy: m.copied === true };
  }
  if (m.gesture === "rotate") {
    const a = angleOf(composedOf(m.before[0]!));
    const b = angleOf(composedOf(m.after[0]!));
    const angle = roundPt(normalise(b - a));
    if (Math.abs(angle) < EPS) return null;
    return { kind: "rotate", angle };
  }
  const anchor = anchorOf(m.handle, m.alt);
  if (m.gesture === "resize" && m.before.length === 1) {
    // The frame's own box: a resize keeps the frame's turn and changes its
    // sides, so its size is read before the transform.
    const [bt, bl, bb, br] = m.before[0]!.bounds;
    const [at, al, ab, ar] = m.after[0]!.bounds;
    if (m.before[0]!.bounds.length !== 4 || m.after[0]!.bounds.length !== 4)
      return null;
    const size = sizeOf(
      [br! - bl!, bb! - bt!],
      [ar! - al!, ab! - at!],
      m.handle,
    );
    return size ? { kind: "resize", ...size, anchor } : null;
  }
  const a = unionBox(m.before);
  const b = unionBox(m.after);
  if (!a || !b) return null;
  const size = sizeOf(
    [a[3] - a[1], a[2] - a[0]],
    [b[3] - b[1], b[2] - b[0]],
    m.handle,
  );
  return size ? { kind: "scale", ...size, anchor } : null;
}

/** The point of `box` an anchor names, spread space. */
export function anchorPoint(
  box: Bounds,
  anchor: TransformAnchor,
): [number, number] {
  const [t, l, b, r] = box;
  const x =
    anchor === "west" || anchor === "northWest" || anchor === "southWest"
      ? l
      : anchor === "east" || anchor === "northEast" || anchor === "southEast"
        ? r
        : (l + r) / 2;
  const y =
    anchor === "north" || anchor === "northWest" || anchor === "northEast"
      ? t
      : anchor === "south" || anchor === "southWest" || anchor === "southEast"
        ? b
        : (t + b) / 2;
  return [x, y];
}

/** Is `value` a {@link TransformAnchor}? */
export function isTransformAnchor(value: unknown): value is TransformAnchor {
  return TRANSFORM_ANCHORS.includes(value as TransformAnchor);
}
