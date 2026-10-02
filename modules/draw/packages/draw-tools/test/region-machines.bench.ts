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

// TRENDED, NOT GATED — see `draw-geometry/test/bench-data.ts`. Nothing
// here asserts: a duration moves with the machine and the load on it.
//
// What a region tool's MACHINE costs per pointer event once the planar
// arrangement is cached. None of it crosses a host door, so the count
// budgets in `draw-bundle/test/perf/` cannot see it; this is the only
// place it is measured.
//
// Two costs, and a row for each:
//
//   · FACE LOOKUP — `resolveAt` runs on every pointer event: the point
//     against the cached faces, in order, until one contains it. 256
//     faces is the engine's cap. The worst move is one over NO face (all
//     256 tested); the common one is over some face (half of them, on
//     average — the rows below take the LAST face, the worst hit).
//   · THE SNAPSHOT — every event answers with a snapshot. A drag's
//     gesture polyline grows by one point per move, so anything that
//     copies it per event makes a drag of N moves cost N²/2 point copies.
//
// `pnpm bench` at the repo root runs the packages that declare a `bench`
// script. This package does not declare one yet (its package.json is not
// this change's to edit), so run it directly:
//
//   pnpm --filter @paged-media/draw-tools exec vitest bench --run

import { bench, describe } from "vitest";

import type { Vec2 } from "@paged-media/draw-geometry";

import {
  LivePaintMachine,
  ShapeBuilderMachine,
  type RegionFace,
} from "../src";
import {
  faceGrid,
  roundFace,
  squareFace,
} from "../../draw-geometry/test/bench-data";

const asFaces = (grid: ReturnType<typeof faceGrid>): RegionFace[] =>
  grid.map((anchors, i) => ({ id: `face#${i}`, anchors }));

/** 256 faces on a 16 × 16 grid of 30 pt cells, from (20, 20). */
const STRAIGHT = asFaces(faceGrid((x, y) => squareFace(x, y, 28)));
const CURVED = asFaces(faceGrid((x, y) => roundFace(x + 14, y + 14, 14)));

/** Outside the whole grid: every face is tested, none matches. */
const NOWHERE: Vec2 = [5, 5];
/** The centre of the LAST face (row 15, column 15): 255 misses, a hit. */
const LAST_FACE: Vec2 = [20 + 15 * 30 + 14, 20 + 15 * 30 + 14];

/** `moves` points on the diagonal of the grid, corner to corner — a drag
 *  that crosses 16 faces and the gaps between them. */
const diagonal = (moves: number): Vec2[] => {
  const out: Vec2[] = [];
  for (let i = 0; i < moves; i++) {
    const t = i / (moves - 1);
    out.push([20 + 480 * t, 20 + 480 * t]);
  }
  return out;
};
const DRAG_1000 = diagonal(1000);

const hovering = (faces: RegionFace[] | null): ShapeBuilderMachine => {
  const machine = new ShapeBuilderMachine();
  machine.setRegions(faces);
  return machine;
};

describe("ShapeBuilderMachine — resolve a point against 256 faces (one hover move)", () => {
  const straight = hovering(STRAIGHT);
  const curved = hovering(CURVED);

  bench("straight faces, pointer over NO face (all 256 tested)", () => {
    straight.handle({ type: "move", point: NOWHERE });
  });

  bench("straight faces, pointer over the LAST face", () => {
    straight.handle({ type: "move", point: LAST_FACE });
  });

  bench("curved faces, pointer over NO face (all 256 tested)", () => {
    curved.handle({ type: "move", point: NOWHERE });
  });

  bench("curved faces, pointer over the LAST face", () => {
    curved.handle({ type: "move", point: LAST_FACE });
  });
});

describe("ShapeBuilderMachine — 1 000 move events through the machine (one drag)", () => {
  const drag = (
    faces: RegionFace[] | null,
    read: boolean,
  ): number => {
    const machine = hovering(faces);
    machine.handle({ type: "down", point: DRAG_1000[0], modifiers: { alt: false } });
    let seen = 0;
    for (const point of DRAG_1000) {
      const snapshot = machine.handle({ type: "move", point });
      // What a handler does when the pointer is over no face: it draws
      // the gesture polyline, so it READS the snapshot's path.
      if (read) seen += snapshot.path?.length ?? 0;
    }
    machine.handle({ type: "up", point: DRAG_1000[DRAG_1000.length - 1] });
    return seen;
  };

  bench("no arrangement installed — the snapshot's share alone", () => {
    drag(null, false);
  });

  bench("no arrangement installed, the handler reading `path` every move", () => {
    drag(null, true);
  });

  bench("256 curved faces installed", () => {
    drag(CURVED, false);
  });

  bench("256 straight faces installed", () => {
    drag(STRAIGHT, false);
  });
});

describe("ShapeBuilderMachine — installing an arrangement (once per gesture scope)", () => {
  bench("setRegions with 256 curved faces", () => {
    new ShapeBuilderMachine().setRegions(CURVED);
  });
});

describe("LivePaintMachine — the same lookup, the bucket's hover and drag", () => {
  const curved = new LivePaintMachine();
  curved.setRegions(CURVED);

  bench("curved faces, pointer over NO face (all 256 tested)", () => {
    curved.handle({ type: "move", point: NOWHERE });
  });

  bench("curved faces, pointer over the LAST face", () => {
    curved.handle({ type: "move", point: LAST_FACE });
  });

  bench("1 000 move events of a paint drag across 256 curved faces", () => {
    const machine = new LivePaintMachine();
    machine.setRegions(CURVED);
    machine.handle({ type: "down", point: DRAG_1000[0] });
    for (const point of DRAG_1000) machine.handle({ type: "move", point });
    machine.handle({ type: "up", point: DRAG_1000[DRAG_1000.length - 1] });
  });
});
