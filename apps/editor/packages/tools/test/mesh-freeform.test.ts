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

// The freeform edits: add, move, recolour and remove points, and draw
// lines through them.

import { describe, expect, it } from "bun:test";

import {
  addFreeformPoint,
  catmullRom,
  emptyFreeform,
  extendLine,
  freeformColorFor,
  moveFreeformPoint,
  recolorFreeformPoints,
  removeFreeformPoint,
} from "../src/mesh/freeform";

const GREY = { space: "Gray" as const, value: [40] };

describe("freeform gradient edits", () => {
  it("adds a point with its colour and spread, leaving the input alone", () => {
    const empty = emptyFreeform();
    const { spec, index } = addFreeformPoint(empty, [10, 20], GREY, 35);
    expect(index).toBe(0);
    expect(spec.points).toEqual([
      { point: [10, 20], color: GREY, spreadPct: 35 },
    ]);
    expect(empty.points).toEqual([]);
    // A zero spread is absent, as the engine stores it.
    const b = addFreeformPoint(spec, [1, 1], GREY, 0);
    expect(b.spec.points[1]).toEqual({ point: [1, 1], color: GREY });
  });

  it("moves and recolours points", () => {
    let s = addFreeformPoint(emptyFreeform(), [0, 0], GREY, 0).spec;
    s = addFreeformPoint(s, [5, 5], GREY, 0).spec;
    expect(moveFreeformPoint(s, 1, [7, 8]).points[1]!.point).toEqual([7, 8]);
    const red = { space: "RGB" as const, value: [255, 0, 0] };
    const r = recolorFreeformPoints(s, [0], red);
    expect(r.points[0]!.color).toEqual(red);
    expect(r.points[1]!.color).toEqual(GREY);
  });

  it("line mode: the first click is remembered, the second opens the line, later ones extend it", () => {
    let s = emptyFreeform();
    for (const p of [
      [0, 0],
      [10, 0],
      [20, 5],
    ] as const)
      s = addFreeformPoint(s, [p[0], p[1]], GREY, 0).spec;
    let st = extendLine(s, null, null, 0);
    expect(st.spec.lines).toEqual([]);
    expect(st.pending).toBe(0);
    st = extendLine(st.spec, st.line, st.pending, 1);
    expect(st.spec.lines).toEqual([[0, 1]]);
    expect(st.line).toBe(0);
    st = extendLine(st.spec, st.line, st.pending, 2);
    expect(st.spec.lines).toEqual([[0, 1, 2]]);
    // The same point twice in a row is not a segment.
    expect(extendLine(st.spec, st.line, null, 2).spec).toBe(st.spec);
  });

  it("removing a point drops it from its lines, renumbers, and drops a line left with one point", () => {
    let s = emptyFreeform();
    for (let i = 0; i < 4; i++) s = addFreeformPoint(s, [i, i], GREY, 0).spec;
    s = {
      ...s,
      lines: [
        [0, 1],
        [1, 2, 3],
      ],
    };
    const r = removeFreeformPoint(s, 1);
    expect(r.points).toHaveLength(3);
    expect(r.lines).toEqual([[1, 2]]);
  });

  it("the first point takes the fill, later ones distinct colours", () => {
    expect(freeformColorFor(0, GREY)).toEqual(GREY);
    expect(freeformColorFor(1, GREY)).not.toEqual(freeformColorFor(2, GREY));
  });

  it("the Catmull-Rom polyline passes through every point", () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [10, 10],
      [20, 0],
    ];
    const line = catmullRom(pts, 4);
    expect(line[0]).toEqual([0, 0]);
    expect(line[4]).toEqual([10, 10]);
    expect(line.at(-1)).toEqual([20, 0]);
  });
});
