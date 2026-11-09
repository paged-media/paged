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

// Draw ADR 367 — the envelope mesh geometry: the engine's map, the net
// edits of the Envelope Mesh tool, Make with Top Object's patch.

import { describe, expect, it } from "bun:test";

import {
  coonsPatch,
  envelopePoint,
  fitCubicEnds,
  flatNet,
  invertEnvelope,
  isNet,
  moveNetPoint,
  netIndex,
  netLength,
  outlinePatch,
  restrictPatch,
  splitColumn,
  splitRow,
  type AnchorTriple,
  type Vec2,
} from "../src";

const near = (a: Vec2, b: Vec2, eps = 1e-9) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]) < eps;

const corner = (x: number, y: number): AnchorTriple => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

describe("envelope mesh (draw ADR 367)", () => {
  it("the flat net maps every point onto itself", () => {
    for (const [r, c] of [
      [1, 1],
      [2, 3],
      [4, 4],
    ] as const) {
      const net = flatNet(r, c);
      expect(net).toHaveLength(netLength(r, c));
      expect(isNet(net, r, c)).toBe(true);
      for (const [u, v] of [
        [0, 0],
        [0.3, 0.7],
        [1, 1],
        [0.99, 0.01],
      ] as const)
        expect(near(envelopePoint(net, r, c, u, v), [u, v], 1e-12)).toBe(true);
    }
  });

  it("a node drag carries its handles; a handle drag moves only itself", () => {
    // The centre node of a 2 × 2 net: row 3, column 3 of 7 × 7.
    const net = flatNet(2, 2);
    const centre = netIndex(2, 3, 3);
    const moved = moveNetPoint(net, 2, 2, centre, [0.6, 0.4]);
    expect(moved[centre]).toEqual([0.6, 0.4]);
    for (const h of [
      netIndex(2, 2, 3),
      netIndex(2, 4, 3),
      netIndex(2, 3, 2),
      netIndex(2, 3, 4),
    ]) {
      expect(near(moved[h]!, [net[h]![0] + 0.1, net[h]![1] - 0.1])).toBe(true);
    }
    expect(near(envelopePoint(moved, 2, 2, 0.5, 0.5), [0.6, 0.4], 1e-12)).toBe(
      true,
    );
    const handle = netIndex(2, 0, 1);
    const one = moveNetPoint(net, 2, 2, handle, [0.2, -0.2]);
    expect(one.filter((p, i) => !near(p, net[i]!))).toHaveLength(1);
  });

  it("splitting a column or a row keeps the surface", () => {
    let net = flatNet(1, 1);
    net = moveNetPoint(net, 1, 1, netIndex(1, 0, 1), [0.33, -0.3]);
    net = moveNetPoint(net, 1, 1, netIndex(1, 3, 3), [1.2, 1.1]);
    const wide = splitColumn(net, 1, 1, 0, 0.4);
    const tall = splitRow(wide, 1, 2, 0, 0.7);
    expect(isNet(wide, 1, 2)).toBe(true);
    expect(isNet(tall, 2, 2)).toBe(true);
    // The same point of the surface: (u, v) of the one cell is, after the
    // column split at 0.4, at u' = u·0.4/… — compare along the mesh.
    for (const [u, v] of [
      [0.2, 0.5],
      [0.4, 0.35],
      [0.9, 0.95],
    ] as const) {
      const want = envelopePoint(net, 1, 1, u, v);
      const uw = u < 0.4 ? (u / 0.4) * 0.5 : 0.5 + ((u - 0.4) / 0.6) * 0.5;
      expect(near(envelopePoint(wide, 1, 2, uw, v), want, 1e-9)).toBe(true);
      const vt = v < 0.7 ? (v / 0.7) * 0.5 : 0.5 + ((v - 0.7) / 0.3) * 0.5;
      expect(near(envelopePoint(tall, 2, 2, uw, vt), want, 1e-9)).toBe(true);
    }
  });

  it("a restricted patch draws the same surface over its part", () => {
    let net = flatNet(1, 1);
    net = moveNetPoint(net, 1, 1, netIndex(1, 1, 1), [0.5, 0.1]);
    net = moveNetPoint(net, 1, 1, netIndex(1, 0, 3), [1.1, -0.2]);
    const part = restrictPatch(net, 0.25, 0.75, 0.5, 1);
    for (const [s, t] of [
      [0, 0],
      [0.5, 0.5],
      [1, 1],
      [0.2, 0.9],
    ] as const)
      expect(
        near(
          envelopePoint(part, 1, 1, s, t),
          envelopePoint(net, 1, 1, 0.25 + 0.5 * s, 0.5 + 0.5 * t),
          1e-9,
        ),
      ).toBe(true);
  });

  it("a cubic is fitted back from its own samples", () => {
    const c: [Vec2, Vec2, Vec2, Vec2] = [
      [0, 0],
      [10, 30],
      [40, 30],
      [50, 0],
    ];
    const pts: Vec2[] = [];
    for (let k = 0; k <= 40; k++) {
      const t = k / 40;
      const s = 1 - t;
      pts.push([
        s ** 3 * c[0][0] +
          3 * s * s * t * c[1][0] +
          3 * s * t * t * c[2][0] +
          t ** 3 * c[3][0],
        s ** 3 * c[0][1] +
          3 * s * s * t * c[1][1] +
          3 * s * t * t * c[2][1] +
          t ** 3 * c[3][1],
      ]);
    }
    const fit = fitCubicEnds(pts);
    // Reparametrised, the fit finds the curve's own control points.
    for (let k = 0; k < 4; k++) expect(near(fit[k]!, c[k]!, 0.1)).toBe(true);
  });

  it("a rectangle's patch is the rectangle; a Coons patch keeps its edges", () => {
    const rect = [
      corner(10, 20),
      corner(110, 20),
      corner(110, 80),
      corner(10, 80),
    ];
    const p = outlinePatch(rect)!;
    expect(near(p[0]!, [10, 20], 1e-6)).toBe(true);
    expect(near(p[3]!, [110, 20], 1e-6)).toBe(true);
    expect(near(p[15]!, [110, 80], 1e-6)).toBe(true);
    expect(near(p[12]!, [10, 80], 1e-6)).toBe(true);
    // The middle of the patch is the middle of the rectangle.
    expect(near(envelopePoint(p, 1, 1, 0.5, 0.5), [60, 50], 1e-3)).toBe(true);
    // Counter-clockwise input gives the same patch.
    const back = outlinePatch([...rect].reverse())!;
    for (let k = 0; k < 16; k++) expect(near(back[k]!, p[k]!, 1e-6)).toBe(true);
    const top: [Vec2, Vec2, Vec2, Vec2] = [
      [0, 0],
      [1, -1],
      [2, -1],
      [3, 0],
    ];
    const bottom: [Vec2, Vec2, Vec2, Vec2] = [
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ];
    const left: [Vec2, Vec2, Vec2, Vec2] = [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ];
    const right: [Vec2, Vec2, Vec2, Vec2] = [
      [3, 0],
      [3, 1],
      [3, 2],
      [3, 3],
    ];
    const q = coonsPatch(top, right, bottom, left);
    for (let s = 0; s <= 4; s++)
      expect(
        near(envelopePoint(q, 1, 1, s / 4, 1), [(3 * s) / 4, 3], 1e-9),
      ).toBe(true);
  });

  it("a trapezoid's corners are its own anchors; a circle's are on it", () => {
    const trap = [
      corner(100, 100),
      corner(300, 100),
      corner(260, 300),
      corner(140, 300),
    ];
    const p = outlinePatch(trap)!;
    expect([p[0], p[3], p[15], p[12]]).toEqual([
      [100, 100],
      [300, 100],
      [260, 300],
      [140, 300],
    ]);
    const k = 0.5523 * 50;
    const circle: AnchorTriple[] = [
      { anchor: [100, 50], left: [100 - k, 50], right: [100 + k, 50] },
      { anchor: [150, 100], left: [150, 100 - k], right: [150, 100 + k] },
      { anchor: [100, 150], left: [100 + k, 150], right: [100 - k, 150] },
      { anchor: [50, 100], left: [50, 100 + k], right: [50, 100 - k] },
    ];
    const q = outlinePatch(circle)!;
    for (const c of [q[0]!, q[3]!, q[15]!, q[12]!])
      expect(Math.abs(Math.hypot(c[0] - 100, c[1] - 100) - 50)).toBeLessThan(
        0.5,
      );
    // The patch's middle is the circle's centre.
    expect(near(envelopePoint(q, 1, 1, 0.5, 0.5), [100, 100], 1)).toBe(true);
  });

  it("a click on the bent mesh finds its parameters", () => {
    let net = flatNet(2, 2);
    net = moveNetPoint(net, 2, 2, netIndex(2, 3, 3), [0.7, 0.3]);
    const target = envelopePoint(net, 2, 2, 0.31, 0.62);
    const got = invertEnvelope(net, 2, 2, target);
    expect(got.distance).toBeLessThan(1e-6);
    expect(Math.abs(got.u - 0.31)).toBeLessThan(1e-4);
    expect(Math.abs(got.v - 0.62)).toBeLessThan(1e-4);
  });
});
