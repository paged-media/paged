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

// Editor ADR 310 — the live-shape geometry the widgets and the Polygon
// tool draw with, held to the engine's definitions (engine ADR 1047,
// `paged_model::live_shape`): the same first point and direction, the
// same fit to a box, the same circle kept across a change of sides, the
// same pie convention.

import { describe, expect, test } from "bun:test";

import {
  circleBoxOf,
  clampShape,
  cornerRadiusAt,
  cornerWidgetPoint,
  ellipseAngleAt,
  ellipsePoint,
  maxCornerRadius,
  nextCornerOption,
  normalizeEnd,
  normalizeStart,
  pieOutlinePath,
  pieSweep,
  pointsBox,
  polygonInBox,
  polygonInCircle,
  sidesFromDrag,
  starInsetAt,
  type Box,
} from "../src/live-shapes/geometry";

const close = (a: number, b: number, eps = 1e-9) =>
  expect(Math.abs(a - b)).toBeLessThan(eps);

describe("live polygons", () => {
  test("the first point is at twelve o'clock and the next runs clockwise on the page", () => {
    const pts = polygonInCircle([0, 0, 100, 100], { sides: 5, starInset: 0 });
    expect(pts).toHaveLength(5);
    close(pts[0]![0], 50);
    close(pts[0]![1], 0);
    expect(pts[1]![0]).toBeGreaterThan(50);
    expect(pts[1]![1]).toBeGreaterThan(0);
  });

  test("a star alternates outer and inner points at 1 − inset", () => {
    const pts = polygonInCircle([0, 0, 200, 200], { sides: 5, starInset: 40 });
    expect(pts).toHaveLength(10);
    pts.forEach((p, i) =>
      close(Math.hypot(p[0] - 100, p[1] - 100), i % 2 === 0 ? 100 : 60),
    );
  });

  test("a shape fitted to a box fills it, and its circle gives the same points back", () => {
    const fit: Box = [10, 20, 90, 120];
    const shape = { sides: 5, starInset: 30 };
    const pts = polygonInBox(fit, shape);
    const box = pointsBox(pts);
    box.forEach((v, i) => close(v, fit[i]!, 1e-9));
    const again = polygonInCircle(circleBoxOf(fit, shape), shape);
    again.forEach((p, i) => {
      close(p[0], pts[i]![0]);
      close(p[1], pts[i]![1]);
    });
  });

  test("clamping is the engine's: sides 3…100 (whole), inset 0…99", () => {
    expect(clampShape(1.4, -3)).toEqual({ sides: 3, starInset: 0 });
    expect(clampShape(250, 120)).toEqual({ sides: 100, starInset: 99 });
    expect(clampShape(6.6, 12.5)).toEqual({ sides: 7, starInset: 12.5 });
  });

  test("the side widget counts one side per 12 screen px, up adds", () => {
    expect(sidesFromDrag(6, -24, 1)).toBe(8);
    expect(sidesFromDrag(6, 12, 2)).toBe(4);
    expect(sidesFromDrag(4, 1000, 1)).toBe(3);
  });

  test("the star widget reads the inset from the distance to the centre", () => {
    const circle: Box = [0, 0, 200, 200];
    expect(starInsetAt(circle, [100, 40])).toBe(40);
    expect(starInsetAt(circle, [100, 100])).toBe(99);
    expect(starInsetAt(circle, [100, -50])).toBe(0);
  });
});

describe("pies", () => {
  test("angles normalise as the engine stores them", () => {
    expect(normalizeStart(-90)).toBe(270);
    expect(normalizeStart(360)).toBe(0);
    expect(normalizeEnd(360)).toBe(360);
    expect(normalizeEnd(0)).toBe(0);
    expect(normalizeEnd(450)).toBe(90);
    expect(pieSweep(0, 360)).toBe(0);
    expect(pieSweep(270, 90)).toBe(180);
  });

  test("0° is three o'clock and 90° is twelve (counter-clockwise on the page)", () => {
    const box: Box = [0, 0, 100, 200];
    const a = ellipsePoint(box, 0);
    close(a[0], 200);
    close(a[1], 50);
    const b = ellipsePoint(box, 90);
    close(b[0], 100);
    close(b[1], 0);
    close(ellipseAngleAt(box, b), 90);
    close(ellipseAngleAt(box, ellipsePoint(box, 225)), 225, 1e-6);
  });

  test("a pie's outline is the centre, the start point and the arc; a whole turn is the ellipse", () => {
    expect(pieOutlinePath([0, 0, 100, 100], 0, 90)).toBe(
      "M50 50 L100 50 A50 50 0 0 0 50 0 Z",
    );
    expect(pieOutlinePath([0, 0, 100, 100], 0, 360)).toContain("A50 50 0 1 0");
  });
});

describe("corner widgets", () => {
  const box: Box = [0, 0, 100, 200];

  test("a widget sits on the corner's diagonal at the radius, never closer than the minimum", () => {
    expect(cornerWidgetPoint(box, 0, 20, 5)).toEqual([20, 20]);
    expect(cornerWidgetPoint(box, 2, 0, 5)).toEqual([195, 95]);
    // No further in than half the shorter side.
    expect(cornerWidgetPoint(box, 1, 80, 5)).toEqual([150, 50]);
    expect(maxCornerRadius(box)).toBe(50);
  });

  test("a drag reads the radius along the diagonal", () => {
    expect(cornerRadiusAt(box, 0, [10, 30])).toBe(20);
    expect(cornerRadiusAt(box, 2, [190, 90])).toBe(10);
    expect(cornerRadiusAt(box, 0, [-5, -5])).toBe(0);
    expect(cornerRadiusAt(box, 0, [90, 90])).toBe(50);
  });

  test("Alt-click cycles rounded → inverse → bevel → inset → fancy → rounded", () => {
    expect(nextCornerOption("None")).toBe("RoundedCorner");
    expect(nextCornerOption("RoundedCorner")).toBe("InverseRoundedCorner");
    expect(nextCornerOption("FancyCorner")).toBe("RoundedCorner");
  });
});
