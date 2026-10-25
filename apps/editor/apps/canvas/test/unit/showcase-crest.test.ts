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

// The showcase's Ch.14 opener imports `annual-crest.svg` through
// paged.draw and counts the Polygons it lands. That count is the
// importer's plan of the file, so it is held here to the importer's own
// pure planner: when the importer changes how it lowers a shape, this
// fails in milliseconds instead of the nightly book failing two hours in
// (and every later chapter with it, since each starts from the one
// before's checkpoint).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { shapesFromSvgBytes, svgImportUnitsFor } from "@paged-media/draw";

import {
  CREST_NAME,
  CREST_POLYGON_CONTOURS,
  CREST_SHAPES,
} from "../../tests/showcase/pages/200-drawing-office/crest";

const CREST = readFileSync(
  join(import.meta.dir, "../../tests/showcase/assets", CREST_NAME),
);

describe("the showcase crest import", () => {
  const shapes = shapesFromSvgBytes(new Uint8Array(CREST));
  // The editor's engine reports every page's origin and carries the
  // element fill rule (document.fillRule@1).
  const units = svgImportUnitsFor(
    { pageId: "p77", pageOrigin: [0, 0], nativeFillRule: true },
    shapes,
  );
  const polygonsOf = (unit: (typeof units)[number]): number =>
    unit.pageOrigin !== null ? 1 : unit.contours.length;

  test("lands the Polygons the opener counts", () => {
    expect(units.reduce((n, u) => n + polygonsOf(u), 0)).toBe(CREST_SHAPES);
  });

  test("each Polygon carries the contours the opener checks, holes as even-odd", () => {
    expect(units.map((u) => u.contours.length)).toEqual([
      ...CREST_POLYGON_CONTOURS,
    ]);
    for (const unit of units) {
      if (unit.contours.length > 1) {
        expect(unit.pageOrigin).not.toBeNull();
        expect(unit.fillRule).toBe("EvenOdd");
      }
    }
  });
});
