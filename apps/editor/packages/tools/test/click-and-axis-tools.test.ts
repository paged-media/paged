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

// The click and axis tools (Scissors, Smooth, Gradient Swatch, Gradient
// Feather, Eyedropper), driven through the gesture DSL against the
// editor-shaped fake: target resolution, zoom-relative pick radii, the
// exact mutation each emits, and click-vs-drag.

import { afterEach, describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/client";
import {
  expectOneCommit,
  stubGlobal,
  unstubAllGlobals,
} from "@paged-media/test-kit";

import { createEyedropperHandler } from "../src/handlers/eyedropper-tool";
import {
  planApply,
  snapshotPixelFor,
  swatchNameFor,
  swatchSpecFor,
} from "../src/handlers/eyedropper-sample";
import { createGradientFeatherHandler } from "../src/handlers/gradient-feather-tool";
import { createGradientSwatchHandler } from "../src/handlers/gradient-tool";
import { createScissorsHandler } from "../src/handlers/scissors-tool";
import { createSmoothHandler } from "../src/handlers/smooth-tool";
import { harness, leaves, previews, quietWarnings } from "./support";

const PATH = { kind: "polygon", id: "p1" } as ElementId;
const SQUARE = {
  id: PATH,
  pageId: "page-1",
  anchors: [
    [100, 100],
    [200, 100],
    [200, 200],
    [100, 200],
  ].map((p) => ({ anchor: p, left: p, right: p })),
  subpathStarts: [0],
  subpathOpen: [false],
};

describe("Scissors tool", () => {
  it("a click on an anchor opens the path there (pathOpenAt, the clicked element by hit test) @level:gesture", async () => {
    const { fake, g } = harness({
      hitTest: () => PATH,
      pathAnchors: () => SQUARE as never,
    });
    await g.tool(createScissorsHandler).click([203, 198]).settle();
    expect(fake.mutations()).toEqual([
      { op: "pathOpenAt", args: { elementId: PATH, index: 2 } },
    ]);
  });

  it("the pick radius is 6 screen px: an anchor 10 pt away is cut at 25% zoom, not at 100% @level:gesture", async () => {
    for (const [zoom, cuts] of [
      [0.25, 1],
      [1, 0],
    ] as const) {
      const { fake, g } = harness({
        zoom,
        hitTest: () => PATH,
        pathAnchors: () => SQUARE as never,
      });
      await g.tool(createScissorsHandler).click([210, 200]).settle();
      expect(fake.mutations()).toHaveLength(cuts);
    }
  });

  it("falls back to the single selection when the hit test misses; a drag cuts nothing @level:gesture", async () => {
    const { fake, g } = harness({
      selection: [PATH],
      pathAnchors: () => SQUARE as never,
    });
    await g
      .tool(createScissorsHandler)
      .click([100, 101])
      .drag({ from: [100, 100], to: [150, 150] })
      .settle();
    expect(fake.mutations()).toEqual([
      { op: "pathOpenAt", args: { elementId: PATH, index: 0 } },
    ]);
  });
});

describe("Smooth tool", () => {
  it("a click simplifies the hit path with the tool's tolerance (default 1.5 pt) @level:gesture", async () => {
    const { fake, g } = harness({ hitTest: () => PATH });
    await g.tool(createSmoothHandler).click([150, 150]).settle();
    expect(fake.mutations()).toEqual([
      { op: "simplifyPath", args: { elementId: PATH, tolerance: 1.5 } },
    ]);
  });

  it("clamps the tolerance setting to 0.1…20 pt and uses the selection when nothing is hit @level:gesture", async () => {
    const { fake, g } = harness({
      selection: [PATH],
      toolSettings: { "paged.tool.smooth": { tolerance: 99 } },
    });
    await g.tool(createSmoothHandler).click([150, 150]).settle();
    expect(fake.mutations()).toEqual([
      { op: "simplifyPath", args: { elementId: PATH, tolerance: 20 } },
    ]);
  });

  it("a drag or a secondary click does nothing @level:gesture", async () => {
    const { fake, g } = harness({ hitTest: () => PATH });
    await g
      .tool(createSmoothHandler)
      .drag({ from: [100, 100], to: [200, 200] })
      .click([150, 150], { button: 2 })
      .settle();
    expect(fake.mutations()).toEqual([]);
  });
});

describe("Gradient Swatch tool", () => {
  const T1 = { kind: "rectangle", id: "r1" } as ElementId;
  const T2 = { kind: "oval", id: "o1" } as ElementId;

  it("a drag sets each selected element's gradient axis (angle + length) as ONE batch @level:gesture", async () => {
    const { fake, g } = harness({ selection: [T1, T2] });
    const mark = fake.mark();
    await g
      .tool(createGradientSwatchHandler)
      .drag({ from: [100, 100], to: [100, 200] })
      .settle();
    expectOneCommit(fake, mark);
    expect(previews(fake).at(-1)).toEqual({
      pageId: "page-1",
      points: [
        [100, 100],
        [100, 200],
      ],
    });
    expect(
      leaves(fake).map((m) => [
        (m.args as { elementId: ElementId }).elementId.id,
        (m.args as { path: string }).path,
        (m.args as { value: { value: number } }).value.value,
      ]),
    ).toEqual([
      ["r1", "frameGradientFillAngle", 90],
      ["r1", "frameGradientFillLength", 100],
      ["o1", "frameGradientFillAngle", 90],
      ["o1", "frameGradientFillLength", 100],
    ]);
  });

  it("Shift snaps the axis to 45° @level:gesture", async () => {
    const { fake, g } = harness({ selection: [T1] });
    await g
      .tool(createGradientSwatchHandler)
      .drag({ from: [100, 100], to: [200, 120], mods: ["shift"] })
      .settle();
    expect(
      (leaves(fake)[0].args as { value: { value: number } }).value.value,
    ).toBe(0);
  });

  it("with nothing selected, or a drag under 1 pt, nothing is sent @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(createGradientSwatchHandler)
      .drag({ from: [100, 100], to: [200, 200] })
      .settle();
    fake.setSelection([T1]);
    await g.click([100, 100]).settle();
    expect(fake.mutations()).toEqual([]);
  });
});

describe("Gradient Feather tool", () => {
  const T1 = { kind: "rectangle", id: "r1" } as ElementId;

  it("a drag writes a linear opaque→transparent feather along the drag axis @level:gesture", async () => {
    const { fake, g } = harness({ selection: [T1] });
    await g
      .tool(createGradientFeatherHandler)
      .drag({ from: [100, 100], to: [200, 100] })
      .settle();
    expect(fake.mutations()).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: T1,
          path: "frameGradientFeather",
          value: {
            type: "gradientFeather",
            value: {
              gradientType: "Linear",
              startPoint: [100, 100],
              endPoint: [200, 100],
              angleDeg: 0,
              stops: [
                {
                  stopColor: null,
                  locationPct: 0,
                  alphaPct: 100,
                  midpointPct: 50,
                },
                {
                  stopColor: null,
                  locationPct: 100,
                  alphaPct: 0,
                  midpointPct: 50,
                },
              ],
            },
          },
        },
      },
    ]);
  });

  it("a plain click clears the feather; several targets go in one batch @level:gesture", async () => {
    const { fake, g } = harness({
      selection: [T1, { kind: "oval", id: "o1" } as ElementId],
    });
    await g.tool(createGradientFeatherHandler).click([150, 150]).settle();
    const [m] = fake.mutations() as Array<{
      op: string;
      args: { ops: Array<{ args: { value: { value: unknown } } }> };
    }>;
    expect(m.op).toBe("batch");
    expect(m.args.ops.map((o) => o.args.value.value)).toEqual([null, null]);
  });
});

describe("Eyedropper (host)", () => {
  afterEach(() => unstubAllGlobals());

  /** A realm that can decode a snapshot: every pixel is `rgb`. */
  const imaging = (rgb: [number, number, number]) => {
    stubGlobal("createImageBitmap", async () => ({
      width: 1024,
      height: 1325,
      close() {},
    }));
    stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return {
            drawImage() {},
            getImageData: () => ({ data: [...rgb, 255] }),
          };
        }
      },
    );
  };

  it("a click samples the composited pixel: find-or-create its swatch, make it the default fill and the selection's fill, as ONE batch @level:gesture", async () => {
    imaging([12, 34, 56]);
    let swatches: Array<{ selfId: string; name: string }> = [];
    const target = { kind: "rectangle", id: "r1" } as ElementId;
    const { fake, g } = harness({
      selection: [target],
      documentMeta: {
        defaultStrokeColor: "Color/Black",
        defaultStrokeWeight: 2,
      },
      snapshot: (_p, w) => ({ pngBytes: [0], widthPx: w, heightPx: w }),
      collections: {
        get swatches() {
          return swatches;
        },
      } as never,
      refuse: (m) => {
        if (m.op === "createSwatch")
          swatches = [{ selfId: "Color/u12", name: "R=12 G=34 B=56" }];
        return null;
      },
    });
    await g.tool(createEyedropperHandler).click([300, 400]).settle();
    expect(fake.mutations()).toEqual([
      {
        op: "createSwatch",
        args: {
          spec: { name: "R=12 G=34 B=56", space: "RGB", value: [12, 34, 56] },
        },
      },
      {
        op: "batch",
        args: {
          ops: [
            {
              op: "setDocumentDefaults",
              args: {
                fillColor: "Color/u12",
                strokeColor: "Color/Black",
                strokeWeight: 2,
              },
            },
            {
              op: "setElementProperty",
              args: {
                elementId: target,
                path: "frameFillColor",
                value: { type: "colorRef", value: "Color/u12" },
              },
            },
          ],
        },
      },
    ]);
  });

  it("a second sample of the same colour reuses its swatch @level:gesture", async () => {
    imaging([12, 34, 56]);
    const { fake, g } = harness({
      snapshot: (_p, w) => ({ pngBytes: [0], widthPx: w, heightPx: w }),
      collections: {
        swatches: [{ selfId: "Color/u12", name: "R=12 G=34 B=56" }],
      },
    });
    await g.tool(createEyedropperHandler).click([300, 400]).settle();
    expect(fake.mutations().map((m) => m.op)).toEqual(["setDocumentDefaults"]);
  });

  it("is honest without imaging (a test realm): it samples nothing; a drag and the pasteboard sample nothing @level:gesture", async () => {
    const { fake, g } = harness({
      snapshot: (_p, w) => ({ pngBytes: [0], widthPx: w, heightPx: w }),
    });
    await g
      .tool(createEyedropperHandler)
      .click([300, 400])
      .drag({ from: [100, 100], to: [200, 200] })
      .click([700, 100])
      .settle();
    expect(fake.mutations()).toEqual([]);
  });

  it("the pure half: page point → snapshot pixel (clamped), RGB → InDesign's swatch name, the plan @level:gesture", () => {
    expect(snapshotPixelFor([306, 396], 612, 1024, 1325)).toEqual([512, 662]);
    expect(snapshotPixelFor([612, 792], 612, 1024, 1325)).toEqual([1023, 1324]);
    expect(snapshotPixelFor([1, 1], 0, 1024, 1325)).toBeNull();
    expect(swatchNameFor({ r: 12.4, g: 33.6, b: 56, a: 255 })).toBe(
      "R=12 G=34 B=56",
    );
    expect(swatchSpecFor({ r: 1, g: 2, b: 3, a: 0 })).toEqual({
      name: "R=1 G=2 B=3",
      space: "RGB",
      value: [1, 2, 3],
    });
    expect(
      planApply(
        { r: 1, g: 2, b: 3, a: 255 },
        [{ selfId: "x", name: "R=1 G=2 B=3" }],
        ["t"],
      ),
    ).toEqual({
      swatchName: "R=1 G=2 B=3",
      needsSwatch: false,
      targets: ["t"],
    });
  });

  it("refusals are warned, never thrown @level:gesture", async () => {
    imaging([1, 2, 3]);
    const restore = quietWarnings();
    try {
      const { fake, g } = harness({ snapshot: () => null });
      await g.tool(createEyedropperHandler).click([300, 400]).settle();
      expect(fake.mutations()).toEqual([]);
    } finally {
      restore();
    }
  });
});
