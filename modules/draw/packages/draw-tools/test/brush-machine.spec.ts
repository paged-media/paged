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

import { MIN_BRUSH_WIDTH_RATIO, type NibProfile } from "@paged-media/draw-geometry";

import { BrushMachine } from "../src";

// A horizontal nib on a 6pt base: horizontal travel deposits the thin
// edge (0.3·6), vertical travel the full 6 — deterministic widths for
// the corner-anchor (smooth:false) runs below.
const NIB: NibProfile = { angle: 0, roundness: 0.3, size: 6 };

describe("BrushMachine — sampling (the pencil pipeline underneath)", () => {
  it("collects decimated samples while drawing (live polyline preview)", () => {
    const m = new BrushMachine({ tolerance: 1, minSampleDistance: 2, nib: NIB });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [0.5, 0] }); // below the floor — dropped
    m.handle({ type: "move", point: [5, 0] });
    const snap = m.handle({ type: "move", point: [10, 0] });
    expect(snap.points).toEqual([
      [0, 0],
      [5, 0],
      [10, 0],
    ]);
    expect(snap.active).toBe(true);
    expect(snap.commit).toBeNull();
  });

  it("a click (no travel) cancels instead of committing a degenerate sweep", () => {
    const m = new BrushMachine({ tolerance: 1, nib: NIB });
    m.handle({ type: "down", point: [10, 10] });
    const snap = m.handle({ type: "up", point: [10, 10] });
    expect(snap.commit).toBeNull();
    expect(snap.active).toBe(false);
  });

  it("Escape cancels the in-flight stroke", () => {
    const m = new BrushMachine({ tolerance: 1, nib: NIB });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [50, 0] });
    const snap = m.handle({ type: "key", key: "Escape" });
    expect(snap.commit).toBeNull();
    expect(snap.active).toBe(false);
    expect(snap.points).toHaveLength(0);
  });
});

describe("BrushMachine — the calligraphic width lane", () => {
  it("commits per-anchor widths, 1:1 with the simplified anchors", () => {
    const m = new BrushMachine({ tolerance: 1, minSampleDistance: 0, nib: NIB });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [50, 40] });
    m.handle({ type: "move", point: [100, 0] });
    const snap = m.handle({ type: "up", point: [100, 0] });
    const c = snap.commit!;
    expect(c.open).toBe(true);
    expect(c.widths).toHaveLength(c.anchors.length);
    expect(c.pressures).toHaveLength(c.anchors.length);
    for (const w of c.widths) expect(w).toBeGreaterThan(0);
  });

  it("width depends on the stroke direction against the nib (the L stroke)", () => {
    // Corner anchors (smooth:false) make the tangents exact: one-sided
    // horizontal at the start, the 45° central difference at the corner,
    // one-sided vertical at the end.
    const m = new BrushMachine({
      tolerance: 1,
      minSampleDistance: 0,
      smooth: false,
      nib: NIB,
    });
    m.handle({ type: "down", point: [0, 0] });
    for (let x = 10; x <= 100; x += 10) m.handle({ type: "move", point: [x, 0] });
    for (let y = 10; y <= 100; y += 10) m.handle({ type: "move", point: [100, y] });
    const snap = m.handle({ type: "up", point: [100, 100] });
    const c = snap.commit!;
    expect(c.anchors.map((a) => a.anchor)).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
    // Horizontal travel along the nib → the thin edge.
    expect(c.widths[0]).toBeCloseTo(0.3 * 6);
    // The corner's central difference is 45°.
    expect(c.widths[1]).toBeCloseTo(6 * (0.3 + 0.7 * Math.sin(Math.PI / 4)));
    // Vertical travel perpendicular to the nib → the full size.
    expect(c.widths[2]).toBeCloseTo(6);
  });

  it("pressure scales the widths (and rides the RDP lane 1:1)", () => {
    const m = new BrushMachine({
      tolerance: 0.1,
      minSampleDistance: 0,
      smooth: false,
      nib: NIB,
    });
    m.handle({ type: "down", point: [0, 0], pressure: 1 });
    m.handle({ type: "move", point: [0, 50], pressure: 1 });
    const snap = m.handle({ type: "up", point: [0, 100], pressure: 0 });
    const c = snap.commit!;
    // Vertical stroke → model width 6; pressure 1 doubles it, pressure 0
    // floors at the hairline ratio.
    expect(c.widths[0]).toBeCloseTo(12);
    expect(c.widths[c.widths.length - 1]).toBeCloseTo(MIN_BRUSH_WIDTH_RATIO * 6);
  });

  it("pressure:false is the uniform lane — a round nib commits constant nib.size", () => {
    const round: NibProfile = { angle: 0, roundness: 1, size: 6 };
    const m = new BrushMachine({
      tolerance: 1,
      minSampleDistance: 0,
      smooth: false,
      nib: round,
      pressure: false,
    });
    m.handle({ type: "down", point: [0, 0], pressure: 0.9 });
    m.handle({ type: "move", point: [100, 0], pressure: 0.1 });
    m.handle({ type: "move", point: [100, 100], pressure: 0.7 });
    const snap = m.handle({ type: "up", point: [100, 100] });
    const c = snap.commit!;
    for (const w of c.widths) expect(w).toBeCloseTo(6);
  });

  it("a close-on-lift commit stays 1:1 (closed contour tangents wrap)", () => {
    const m = new BrushMachine({
      tolerance: 1,
      minSampleDistance: 0,
      smooth: false,
      closeTolerance: 5,
      nib: NIB,
    });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [100, 0] });
    m.handle({ type: "move", point: [100, 100] });
    m.handle({ type: "move", point: [0, 100] });
    const snap = m.handle({ type: "up", point: [2, 2] });
    const c = snap.commit!;
    expect(c.open).toBe(false);
    expect(c.widths).toHaveLength(c.anchors.length);
    for (const w of c.widths) expect(w).toBeGreaterThan(0);
  });
});
