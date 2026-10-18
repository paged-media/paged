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

// Fixtures for the PATH-EDITING conformance specs (Direct Selection +
// Pen v2). The shared corpus has corners-only, single-contour,
// identity-transform shapes; path editing needs exactly the three things
// it lacks — a SMOOTH anchor (paired handles), TWO CONTOURS in one
// element (flat indices, per-contour starts) and a NON-IDENTITY item
// transform (pointer space ≠ path-inner space). Every coordinate is an
// integer so the engine's f32 storage holds it exactly and the specs can
// assert with `toEqual`.

import { packageWithSpread, pathItem } from "./build-idml";

type Pt = [number, number];

interface Contour {
  open: boolean;
  anchors: { a: Pt; l?: Pt; r?: Pt }[];
}

/** A `<Polygon>` with one `<GeometryPathType>` PER CONTOUR — the IDML
 *  shape of a compound path. `transform` is the `ItemTransform`. */
function polygon(
  self: string,
  bounds: string,
  contours: Contour[],
  transform = "1 0 0 1 0 0",
): string {
  const geometry = contours
    .map((c) => {
      const pts = c.anchors
        .map((p) => {
          const l = p.l ?? p.a;
          const r = p.r ?? p.a;
          return (
            `<PathPointType Anchor="${p.a[0]} ${p.a[1]}" ` +
            `LeftDirection="${l[0]} ${l[1]}" RightDirection="${r[0]} ${r[1]}"/>`
          );
        })
        .join("");
      return (
        `<GeometryPathType PathOpen="${c.open}"><PathPointArray>` +
        pts +
        `</PathPointArray></GeometryPathType>`
      );
    })
    .join("");
  return (
    `<Polygon Self="${self}" GeometricBounds="${bounds}" ItemTransform="${transform}" FillColor="Color/Black">` +
    `<Properties><PathGeometry>${geometry}</PathGeometry></Properties></Polygon>`
  );
}

export const PATH_EDIT_PAGE = "usp";

/** An open arch whose MIDDLE anchor is smooth and asymmetric: handles
 *  collinear through (200, 200), 40 and 80 long. */
export const SMOOTH_ARCH = {
  id: "usmooth",
  bytes: (): Uint8Array =>
    packageWithSpread(
      pathItem("Polygon", "usmooth", "200 100 300 300", true, [
        { a: [100, 300] },
        { a: [200, 200], l: [160, 200], r: [280, 200] },
        { a: [300, 300] },
      ]),
    ),
};

/** ONE element, TWO contours: a closed triangle (flat 0–2) and an open
 *  three-anchor run (flat 3–5). */
export const TWO_CONTOURS = {
  id: "ucompound",
  bytes: (): Uint8Array =>
    packageWithSpread(
      polygon("ucompound", "100 100 200 500", [
        {
          open: false,
          anchors: [{ a: [100, 100] }, { a: [200, 100] }, { a: [150, 200] }],
        },
        {
          open: true,
          anchors: [{ a: [300, 100] }, { a: [400, 200] }, { a: [500, 100] }],
        },
      ]),
    ),
};

/** The same pair the other way round — the OPEN run first (flat 0–2),
 *  the closed triangle after it (3–5): appending to the run inserts at a
 *  contour boundary, where the engine's default start rule misfiles. */
export const OPEN_THEN_CLOSED = {
  id: "uopenfirst",
  bytes: (): Uint8Array =>
    packageWithSpread(
      polygon("uopenfirst", "500 100 600 500", [
        {
          open: true,
          anchors: [{ a: [100, 500] }, { a: [200, 600] }, { a: [300, 500] }],
        },
        {
          open: false,
          anchors: [{ a: [400, 500] }, { a: [500, 500] }, { a: [450, 600] }],
        },
      ]),
    ),
};

/** A closed 100pt square in its own space, shown at ×2 + (50, 60): the
 *  inner point (100, 0) sits at page (250, 60). */
export const SCALED_SQUARE = {
  id: "uscaled",
  transform: [2, 0, 0, 2, 50, 60] as const,
  bytes: (): Uint8Array =>
    packageWithSpread(
      polygon(
        "uscaled",
        "0 0 100 100",
        [
          {
            open: false,
            anchors: [
              { a: [0, 0] },
              { a: [100, 0] },
              { a: [100, 100] },
              { a: [0, 100] },
            ],
          },
        ],
        "2 0 0 2 50 60",
      ),
    ),
};

/** Two OPEN paths for the Pen: `upa` (a three-anchor polygon) and `upb`
 *  (a line whose START dangles a left handle and whose END a right one —
 *  the handles a join must carry over rather than flatten). */
export const PEN_PAIR = {
  a: "upa",
  b: "upb",
  bytes: (): Uint8Array =>
    packageWithSpread(
      pathItem("Polygon", "upa", "400 100 600 400", true, [
        { a: [100, 400] },
        { a: [250, 600] },
        { a: [400, 400] },
      ]) +
        pathItem("GraphicLine", "upb", "650 100 700 400", true, [
          { a: [100, 650], l: [80, 640] },
          { a: [400, 700], r: [420, 710] },
        ]),
    ),
};
