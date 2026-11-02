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

export {
  IDENTITY,
  apply,
  compose,
  invert,
  transformBounds,
  translate,
  type Affine,
  type Bounds,
} from "@paged-media/helpers";
import {
  IDENTITY,
  compose,
  invert,
  type Affine,
  type Bounds,
} from "@paged-media/helpers";

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
  /** The origin of its page inside the spread (`pageOrigin`): how a
   *  PAGE-space point (a typed Reflect axis point) is taken to spread
   *  space. Absent: unknown, the spread's own origin. */
  origin?: readonly [number, number];
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
