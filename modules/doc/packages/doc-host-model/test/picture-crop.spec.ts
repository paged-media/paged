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

// Doc ADR 623 — a cropped picture (`a:srcRect`) is placed in its anchored
// frame: the pour writes the lowering's placement on the frame's handle as
// `imageContentTransform`, in the frame's batch (one undo step).

import { describe, expect, it } from "bun:test";

import type { LoweredCrop } from "../src/lowered.js";
import { buildTextPour, pictureCropOps } from "../src/mutations.js";

type Op = { op: string; args: Record<string, unknown> };

const flat = (ops: Op[]): Op[] =>
  ops.flatMap((o) =>
    o.op === "batch" ? flat((o.args as { ops: Op[] }).ops) : [o],
  );

const URI = "data:image/png;base64,AAAA";

/** l = r = 25 % of a 200 px picture shown 72 pt wide: the middle 100 px
 *  (50 to 150) over the frame, so 144 pt of image with 36 pt left of it. */
const middleHalf: LoweredCrop = {
  l: 0.25,
  t: 0,
  r: 0.25,
  b: 0,
  placement: [0.72, 0, 0, 0.72, -36, 0],
};

const pour = (images: object[]) =>
  flat(
    buildTextPour(
      [
        {
          paraStyleId: null,
          runs: [{ text: "a", charStyleId: null }],
          images,
          sourceIndex: 0,
        } as never,
      ],
      "Story/u1",
      0,
    ).mutations as unknown as Op[],
  );

describe("[plugin-doc.picture-crop] a cropped picture in its anchored frame", () => {
  it("sets the placement on the frame the pour just inserted", () => {
    const ops = pour([
      { widthPt: 72, heightPt: 36, uri: URI, crop: middleHalf },
    ]);
    const insert = ops.findIndex((o) => o.op === "insertAnchoredFrame");
    expect(ops[insert + 1]).toEqual({
      op: "bindCreated",
      args: { handle: "docxPicture0" },
    });
    expect(ops[insert + 2]).toEqual({
      op: "setElementProperty",
      args: {
        elementId: { kind: "rectangle", id: "$h:docxPicture0" },
        path: "imageContentTransform",
        value: { type: "transform", value: [0.72, 0, 0, 0.72, -36, 0] },
      },
    });
  });

  it("a picture shown whole, or one whose size is unknown, sets nothing", () => {
    for (const crop of [
      undefined,
      { l: 0.25, t: 0, r: 0.25, b: 0 } as LoweredCrop,
    ]) {
      const ops = pour([{ widthPt: 72, heightPt: 36, uri: URI, crop }]);
      expect(ops.some((o) => o.op === "setElementProperty")).toBe(false);
      expect(ops.some((o) => o.op === "bindCreated")).toBe(false);
    }
    expect(pictureCropOps(undefined, "h")).toEqual([]);
  });

  it("a floating picture takes the crop in its own batch", () => {
    const ops = pour([
      {
        widthPt: 72,
        heightPt: 36,
        uri: URI,
        crop: middleHalf,
        anchor: {
          position: "Anchored",
          anchorPoint: "TopLeftAnchor",
          horizontalReference: "ColumnEdge",
          horizontalAlignment: "LeftAlign",
          verticalReference: "LineBaseline",
          verticalAlignment: "TopAlign",
          xOffsetPt: 0,
          yOffsetPt: 0,
        },
      },
    ]);
    const place = ops.filter((o) => o.args.path === "imageContentTransform");
    expect(place).toHaveLength(1);
    expect(place[0]?.args.elementId).toEqual({
      kind: "rectangle",
      id: "$h:docFloat0",
    });
  });
});
