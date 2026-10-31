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

// W2.8 — shell-local copy of the canvas page-layout convention.
//
// The guide controller (shell) must resolve a document-pt pointer to
// a page + page-local coordinate, the same way the canvas viewport
// does. The authoritative layout lives in `apps/canvas/src/ui/layout.ts`
// (the app owns page geometry), but shell cannot import from apps, so
// the ONE convention the controller needs is mirrored here: each page at
// its canvas origin (engine ADR 1011, `DocumentHandle.pageOriginsPt`),
// else stacked vertically at x=0 with a fixed 24 pt gap. Both must move
// together; this file names that coupling explicitly.

export interface ShellPageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Mirror of `apps/canvas/src/ui/layout.ts` `layoutPages`. */
export function layoutPageRects(
  pageSizesPt: ReadonlyArray<readonly [number, number]>,
  pageOriginsPt?: ReadonlyArray<readonly [number, number]> | null,
  gapPt = 24,
): ShellPageRect[] {
  const out: ShellPageRect[] = [];
  const placed =
    pageOriginsPt != null && pageOriginsPt.length === pageSizesPt.length;
  let y = 0;
  pageSizesPt.forEach(([w, h], i) => {
    const at = placed ? pageOriginsPt[i] : null;
    out.push(at ? { x: at[0], y: at[1], w, h } : { x: 0, y, w, h });
    y += h + gapPt;
  });
  return out;
}
