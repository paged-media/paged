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

import { describe, expect, it } from "vitest";

import { radialCenterFor, radialPointAt } from "@paged-media/draw-geometry";

import {
  repeatGuide,
  repeatSteer,
  snapAngleDeg,
  CONSTRAIN_STEP_DEG,
  MIN_RADIUS_PT,
  RING_SEGMENTS,
} from "../src/index";

const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

/** A 100 × 100 source centred at (50, 50). */
const CENTER: [number, number] = [50, 50];
const SIZE: [number, number] = [100, 100];

describe("draw-tools — the on-canvas REPEAT widget (§12.4)", () => {
  describe("steering", () => {
    it("RADIAL — the pointer places the ring CENTRE, so the drag sets radius AND start angle", () => {
      // Drag 200 pt straight up from the source centre.
      const steer = repeatSteer("radial", CENTER, [50, -150], SIZE);
      expect(near(steer.radiusPt!, 200)).toBe(true);
      // The source sits on the ring at the angle from the CENTRE back to
      // the source: straight down in a y-down frame, i.e. +90°.
      expect(near(steer.startDeg!, 90)).toBe(true);
      // …and the derivation round-trips: rebuilding the centre from the
      // steered pair lands on the pointer.
      const center = radialCenterFor(CENTER, steer.radiusPt!, steer.startDeg!);
      expect(near(center[0], 50, 1e-9)).toBe(true);
      expect(near(center[1], -150, 1e-9)).toBe(true);
      // The SOURCE is still on the ring — it never moves.
      const back = radialPointAt(center, steer.radiusPt!, steer.startDeg!);
      expect(near(back[0], CENTER[0], 1e-9) && near(back[1], CENTER[1], 1e-9)).toBe(
        true,
      );
    });

    it("RADIAL — a sub-pixel drag reads as NO radius rather than a degenerate ring", () => {
      const steer = repeatSteer("radial", CENTER, [50.2, 50.2], SIZE);
      expect(steer.radiusPt).toBe(0);
      expect(steer.startDeg).toBeUndefined();
      expect(MIN_RADIUS_PT).toBeGreaterThan(0);
    });

    it("GRID — the pointer places the NEXT cell, so the spacing is the step MINUS the source size", () => {
      // One source-width plus a 20 pt gutter to the right.
      const steer = repeatSteer("grid", CENTER, [170, 60], SIZE);
      expect(steer.spacing).toEqual([20, -90]);
    });

    it("GRID — dragging INSIDE the source's own footprint gives a NEGATIVE spacing, which is a real overlap", () => {
      const steer = repeatSteer("grid", CENTER, [80, 80], SIZE);
      expect(steer.spacing![0]).toBeLessThan(0);
      expect(steer.spacing![1]).toBeLessThan(0);
    });

    it("MIRROR — the axis runs PERPENDICULAR to the drag, and the offset is the distance", () => {
      // Drag straight right: the axis is vertical (90°), 60 pt out.
      const steer = repeatSteer("mirror", CENTER, [110, 50], SIZE);
      expect(near(steer.angleDeg!, 90)).toBe(true);
      expect(near(steer.offsetPt!, 60)).toBe(true);
      // Drag straight down: the axis is horizontal (180° ≡ 0°).
      const down = repeatSteer("mirror", CENTER, [50, 110], SIZE);
      expect(near(Math.abs(down.angleDeg!) % 180, 0)).toBe(true);
    });
  });

  describe("the Shift constraint", () => {
    it("snaps ANGLES to 45° and leaves the DISTANCE alone", () => {
      const free = repeatSteer("radial", CENTER, [150, -95], SIZE);
      const snapped = repeatSteer("radial", CENTER, [150, -95], SIZE, {
        constrain: true,
      });
      // Same radius — Shift must not move the pointer's distance (which
      // is what draw-geometry's own `constrainAngle` would have done).
      expect(snapped.radiusPt).toBe(free.radiusPt);
      expect(snapped.startDeg! % CONSTRAIN_STEP_DEG).toBe(0);
      expect(snapped.startDeg).not.toBe(free.startDeg);
    });

    it("is ignored for the GRID, which has no angular parameter to snap", () => {
      const a = repeatSteer("grid", CENTER, [170, 60], SIZE);
      const b = repeatSteer("grid", CENTER, [170, 60], SIZE, { constrain: true });
      expect(b).toEqual(a);
    });

    it("snapAngleDeg is a pure degree snap, off by default", () => {
      expect(snapAngleDeg(37, false)).toBe(37);
      expect(snapAngleDeg(37, undefined)).toBe(37);
      expect(snapAngleDeg(37, true)).toBe(45);
      expect(snapAngleDeg(-100, true)).toBe(-90);
    });
  });

  describe("the guide — ONE polyline, because that is what the overlay door takes", () => {
    it("RADIAL draws the spoke then the ring, as one connected run", () => {
      const center = radialCenterFor(CENTER, 120, -90);
      const points = repeatGuide({ kind: "radial", center, source: CENTER });
      // 1 centre + RING_SEGMENTS + 1 closing sample.
      expect(points).toHaveLength(RING_SEGMENTS + 2);
      expect(points[0][0]).toBe(center[0]);
      expect(points[0][1]).toBe(center[1]);
      // The ring starts AT the source, so the spoke ends where the
      // artwork is.
      expect(near(points[1][0], CENTER[0], 1e-9)).toBe(true);
      expect(near(points[1][1], CENTER[1], 1e-9)).toBe(true);
      // Every ring sample is one radius from the centre.
      for (const p of points.slice(1)) {
        expect(near(Math.hypot(p[0] - center[0], p[1] - center[1]), 120, 1e-9)).toBe(
          true,
        );
      }
    });

    it("RADIAL draws NOTHING below the minimum radius (the handler then clears the preview)", () => {
      expect(
        repeatGuide({ kind: "radial", center: [50, 50], source: [50, 50] }),
      ).toEqual([]);
    });

    it("GRID draws the closed rectangle the whole lattice will occupy", () => {
      const points = repeatGuide({
        kind: "grid",
        bounds: [0, 0, 100, 100],
        stepX: 120,
        stepY: 130,
        columns: 3,
        rows: 2,
      });
      expect(points).toHaveLength(5);
      expect(points[0]).toEqual(points[4]);
      // 2 steps right + one source width; 1 step down + one source height.
      expect(points[2]).toEqual([340, 230]);
    });

    it("GRID handles a NEGATIVE step without inverting the rectangle", () => {
      const points = repeatGuide({
        kind: "grid",
        bounds: [0, 0, 100, 100],
        stepX: -60,
        stepY: 100,
        columns: 3,
        rows: 1,
      });
      const xs = points.map((p) => p[0]);
      expect(Math.min(...xs)).toBe(-120);
      expect(Math.max(...xs)).toBe(100);
    });

    it("MIRROR draws the axis segment, centred on its origin", () => {
      const points = repeatGuide({
        kind: "mirror",
        origin: [100, 50],
        angleDeg: 90,
        span: 300,
      });
      expect(points).toHaveLength(2);
      expect(near(points[0][0], 100) && near(points[1][0], 100)).toBe(true);
      expect(near(points[1][1] - points[0][1], 300)).toBe(true);
    });
  });
});
