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

// Property tests for the anchor-construction modules: spline.ts (smooth
// handles through points — the Curvature tool and the Pencil's smoothing
// pass), handles.ts (corner / smooth anchors from a click or a drag),
// classify.ts (the corner test) and the three helpers in types.ts.

import { describe, expect, it } from "vitest";

import {
  clone,
  cornerAnchor,
  dist,
  isCornerAnchor,
  mirrorHandle,
  smoothAnchorFromDrag,
  smoothAnchorsThrough,
  vec,
  type AnchorTriple,
  type Vec2,
} from "../src";
import {
  anchorTriple,
  assertClose,
  assertTrue,
  assertVecClose,
  coord,
  fc,
  magnitude,
  polyline,
  real,
  refEvalCubic,
  unit,
  vec2,
} from "./property-kit";

const points = polyline(0, 9);
const tolOf = (pts: readonly Vec2[]): number => 1e-9 * magnitude(...pts);

describe("spline — smoothAnchorsThrough (properties)", () => {
  it("passes THROUGH every point, in order, one anchor each", () => {
    fc.assert(
      fc.property(points, fc.boolean(), (pts, closed) => {
        const anchors = smoothAnchorsThrough(pts, undefined, closed);
        expect(anchors).toHaveLength(pts.length);
        anchors.forEach((a, i) => assertVecClose(a.anchor, pts[i], 0, `anchor ${i}`));
      }),
    );
  });

  it("gives every non-corner anchor a MIRRORED pair of handles (it is smooth)", () => {
    fc.assert(
      fc.property(points, fc.boolean(), (pts, closed) => {
        const tol = tolOf(pts);
        smoothAnchorsThrough(pts, undefined, closed).forEach((a, i) => {
          assertVecClose(
            a.left,
            [2 * a.anchor[0] - a.right[0], 2 * a.anchor[1] - a.right[1]],
            tol,
            `anchor ${i}`,
          );
        });
      }),
    );
  });

  it("the outgoing handle is a sixth of the chord between the neighbours — wrapped when closed, clamped when open", () => {
    fc.assert(
      fc.property(polyline(2, 9), fc.boolean(), (pts, closed) => {
        const n = pts.length;
        const tol = tolOf(pts);
        smoothAnchorsThrough(pts, undefined, closed).forEach((a, i) => {
          const prev = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
          const next = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
          assertVecClose(
            a.right,
            [pts[i][0] + (next[0] - prev[0]) / 6, pts[i][1] + (next[1] - prev[1]) / 6],
            tol,
            `anchor ${i} right handle`,
          );
        });
      }),
    );
  });

  it("IS the uniform Catmull-Rom spline: each closed segment matches the textbook polynomial", () => {
    // The identity the module is named for, checked on the curve rather
    // than on the handles: the cubic between P1 and P2 equals
    //   ½·[2P1 + (P2 − P0)t + (2P0 − 5P1 + 4P2 − P3)t² + (3P1 − P0 − 3P2 + P3)t³].
    fc.assert(
      fc.property(polyline(4, 8), fc.nat(20), unit, (pts, pick, t) => {
        const n = pts.length;
        const anchors = smoothAnchorsThrough(pts, undefined, true);
        const i = pick % n;
        const p0 = pts[(i - 1 + n) % n];
        const p1 = pts[i];
        const p2 = pts[(i + 1) % n];
        const p3 = pts[(i + 2) % n];
        const cr = (k: 0 | 1): number =>
          0.5 *
          (2 * p1[k] +
            (p2[k] - p0[k]) * t +
            (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t +
            (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t * t * t);
        const a = anchors[i];
        const b = anchors[(i + 1) % n];
        assertVecClose(
          refEvalCubic([a.anchor, a.right, b.left, b.anchor], t),
          [cr(0), cr(1)],
          1e-8 * magnitude(...pts),
        );
      }),
    );
  });

  it("a flagged corner collapses both handles; an unflagged neighbour is unaffected", () => {
    fc.assert(
      fc.property(
        polyline(1, 9),
        fc.array(fc.boolean(), { minLength: 9, maxLength: 9 }),
        fc.boolean(),
        (pts, flags, closed) => {
          const corners = flags.slice(0, pts.length);
          const flagged = smoothAnchorsThrough(pts, corners, closed);
          const plain = smoothAnchorsThrough(pts, undefined, closed);
          flagged.forEach((a, i) => {
            if (corners[i]) {
              assertVecClose(a.left, a.anchor, 0, `corner ${i} left`);
              assertVecClose(a.right, a.anchor, 0, `corner ${i} right`);
            } else {
              assertVecClose(a.left, plain[i].left, 0, `anchor ${i} left`);
              assertVecClose(a.right, plain[i].right, 0, `anchor ${i} right`);
            }
          });
        },
      ),
    );
  });

  it("degenerate runs stay honest: nothing in, nothing out; one point is one corner", () => {
    expect(smoothAnchorsThrough([])).toEqual([]);
    fc.assert(
      fc.property(vec2, fc.boolean(), (p, closed) => {
        const [only] = smoothAnchorsThrough([p], undefined, closed);
        assertVecClose(only.anchor, p, 0);
        assertVecClose(only.left, p, 0);
        assertVecClose(only.right, p, 0);
      }),
    );
  });

  it("commutes with a translation and with a uniform scale of the points", () => {
    fc.assert(
      fc.property(points, fc.boolean(), vec2, real(-4, 4), (pts, closed, d, k) => {
        const base = smoothAnchorsThrough(pts, undefined, closed);
        const mapped = smoothAnchorsThrough(
          pts.map((p): Vec2 => [k * p[0] + d[0], k * p[1] + d[1]]),
          undefined,
          closed,
        );
        const tol = 1e-9 * magnitude(...pts, d) * Math.max(1, Math.abs(k));
        base.forEach((a, i) => {
          for (const key of ["anchor", "left", "right"] as const) {
            assertVecClose(
              mapped[i][key],
              [k * a[key][0] + d[0], k * a[key][1] + d[1]],
              tol,
              `anchors[${i}].${key}`,
            );
          }
        });
      }),
    );
  });

  it("fitting the points in reverse is the same curve reversed: handles swap", () => {
    fc.assert(
      fc.property(points, fc.boolean(), (pts, closed) => {
        const forward = smoothAnchorsThrough(pts, undefined, closed);
        const backward = smoothAnchorsThrough([...pts].reverse(), undefined, closed);
        const n = pts.length;
        const tol = tolOf(pts);
        forward.forEach((a, i) => {
          const b = backward[n - 1 - i];
          assertVecClose(b.left, a.right, tol, `anchor ${i} right`);
          assertVecClose(b.right, a.left, tol, `anchor ${i} left`);
        });
      }),
    );
  });

  it("returns fresh anchors: mutating the output leaves the points alone", () => {
    fc.assert(
      fc.property(points, fc.boolean(), (pts, closed) => {
        const input = structuredClone(pts);
        const before = JSON.stringify(input);
        for (const a of smoothAnchorsThrough(input, undefined, closed)) {
          a.anchor[0] = Number.NaN;
          a.left[1] = Number.NaN;
          a.right[0] = Number.NaN;
        }
        expect(JSON.stringify(input)).toBe(before);
      }),
    );
  });
});

describe("handles — cornerAnchor / mirrorHandle / smoothAnchorFromDrag (properties)", () => {
  it("mirrorHandle is a point reflection: an involution with the anchor as midpoint", () => {
    fc.assert(
      fc.property(vec2, vec2, (anchor, handle) => {
        const mirrored = mirrorHandle(anchor, handle);
        const tol = 1e-9 * magnitude(anchor, handle);
        assertVecClose(
          [(mirrored[0] + handle[0]) / 2, (mirrored[1] + handle[1]) / 2],
          anchor,
          tol,
          "midpoint",
        );
        assertVecClose(mirrorHandle(anchor, mirrored), handle, tol, "twice");
        assertClose(dist(anchor, mirrored), dist(anchor, handle), tol, "length");
      }),
    );
  });

  it("cornerAnchor collapses both handles onto the point, as three independent copies", () => {
    fc.assert(
      fc.property(vec2, (p) => {
        const a = cornerAnchor(p);
        assertVecClose(a.anchor, p, 0);
        assertVecClose(a.left, p, 0);
        assertVecClose(a.right, p, 0);
        assertTrue(isCornerAnchor(a), "a cornerAnchor is not a corner");
        expect(a.anchor).not.toBe(p);
        expect(a.left).not.toBe(a.anchor);
        expect(a.right).not.toBe(a.left);
      }),
    );
  });

  it("smoothAnchorFromDrag: the outgoing handle follows the pointer, the incoming one mirrors it", () => {
    fc.assert(
      fc.property(vec2, vec2, (anchor, drag) => {
        const a = smoothAnchorFromDrag(anchor, drag);
        assertVecClose(a.anchor, anchor, 0);
        assertVecClose(a.right, drag, 0);
        assertVecClose(a.left, [2 * anchor[0] - drag[0], 2 * anchor[1] - drag[1]], 0);
        // A real drag makes a smooth anchor; no drag makes a corner.
        expect(isCornerAnchor(a)).toBe(dist(anchor, drag) < 1e-3);
      }),
    );
  });
});

describe("classify — isCornerAnchor (properties)", () => {
  const eps = real(1e-6, 10);

  it("is exactly: BOTH handles nearer than eps", () => {
    fc.assert(
      fc.property(anchorTriple, eps, (a, e) => {
        expect(isCornerAnchor(a, e)).toBe(
          dist(a.left, a.anchor) < e && dist(a.right, a.anchor) < e,
        );
      }),
    );
  });

  it("a wider tolerance never turns a corner back into a smooth anchor", () => {
    fc.assert(
      fc.property(anchorTriple, eps, eps, (a, e1, e2) => {
        if (isCornerAnchor(a, Math.min(e1, e2))) {
          expect(isCornerAnchor(a, Math.max(e1, e2))).toBe(true);
        }
      }),
    );
  });

  it("is blind to the order of the handles, and extending either one alone breaks the corner", () => {
    fc.assert(
      fc.property(vec2, real(0.01, 100), (p, reach) => {
        const out: [number, number] = [p[0] + reach, p[1]];
        const leftOut: AnchorTriple = { anchor: p, left: out, right: [p[0], p[1]] };
        const rightOut: AnchorTriple = { anchor: p, left: [p[0], p[1]], right: out };
        // Skip the case where the reach is lost to rounding at this
        // magnitude (p + reach === p).
        fc.pre(dist(out, p) >= 1e-3);
        expect(isCornerAnchor(leftOut)).toBe(false);
        expect(isCornerAnchor(rightOut)).toBe(false);
      }),
    );
  });
});

describe("types — vec / clone / dist (properties)", () => {
  it("vec and clone build fresh tuples with the same numbers", () => {
    fc.assert(
      fc.property(coord, coord, (x, y) => {
        const v = vec(x, y);
        assertVecClose(v, [x, y], 0);
        const c = clone(v);
        assertVecClose(c, v, 0);
        expect(c).not.toBe(v);
      }),
    );
  });

  it("dist is a metric: symmetric, zero only on itself, and obeys the triangle inequality", () => {
    fc.assert(
      fc.property(vec2, vec2, vec2, (a, b, c) => {
        expect(dist(a, b)).toBe(dist(b, a));
        expect(dist(a, a)).toBe(0);
        assertTrue(dist(a, b) >= 0, "negative distance");
        assertTrue(
          dist(a, c) <= dist(a, b) + dist(b, c) + 1e-9 * magnitude(a, b, c),
          "triangle inequality",
        );
        assertClose(
          dist(a, b),
          Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2),
          1e-9 * magnitude(a, b),
        );
      }),
    );
  });
});
