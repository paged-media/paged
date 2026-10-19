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

// The shape-drawing tools (Rectangle, Ellipse, Polygon, their Frame
// variants, Line) driven through the gesture DSL against the editor-
// shaped fake: the previews they publish, the modifier semantics
// (gestures.md DR-01…DR-07), the exact mutation they emit, the post-
// insert selection, cancel, and the universal invariants (one gesture =
// one commit = one undo step; Escape commits nothing).

import { describe, expect, it, test } from "bun:test";

import {
  expectNoCommit,
  expectOneCommit,
  expectOneUndoStep,
} from "@paged-media/test-kit";

import { createEllipseHandler } from "../src/handlers/ellipse-tool";
import { createLineHandler } from "../src/handlers/line-tool";
import { createPolygonHandler } from "../src/handlers/polygon-tool";
import { createRectangleHandler } from "../src/handlers/rectangle-tool";
import { harness, lastPreview, leaves, ops, previews, rb } from "./support";

const STROKE_PAINT = ["setElementProperty", "setElementProperty"];

describe("Rectangle tool", () => {
  it("DR-01: a drag previews the rubber band and commits ONE insertFrame wearing the graphic default @level:gesture", async () => {
    const { fake, g } = harness();
    const mark = fake.mark();
    await g
      .tool(() => createRectangleHandler())
      .drag({ from: [72, 72], to: [216, 144] })
      .settle();
    // The preview follows the pointer in page-local pt, then clears.
    const shown = previews(fake);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.at(-1)).toEqual({
      pageId: "page-1",
      rect: [72, 72, 144, 216],
    });
    expect(lastPreview(fake)).toBeNull();
    // ONE batch: the insert, then its paint (`[Normal Graphics Frame]`:
    // no fill, a 1 pt Color/Black stroke), so the shape is one undo step.
    const commit = expectOneCommit(fake, mark);
    expect(commit).toMatchObject({ mutation: { op: "batch" } });
    expect(ops(fake)).toEqual(["insertFrame", ...STROKE_PAINT]);
    const [insert, stroke, weight] = leaves(fake);
    expect(insert).toEqual({
      op: "insertFrame",
      args: { pageId: "page-1", bounds: [72, 72, 144, 216] },
    });
    expect(stroke).toMatchObject({
      args: {
        elementId: { id: "$created" },
        path: "frameStrokeColor",
        value: { type: "colorRef", value: "Color/Black" },
      },
    });
    expect(weight).toMatchObject({
      args: { path: "frameStrokeWeight", value: { type: "length", value: 1 } },
    });
    // The fresh shape is selected, with its chrome geometry requested.
    const sel = fake.ofChannel("selection").map((e) => e.method);
    expect(sel).toEqual([
      "client.setElementSelection",
      "setElementSelection",
      "setElementGeometry",
    ]);
  });

  it("the Frame variant commits a plain insertFrame (a placeholder stays unpainted) @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(() => createRectangleHandler({ frame: true }))
      .drag({ from: [72, 72], to: [216, 144] })
      .settle();
    expect(fake.mutations()).toEqual([
      {
        op: "insertFrame",
        args: { pageId: "page-1", bounds: [72, 72, 144, 216] },
      },
    ]);
  });

  it("a document with defaults of its own gets no tool paint (the engine applies them) @level:gesture", async () => {
    const { fake, g } = harness({
      documentMeta: { defaultStrokeColor: "Color/Red" },
    });
    await g
      .tool(() => createRectangleHandler())
      .drag({ from: [72, 72], to: [216, 144] })
      .settle();
    expect(ops(fake)).toEqual(["insertFrame"]);
  });

  it("a document's own [Normal Graphics Frame] style is the paint @level:gesture", async () => {
    const { fake, g } = harness({
      reply: (m) =>
        m.kind === "requestStyleProperties"
          ? {
              kind: "styleProperties",
              payload: {
                result: {
                  entries: [
                    {
                      path: "frameFillColor",
                      value: { type: "colorRef", value: "Color/Paper" },
                    },
                    {
                      path: "frameStrokeColor",
                      value: { type: "colorRef", value: "Color/Blue" },
                    },
                    {
                      path: "frameStrokeWeight",
                      value: { type: "length", value: 0.5 },
                    },
                  ],
                },
              },
            }
          : undefined,
    });
    await g
      .tool(() => createRectangleHandler())
      .drag({ from: [72, 72], to: [216, 144] })
      .settle();
    const paths = leaves(fake)
      .slice(1)
      .map((m) => [
        (m.args as { path: string }).path,
        (m.args as { value: { value: unknown } }).value.value,
      ]);
    expect(paths).toEqual([
      ["frameFillColor", "Color/Paper"],
      ["frameStrokeColor", "Color/Blue"],
      ["frameStrokeWeight", 0.5],
    ]);
  });

  it.each([
    [
      "DR-01 a negative drag normalises",
      [],
      [216, 144],
      [72, 72],
      [72, 72, 144, 216],
    ],
    [
      "DR-02 Shift: a square on the larger extent",
      ["shift"],
      [72, 72],
      [216, 144],
      [72, 72, 216, 216],
    ],
    [
      "DR-02 Shift up-left: the square grows toward the pointer",
      ["shift"],
      [216, 216],
      [180, 72],
      [72, 72, 216, 216],
    ],
    [
      "DR-03 Alt: from the centre",
      ["alt"],
      [144, 144],
      [216, 180],
      [108, 72, 180, 216],
    ],
    [
      "DR-02+03 Shift+Alt: a square from the centre",
      ["shift", "alt"],
      [144, 144],
      [216, 160],
      [72, 72, 216, 216],
    ],
  ] as const)("%s @level:gesture", async (_label, mods, from, to, bounds) => {
    const { fake, g } = harness();
    await g
      .tool(() => createRectangleHandler({ frame: true }))
      .drag({ from, to, mods })
      .settle();
    expect(fake.mutations()).toEqual([
      { op: "insertFrame", args: { pageId: "page-1", bounds: [...bounds] } },
    ]);
  });

  it("INV-5: the constraint is a function of the CURRENT modifiers (Shift released before the release = no square) @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(() => createRectangleHandler({ frame: true }))
      .drag({
        from: [72, 72],
        to: [216, 144],
        steps: 4,
        modsAt: (i, n) => (i < n ? ["shift"] : []),
      })
      .settle();
    // Squared while Shift was held, unsquared once it was let go.
    expect(previews(fake)).toContainEqual({
      pageId: "page-1",
      rect: [72, 72, 180, 180],
    });
    expect(previews(fake).at(-1)).toEqual({
      pageId: "page-1",
      rect: [72, 72, 144, 216],
    });
    expect(fake.mutations()).toEqual([
      {
        op: "insertFrame",
        args: { pageId: "page-1", bounds: [72, 72, 144, 216] },
      },
    ]);
  });

  it("DR-05…07 gridify: arrows mid-drag split the frame; release commits ALL cells as ONE batch @level:gesture", async () => {
    const { fake, g } = harness();
    const mark = fake.mark();
    await expectOneUndoStep(fake, () =>
      g
        .tool(() => createRectangleHandler({ frame: true }))
        .drag({
          from: [72, 72],
          to: [372, 272],
          steps: 6,
          keys: [
            { at: 2, key: "ArrowRight" },
            { at: 3, key: "ArrowRight" },
            { at: 4, key: "ArrowUp" },
          ],
        }),
    );
    const cellsPreview = previews(fake).at(-1) as { cells: number[][] };
    expect(cellsPreview.cells).toHaveLength(6);
    expectOneCommit(fake, mark);
    const cells = leaves(fake).map(
      (m) => (m.args as { bounds: number[] }).bounds,
    );
    expect(cells).toHaveLength(6);
    // 3 columns × 2 rows inside 300 × 200 pt, 12 pt gutters: 92 × 94 pt cells.
    expect(rb(cells[0])).toEqual([72, 72, 166, 164]);
    expect(rb(cells[5])).toEqual([178, 280, 272, 372]);
  });

  it("DR-07: keying back to 1×1 commits one plain frame; arrows with no drag are not consumed @level:gesture", async () => {
    const { fake, g } = harness();
    const handler = createRectangleHandler({ frame: true });
    await g
      .tool(handler)
      .drag({
        from: [72, 72],
        to: [372, 272],
        keys: [
          { at: 2, key: "ArrowRight" },
          { at: 4, key: "ArrowLeft" },
        ],
      })
      .settle();
    expect(fake.mutations()).toEqual([
      {
        op: "insertFrame",
        args: { pageId: "page-1", bounds: [72, 72, 272, 372] },
      },
    ]);
    let prevented = false;
    handler.onKey!({
      key: "ArrowRight",
      preventDefault: () => (prevented = true),
    } as unknown as KeyboardEvent);
    expect(prevented).toBe(false);
  });

  it("INV-2: Escape mid-drag commits nothing and clears the preview; the release after it is inert @level:gesture", async () => {
    const { fake, g } = harness();
    const mark = fake.mark();
    await g
      .tool(() => createRectangleHandler())
      .drag({ from: [72, 72], to: [216, 144], release: false })
      .cancel()
      .up()
      .settle();
    expectNoCommit(fake, mark);
    expect(lastPreview(fake)).toBeNull();
  });

  it("a spring-load suspend keeps the drag (it commits on release); a real switch cancels it @level:gesture", async () => {
    const { fake, g } = harness();
    const handler = createRectangleHandler({ frame: true });
    await g
      .tool(handler)
      .drag({ from: [72, 72], to: [216, 144], release: false })
      .do(() => handler.onDeactivate("suspend"))
      .up()
      .settle();
    expect(fake.mutations()).toHaveLength(1);
    const other = createRectangleHandler({ frame: true });
    await g
      .tool(other)
      .drag({ from: [72, 72], to: [216, 144], release: false })
      .do(() => other.onDeactivate("switch"))
      .up()
      .settle();
    expect(fake.mutations()).toHaveLength(1);
  });

  it("a press on the pasteboard or with the secondary button draws nothing; a drag ending off the page still lands on the start page @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(() => createRectangleHandler({ frame: true }))
      .drag({ from: [700, 100], to: [800, 200] })
      .drag({ from: [72, 72], to: [216, 144], button: 2 })
      .settle();
    expect(fake.mutations()).toEqual([]);
    await g.drag({ from: [500, 700], to: [700, 900] }).settle();
    expect(fake.mutations()).toEqual([
      {
        op: "insertFrame",
        args: { pageId: "page-1", bounds: [700, 500, 900, 700] },
      },
    ]);
  });

  it("the click-vs-drag threshold is in screen px: a 2.5 pt drag shows a preview at 400% and none at 100% @level:gesture", async () => {
    for (const [zoom, shown] of [
      [4, true],
      [1, false],
    ] as const) {
      const { fake, g } = harness({ zoom });
      await g
        .tool(() => createRectangleHandler({ frame: true }))
        .drag({ from: [72, 72], to: [74.5, 74.5] })
        .settle();
      expect(previews(fake).length > 0).toBe(shown);
    }
  });

  // INV-6 (gestures.md §5): click-vs-drag is decided in SCREEN px. The
  // handler decides it in document pt (≥ 1 pt draws), so at 25% a 3 px
  // click jitter (12 pt) draws a 12 pt frame where InDesign would open
  // the size dialog. Found by these tests (GT-1).
  test.failing(
    "[GT-1] a click within the screen-px threshold draws nothing at 25% zoom @level:gesture",
    async () => {
      const { fake, g } = harness({ zoom: 0.25 });
      await g
        .tool(() => createRectangleHandler({ frame: true }))
        .drag({ from: [72, 72], to: [84, 84] })
        .settle();
      expect(fake.mutations()).toEqual([]);
    },
  );

  it("a click (under 1 pt) draws nothing @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(() => createRectangleHandler())
      .click([72, 72])
      .settle();
    expect(fake.mutations()).toEqual([]);
  });

  it("an engine refusal is reported, not thrown, and selects nothing @level:gesture", async () => {
    const { fake, g } = harness({ refuse: () => "no" });
    const warn = console.warn;
    const said: unknown[] = [];
    console.warn = (...a: unknown[]) => void said.push(a);
    try {
      await g
        .tool(() => createRectangleHandler())
        .drag({ from: [72, 72], to: [216, 144] })
        .settle();
    } finally {
      console.warn = warn;
    }
    expect(said).toHaveLength(1);
    expect(fake.ofChannel("selection")).toEqual([]);
  });
});

describe("Ellipse tool", () => {
  it("DR-01: previews the inscribed ellipse as a closed 48-point ring; commits ONE insertOval @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(() => createEllipseHandler())
      .drag({ from: [100, 100], to: [300, 200] })
      .settle();
    const ring = previews(fake).at(-1) as {
      points: Array<[number, number]>;
      close: boolean;
    };
    expect(ring.close).toBe(true);
    expect(ring.points).toHaveLength(48);
    // Every point is on the ellipse centred (200,150) with radii 100 × 50.
    for (const [x, y] of ring.points)
      expect(((x - 200) / 100) ** 2 + ((y - 150) / 50) ** 2).toBeCloseTo(1, 9);
    expect(ops(fake)).toEqual(["insertOval", ...STROKE_PAINT]);
    expect(leaves(fake)[0]).toEqual({
      op: "insertOval",
      args: { pageId: "page-1", bounds: [100, 100, 200, 300] },
    });
  });

  it.each([
    [
      "Shift: a circle",
      ["shift"],
      [100, 100],
      [300, 160],
      [100, 100, 300, 300],
    ],
    [
      "Alt: from the centre",
      ["alt"],
      [200, 200],
      [260, 230],
      [170, 140, 230, 260],
    ],
  ] as const)("%s @level:gesture", async (_l, mods, from, to, bounds) => {
    const { fake, g } = harness();
    await g
      .tool(() => createEllipseHandler({ frame: true }))
      .drag({ from, to, mods })
      .settle();
    expect(fake.mutations()).toEqual([
      { op: "insertOval", args: { pageId: "page-1", bounds: [...bounds] } },
    ]);
  });

  it("Escape commits nothing @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(() => createEllipseHandler())
      .drag({ from: [100, 100], to: [300, 200], release: false })
      .cancel()
      .up()
      .settle();
    expectNoCommit(fake);
  });
});

describe("Polygon tool", () => {
  it("draws the default hexagon (6 corner anchors, first at 12 o'clock) as ONE closed insertPath @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(() => createPolygonHandler({ frame: true }))
      .drag({ from: [100, 100], to: [300, 300] })
      .settle();
    const [m] = fake.mutations() as Array<{
      op: string;
      args: {
        anchors: Array<{ anchor: number[]; left: number[]; right: number[] }>;
        open: boolean;
        smooth: boolean;
      };
    }>;
    expect(m.op).toBe("insertPath");
    expect(m.args.open).toBe(false);
    expect(m.args.smooth).toBe(false);
    expect(m.args.anchors).toHaveLength(6);
    expect(rb(m.args.anchors[0].anchor)).toEqual([200, 100]);
    for (const a of m.args.anchors) {
      expect(a.left).toEqual(a.anchor);
      expect(a.right).toEqual(a.anchor);
      expect(Math.hypot(a.anchor[0] - 200, a.anchor[1] - 200)).toBeCloseTo(
        100,
        9,
      );
    }
  });

  it("reads sides and star inset from the tool settings: a 5-point star has 10 anchors, inner radius × (1 − inset) @level:gesture", async () => {
    const { fake, g } = harness({
      toolSettings: { "paged.tool.polygon": { sides: 5, starInset: 40 } },
    });
    await g
      .tool(() => createPolygonHandler())
      .drag({ from: [100, 100], to: [300, 300] })
      .settle();
    const anchors = (
      leaves(fake)[0].args as { anchors: Array<{ anchor: number[] }> }
    ).anchors;
    expect(anchors).toHaveLength(10);
    const radii = anchors.map((a) =>
      Math.hypot(a.anchor[0] - 200, a.anchor[1] - 200),
    );
    radii.forEach((rad, i) =>
      expect(rad).toBeCloseTo(i % 2 === 0 ? 100 : 60, 9),
    );
    // The preview is the same vertex ring, closed.
    expect(
      (previews(fake).at(-1) as { points: unknown[]; close: boolean }).points,
    ).toHaveLength(10);
  });

  it("clamps the settings (sides 3…100, inset 0…100) @level:gesture", async () => {
    const { fake, g } = harness({
      toolSettings: { "paged.tool.polygon": { sides: 1, starInset: -5 } },
    });
    await g
      .tool(() => createPolygonHandler({ frame: true }))
      .drag({ from: [100, 100], to: [300, 300] })
      .settle();
    expect(
      (leaves(fake)[0].args as { anchors: unknown[] }).anchors,
    ).toHaveLength(3);
  });

  it("Shift squares the bounds @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(() => createPolygonHandler({ frame: true }))
      .drag({ from: [100, 100], to: [300, 140], mods: ["shift"] })
      .settle();
    const xs = (
      leaves(fake)[0].args as { anchors: Array<{ anchor: number[] }> }
    ).anchors.map((a) => a.anchor[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(150);
  });
});

describe("Line tool", () => {
  it("previews the segment and commits ONE insertLine with a stroke but never a fill @level:gesture", async () => {
    const { fake, g } = harness({
      reply: (m) =>
        m.kind === "requestStyleProperties"
          ? {
              kind: "styleProperties",
              payload: {
                result: {
                  entries: [
                    {
                      path: "frameFillColor",
                      value: { type: "colorRef", value: "Color/Paper" },
                    },
                  ],
                },
              },
            }
          : undefined,
    });
    await g
      .tool(() => createLineHandler())
      .drag({ from: [100, 100], to: [250, 180] })
      .settle();
    expect(previews(fake).at(-1)).toEqual({
      pageId: "page-1",
      points: [
        [100, 100],
        [250, 180],
      ],
    });
    expect(leaves(fake)[0]).toEqual({
      op: "insertLine",
      args: { pageId: "page-1", start: [100, 100], end: [250, 180] },
    });
    expect(
      leaves(fake).some(
        (m) => (m.args as { path?: string }).path === "frameFillColor",
      ),
    ).toBe(false);
  });

  it("Shift constrains to 45° keeping the length @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(() => createLineHandler())
      .drag({ from: [100, 100], to: [200, 120], mods: ["shift"] })
      .settle();
    const { start, end } = leaves(fake)[0].args as {
      start: number[];
      end: number[];
    };
    expect(rb(end)).toEqual([r(100 + Math.hypot(100, 20)), 100]);
    expect(start).toEqual([100, 100]);
  });

  it("a line under 1 pt is not drawn; Escape commits nothing @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(() => createLineHandler())
      .click([100, 100])
      .drag({ from: [100, 100], to: [200, 200], release: false })
      .cancel()
      .up()
      .settle();
    expect(fake.mutations()).toEqual([]);
  });
});

const r = (n: number) => Math.round(n * 1e6) / 1e6;
