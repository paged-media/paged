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

// Extensions ADR 339 / editor ADR 295 — the transform box's geometry:
// the homography solve, the handle layout and hit order, and every drag
// arm with its modifiers (Shift / Alt / Cmd, the four modes).

import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import {
  applyMatrix3,
  dragBox,
  hitTestBox,
  homographyFromQuads,
  invert3,
  isAffine3,
  isUsableQuad,
  multiply3,
  operationFor,
  quadMap,
  rectQuad,
  type BoxDragStart,
  type BoxModifiers,
  type BoxPoint,
  type BoxQuad,
} from "../src";

const NONE: BoxModifiers = { shift: false, alt: false, cmd: false };
const box = rectQuad(100, 100, 300, 200); // 200 × 100

const close = (a: BoxPoint, b: BoxPoint) => {
  expect(a[0]).toBeCloseTo(b[0], 5);
  expect(a[1]).toBeCloseTo(b[1], 5);
};
const quadClose = (a: BoxQuad, b: BoxQuad) =>
  a.forEach((p, i) => close(p, b[i]!));

function start(
  hitAt: BoxPoint,
  m: BoxModifiers = NONE,
  mode: Parameters<typeof operationFor>[1] = "freeTransform",
): BoxDragStart {
  const hit = hitTestBox(box, hitAt, 1);
  const op = operationFor(hit, mode, m);
  if (!op) throw new Error(`no operation at ${hitAt}`);
  return { quad: box, start: hitAt, hit, op };
}

describe("homography [editor-tools.free-transform]", () => {
  it("maps each source corner onto its target corner", () => {
    const dst: BoxQuad = [
      [110, 90],
      [320, 120],
      [280, 230],
      [90, 210],
    ];
    const h = homographyFromQuads(box, dst)!;
    box.forEach((p, i) => close(applyMatrix3(h, p), dst[i]!));
    expect(isAffine3(h)).toBe(false);
  });

  it("is affine between two parallelograms and inverts to the identity", () => {
    const dst: BoxQuad = [
      [0, 0],
      [100, 20],
      [120, 70],
      [20, 50],
    ];
    const h = homographyFromQuads(box, dst)!;
    expect(isAffine3(h)).toBe(true);
    const id = multiply3(invert3(h)!, h);
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) =>
      expect(id[i]).toBeCloseTo(v, 9),
    );
  });

  it("refuses a degenerate quad", () => {
    const flat: BoxQuad = [
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
    ];
    expect(homographyFromQuads(box, flat)).toBeNull();
  });

  it("property: any convex target is hit exactly at its corners", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -30, max: 30, noNaN: true }), {
          minLength: 8,
          maxLength: 8,
        }),
        (j) => {
          const dst = box.map((p, i) => [
            p[0] + j[i * 2]!,
            p[1] + j[i * 2 + 1]!,
          ]) as BoxQuad;
          if (!isUsableQuad(dst)) return;
          const h = homographyFromQuads(box, dst)!;
          box.forEach((p, i) => {
            const q = applyMatrix3(h, p);
            expect(Math.abs(q[0] - dst[i]![0])).toBeLessThan(1e-6);
            expect(Math.abs(q[1] - dst[i]![1])).toBeLessThan(1e-6);
          });
        },
      ),
    );
  });
});

describe("hit-testing [editor-tools.free-transform]", () => {
  it("handles, then the rotate zone outside a corner, then inside / outside", () => {
    expect(hitTestBox(box, [100, 100], 1)).toEqual({
      kind: "handle",
      handle: "northWest",
    });
    expect(hitTestBox(box, [200, 102], 1)).toEqual({
      kind: "handle",
      handle: "north",
    });
    expect(hitTestBox(box, [303, 150], 1)).toEqual({
      kind: "handle",
      handle: "east",
    });
    expect(hitTestBox(box, [85, 85], 1)).toEqual({
      kind: "rotate",
      corner: "northWest",
    });
    expect(hitTestBox(box, [150, 150], 1)).toEqual({ kind: "inside" });
    expect(hitTestBox(box, [500, 500], 1)).toEqual({ kind: "outside" });
  });

  it("the reference point wins over everything under it", () => {
    expect(hitTestBox(box, [201, 151], 1, [200, 150])).toEqual({
      kind: "reference",
    });
  });

  it("metrics are screen px: at 4× zoom the handle shrinks to 1.5 pt", () => {
    expect(hitTestBox(box, [103, 103], 0.25).kind).toBe("inside");
    expect(hitTestBox(box, [101, 101], 0.25).kind).toBe("handle");
  });

  it("operations per mode and modifiers", () => {
    const corner = hitTestBox(box, [300, 200], 1);
    const side = hitTestBox(box, [300, 150], 1);
    expect(operationFor(corner, "freeTransform", NONE)).toBe("scale");
    expect(operationFor(corner, "freeTransform", { ...NONE, cmd: true })).toBe(
      "distort",
    );
    expect(
      operationFor(corner, "freeTransform", {
        shift: true,
        alt: true,
        cmd: true,
      }),
    ).toBe("perspective");
    expect(operationFor(side, "freeTransform", { ...NONE, cmd: true })).toBe(
      "shear",
    );
    expect(operationFor(corner, "freeDistort", NONE)).toBe("distort");
    expect(operationFor(corner, "perspective", NONE)).toBe("perspective");
    expect(operationFor(side, "perspective", NONE)).toBe("scale");
    expect(operationFor({ kind: "outside" }, "freeTransform", NONE)).toBeNull();
  });
});

describe("drag arms [editor-tools.free-transform]", () => {
  it("move follows the pointer; Shift keeps the dominant axis", () => {
    const r = dragBox(start([150, 150]), [170, 155], NONE);
    quadClose(r.quad, rectQuad(120, 105, 320, 205));
    const s = dragBox(start([150, 150]), [170, 155], { ...NONE, shift: true });
    quadClose(s.quad, rectQuad(120, 100, 320, 200));
  });

  it("a corner scales from the opposite corner; Alt from the centre", () => {
    const r = dragBox(start([300, 200]), [400, 250], NONE);
    quadClose(r.quad, rectQuad(100, 100, 400, 250));
    expect(r.readout.sx).toBeCloseTo(1.5);
    const a = dragBox(start([300, 200], { ...NONE, alt: true }), [400, 250], {
      ...NONE,
      alt: true,
    });
    quadClose(a.quad, rectQuad(0, 50, 400, 250));
  });

  it("Shift scales a corner proportionally (the dominant factor)", () => {
    const r = dragBox(start([300, 200]), [500, 210], { ...NONE, shift: true });
    // sx = 2 dominates sy = 1.1 → both 2.
    quadClose(r.quad, rectQuad(100, 100, 500, 300));
  });

  it("a side scales one axis; Shift (or Constrain mode) both", () => {
    const r = dragBox(start([300, 150]), [400, 170], NONE);
    quadClose(r.quad, rectQuad(100, 100, 400, 200));
    const c = dragBox(
      start([300, 150], NONE, "constrain"),
      [400, 170],
      NONE,
      "constrain",
    );
    // sx = 1.5 about the west side; sy follows about the box's mid line.
    quadClose(c.quad, rectQuad(100, 75, 400, 225));
  });

  it("a turned box scales along its own axes", () => {
    const c = Math.SQRT1_2;
    const diamond: BoxQuad = [
      [0, 0],
      [100 * c, 100 * c],
      [0, 200 * c],
      [-100 * c, 100 * c],
    ];
    const hit = hitTestBox(diamond, diamond[1], 1);
    const r = dragBox(
      { quad: diamond, start: diamond[1], hit, op: "scale" },
      [200 * c, 200 * c],
      NONE,
    );
    // North-east handle pulled outward along the box's u axis doubles u;
    // the box stays a rectangle at 45°.
    close(r.quad[0], [0, 0]);
    close(r.quad[1], [200 * c, 200 * c]);
    expect(isAffine3(r.matrix!)).toBe(true);
  });

  it("rotate turns about the reference point; Shift snaps to 15°", () => {
    const s = start([312, 212]);
    expect(s.op).toBe("rotate");
    const quarter = dragBox({ ...s, start: [300, 150] }, [200, 250], NONE);
    // 90° about the centre (200, 150).
    close(quarter.quad[0], [250, 50]);
    expect(quarter.readout.angle).toBeCloseTo(90);
    const snapped = dragBox({ ...s, start: [300, 150] }, [300, 160], {
      ...NONE,
      shift: true,
    });
    expect(Math.abs(snapped.readout.angle!)).toBeCloseTo(0);
    const about = dragBox(
      { ...s, start: [300, 150], reference: [100, 100] },
      [100, 300],
      NONE,
    );
    close(about.quad[0], [100, 100]);
  });

  it("Cmd on a side shears; the opposite side holds", () => {
    const top = dragBox(
      start([200, 100], { ...NONE, cmd: true }),
      [250, 100],
      NONE,
    );
    // North slanted by +50 along u; the south side stays.
    close(top.quad[0], [150, 100]);
    close(top.quad[1], [350, 100]);
    close(top.quad[2], [300, 200]);
    close(top.quad[3], [100, 200]);
    const right = dragBox(
      start([300, 150], { ...NONE, cmd: true }),
      [300, 180],
      NONE,
    );
    close(right.quad[1], [300, 130]);
    close(right.quad[2], [300, 230]);
    close(right.quad[0], [100, 100]);
    expect(right.readout.shear).toBeCloseTo(0.3);
  });

  it("Shift snaps a shear to 15° slants", () => {
    const r = dragBox(start([200, 100], { ...NONE, cmd: true }), [230, 100], {
      ...NONE,
      shift: true,
    });
    // 30 over a lever of 100 is 16.7° → 15°: the top moves tan 15° · 100.
    expect(r.quad[0][0] - 100).toBeCloseTo(Math.tan(Math.PI / 12) * 100, 3);
  });

  it("Cmd on a corner distorts that corner alone", () => {
    const r = dragBox(
      start([300, 200], { ...NONE, cmd: true }),
      [330, 240],
      NONE,
    );
    close(r.quad[2], [330, 240]);
    close(r.quad[0], [100, 100]);
    close(r.quad[1], [300, 100]);
    close(r.quad[3], [100, 200]);
    expect(isAffine3(r.matrix!)).toBe(false);
  });

  it("perspective mirrors the partner corner on the dominant edge", () => {
    const op = { shift: true, alt: true, cmd: true };
    const h = dragBox(start([300, 100], op), [340, 105], op);
    close(h.quad[1], [340, 100]);
    close(h.quad[0], [60, 100]);
    close(h.quad[2], [300, 200]);
    const v = dragBox(start([300, 100], op), [302, 80], op);
    close(v.quad[1], [300, 80]);
    close(v.quad[2], [300, 220]);
    expect(isAffine3(v.matrix!)).toBe(false);
  });

  it("the matrix maps the start box onto the result", () => {
    const r = dragBox(
      start([300, 200], { ...NONE, cmd: true }),
      [350, 260],
      NONE,
    );
    box.forEach((p, i) => close(applyMatrix3(r.matrix!, p), r.quad[i]!));
  });

  it("a fold is detectable (the caller keeps the last good box)", () => {
    const r = dragBox(
      start([300, 200], { ...NONE, cmd: true }),
      [50, 50],
      NONE,
    );
    expect(isUsableQuad(r.quad)).toBe(false);
  });
});

describe("anchor maps for vector distort [editor-tools.free-transform]", () => {
  const target: BoxQuad = [
    [100, 100],
    [300, 100],
    [350, 250],
    [80, 200],
  ];

  it("bilinear (Free Distort) sends corners and edge midpoints along the edges", () => {
    const f = quadMap(box, target, "bilinear")!;
    box.forEach((p, i) => close(f(p), target[i]!));
    // The south edge's midpoint is the midpoint of the target's south edge.
    close(f([200, 200]), [215, 225]);
    // The box centre lands on the mean of the four corners.
    close(f([200, 150]), [207.5, 162.5]);
  });

  it("projective (Perspective) keeps straight lines straight", () => {
    const f = quadMap(box, target, "projective")!;
    box.forEach((p, i) => close(f(p), target[i]!));
    const a = f([100, 150]);
    const b = f([200, 150]);
    const c = f([300, 150]);
    // Collinear: the cross product of (b − a) and (c − a) is zero.
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    expect(Math.abs(cross)).toBeLessThan(1e-6);
  });
});
