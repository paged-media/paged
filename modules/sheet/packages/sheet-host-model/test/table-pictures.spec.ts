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

// W2.3 (sheet ADR 526) — pictures over a placed table: an image frame at
// the anchor cell in the table's own column widths plus the offset, the
// image placed by its data URI; an image in a cell scales with its column.

import { describe, expect, it } from "bun:test";

import {
  paletteSwatchId,
  tablePictureBox,
  tablePictureLosses,
  tablePictureOps,
  type LoweredContent,
  type LoweredPicture,
} from "../src";

const content = {
  cols: [
    { index: 4, widthPt: 40 },
    { index: 5, widthPt: 60 },
  ],
  rows: [
    { index: 1, heightPt: 15, cells: [] },
    { index: 2, heightPt: 20, cells: [] },
  ],
  rules: { h: [], v: [] },
  merges: [],
  styles: [],
} as unknown as LoweredContent;

const pic: LoweredPicture = {
  id: "xl/drawings/drawing1.xml#0",
  row: 2,
  col: 5,
  dx: 3,
  dy: 2,
  wPt: 50,
  hPt: 30,
  inCell: false,
  uri: "data:image/png;base64,AA==",
};

describe("pictures over a page table [sheet.xlsx.pictures]", () => {
  it("places a picture at its anchor cell plus its offset", () => {
    expect(tablePictureBox(content, [40, 60], [100, 50], pic)).toEqual([
      117, 93, 147, 143,
    ]);
    // Wider table columns move it (an image in a cell also widens).
    expect(tablePictureBox(content, [80, 120], [0, 0], pic)).toEqual([
      17, 86, 47, 136,
    ]);
    expect(
      tablePictureBox(content, [80, 120], [0, 0], { ...pic, inCell: true }),
    ).toEqual([17, 86, 47, 186]);
    expect(
      tablePictureBox(content, [40, 60], [0, 0], { ...pic, col: 9 }),
    ).toBeNull();
  });

  it("emits a frame and its image per picture", () => {
    const ops = tablePictureOps(
      { ...content, pictures: [pic, { ...pic, col: 9 }] },
      [40, 60],
      "p1" as never,
      [0, 0],
    );
    expect(ops.map((o) => o.op)).toEqual([
      "insertFrame",
      "bindCreated",
      "placeImage",
    ]);
    expect(ops[2]).toEqual({
      op: "placeImage",
      args: {
        elementId: "$h:pic0",
        uri: "data:image/png;base64,AA==",
        fit: "ContentToFrame",
      },
    });
  });
});

describe("a picture's DrawingML look [sheet.chart.native-effects]", () => {
  const styled: LoweredPicture = {
    ...pic,
    fx: {
      opacity: 60,
      dropShadow: {
        xOffset: 2,
        yOffset: 2,
        size: 2,
        opacity: 40,
        color: "#000000",
      },
    },
    losses: [
      {
        code: "dml.picture.tint",
        count: 1,
        message: "picture effect a:tint is not carried",
      },
    ],
  };
  const withPics = { ...content, pictures: [styled, { ...styled, row: 1 }] };

  it("sets the frame's opacity and shadow and mints the shadow colour once", () => {
    const ops = tablePictureOps(withPics, [40, 60], "p1" as never, [0, 0]) as {
      op: string;
      args: Record<string, unknown>;
    }[];
    const mints = ops.filter((o) => o.op === "createSwatch");
    expect(mints).toHaveLength(1);
    expect(ops[0]!.op).toBe("createSwatch");
    const sets = ops.filter((o) => o.op === "setElementProperty");
    expect(sets[0]!.args.elementId).toEqual({
      kind: "rectangle",
      id: "$h:pic0",
    });
    const paths = sets.map((o) => [
      o.args.path,
      (o.args.value as { value: unknown }).value,
    ]);
    expect(paths).toContainEqual(["frameOpacity", 60]);
    expect(paths).toContainEqual(["frameDropShadow", true]);
    expect(paths).toContainEqual([
      "frameDropShadowColor",
      paletteSwatchId("chart", "000000"),
    ]);
    // A colour the document has is referenced; a failed read mints none.
    const known = new Set([paletteSwatchId("chart", "000000")]);
    expect(
      tablePictureOps(withPics, [40, 60], "p1" as never, [0, 0], known).some(
        (o) => o.op === "createSwatch",
      ),
    ).toBe(false);
    expect(
      tablePictureOps(withPics, [40, 60], "p1" as never, [0, 0], null).some(
        (o) => o.op === "createSwatch",
      ),
    ).toBe(false);
    expect(tablePictureLosses(withPics)).toHaveLength(1);
  });
});

describe("a picture's crop and corrections [sheet.chart.native-effects]", () => {
  it("sets the crop's placement and the filter stack on the frame, after the image", () => {
    const adjustments = [
      {
        op: "blackWhite",
        reds: 0.3,
        yellows: 0.3,
        greens: 0.59,
        cyans: 0.3,
        blues: 0.11,
        magentas: 0.3,
      },
      { op: "brightnessContrast", brightness: 0.2, contrast: 0.9 },
    ] as LoweredPicture["adjustments"];
    const placement: LoweredPicture["placement"] = [2, 0, 0, 1, -50, 0];
    const ops = tablePictureOps(
      { ...content, pictures: [{ ...pic, adjustments, placement }] },
      [40, 60],
      "p1" as never,
      [0, 0],
    ) as { op: string; args: Record<string, unknown> }[];
    expect(ops.map((o) => o.op)).toEqual([
      "insertFrame",
      "bindCreated",
      "placeImage",
      "setElementProperty",
      "setElementProperty",
    ]);
    expect(ops[3]!.args).toEqual({
      elementId: { kind: "rectangle", id: "$h:pic0" },
      path: "imageContentTransform",
      value: { type: "transform", value: placement },
    });
    expect(ops[4]!.args).toEqual({
      elementId: { kind: "rectangle", id: "$h:pic0" },
      path: "frameImageAdjustments",
      value: { type: "imageAdjustments", value: adjustments },
    });
  });
});

describe("a picture's click action [sheet.xlsx.pictures]", () => {
  it("makes the frame an item hyperlink in the same batch", () => {
    const ops = tablePictureOps(
      { ...content, pictures: [{ ...pic, link: "https://paged.media" }] },
      [40, 60],
      "p1" as never,
      [0, 0],
    ) as { op: string; args: Record<string, unknown> }[];
    expect(ops.at(-1)).toEqual({
      op: "insertItemHyperlink",
      args: { item: "$h:pic0", url: "https://paged.media", name: pic.id },
    });
  });
});
