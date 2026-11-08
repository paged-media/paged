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

// ORACLE — Illustrator's ART BRUSH against the engine's (engine ADR 1053,
// draw ADR 366). The recording (`tooling/oracle/illustrator/probes/brushes.jsx`)
// applies Illustrator 30.1's default art brush to a 1 pt stroke along
// straight lines 200, 303 and 420 pt long and expands it. What it says,
// and what is asserted:
//
//   1. The artwork is STRETCHED along the whole path: the same paths and
//      anchors every time, their x scaled with the length from the path's
//      start, their y untouched — the art brush's mapping (`x` to the
//      arc-length fraction, `y` across).
//   2. The engine, given the 200 pt result as its brush artwork (x along
//      the path 0..1, y across, the artwork's height as the band), draws
//      the 303 and 420 pt cases anchor for anchor to 0.01 pt.
//   3. Convention, not a defect: Illustrator's band at a 1 pt stroke is
//      the artwork's own height (3.24 pt here); the engine's is the stroke
//      weight × the brush's size, so the replay sets the size to match.
//      The default pattern and bristle brushes expand to raster images
//      and record no geometry.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { brushEntryFor, stackMutationFor } from "../../src/commands/brushes";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openOracleHost, pathsOf } from "./engine";
import { loadOracle, type OraclePath, type Vec2 } from "./oracle";
import { covers } from "@paged-media/test-kit";

interface Params {
  brushIndex: number;
  length: number;
  strokeWidth: number;
  brushName?: string;
}

const FIXTURE = loadOracle<Params>("brushes");
const TOL = 0.01;
const X0 = 50;
const Y = 300;

const anchorsOf = (paths: readonly OraclePath[]): Vec2[] =>
  paths
    .flatMap((p) => p.anchors.map((a) => a.anchor))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

const sameSet = (a: Vec2[], b: Vec2[]) =>
  a.length === b.length &&
  a.every(
    (p, i) =>
      Math.abs(p[0] - b[i]![0]) <= TOL && Math.abs(p[1] - b[i]![1]) <= TOL,
  );

let h: HeadlessHost;
beforeAll(async () => {
  h = await openOracleHost();
});
afterAll(() => h?.dispose());

describe("oracle — Illustrator's art brush vs the engine's (engine ADR 1053)", () => {
  it("records the art brush on three lengths", () => {
    expect(FIXTURE.produced_by.app).toContain("Illustrator");
    expect(FIXTURE.cases.map((c) => c.id)).toEqual([
      "art-200",
      "art-303",
      "art-420",
    ]);
  });

  it("stretches the artwork along the path, x with the length, y untouched", () => {
    const base = FIXTURE.cases[0]!;
    const from = anchorsOf(base.measured.paths);
    for (const c of FIXTURE.cases.slice(1)) {
      const k = c.parameters.length / base.parameters.length;
      const want = from
        .map(([x, y]) => [X0 + (x - X0) * k, y] as Vec2)
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      expect(sameSet(anchorsOf(c.measured.paths), want)).toBe(true);
    }
  });

  it("the engine draws Illustrator's stretch anchor for anchor [plugin-draw.brushes-width]", async () => {
    covers("command:media.paged.draw.command.applyBrush");
    const base = FIXTURE.cases[0]!;
    const ys = base.measured.paths.flatMap((p) =>
      p.anchors.flatMap((a) => [a.anchor[1], a.left[1], a.right[1]]),
    );
    const height = Math.max(...ys.map((y) => Math.abs(y - Y))) * 2;
    const L = base.parameters.length;
    // Illustrator's result as the brush's artwork, in the brush frame.
    const frame = (q: readonly number[]) =>
      [(q[0]! - X0) / L, (Y - q[1]!) / height] as const;
    const nodes: [number, number, number, number, number, number][] = [];
    const starts: number[] = [];
    const closed: boolean[] = [];
    for (const p of base.measured.paths) {
      starts.push(nodes.length);
      closed.push(p.closed);
      for (const a of p.anchors)
        nodes.push([...frame(a.anchor), ...frame(a.left), ...frame(a.right)]);
    }
    const entry = brushEntryFor({
      type: "art",
      options: { scalePct: height * 100 },
      art: { nodes, starts, closed },
    });
    for (const c of FIXTURE.cases.slice(1)) {
      const len = c.parameters.length;
      let steps = 0;
      const apply = async (m: Parameters<typeof h.host.document.mutate>[0]) => {
        const out = await h.host.document.mutate(m);
        if (!out.applied) throw new Error(JSON.stringify(out.error));
        steps++;
        return out;
      };
      try {
        const meta = await h.host.document.meta();
        await apply({
          op: "setDocumentDefaults",
          args: {
            fillColor: null,
            strokeColor: "Color/Black",
            strokeWeight: 1,
          },
        });
        const inserted = await apply({
          op: "insertPath",
          args: {
            pageId: F1_MULTI_SHAPE.pageId,
            anchors: [
              { anchor: [X0, Y], left: [X0, Y], right: [X0, Y] },
              {
                anchor: [X0 + len, Y],
                left: [X0 + len, Y],
                right: [X0 + len, Y],
              },
            ],
            open: true,
          },
        });
        await apply({
          op: "setDocumentDefaults",
          args: {
            fillColor: meta.defaultFillColor ?? null,
            strokeColor: meta.defaultStrokeColor ?? null,
            strokeWeight: meta.defaultStrokeWeight ?? null,
          },
        });
        const id = inserted.createdId as ElementId;
        await apply(stackMutationFor(id, [entry]));
        await apply({ op: "expandAppearance", args: { elementId: id } });
        const got = anchorsOf(await pathsOf(h, id));
        const want = anchorsOf(c.measured.paths);
        expect(got.length).toBe(want.length);
        expect(sameSet(got, want)).toBe(true);
      } finally {
        for (let i = 0; i < steps; i++) await h.host.document.undo();
      }
    }
  });
});
