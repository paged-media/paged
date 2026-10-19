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

// The freehand and point-placing tools (Pen, Pencil) and the Type tool's
// drag, driven through the gesture DSL against the editor-shaped fake.

import { describe, expect, it, test } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { expectNoCommit, expectOneCommit } from "@paged-media/test-kit";

import { createPencilHandler } from "../src/handlers/pencil-tool";
import { createPenHandler } from "../src/handlers/pen-tool";
import { createTypeHandler } from "../src/handlers/type-tool";
import { harness, lastPreview, leaves, ops, previews, rb } from "./support";

type Anchor = { anchor: number[]; left: number[]; right: number[] };
const insertedAnchors = (fake: ReturnType<typeof harness>["fake"]) =>
  (leaves(fake).find((m) => m.op === "insertPath")?.args as
    { anchors: Anchor[]; open: boolean } | undefined) ?? null;

// Points clear of the page's snap targets (edges, centre lines) and of
// each other's x / y lines, so the Pen's snapping leaves them alone.
const A: [number, number] = [100, 100];
const B: [number, number] = [220, 160];
const C: [number, number] = [150, 260];

describe("Pen tool", () => {
  it("three clicks and Enter commit ONE open insertPath of three corner anchors (painted, selected) @level:gesture", async () => {
    const { fake, g } = harness();
    const mark = fake.mark();
    await g.tool(createPenHandler).click(A).settle().click(B).settle();
    // A true-cubic preview of the run so far (B-07), not a polyline.
    expect(lastPreview(fake)).toMatchObject({
      pageId: "page-1",
      anchors: [{ anchor: A }, { anchor: B }],
    });
    await g.click(C).settle().key("Enter").settle();
    expectOneCommit(fake, mark);
    expect(ops(fake)).toEqual([
      "insertPath",
      "setElementProperty",
      "setElementProperty",
    ]);
    const path = insertedAnchors(fake)!;
    expect(path.open).toBe(true);
    expect(path.anchors.map((a) => a.anchor)).toEqual([A, B, C]);
    for (const a of path.anchors)
      expect([a.left, a.right]).toEqual([a.anchor, a.anchor]);
    expect(lastPreview(fake)).toBeNull();
  });

  it("a click on the first anchor closes the path @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(createPenHandler)
      .click(A)
      .settle()
      .click(B)
      .settle()
      .click(C)
      .settle()
      .click(A)
      .settle();
    expect(insertedAnchors(fake)!.open).toBe(false);
    expect(insertedAnchors(fake)!.anchors).toHaveLength(3);
  });

  it("a click-drag makes a smooth anchor whose handles mirror through it @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(createPenHandler)
      .click(A)
      .settle()
      .drag({ from: B, to: [260, 160] })
      .settle()
      .click(C)
      .settle()
      .key("Enter")
      .settle();
    const smooth = insertedAnchors(fake)!.anchors[1];
    expect(rb(smooth.right)).toEqual([260, 160]);
    expect(rb(smooth.left)).toEqual([180, 160]);
  });

  it("Shift constrains the next anchor to 45° from the last @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(createPenHandler)
      .click(A)
      .settle()
      .click([240, 112], { mods: ["shift"] })
      .settle()
      .key("Enter")
      .settle();
    const [, b] = insertedAnchors(fake)!.anchors;
    expect(b.anchor[1]).toBeCloseTo(100, 6);
  });

  it("INV-2: Escape drops the run; nothing commits @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(createPenHandler)
      .click(A)
      .settle()
      .click(B)
      .settle()
      .key("Escape")
      .settle();
    expectNoCommit(fake);
    expect(lastPreview(fake)).toBeNull();
  });

  it("a tool switch commits the open run (Illustrator); a spring-load suspend keeps it @level:gesture", async () => {
    const { fake, g } = harness();
    const pen = createPenHandler();
    await g.tool(pen).click(A).settle().click(B).settle();
    pen.onDeactivate("suspend");
    await fake.settle();
    expect(fake.mutations()).toEqual([]);
    pen.onDeactivate("switch");
    await fake.settle();
    expect(insertedAnchors(fake)!.anchors.map((a) => a.anchor)).toEqual([A, B]);
  });

  it("hovering over the first anchor with a run in progress shows the close cursor @level:gesture", async () => {
    const { g } = harness();
    await g
      .tool(createPenHandler)
      .click(A)
      .settle()
      .click(B)
      .settle()
      .hover([101, 101])
      .settle();
    expect(await g.cursorAt([101, 101])).toEqual({
      kind: "css",
      token: "pointer",
    });
  });

  it("pressing on an open path's endpoint continues THAT path (an edit, not a new path) @level:gesture", async () => {
    const path = { kind: "polygon", id: "p1" } as ElementId;
    const table = {
      id: path,
      pageId: "page-1",
      anchors: [
        { anchor: [100, 400], left: [100, 400], right: [100, 400] },
        { anchor: [200, 450], left: [200, 450], right: [200, 450] },
      ],
      subpathStarts: [0],
      subpathOpen: [true],
      itemTransform: null,
    };
    const { fake, g } = harness({
      marqueeHits: (_p, [t, l, b, r]) =>
        l <= 200 && r >= 200 && t <= 450 && b >= 450 ? [path] : [],
      pathAnchors: (id) => (id.id === "p1" ? (table as never) : null),
    });
    await g
      .tool(createPenHandler)
      .click([200, 450])
      .settle()
      .click([300, 380])
      .settle()
      .key("Enter")
      .settle();
    expect(ops(fake)).not.toContain("insertPath");
    expect(leaves(fake).every((m) => JSON.stringify(m).includes('"p1"'))).toBe(
      true,
    );
  });
});

describe("Pencil tool", () => {
  it("previews the raw stroke and commits ONE smooth open insertPath of the simplified points @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(createPencilHandler)
      .drag({ from: [100, 100], to: [300, 100], steps: 10 })
      .settle();
    expect(
      (previews(fake).at(-1) as { points: unknown[] }).points.length,
    ).toBeGreaterThan(5);
    const m = leaves(fake)[0] as {
      op: string;
      args: { anchors: Anchor[]; open: boolean; smooth: boolean };
    };
    expect(m.op).toBe("insertPath");
    expect(m.args.open).toBe(true);
    expect(m.args.smooth).toBe(true);
    // A straight stroke simplifies to its two ends.
    expect(m.args.anchors.map((a) => a.anchor)).toEqual([
      [100, 100],
      [300, 100],
    ]);
  });

  it("the simplification tolerance is in screen px: a 1 pt wobble is dropped at 100% and kept at 400% @level:gesture", async () => {
    const counts: number[] = [];
    for (const zoom of [1, 4]) {
      const { fake, g } = harness({ zoom });
      await g
        .tool(createPencilHandler)
        .drag({
          from: [100, 100],
          to: [300, 100],
          via: [
            [150, 101],
            [200, 99],
            [250, 101],
          ],
          steps: 2,
        })
        .settle();
      counts.push(
        (leaves(fake)[0].args as { anchors: unknown[] }).anchors.length,
      );
    }
    expect(counts[0]).toBe(2);
    expect(counts[1]).toBeGreaterThan(2);
  });

  it("a PEN stroke bakes its pressure into a variable-width outline in the same batch (one undo step) @level:gesture", async () => {
    const { fake, g } = harness();
    const mark = fake.mark();
    await g
      .tool(createPencilHandler)
      .drag({
        from: [100, 100],
        to: [300, 200],
        via: [[200, 120]],
        steps: 6,
        device: "pen",
        pressureAt: (i, n) => i / n,
      })
      .settle();
    expectOneCommit(fake, mark);
    const variable = leaves(fake).find(
      (m) => (m.args as { path?: string }).path === "outlineStrokeVariable",
    );
    const widths = (
      variable!.args as { value: { value: { widths: number[] } } }
    ).value.value.widths;
    expect(widths.length).toBeGreaterThanOrEqual(2);
    // Light at the press, heavy as the pressure ramps (the lift reads 0).
    expect(Math.max(...widths)).toBeGreaterThan(widths[0]);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(0.5);
    expect(Math.max(...widths)).toBeLessThanOrEqual(4);
  });

  it("a mouse stroke stays a plain stroke (no outline op) @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(createPencilHandler)
      .drag({ from: [100, 100], to: [300, 200], via: [[200, 120]] })
      .settle();
    expect(ops(fake)).not.toContain("outlineStrokeVariable");
    expect(
      leaves(fake).some(
        (m) => (m.args as { path?: string }).path === "outlineStrokeVariable",
      ),
    ).toBe(false);
  });

  it("INV-2: Escape mid-stroke commits nothing @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(createPencilHandler)
      .drag({ from: [100, 100], to: [300, 200], release: false })
      .cancel()
      .up()
      .settle();
    expectNoCommit(fake);
  });

  // A click is not a stroke: the handler keeps the press and the release
  // as two samples and commits a path whose two anchors coincide.
  // Found by these tests (GT-2).
  test.failing(
    "[GT-2] a click with the Pencil draws nothing @level:gesture",
    async () => {
      const { fake, g } = harness();
      await g.tool(createPencilHandler).click([100, 100]).settle();
      expect(fake.mutations()).toEqual([]);
    },
  );
});

describe("Type tool (the drag)", () => {
  it("a drag pulls out ONE text frame, selects it, and puts the caret in its new story @level:gesture", async () => {
    let stories = [{ selfId: "s0" }];
    const { fake, g } = harness({
      collections: {
        get stories() {
          return stories;
        },
      } as never,
      refuse: (m) => {
        if (m.op === "insertTextFrame")
          stories = [...stories, { selfId: "s1" }];
        return null;
      },
    });
    const mark = fake.mark();
    await g
      .tool(createTypeHandler)
      .drag({ from: [100, 100], to: [300, 160] })
      .settle();
    expect(previews(fake).at(-1)).toEqual({
      pageId: "page-1",
      rect: [100, 100, 160, 300],
    });
    expectOneCommit(fake, mark);
    expect(fake.mutations()).toEqual([
      {
        op: "insertTextFrame",
        args: { pageId: "page-1", bounds: [100, 100, 160, 300] },
      },
    ]);
    expect(fake.contentSelection()).toEqual({
      storyId: "s1",
      start: 0,
      end: 0,
      affinity: false,
    });
  });

  it("a drag that starts over an existing text frame creates nothing @level:gesture", async () => {
    const { fake, g } = harness({
      hitTest: (_p, _pt, filter) =>
        filter === "text"
          ? ({ kind: "textFrame", id: "t" } as ElementId)
          : null,
    });
    await g
      .tool(createTypeHandler)
      .drag({ from: [100, 100], to: [300, 160] })
      .settle();
    expect(fake.mutations()).toEqual([]);
  });

  // The Rectangle handler resolves BOTH corners against the page the drag
  // started on; the Type handler reads the release point off the page
  // under the pointer, so a drag released over the pasteboard pulls out
  // nothing, and one released over another page mixes the two pages'
  // coordinates. Found by the gesture matrix at 25% (GT-3).
  test.failing(
    "[GT-3] a drag released over the pasteboard still pulls out the frame, on the start page @level:gesture",
    async () => {
      const { fake, g } = harness();
      await g
        .tool(createTypeHandler)
        .drag({ from: [500, 600], to: [700, 700] })
        .settle();
      expect(fake.mutations()).toEqual([
        {
          op: "insertTextFrame",
          args: { pageId: "page-1", bounds: [600, 500, 700, 700] },
        },
      ]);
    },
  );

  it("a frame under 8 pt on either axis is not pulled out @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(createTypeHandler)
      .drag({ from: [100, 100], to: [300, 106] })
      .settle();
    expect(fake.mutations()).toEqual([]);
  });
});
