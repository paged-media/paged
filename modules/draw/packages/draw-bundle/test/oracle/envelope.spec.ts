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

// Draw ADR 367 — Envelope Distort ▸ Make with Top Object against
// Illustrator 30.1 (`scripts/illustrator/probes/envelope.jsx`): the front
// shape's patch (`outlinePatch`), each content's part of it over the union
// box (`restrictPatch`), and the engine's map (`envelopePoint`), against
// what Illustrator's Make Envelope + Expand Envelope left. Compared: every
// content corner lands on Illustrator's anchor (Illustrator keeps the
// content's four anchors and bends the edges between them), the bounds and
// the area of the bent outline. [plugin-draw.envelope-distort]

import { describe, expect, it } from "bun:test";

import {
  envelopePoint,
  outlinePatch,
  restrictPatch,
  type AnchorTriple,
  type Vec2 as GVec2,
} from "@paged-media/draw-geometry";

import {
  loadOracle,
  signedArea,
  pathBounds,
  type OraclePath,
  type Vec2,
} from "./oracle";

const FIXTURE = loadOracle<{ contents: number }>("envelope");

/** The content `path` bent by the envelope of `top` over `union`, as a
 *  densely sampled closed outline. */
function bent(
  path: OraclePath,
  top: OraclePath,
  union: [number, number, number, number],
): { corners: Vec2[]; outline: OraclePath } {
  const patch = outlinePatch(top.anchors as unknown as AnchorTriple[])!;
  const [x0, y0, x1, y1] = union;
  const b = pathBounds(path);
  const part = restrictPatch(
    patch,
    (b[0] - x0) / (x1 - x0),
    (b[2] - x0) / (x1 - x0),
    (b[1] - y0) / (y1 - y0),
    (b[3] - y0) / (y1 - y0),
  );
  const map = (p: GVec2): Vec2 => {
    const u = (p[0] - b[0]) / (b[2] - b[0]);
    const v = (p[1] - b[1]) / (b[3] - b[1]);
    const q = envelopePoint(part, 1, 1, u, v);
    return [q[0], q[1]];
  };
  const pts: Vec2[] = [];
  const n = path.anchors.length;
  for (let k = 0; k < n; k++) {
    const a = path.anchors[k]!.anchor;
    const c = path.anchors[(k + 1) % n]!.anchor;
    for (let s = 0; s < 64; s++) {
      const t = s / 64;
      pts.push(map([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t]));
    }
  }
  return {
    corners: path.anchors.map((a) => map(a.anchor as GVec2)),
    outline: {
      closed: true,
      anchors: pts.map((p) => ({ anchor: p, left: p, right: p })),
    },
  };
}

describe("Envelope distort ▸ Make with top object vs Illustrator 30.1 [plugin-draw.envelope-distort]", () => {
  for (const c of FIXTURE.cases) {
    it(c.id, () => {
      const inputs = c.input.paths;
      const top = inputs[inputs.length - 1]!;
      const contents = inputs.slice(0, -1);
      const boxes = contents.map(pathBounds);
      const union: [number, number, number, number] = [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3])),
      ];
      const measured = c.measured!.paths;
      expect(measured).toHaveLength(contents.length);
      for (const content of contents) {
        const ours = bent(content, top, union);
        // Illustrator's path for this content: the one whose anchors are
        // nearest our corners.
        const theirs = measured
          .map((p) => ({
            p,
            d: Math.max(
              ...ours.corners.map((q) =>
                Math.min(
                  ...p.anchors.map((a) =>
                    Math.hypot(a.anchor[0] - q[0], a.anchor[1] - q[1]),
                  ),
                ),
              ),
            ),
          }))
          .sort((a, b) => a.d - b.d)[0]!;
        // Every corner on Illustrator's anchor.
        expect(theirs.d, `${c.id}: corner distance`).toBeLessThan(
          CORNER_TOL[c.id] ?? 0.05,
        );
        const ob = pathBounds(ours.outline);
        const tb = pathBounds(theirs.p);
        for (let k = 0; k < 4; k++)
          expect(
            Math.abs(ob[k]! - tb[k]!),
            `${c.id}: bounds[${k}]`,
          ).toBeLessThan(BOUNDS_TOL[c.id] ?? 0.5);
        const oa = Math.abs(signedArea(ours.outline));
        const ta = theirs.p.area ?? Math.abs(signedArea(theirs.p));
        expect(Math.abs(oa - ta) / ta, `${c.id}: area`).toBeLessThan(
          AREA_TOL[c.id] ?? 0.005,
        );
      }
    });
  }
});

// Tolerances per case, with what was measured (see the ADR's table).
// CONVENTION (both numbers recorded): Illustrator expands an envelope by
// refitting each content edge with ONE cubic between the content's own
// anchors, at its Envelope Options fidelity, so its outline falls short
// of a curved envelope side; the engine bends every point through the
// patch and follows the side. top-circle: Illustrator's box 100.87 …
// 299.13, ours 100.00 … 300.00 (the circle itself). top-wave: Illustrator's
// top 90.33, ours on the cubic's own extreme.
const CORNER_TOL: Record<string, number> = {};
const BOUNDS_TOL: Record<string, number> = { "top-circle": 0.9, "top-wave": 2 };
const AREA_TOL: Record<string, number> = {
  "top-circle": 0.02,
  "top-wave": 0.01,
};
