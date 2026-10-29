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

// Doc ADR 619 — a picture's DrawingML look (doc ADR 618) painted on its
// anchored frame: the pour binds the frame it just inserted and writes the
// look through the lowering kit (engine ADR 1045), colours as the document
// swatches docx-lower minted, a gradient's swatch minted with the styles.

import { describe, expect, it } from "bun:test";

import type { LoweredDoc, NativeFx } from "../src/lowered.js";
import {
  buildStyleMutations,
  buildTextPour,
  lookSwatchIds,
  pictureLookOps,
} from "../src/mutations.js";

type Op = { op: string; args: Record<string, unknown> };

const look: NativeFx = {
  stroke: { color: "#FFFFFF", weight: 6, join: "MiterEndJoin" },
  opacity: 60,
  dropShadow: {
    xOffset: 3,
    yOffset: 3,
    size: 2,
    opacity: 70,
    color: "#000000",
  },
  outerGlow: { size: 5, opacity: 40, color: "#4472C4" },
  feather: 2.5,
};

const URI = "data:image/png;base64,AAAA";

describe("[plugin-doc.native-effects] a picture's look on its anchored frame", () => {
  it("binds the frame it inserts and writes the look on the handle", () => {
    const { mutations } = buildTextPour(
      [
        {
          paraStyleId: null,
          runs: [{ text: "a", charStyleId: null }],
          images: [{ widthPt: 72, heightPt: 54, uri: URI, fx: look }],
          sourceIndex: 0,
        },
      ],
      "Story/u1",
      0,
    );
    const ops = mutations as unknown as Op[];
    const insert = ops.findIndex((o) => o.op === "insertAnchoredFrame");
    expect(ops[insert + 1]).toEqual({
      op: "bindCreated",
      args: { handle: "docxPicture0" },
    });
    const looks = ops.slice(insert + 2);
    expect(looks.length).toBeGreaterThan(0);
    for (const o of looks) {
      expect(o.op).toBe("setElementProperty");
      expect(o.args.elementId).toEqual({
        kind: "rectangle",
        id: "$h:docxPicture0",
      });
    }
    const paths = looks.map((o) => o.args.path);
    expect(paths).toContain("frameOpacity");
    expect(paths).toContain("frameDropShadow");
    expect(paths).toContain("frameOuterGlowEnabled");
    expect(paths).toContain("frameFeatherWidth");
    expect(
      looks.find((o) => o.args.path === "frameStrokeColor")?.args.value,
    ).toEqual({ type: "colorRef", value: "Color/docx-FFFFFF" });
    expect(
      looks.find((o) => o.args.path === "frameDropShadowColor")?.args.value,
    ).toEqual({ type: "colorRef", value: "Color/docx-000000" });
  });

  it("a plain picture gets no handle and no look", () => {
    const { mutations } = buildTextPour(
      [
        {
          paraStyleId: null,
          runs: [],
          images: [{ widthPt: 72, heightPt: 54, uri: URI }],
          sourceIndex: 0,
        },
      ],
      "Story/u1",
      0,
    );
    const ops = mutations as unknown as Op[];
    expect(ops.some((o) => o.op === "bindCreated")).toBe(false);
    expect(ops.some((o) => o.op === "setElementProperty")).toBe(false);
  });

  it("two pictures take two handles", () => {
    const { mutations } = buildTextPour(
      [
        {
          paraStyleId: null,
          runs: [{ text: "ab", charStyleId: null }],
          images: [
            { widthPt: 10, heightPt: 10, uri: URI, at: 0, fx: look },
            { widthPt: 10, heightPt: 10, uri: URI, at: 1, fx: look },
          ],
          sourceIndex: 0,
        },
      ],
      "Story/u1",
      0,
    );
    const handles = (mutations as unknown as Op[])
      .filter((o) => o.op === "bindCreated")
      .map((o) => o.args.handle);
    expect(handles).toEqual(["docxPicture0", "docxPicture1"]);
  });

  it("a gradient behind the picture is a gradient swatch minted with the styles", () => {
    const fx: NativeFx = {
      gradient: {
        kind: "linear",
        stops: [
          [0, "#FF0000"],
          [100, "#0000FF"],
        ],
        angle: 0,
        length: 72,
        start: [0, 27],
      },
    };
    const ops = pictureLookOps(fx, "p") as unknown as Op[];
    const fill = ops.find((o) => o.args.path === "frameFillColor");
    expect(fill?.args.value).toEqual({
      type: "colorRef",
      value: "Gradient/docx-L-0-FF0000-100-0000FF",
    });
    // The start is in the frame's own box.
    expect(
      ops.find((o) => o.args.path === "frameGradientFillStart")?.args.value,
    ).toEqual({ type: "lengths", value: [0, 27] });
    const ir = {
      swatches: [],
      styles: [],
      story: {
        blocks: [
          {
            kind: "paragraph",
            paraStyleId: null,
            runs: [],
            images: [{ widthPt: 72, heightPt: 54, uri: URI, fx }],
            sourceIndex: 0,
          },
        ],
      },
    } as unknown as LoweredDoc;
    const styleOps = buildStyleMutations(ir) as unknown as Op[];
    const create = styleOps.filter((o) => o.op === "createGradient");
    expect(create).toHaveLength(1);
    expect(create[0]!.args.spec).toMatchObject({
      selfId: "Gradient/docx-L-0-FF0000-100-0000FF",
      kind: "Linear",
      stops: [
        { stopColor: "Color/docx-FF0000", locationPct: 0 },
        { stopColor: "Color/docx-0000FF", locationPct: 100 },
      ],
    });
  });

  it("names the swatches docx-lower mints for the look's colours", () => {
    expect(lookSwatchIds(look)).toEqual([
      "Color/docx-FFFFFF",
      "Color/docx-000000",
      "Color/docx-4472C4",
    ]);
  });
});
