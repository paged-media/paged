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

// WP4.4 — the spread-space targets Align and Transform Each move, and the
// one write each takes. Pure (types-only imports), so the unit tests pin
// every number.
//
// THE frameTransform DOOR (modules/draw/CLAUDE.md): `frameTransform`
// REPLACES an item's stored transform M, which is in SPREAD space, while
// `elementGeometry` answers the transform in the space of the item's
// PAGE (`pageOrigin` beside it). So a target keeps
//
//     E = translate(pageOrigin) ∘ itemTransform      (spread space)
//
// and a spread-space change R is written as `R ∘ E` for a page item
// (group members included: the engine stores a leaf's composed
// transform). A GROUP moves through `setGroupTransform`, which replaces
// its stored transform G, relative to its parent frame F (`E = F ∘ G`);
// R seen from inside that frame is `F⁻¹ ∘ R ∘ F`, so the write is
// `F⁻¹ ∘ R ∘ F ∘ G = G ∘ E⁻¹ ∘ R ∘ E` — `R ∘ G` for a top-level group,
// whose F is the spread. Every write of one command rides ONE
// `host.objects` batch: one undo step.

import type { ShellObjectOp } from "@paged-media/shell";

/** `[a, b, c, d, tx, ty]`: x' = a·x + c·y + tx, y' = b·x + d·y + ty. */
export type Affine = readonly [number, number, number, number, number, number];
/** IDML bounds, `[top, left, bottom, right]`. */
export type Bounds = readonly [number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** `m ∘ n`: n first, then m. */
export function compose(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function translate(dx: number, dy: number): Affine {
  return [1, 0, 0, 1, dx, dy];
}

export function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The axis-aligned box of `bounds` through `m`. */
export function transformBounds(bounds: Bounds, m: Affine | null): Bounds {
  if (!m) return bounds;
  const [t, l, b, r] = bounds;
  const pts = [apply(m, l, t), apply(m, r, t), apply(m, r, b), apply(m, l, b)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)];
}

/** One object of a command, in SPREAD space. */
export interface SpreadTarget {
  /** Its ADR 131 address (`rectangle:<id>`, `group:<id>`, …). */
  address: string;
  /** Its transformed box, `[top, left, bottom, right]`, spread space. */
  box: Bounds;
  /** The page it sits on; null on the pasteboard. */
  pageId: string | null;
  /** Its spread. */
  spreadId: string | null;
  /** E — its composed transform in spread space (null = identity). */
  composed: Affine | null;
  /** A group: its STORED transform G (null = identity). Absent: a page item. */
  group?: { stored: Affine | null };
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** The transform `target` is written with under the spread-space `r`. */
export function writtenTransform(target: SpreadTarget, r: Affine): Affine {
  const e = target.composed ?? IDENTITY;
  if (!target.group) return compose(r, e);
  const g = target.group.stored ?? IDENTITY;
  const inv = invert(e);
  if (!inv) return compose(r, g);
  return compose(g, compose(inv, compose(r, e)));
}

/** The one op that writes `r` to `target`: `frameTransform` for a page
 *  item, the typed `core.setGroupTransform` for a group. */
export function transformOpFor(target: SpreadTarget, r: Affine): ShellObjectOp {
  const next = [...writtenTransform(target, r)].map(round);
  if (target.group) {
    return {
      op: "invoke",
      command: "core.setGroupTransform",
      args: { groupId: target.address, transform: next },
    };
  }
  return {
    op: "set",
    address: target.address,
    path: "frameTransform",
    value: next,
  };
}

/** Whether `r` changes nothing. */
export function isIdentity(r: Affine): boolean {
  return r.every((v, i) => close(v, IDENTITY[i]!));
}

/** Engine transforms are single precision; keep the written numbers
 *  free of binary noise so a spec can compare them exactly. */
function round(v: number): number {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}
