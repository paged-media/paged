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

// ORACLE — Illustrator's POLYGON and STAR against the live shapes (engine
// ADR 1047): the Star tool makes an upright live star from draw-geometry's
// `regularPolygonPath` on Radius 1 plus its points and inset, which the
// engine draws as `starPath` draws it; the Polygon tool's live polygon
// follows InDesign's polygon tool.
//
// The recording (`scripts/illustrator/probes/live-shapes.jsx`) asks
// `PathItems.polygon(cx, cy, r, sides)` and `PathItems.star(cx, cy, r, ri,
// points)` about one centre, and reflects an ellipse's properties. What
// it says, and what is asserted:
//
//   1. A STAR is ours to 0.01 pt: the first point straight up, the points
//      running clockwise on the page, the inner points between them on the
//      inner radius — `starPath` exactly, so a live star's points and inset
//      are Illustrator's star.
//   2. A POLYGON is the same set of corners as ours for an ODD side count
//      (a point straight up), wound the other way (Illustrator runs
//      counter-clockwise on the page). For an EVEN count Illustrator turns
//      it half a step, flat side up; ours keeps a corner up, InDesign's
//      polygon tool's orientation. Recorded as a convention, not a defect:
//      the live polygon is InDesign's (the IDML round trip is the document
//      format), and a turned polygon is a rotation away.
//   3. Illustrator's scripting DOM has NO pie or live-shape property on an
//      ellipse (none of its reflected properties names a pie, a live
//      shape, a shape or an angle), so pie angles are not recordable here.

import { describe, expect, it } from "bun:test";

import { regularPolygonPath, starPath } from "@paged-media/draw-geometry";

import { loadOracle, type Vec2 } from "./oracle";

interface Params {
  kind: "polygon" | "star" | "ellipse";
  centre: Vec2;
  radius: number;
  sides: number;
  innerRadius: number;
  reflected_shape_properties?: string[];
  reflected_property_count?: number;
}

const FIXTURE = loadOracle<Params>("live-shapes");
const TOL = 0.01;
const pts = (c: (typeof FIXTURE.cases)[number]): Vec2[] =>
  c.measured.paths[0]!.anchors.map((a) => a.anchor);
const close = (a: Vec2, b: Vec2) =>
  Math.abs(a[0] - b[0]) <= TOL && Math.abs(a[1] - b[1]) <= TOL;

describe("oracle — Illustrator polygon and star vs the live shapes (engine ADR 1047)", () => {
  it("records every case from Illustrator", () => {
    expect(FIXTURE.produced_by.app).toContain("Illustrator");
    expect(FIXTURE.cases.map((c) => c.id)).toEqual([
      "polygon-3",
      "polygon-5",
      "polygon-6",
      "star-5",
      "star-6",
      "ellipse",
    ]);
  });

  for (const c of FIXTURE.cases.filter((c) => c.parameters.kind === "star")) {
    it(`${c.id}: Illustrator's star is starPath, point for point`, () => {
      const p = c.parameters;
      const ours = starPath({
        cx: p.centre[0],
        cy: p.centre[1],
        radius1: p.radius,
        radius2: p.innerRadius,
        points: p.sides,
      }).anchors.map((a) => a.anchor as Vec2);
      const theirs = pts(c);
      expect(theirs).toHaveLength(ours.length);
      theirs.forEach((q, i) => expect(close(q, ours[i]!)).toBe(true));
      expect(c.measured.paths[0]!.winding).toBe("cw");
    });
  }

  for (const c of FIXTURE.cases.filter(
    (c) => c.parameters.kind === "polygon",
  )) {
    const p = c.parameters;
    const ours = regularPolygonPath(
      p.centre[0],
      p.centre[1],
      p.radius,
      p.sides,
    ).anchors.map((a) => a.anchor as Vec2);
    const theirs = pts(c);
    if (p.sides % 2 === 1) {
      it(`${c.id}: the same corners as ours (a point up), wound counter-clockwise`, () => {
        expect(theirs).toHaveLength(ours.length);
        for (const q of theirs)
          expect(ours.some((o) => close(o, q))).toBe(true);
        expect(close(theirs[0]!, ours[0]!)).toBe(true);
        expect(c.measured.paths[0]!.winding).toBe("ccw");
      });
    } else {
      it(`${c.id}: CONVENTION — Illustrator turns an even polygon half a step (flat side up); ours keeps a corner up`, () => {
        const half = regularPolygonPath(
          p.centre[0],
          p.centre[1],
          p.radius,
          p.sides,
          180 / p.sides,
        ).anchors.map((a) => a.anchor as Vec2);
        for (const q of theirs)
          expect(half.some((o) => close(o, q))).toBe(true);
        expect(theirs.some((q) => close(q, ours[0]!))).toBe(false);
      });
    }
  }

  it("the ellipse: Illustrator's scripting has no pie or live-shape property", () => {
    const e = FIXTURE.cases.find((c) => c.id === "ellipse")!.parameters;
    expect(e.reflected_property_count).toBeGreaterThan(20);
    expect(e.reflected_shape_properties).toEqual([]);
  });
});
