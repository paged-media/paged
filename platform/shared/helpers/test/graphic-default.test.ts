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

import { describe, expect, it } from "bun:test";

import {
  INDESIGN_GRAPHIC_PAINT,
  graphicPaintFromStyle,
  resolveGraphicPaint,
  withGraphicPaint,
} from "../src/index.ts";

const STYLE = { fill: "Color/Paper", stroke: "Color/Black", strokeWeight: 4 };

describe("resolveGraphicPaint", () => {
  it("document defaults of its own: no paint (the engine applies them)", () => {
    for (const meta of [
      { defaultFillColor: "Color/Black" },
      { defaultStrokeColor: "Color/Black" },
      { defaultStrokeWeight: 2 },
    ]) {
      expect(resolveGraphicPaint(meta, STYLE)).toBeNull();
    }
  });

  it("the document's style wins; without one, InDesign's values", () => {
    expect(resolveGraphicPaint({}, STYLE)).toEqual(STYLE);
    expect(resolveGraphicPaint(null, null)).toEqual(INDESIGN_GRAPHIC_PAINT);
    expect(INDESIGN_GRAPHIC_PAINT).toEqual({
      fill: null,
      stroke: "Color/Black",
      strokeWeight: 1,
    });
  });
});

describe("graphicPaintFromStyle", () => {
  it("reads colour refs and the weight; a None swatch or a missing entry is null", () => {
    expect(
      graphicPaintFromStyle({
        entries: [
          {
            path: "frameFillColor",
            value: { type: "colorRef", value: "Color/Paper" },
          },
          {
            path: "frameStrokeColor",
            value: { type: "colorRef", value: null },
          },
          { path: "frameStrokeWeight", value: { type: "length", value: 3 } },
        ],
      }),
    ).toEqual({ fill: "Color/Paper", stroke: null, strokeWeight: 3 });
    expect(graphicPaintFromStyle({ entries: [] })).toEqual({
      fill: null,
      stroke: null,
      strokeWeight: null,
    });
  });
});

describe("withGraphicPaint", () => {
  const insert = { op: "insertOval", args: { pageId: "p" } };
  const line = { op: "insertLine", args: { pageId: "p" } };

  it("paints every shape a batch mints right after its insert; a line never gets a fill", () => {
    const out = withGraphicPaint(
      { op: "batch", args: { ops: [insert, line] } },
      STYLE,
    );
    const names = (
      out.args as { ops: { op: string; args?: unknown }[] }
    ).ops.map((m) =>
      m.op === "setElementProperty" ? (m.args as { path: string }).path : m.op,
    );
    expect(names).toEqual([
      "insertOval",
      "frameFillColor",
      "frameStrokeColor",
      "frameStrokeWeight",
      "insertLine",
      "frameStrokeColor",
      "frameStrokeWeight",
    ]);
  });

  it("no paint, or nothing to paint: the mutation itself", () => {
    expect(withGraphicPaint(insert, null)).toBe(insert);
    const text = { op: "insertTextFrame", args: {} };
    expect(withGraphicPaint(text, STYLE)).toBe(text);
    expect(
      withGraphicPaint(insert, { fill: null, stroke: null, strokeWeight: 3 }),
    ).toBe(insert);
  });
});
