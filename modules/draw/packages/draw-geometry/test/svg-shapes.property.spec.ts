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

// Property tests for svg-shapes.ts — the basic shapes lowered to anchors.

import { describe, expect, it } from "vitest";

import {
  circleToPath,
  contourSignedArea,
  ellipseToPath,
  flattenAnchorRun,
  isCornerAnchor,
  lineToPath,
  pointInAnchorPath,
  polyToPath,
  rectToPath,
  type Vec2,
} from "../src";
import {
  assertClose,
  assertTrue,
  assertVecClose,
  coord,
  fc,
  polyline,
  real,
  refSignedArea,
} from "./property-kit";

const side = real(0.5, 500);
const radius = real(0.5, 300);
const EMPTY = { anchors: [], subpathStarts: [], subpathOpen: [] };

/** A fine flattening: the chord error of 64 samples per quarter turn is
 *  3e-5 of the radius, well under the κ approximation's own 2.7e-4. */
const FINE = { close: true, samplesPerSegment: 64 };

describe("svg-shapes — rectToPath (properties)", () => {
  it("a sharp rect is its four corners, clockwise on a y-down page, closed", () => {
    fc.assert(
      fc.property(coord, coord, side, side, (x, y, w, h) => {
        const t = rectToPath(x, y, w, h);
        expect(t.subpathStarts).toEqual([0]);
        expect(t.subpathOpen).toEqual([false]);
        expect(t.anchors.map((a) => a.anchor)).toEqual([
          [x, y],
          [x + w, y],
          [x + w, y + h],
          [x, y + h],
        ]);
        for (const a of t.anchors) assertTrue(isCornerAnchor(a), "a sharp corner has handles");
        // Clockwise in y-down space is the POSITIVE shoelace sign.
        assertClose(
          refSignedArea(t.anchors.map((a): Vec2 => a.anchor)),
          w * h,
          1e-9 * Math.max(1, w * h, Math.abs(x) * h, Math.abs(y) * w),
        );
      }),
    );
  });

  it("a non-positive width or height is no shape at all", () => {
    const nonPositive = real(-100, 0);
    fc.assert(
      fc.property(coord, coord, nonPositive, side, radius, (x, y, bad, good, r) => {
        expect(rectToPath(x, y, bad, good, r, r)).toEqual(EMPTY);
        expect(rectToPath(x, y, good, bad, r, r)).toEqual(EMPTY);
      }),
    );
  });

  it("a rounded rect is 8 anchors ON the rect's boundary, and stays inside the rect", () => {
    fc.assert(
      fc.property(coord, coord, side, side, radius, radius, (x, y, w, h, rx, ry) => {
        const t = rectToPath(x, y, w, h, rx, ry);
        expect(t.anchors).toHaveLength(8);
        expect(t.subpathOpen).toEqual([false]);
        const slack = 1e-9 * Math.max(1, Math.abs(x), Math.abs(y), w, h);
        const onEdge = (p: Vec2): boolean =>
          Math.abs(p[0] - x) <= slack ||
          Math.abs(p[0] - (x + w)) <= slack ||
          Math.abs(p[1] - y) <= slack ||
          Math.abs(p[1] - (y + h)) <= slack;
        for (const a of t.anchors) {
          assertTrue(onEdge(a.anchor), `anchor [${a.anchor}] is off the boundary`);
        }
        for (const p of flattenAnchorRun(t.anchors, FINE)) {
          assertTrue(
            p[0] >= x - slack && p[0] <= x + w + slack && p[1] >= y - slack && p[1] <= y + h + slack,
            `[${p}] is outside the rect`,
          );
        }
      }),
    );
  });

  it("radii are clamped to half the side, and a missing one mirrors the other", () => {
    fc.assert(
      fc.property(coord, coord, side, side, radius, radius, (x, y, w, h, rx, ry) => {
        const clamped = rectToPath(x, y, w, h, Math.min(rx, w / 2), Math.min(ry, h / 2));
        expect(rectToPath(x, y, w, h, rx, ry)).toEqual(clamped);
        // rx given, ry missing (0) ⇒ ry = rx — and the other way round.
        expect(rectToPath(x, y, w, h, rx, 0)).toEqual(rectToPath(x, y, w, h, rx, rx));
        expect(rectToPath(x, y, w, h, 0, ry)).toEqual(rectToPath(x, y, w, h, ry, ry));
      }),
    );
  });

  it("rounding removes exactly the four corner slivers: area = w·h − (4 − π)·rx·ry", () => {
    fc.assert(
      fc.property(side, side, radius, radius, (w, h, rxIn, ryIn) => {
        const rx = Math.min(rxIn, w / 2);
        const ry = Math.min(ryIn, h / 2);
        const t = rectToPath(0, 0, w, h, rx, ry);
        const area = contourSignedArea(t.anchors, { samplesPerSegment: 64 });
        assertClose(area, w * h - (4 - Math.PI) * rx * ry, 2e-3 * rx * ry + 1e-9 * w * h, "area");
      }),
    );
  });

  it("the rect's own corner is cut off, its centre is kept", () => {
    fc.assert(
      fc.property(side, side, radius, radius, (w, h, rxIn, ryIn) => {
        const rx = Math.min(rxIn, w / 2);
        const ry = Math.min(ryIn, h / 2);
        const t = rectToPath(0, 0, w, h, rx, ry);
        expect(pointInAnchorPath([w / 2, h / 2], t.anchors)).toBe(true);
        // A point 5 % of the radii in from the corner: outside the
        // quarter ellipse (the ellipse is 29 % in at the diagonal).
        expect(pointInAnchorPath([0.05 * rx, 0.05 * ry], t.anchors)).toBe(false);
        expect(pointInAnchorPath([w - 0.05 * rx, h - 0.05 * ry], t.anchors)).toBe(false);
      }),
    );
  });
});

describe("svg-shapes — ellipseToPath / circleToPath (properties)", () => {
  it("is four smooth anchors at the ends of the axes: right, bottom, left, top", () => {
    fc.assert(
      fc.property(coord, coord, radius, radius, (cx, cy, rx, ry) => {
        const t = ellipseToPath(cx, cy, rx, ry);
        expect(t.subpathOpen).toEqual([false]);
        expect(t.anchors.map((a) => a.anchor)).toEqual([
          [cx + rx, cy],
          [cx, cy + ry],
          [cx - rx, cy],
          [cx, cy - ry],
        ]);
        const tol = 1e-9 * Math.max(1, Math.abs(cx), Math.abs(cy), rx, ry);
        for (const a of t.anchors) {
          // Smooth: the handles mirror each other through the anchor.
          assertVecClose(
            a.left,
            [2 * a.anchor[0] - a.right[0], 2 * a.anchor[1] - a.right[1]],
            tol,
            "left handle",
          );
          assertTrue(!isCornerAnchor(a, 1e-9), "an ellipse anchor is a corner");
        }
      }),
    );
  });

  it("every point of the outline satisfies the ellipse equation to 3e-4 (the κ error)", () => {
    fc.assert(
      fc.property(coord, coord, radius, radius, (cx, cy, rx, ry) => {
        const t = ellipseToPath(cx, cy, rx, ry);
        for (const p of flattenAnchorRun(t.anchors, FINE)) {
          assertClose(Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry), 1, 3e-4, "radial ratio");
        }
      }),
    );
  });

  it("encloses π·rx·ry, wound clockwise (positive on a y-down page)", () => {
    fc.assert(
      fc.property(radius, radius, (rx, ry) => {
        const t = ellipseToPath(0, 0, rx, ry);
        const area = contourSignedArea(t.anchors, { samplesPerSegment: 64 });
        assertClose(area, Math.PI * rx * ry, 1e-3 * rx * ry, "area");
      }),
    );
  });

  it("a circle is the ellipse with equal radii, and non-positive radii are no shape", () => {
    const nonPositive = real(-100, 0);
    fc.assert(
      fc.property(coord, coord, radius, nonPositive, (cx, cy, r, bad) => {
        expect(circleToPath(cx, cy, r)).toEqual(ellipseToPath(cx, cy, r, r));
        expect(ellipseToPath(cx, cy, bad, r)).toEqual(EMPTY);
        expect(ellipseToPath(cx, cy, r, bad)).toEqual(EMPTY);
        expect(circleToPath(cx, cy, bad)).toEqual(EMPTY);
      }),
    );
  });

  it("a fully rounded square is the inscribed circle", () => {
    fc.assert(
      fc.property(side, (d) => {
        const rounded = rectToPath(0, 0, d, d, d / 2, d / 2);
        const circle = circleToPath(d / 2, d / 2, d / 2);
        assertClose(
          contourSignedArea(rounded.anchors, { samplesPerSegment: 64 }),
          contourSignedArea(circle.anchors, { samplesPerSegment: 64 }),
          1e-9 * d * d,
          "area",
        );
      }),
    );
  });
});

describe("svg-shapes — lineToPath / polyToPath (properties)", () => {
  it("a line is an open pair of corner anchors", () => {
    fc.assert(
      fc.property(coord, coord, coord, coord, (x1, y1, x2, y2) => {
        const t = lineToPath(x1, y1, x2, y2);
        expect(t.subpathStarts).toEqual([0]);
        expect(t.subpathOpen).toEqual([true]);
        expect(t.anchors.map((a) => a.anchor)).toEqual([
          [x1, y1],
          [x2, y2],
        ]);
        for (const a of t.anchors) assertTrue(isCornerAnchor(a), "a line end has handles");
      }),
    );
  });

  it("a polyline/polygon is one corner anchor per point; `close` is the only difference", () => {
    fc.assert(
      fc.property(polyline(0, 12), fc.boolean(), (pts, close) => {
        const t = polyToPath(pts, close);
        if (pts.length < 2) {
          expect(t).toEqual(EMPTY);
          return;
        }
        expect(t.subpathStarts).toEqual([0]);
        expect(t.subpathOpen).toEqual([!close]);
        expect(t.anchors.map((a) => a.anchor)).toEqual(pts);
        for (const a of t.anchors) assertTrue(isCornerAnchor(a), "a polygon vertex has handles");
      }),
    );
  });

  it("never aliases its input points", () => {
    fc.assert(
      fc.property(polyline(2, 6), (pts) => {
        const input = structuredClone(pts);
        const before = JSON.stringify(input);
        for (const a of polyToPath(input, true).anchors) {
          a.anchor[0] = Number.NaN;
          a.left[1] = Number.NaN;
          a.right[0] = Number.NaN;
        }
        expect(JSON.stringify(input)).toBe(before);
      }),
    );
  });
});
