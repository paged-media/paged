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

// SVG basic shapes → the draw anchor model (their path equivalents).
// `<rect>` (incl. rounded corners), `<circle>`, `<ellipse>`, `<line>`,
// `<polyline>`, `<polygon>` each lower to an `AnchorTable` so the rest of
// the pipeline only ever sees cubic anchors. Circles/ellipses use the
// classic 4-arc κ = 4/3·(√2−1) Bézier approximation. Pure, host-free.

import type { AnchorTriple, AnchorTable, Vec2, Vec2Mut } from "./types";

/** Bézier circle constant: handle length = κ·radius for a 90° arc. */
const KAPPA = (4 / 3) * (Math.SQRT2 - 1);

const corner = (p: Vec2): AnchorTriple => ({
  anchor: [p[0], p[1]],
  left: [p[0], p[1]],
  right: [p[0], p[1]],
});

const tableFrom = (anchors: AnchorTriple[], open: boolean): AnchorTable => ({
  anchors,
  subpathStarts: [0],
  subpathOpen: [open],
});

/** `<line x1 y1 x2 y2>` → an open two-anchor path. */
export function lineToPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): AnchorTable {
  return tableFrom([corner([x1, y1]), corner([x2, y2])], true);
}

/** `<polyline points>` → an open corner path; `<polygon>` → closed.
 *  Fewer than 2 points yields an empty table. */
export function polyToPath(
  points: readonly Vec2[],
  close: boolean,
): AnchorTable {
  if (points.length < 2) return { anchors: [], subpathStarts: [], subpathOpen: [] };
  return tableFrom(
    points.map((p) => corner(p)),
    !close,
  );
}

/** `<rect>` → a closed 4-corner path, or an 8-anchor rounded-rect when
 *  rx/ry are positive. Radii are clamped to half the side (SVG rule).
 *  Non-positive width/height yields an empty table. */
export function rectToPath(
  x: number,
  y: number,
  width: number,
  height: number,
  rxIn = 0,
  ryIn = 0,
): AnchorTable {
  if (width <= 0 || height <= 0) {
    return { anchors: [], subpathStarts: [], subpathOpen: [] };
  }
  let rx = rxIn;
  let ry = ryIn;
  // SVG: a missing rx mirrors ry and vice-versa.
  if (rx <= 0 && ry > 0) rx = ry;
  if (ry <= 0 && rx > 0) ry = rx;
  rx = Math.min(Math.max(rx, 0), width / 2);
  ry = Math.min(Math.max(ry, 0), height / 2);

  if (rx === 0 || ry === 0) {
    // Sharp rectangle: TL, TR, BR, BL (clockwise in y-down space).
    return tableFrom(
      [
        corner([x, y]),
        corner([x + width, y]),
        corner([x + width, y + height]),
        corner([x, y + height]),
      ],
      false,
    );
  }

  // Rounded: 8 anchors, two per corner, handles κ-scaled along the axes.
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  const x0 = x;
  const x1 = x + width;
  const y0 = y;
  const y1 = y + height;

  // Build in clockwise order starting at the top edge after the TL
  // corner. Each anchor records the handle that curves INTO the next.
  const anchors: AnchorTriple[] = [
    // Top edge → top-right corner start
    handle([x0 + rx, y0], [x0 + rx, y0], [x0 + rx, y0]),
    handle([x1 - rx, y0], [x1 - rx, y0], [x1 - rx + kx, y0]),
    // Right edge after TR corner
    handle([x1, y0 + ry], [x1, y0 + ry - ky], [x1, y0 + ry]),
    handle([x1, y1 - ry], [x1, y1 - ry], [x1, y1 - ry + ky]),
    // Bottom edge after BR corner
    handle([x1 - rx, y1], [x1 - rx + kx, y1], [x1 - rx, y1]),
    handle([x0 + rx, y1], [x0 + rx, y1], [x0 + rx - kx, y1]),
    // Left edge after BL corner
    handle([x0, y1 - ry], [x0, y1 - ry + ky], [x0, y1 - ry]),
    handle([x0, y0 + ry], [x0, y0 + ry], [x0, y0 + ry - ky]),
  ];
  // Close: the last anchor (left edge, top-left corner start) curves
  // back into the first via the TL corner. Set its outgoing handle.
  anchors[7].right = [x0, y0 + ry - ky];
  anchors[0].left = [x0 + rx - kx, y0];
  return tableFrom(anchors, false);
}

function handle(anchor: Vec2, left: Vec2, right: Vec2): AnchorTriple {
  return {
    anchor: [anchor[0], anchor[1]],
    left: [left[0], left[1]],
    right: [right[0], right[1]],
  };
}

/** `<ellipse cx cy rx ry>` → a closed 4-anchor κ-approximated path.
 *  Non-positive radii yield an empty table. */
export function ellipseToPath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): AnchorTable {
  if (rx <= 0 || ry <= 0) {
    return { anchors: [], subpathStarts: [], subpathOpen: [] };
  }
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  // Four on-curve points: right, bottom, left, top (clockwise, y-down).
  const right: Vec2Mut = [cx + rx, cy];
  const bottom: Vec2Mut = [cx, cy + ry];
  const left: Vec2Mut = [cx - rx, cy];
  const top: Vec2Mut = [cx, cy - ry];
  const anchors: AnchorTriple[] = [
    { anchor: right, left: [cx + rx, cy - ky], right: [cx + rx, cy + ky] },
    { anchor: bottom, left: [cx + kx, cy + ry], right: [cx - kx, cy + ry] },
    { anchor: left, left: [cx - rx, cy + ky], right: [cx - rx, cy - ky] },
    { anchor: top, left: [cx - kx, cy - ry], right: [cx + kx, cy - ry] },
  ];
  return tableFrom(anchors, false);
}

/** `<circle cx cy r>` → ellipse with rx = ry = r. */
export function circleToPath(cx: number, cy: number, r: number): AnchorTable {
  return ellipseToPath(cx, cy, r, r);
}
