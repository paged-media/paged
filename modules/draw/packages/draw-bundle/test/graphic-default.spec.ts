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

// The graphic default (`src/handlers/graphic-default.ts`) — which paint a
// drawing tool gives its shape, and where in the batch it goes. Pure: a
// stub host answers `document.meta` and the raw `requestStyleProperties`
// read; the real-engine half is `conformance/tool-graphic-default.spec.ts`.

import { describe, expect, it } from "vitest";

import type { BundleHost, MutationInput } from "@paged-media/plugin-api";

import {
  INDESIGN_GRAPHIC_PAINT,
  NORMAL_GRAPHICS_FRAME_STYLE,
  graphicPaintFor,
  withGraphicPaint,
  type GraphicPaint,
} from "../src/handlers/graphic-default";
import { insertPathMutationFor } from "../src/handlers/insert-path";
import { outlineStrokeVariableMutationFor } from "../src/handlers/brush";
import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
} from "../src/commands/v59-wire";

type Defaults = {
  defaultFillColor?: string | null;
  defaultStrokeColor?: string | null;
  defaultStrokeWeight?: number | null;
};

/** A host whose document has `defaults` and, when given, a
 *  `[Normal Graphics Frame]` with `style`'s entries. Records every raw
 *  request it was sent. */
function stubHost(
  defaults: Defaults,
  style: { fill: string | null; stroke: string | null; weight: number | null } | null,
  opts: { hatch?: boolean } = {},
): { host: BundleHost; sent: unknown[] } {
  const sent: unknown[] = [];
  const send = async (req: { kind: string; payload?: { styleId?: string } }) => {
    sent.push(req);
    if (req.kind !== "requestStyleProperties") return { kind: "error" };
    const result =
      style && req.payload?.styleId === NORMAL_GRAPHICS_FRAME_STYLE
        ? {
            collection: "object",
            styleId: NORMAL_GRAPHICS_FRAME_STYLE,
            entries: [
              { path: "frameFillColor", value: { type: "colorRef", value: style.fill } },
              { path: "frameFillTint", value: { type: "length", value: null } },
              { path: "frameStrokeColor", value: { type: "colorRef", value: style.stroke } },
              { path: "frameStrokeWeight", value: { type: "length", value: style.weight } },
            ],
          }
        : null;
    return { kind: "styleProperties", payload: { result } };
  };
  const host = {
    document: {
      meta: async () => ({
        defaultFillColor: null,
        defaultStrokeColor: null,
        defaultStrokeWeight: null,
        ...defaults,
      }),
    },
    editor: opts.hatch === false ? {} : { client: { send } },
  } as unknown as BundleHost;
  return { host, sent };
}

const PAGE = "usp";
const ANCHORS = [
  { anchor: [0, 0] as [number, number], left: [0, 0] as [number, number], right: [0, 0] as [number, number] },
  { anchor: [10, 10] as [number, number], left: [10, 10] as [number, number], right: [10, 10] as [number, number] },
];
const INSERT = insertPathMutationFor(PAGE, ANCHORS, true);

const set = (kind: string, path: string, value: unknown): MutationInput =>
  ({
    op: "setElementProperty",
    args: { elementId: { kind, id: "$created" }, path, value },
  }) as MutationInput;
const colorRef = (value: string) => ({ type: "colorRef", value });
const length = (value: number) => ({ type: "length", value });

describe("graphicPaintFor — which paint a tool-made shape wears", () => {
  it("the document has defaults of its own: no paint (the engine applies them)", async () => {
    for (const defaults of [
      { defaultFillColor: "Color/Black" },
      { defaultStrokeColor: "Color/Black" },
      { defaultStrokeWeight: 2 },
    ]) {
      const { host } = stubHost(defaults, { fill: "Color/Black", stroke: "Color/Black", weight: 4 });
      expect(await graphicPaintFor(host)).toBeNull();
    }
  });

  it("no defaults, the document's [Normal Graphics Frame] present: its values", async () => {
    const { host, sent } = stubHost({}, { fill: "Color/Paper", stroke: "Color/Black", weight: 4 });
    expect(await graphicPaintFor(host)).toEqual({
      fill: "Color/Paper",
      stroke: "Color/Black",
      strokeWeight: 4,
    });
    expect(sent).toEqual([
      {
        kind: "requestStyleProperties",
        payload: { collection: "object", styleId: NORMAL_GRAPHICS_FRAME_STYLE },
      },
    ]);
  });

  it("a style whose swatch is None reads as null", async () => {
    const { host } = stubHost({}, { fill: null, stroke: null, weight: 3 });
    expect(await graphicPaintFor(host)).toEqual({ fill: null, stroke: null, strokeWeight: 3 });
  });

  it("no such style (File ▸ New): InDesign's values — no fill, 1 pt Color/Black", async () => {
    const { host } = stubHost({}, null);
    expect(await graphicPaintFor(host)).toEqual(INDESIGN_GRAPHIC_PAINT);
    expect(INDESIGN_GRAPHIC_PAINT).toEqual({ fill: null, stroke: "Color/Black", strokeWeight: 1 });
  });

  it("a host with no raw wire, or a read that fails, degrades to InDesign's values", async () => {
    expect(await graphicPaintFor(stubHost({}, null, { hatch: false }).host)).toEqual(
      INDESIGN_GRAPHIC_PAINT,
    );
    const { host } = stubHost({}, null);
    (host.document as unknown as { meta: () => Promise<never> }).meta = () =>
      Promise.reject(new Error("gone"));
    expect(await graphicPaintFor(host)).toEqual(INDESIGN_GRAPHIC_PAINT);
  });
});

describe("withGraphicPaint — where the paint goes", () => {
  const STYLE: GraphicPaint = { fill: "Color/Paper", stroke: "Color/Black", strokeWeight: 4 };

  it("no paint (the document has defaults): the mutation is unchanged", () => {
    expect(withGraphicPaint(INSERT, null)).toBe(INSERT);
  });

  it("an insert becomes ONE batch: the insert, then its paint on $created", () => {
    expect(withGraphicPaint(INSERT, INDESIGN_GRAPHIC_PAINT)).toEqual({
      op: "batch",
      args: {
        ops: [
          INSERT,
          set("polygon", "frameStrokeColor", colorRef("Color/Black")),
          set("polygon", "frameStrokeWeight", length(1)),
        ],
      },
    });
    expect(withGraphicPaint(INSERT, STYLE)).toEqual({
      op: "batch",
      args: {
        ops: [
          INSERT,
          set("polygon", "frameFillColor", colorRef("Color/Paper")),
          set("polygon", "frameStrokeColor", colorRef("Color/Black")),
          set("polygon", "frameStrokeWeight", length(4)),
        ],
      },
    });
  });

  it("a weight is written only with a stroke; nothing to paint leaves the mutation alone", () => {
    expect(withGraphicPaint(INSERT, { fill: null, stroke: null, strokeWeight: 3 })).toBe(INSERT);
    expect(withGraphicPaint(INSERT, { fill: null, stroke: "Color/Black", strokeWeight: null })).toEqual({
      op: "batch",
      args: { ops: [INSERT, set("polygon", "frameStrokeColor", colorRef("Color/Black"))] },
    });
  });

  it("the pencil's pressure batch: the paint rides right after the insert, BEFORE the bind and the outline", () => {
    const bind = bindCreatedMutationFor("stroke");
    const outline = outlineStrokeVariableMutationFor(handleElementId("stroke"), [1, 2, 3]);
    expect(withGraphicPaint(batchMutationFor([INSERT, bind, outline]), INDESIGN_GRAPHIC_PAINT)).toEqual({
      op: "batch",
      args: {
        ops: [
          INSERT,
          set("polygon", "frameStrokeColor", colorRef("Color/Black")),
          set("polygon", "frameStrokeWeight", length(1)),
          bind,
          outline,
        ],
      },
    });
  });

  it("every insert in a batch gets its own paint, right after it", () => {
    const second = insertPathMutationFor(PAGE, ANCHORS, false);
    const painted = withGraphicPaint(batchMutationFor([INSERT, second]), INDESIGN_GRAPHIC_PAINT);
    expect(painted).toEqual({
      op: "batch",
      args: {
        ops: [
          INSERT,
          set("polygon", "frameStrokeColor", colorRef("Color/Black")),
          set("polygon", "frameStrokeWeight", length(1)),
          second,
          set("polygon", "frameStrokeColor", colorRef("Color/Black")),
          set("polygon", "frameStrokeWeight", length(1)),
        ],
      },
    });
  });

  it("a line gets no fill; each insert kind addresses $created as the kind it mints", () => {
    const line: MutationInput = {
      op: "insertLine",
      args: { pageId: PAGE, start: [0, 0], end: [10, 10] },
    } as MutationInput;
    expect(withGraphicPaint(line, STYLE)).toEqual({
      op: "batch",
      args: {
        ops: [
          line,
          set("graphicLine", "frameStrokeColor", colorRef("Color/Black")),
          set("graphicLine", "frameStrokeWeight", length(4)),
        ],
      },
    });
    const frame = { op: "insertFrame", args: { pageId: PAGE, bounds: [0, 0, 10, 10] } } as MutationInput;
    const oval = { op: "insertOval", args: { pageId: PAGE, bounds: [0, 0, 10, 10] } } as MutationInput;
    for (const [insert, kind] of [
      [frame, "rectangle"],
      [oval, "oval"],
    ] as const) {
      expect(withGraphicPaint(insert, STYLE)).toEqual({
        op: "batch",
        args: {
          ops: [
            insert,
            set(kind, "frameFillColor", colorRef("Color/Paper")),
            set(kind, "frameStrokeColor", colorRef("Color/Black")),
            set(kind, "frameStrokeWeight", length(4)),
          ],
        },
      });
    }
  });

  it("a mutation that inserts no shape is left alone", () => {
    const outline = outlineStrokeVariableMutationFor(handleElementId("stroke"), [1, 2]);
    expect(withGraphicPaint(outline, STYLE)).toBe(outline);
    const textFrame = { op: "insertTextFrame", args: { pageId: PAGE, bounds: [0, 0, 10, 10] } } as MutationInput;
    expect(withGraphicPaint(textFrame, STYLE)).toBe(textFrame);
  });
});
