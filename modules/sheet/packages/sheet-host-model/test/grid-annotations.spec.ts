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

// W2.3 (sheet ADR 526) — hyperlinks and pictures in the grid: the link
// under a point, a picture drawn at its box, an image in a cell fitted into
// the cell keeping its aspect ratio, nothing drawn before the image is
// decoded.

import { describe, expect, it } from "bun:test";

import {
  linkAt,
  paintGridScene,
  pictureBox,
  type GridPicture,
  type GridScene,
  type PaintContext,
} from "../src";

function recorder(): { ctx: PaintContext; images: unknown[][] } {
  const images: unknown[][] = [];
  const noop = () => {};
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    save: noop,
    restore: noop,
    translate: noop,
    beginPath: noop,
    rect: noop,
    clip: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    fillText: noop,
    drawImage: (...args: unknown[]) => images.push(args),
  } as unknown as PaintContext;
  return { ctx, images };
}

const cellPic: GridPicture = {
  id: "cell:B3",
  media: "xl/media/image2.png",
  contentType: "image/png",
  x: 40,
  y: 30,
  w: 40,
  h: 15,
  inCell: true,
};

const scene: GridScene = {
  viewport: {
    firstRow: 0,
    firstCol: 0,
    rows: 3,
    cols: 3,
    xOffsets: [0, 40, 80, 120],
    yOffsets: [0, 15, 30, 45],
  },
  cells: [],
  styles: [],
  gridlines: { h: [], v: [] },
  links: [
    { row: 0, col: 0, x: 0, y: 0, w: 40, h: 15, url: "https://paged.media" },
  ],
  pictures: [
    {
      id: "xl/drawings/drawing1.xml#0",
      media: "xl/media/image1.png",
      contentType: "image/png",
      x: 80,
      y: 0,
      w: 60,
      h: 30,
      inCell: false,
    },
    cellPic,
  ],
};

describe("hyperlinks and pictures in the grid [sheet.xlsx.pictures]", () => {
  it("finds the link under a point", () => {
    expect(linkAt(scene, 10, 5)?.url).toBe("https://paged.media");
    expect(linkAt(scene, 50, 5)).toBeNull();
  });

  it("fits an image in a cell keeping its aspect ratio", () => {
    expect(pictureBox(cellPic, { width: 10, height: 10 })).toEqual([
      52.5, 30, 15, 15,
    ]);
    expect(pictureBox(cellPic)).toEqual([40, 30, 40, 15]);
  });

  it("draws the decoded pictures at their boxes", () => {
    const { ctx, images } = recorder();
    const img = { width: 10, height: 10 } as unknown as CanvasImageSource & {
      width: number;
      height: number;
    };
    paintGridScene(ctx, scene, {
      headings: false,
      rowHeadingWidthPt: 0,
      widthPt: 200,
      heightPt: 100,
      pictureImage: (m) => (m === "xl/media/image1.png" ? img : img),
    });
    expect(images.map((a) => a.slice(1))).toEqual([
      [80, 0, 60, 30],
      [52.5, 30, 15, 15],
    ]);
    const none = recorder();
    paintGridScene(none.ctx, scene, {
      headings: false,
      rowHeadingWidthPt: 0,
      widthPt: 200,
      heightPt: 100,
      pictureImage: () => undefined,
    });
    expect(none.images).toEqual([]);
  });
});
