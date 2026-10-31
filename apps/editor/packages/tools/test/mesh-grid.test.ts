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

// The Mesh tool's grid maths: a point inserted into a grid leaves the
// surface where it was (sampled before and after), its colours blend
// their neighbours, a node moves with its handles, a handle moves alone,
// and removing the lines of an inserted point gives the grid back.

import { describe, expect, it } from "bun:test";

import {
  boxGrid,
  evalPatch,
  gridEdges,
  insertMeshPoint,
  isValidGrid,
  locate,
  moveNode,
  nodeIndex,
  patchNet,
  recolorNodes,
  removeNodeLines,
  setHandle,
  splitCubic,
  type Cubic,
} from "../src/mesh/grid";
import {
  applyAffine,
  invertAffine,
  lerpColor,
  type MeshGridSpec,
  type Vec2,
} from "../src/mesh/types";

const RED = { space: "RGB" as const, value: [255, 0, 0] };
const BLUE = { space: "RGB" as const, value: [0, 0, 255] };

/** A 1×1 grid with curved edges and two colours, so the checks are not
 *  passing on a flat bilinear square by accident. */
function curvedGrid(): MeshGridSpec {
  const g = boxGrid([0, 0, 100, 200], RED);
  g.nodes[0]!.handles[1] = [60, -30];
  g.nodes[1]!.handles[0] = [150, 20];
  g.nodes[1]!.handles[3] = [230, 40];
  g.nodes[3]!.handles[2] = [180, 70];
  g.nodes[2]!.handles[1] = [70, 130];
  g.nodes[3]!.color = { ...BLUE };
  g.nodes[1]!.color = { ...BLUE };
  return g;
}

/** The grid's surface point at global parameters (s, t) over the whole
 *  grid, given the patch boundaries in parameter space. */
function surfaceAt(
  g: MeshGridSpec,
  us: number[],
  vs: number[],
  s: number,
  t: number,
): Vec2 {
  let c = us.findIndex((x, i) => s >= x && s <= us[i + 1]!);
  let r = vs.findIndex((y, i) => t >= y && t <= vs[i + 1]!);
  c = Math.max(0, Math.min(g.cols - 1, c));
  r = Math.max(0, Math.min(g.rows - 1, r));
  const u = (s - us[c]!) / (us[c + 1]! - us[c]!);
  const v = (t - vs[r]!) / (vs[r + 1]! - vs[r]!);
  return evalPatch(g, r, c, u, v);
}

const close = (a: Vec2, b: Vec2, eps = 1e-6) =>
  expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(eps);

describe("mesh grid maths", () => {
  it("a box grid is the frame's box, one patch, valid", () => {
    const g = boxGrid([10, 20, 110, 220], RED);
    expect(isValidGrid(g)).toBe(true);
    close(evalPatch(g, 0, 0, 0, 0), [20, 10]);
    close(evalPatch(g, 0, 0, 1, 1), [220, 110]);
    close(evalPatch(g, 0, 0, 0.5, 0.5), [120, 60]);
    // The Coons interior of straight edges is the bilinear net.
    close(patchNet(g, 0, 0)[1]![1]!, [20 + 200 / 3, 10 + 100 / 3]);
  });

  it("locate finds the patch and parameters of a surface point", () => {
    const g = curvedGrid();
    const p = evalPatch(g, 0, 0, 0.3, 0.7);
    const at = locate(g, p)!;
    expect(at.r).toBe(0);
    expect(at.c).toBe(0);
    expect(at.u).toBeCloseTo(0.3, 6);
    expect(at.v).toBeCloseTo(0.7, 6);
    expect(locate(g, [-500, -500])).toBeNull();
  });

  it("inserting a point keeps the surface and makes a 2×2 grid with a node at the click", () => {
    const g = curvedGrid();
    const click = evalPatch(g, 0, 0, 0.4, 0.6);
    const at = locate(g, click)!;
    const res = insertMeshPoint(g, at)!;
    expect(res.grid.rows).toBe(2);
    expect(res.grid.cols).toBe(2);
    expect(isValidGrid(res.grid)).toBe(true);
    expect(res.grid.tensor).toEqual([]);
    expect(res.node).toBe(nodeIndex(res.grid, 1, 1));
    close(res.grid.nodes[res.node]!.point, click, 1e-6);
    // The surface, sampled across the whole grid, did not move.
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const s = j / 8;
        const t = i / 8;
        const before = evalPatch(g, 0, 0, s, t);
        const after = surfaceAt(res.grid, [0, at.u, 1], [0, at.v, 1], s, t);
        close(before, after, 1e-6);
      }
    }
  });

  it("a second insertion into the 2×2 grid keeps the surface too (3×3)", () => {
    const g = curvedGrid();
    const a = locate(g, evalPatch(g, 0, 0, 0.5, 0.5))!;
    const g2 = insertMeshPoint(g, a)!.grid;
    const p = evalPatch(g2, 1, 0, 0.25, 0.5);
    const b = locate(g2, p)!;
    expect([b.r, b.c]).toEqual([1, 0]);
    const g3 = insertMeshPoint(g2, b)!.grid;
    expect([g3.rows, g3.cols]).toEqual([3, 3]);
    // Global parameters of g2's lines: u 0, .5, 1; v 0, .5, 1. The new
    // column sits at .125 and the new row at .75 of the whole.
    for (let i = 0; i <= 6; i++) {
      for (let j = 0; j <= 6; j++) {
        const s = j / 6;
        const t = i / 6;
        close(
          surfaceAt(g2, [0, 0.5, 1], [0, 0.5, 1], s, t),
          surfaceAt(g3, [0, 0.125, 0.5, 1], [0, 0.5, 0.75, 1], s, t),
          1e-6,
        );
      }
    }
  });

  it("new nodes blend their neighbours' colours; a cross-space pair takes the nearer", () => {
    const g = boxGrid([0, 0, 100, 100], RED);
    g.nodes[1]!.color = { ...BLUE };
    g.nodes[3]!.color = { ...BLUE };
    const res = insertMeshPoint(g, { r: 0, c: 0, u: 0.25, v: 0.5 })!;
    expect(res.grid.nodes[1]!.color.value).toEqual([191.25, 0, 63.75]);
    expect(
      lerpColor(RED, { space: "CMYK", value: [0, 0, 0, 100] }, 0.3),
    ).toEqual(RED);
    expect(
      lerpColor(RED, { space: "RGB", value: [0, 0, 0], opacityPct: 50 }, 0.5),
    ).toEqual({ space: "RGB", value: [127.5, 0, 0], opacityPct: 75 });
  });

  it("a click on an existing line adds a point on that line only", () => {
    const g = boxGrid([0, 0, 100, 100], RED);
    const res = insertMeshPoint(g, { r: 0, c: 0, u: 0.5, v: 0.001 })!;
    expect([res.grid.rows, res.grid.cols]).toEqual([1, 2]);
    expect(res.node).toBe(nodeIndex(res.grid, 0, 1));
    expect(insertMeshPoint(g, { r: 0, c: 0, u: 0, v: 1 })).toBeNull();
  });

  it("moving a node carries its handles; a handle moves alone; outside handles stay on the point", () => {
    const g = insertMeshPoint(boxGrid([0, 0, 90, 90], RED), {
      r: 0,
      c: 0,
      u: 0.5,
      v: 0.5,
    })!.grid;
    const centre = nodeIndex(g, 1, 1);
    const moved = moveNode(g, centre, [5, -3]);
    const before = g.nodes[centre]!;
    const after = moved.nodes[centre]!;
    close(after.point, [before.point[0] + 5, before.point[1] - 3]);
    after.handles.forEach((h, k) =>
      close(h, [before.handles[k]![0] + 5, before.handles[k]![1] - 3]),
    );
    // Everything else is untouched, and the input grid too.
    expect(moved.nodes[0]).toEqual(g.nodes[0]!);
    expect(g.nodes[centre]).toEqual(before);

    const h = setHandle(g, centre, 1, [70, 50]);
    expect(h.nodes[centre]!.handles[1]).toEqual([70, 50]);
    expect(h.nodes[centre]!.point).toEqual(before.point);
    // The top-left corner has no edge to its left: its LEFT handle stays.
    const dead = setHandle(g, 0, 0, [-20, 0]);
    expect(dead.nodes[0]!.handles[0]).toEqual(g.nodes[0]!.handles[0]);
  });

  it("recolouring touches only the chosen nodes", () => {
    const g = boxGrid([0, 0, 10, 10], RED);
    const r = recolorNodes(g, [2], BLUE);
    expect(r.nodes[2]!.color).toEqual(BLUE);
    expect(r.nodes[0]!.color).toEqual(RED);
    expect(g.nodes[2]!.color).toEqual(RED);
  });

  it("removing an inserted point's lines gives back the grid it was inserted into", () => {
    const g = curvedGrid();
    const res = insertMeshPoint(g, locate(g, evalPatch(g, 0, 0, 0.3, 0.6))!)!;
    const back = removeNodeLines(res.grid, res.node)!;
    expect([back.rows, back.cols]).toEqual([1, 1]);
    back.nodes.forEach((n, i) => {
      close(n.point, g.nodes[i]!.point, 1e-6);
      n.handles.forEach((h, k) => close(h, g.nodes[i]!.handles[k]!, 1e-3));
    });
    // A corner has no line to remove.
    expect(removeNodeLines(g, 0)).toBeNull();
  });

  it("the edges list every row and column line; de Casteljau halves meet", () => {
    const g = insertMeshPoint(boxGrid([0, 0, 90, 90], RED), {
      r: 0,
      c: 0,
      u: 0.5,
      v: 0.5,
    })!.grid;
    // 3 rows × 2 + 3 columns × 2.
    expect(gridEdges(g)).toHaveLength(12);
    const c: Cubic = [
      [0, 0],
      [10, 30],
      [40, 30],
      [50, 0],
    ];
    const [L, R] = splitCubic(c, 0.3);
    expect(L[3]).toEqual(R[0]);
  });

  it("inner ↔ page mapping round-trips through the item transform", () => {
    const m = [0, 1, -1, 0, 300, 40] as const;
    const inv = invertAffine(m)!;
    close(applyAffine(inv, applyAffine(m, [12, 34])), [12, 34]);
    expect(applyAffine(null, [1, 2])).toEqual([1, 2]);
  });
});
