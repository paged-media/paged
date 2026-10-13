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

// PAGE SPACE AND THE STORED MATRIX — the one place this bundle converts
// between them.
//
// The engine's geometry reads (`elementGeometry`, `pathAnchors`, the hit
// test) answer an item's `itemTransform` in the space of the PAGE it sits
// on — its bounds through it land in page coordinates, `(0, 0)` at the
// page's top-left, the space of the pointer and of `insertPath` — and
// report that page's origin inside its spread as `pageOrigin`. The
// document stores the transform in SPREAD space, and two writes speak
// that space: the `frameTransform` property, and `framePath` on a path
// whose transform is the identity (a path `insertPath` has just made:
// `insertPath` adds the page origin to the anchors it is given,
// `framePath` stores its table verbatim). So
//
//     stored = translate(pageOrigin) ∘ itemTransform
//
// and anything this bundle WRITES from a geometry read goes through that.
//
// Engines before core's page-space fix answer `itemTransform` in spread
// space and send no `pageOrigin`. Reading the origin as `[0, 0]` there
// makes the same formula exact, so no caller branches on the engine. The
// two spaces differ only on a page that does not start at its spread's
// origin: a verso of a facing spread, and every page of an InDesign
// document (which centres the spread on the spine).

import {
  affineTranslate,
  transformAnchorTable,
  type Affine,
  type AnchorTable,
} from "@paged-media/draw-geometry";

/** A page's origin inside its spread, `[x, y]` in spread coordinates. */
export type PageOrigin = readonly [number, number];

/** The origin of a page that starts at its spread's origin — and what
 *  an engine that reads spread space amounts to. */
export const SPREAD_ORIGIN: PageOrigin = [0, 0];

/** `pageOrigin` is newer than the wire types vendored into
 *  `@paged-media/plugin-api`, so it is read through this narrow shape
 *  rather than through `any`. */
interface PageOriginRead {
  readonly pageOrigin?: unknown;
}

/** The page origin a geometry read (`elementGeometry` item,
 *  `pathAnchors` result) reports; `[0, 0]` when it reports none (an older
 *  engine, a pasteboard item, a malformed value). */
export function pageOriginOf(read: object | null | undefined): PageOrigin {
  const o = (read as PageOriginRead | null | undefined)?.pageOrigin;
  if (!Array.isArray(o) || o.length !== 2) return SPREAD_ORIGIN;
  const [x, y] = o as unknown[];
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
    ? [x, y]
    : SPREAD_ORIGIN;
}

/** Whether `o` is the spread's own origin (nothing to convert). */
export function isSpreadOrigin(o: PageOrigin): boolean {
  return o[0] === 0 && o[1] === 0;
}

/** The STORED (spread-space) transform of an item whose geometry read
 *  answered `itemTransform` (page space) on a page at `origin` —
 *  `translate(origin) ∘ itemTransform`, what `frameTransform` writes.
 *  Null stays null at the spread's origin (the identity, unwritten). */
export function storedTransformOf(
  itemTransform: Affine | null | undefined,
  origin: PageOrigin,
): Affine | null {
  if (isSpreadOrigin(origin)) return itemTransform ?? null;
  const m = itemTransform ?? ([1, 0, 0, 1, 0, 0] as const);
  return [m[0], m[1], m[2], m[3], m[4] + origin[0], m[5] + origin[1]];
}

/** A PAGE-space table as the anchors `framePath` must store on a path
 *  `insertPath` just made on that page (identity transform, so its
 *  stored anchors are spread coordinates). */
export function spreadTableOf(table: AnchorTable, origin: PageOrigin): AnchorTable {
  return isSpreadOrigin(origin) ? table : transformAnchorTable(table, affineTranslate(origin[0], origin[1]));
}
