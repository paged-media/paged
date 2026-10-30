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

// Free Transform (editor ADR 295) through the gesture DSL against the
// editor-shaped fake: each arm and its modifiers become the right ENGINE
// gesture (translate / scale / rotate / shear, one commit each), and the
// distort / perspective arms one framePath batch (one commit) with every
// anchor mapped — or a refusal with nothing written.

import { describe, expect, it } from "bun:test";

import type { ElementId, PathAnchorsResult } from "@paged-media/client";
import { covers, expectNoCommit, expectOneCommit } from "@paged-media/test-kit";

import {
  createFreeTransformHandler,
  distortBatchFor,
  freeTransformBoxOf,
  referencePointOf,
} from "../src";
import { harness, leaves } from "./support";

const RECT = { kind: "rectangle", id: "r1" } as ElementId;
const POLY = { kind: "polygon", id: "p1" } as ElementId;
const TEXT = { kind: "textFrame", id: "t1" } as ElementId;

/** A 200 × 100 box at (100, 100) on page-1. */
const BOUNDS: [number, number, number, number] = [100, 100, 200, 300];

const geometry = (id: ElementId) => ({
  id,
  pageId: "page-1",
  bounds: BOUNDS,
});

const square = (x0: number, y0: number, x1: number, y1: number) =>
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map((p) => ({ anchor: p, left: p, right: p }));

const pathOf = (id: ElementId): PathAnchorsResult =>
  ({
    id,
    pageId: "page-1",
    anchors: square(100, 100, 300, 200),
    subpathStarts: [],
    itemTransform: null,
  }) as unknown as PathAnchorsResult;

function setup(
  selection: ElementId[] = [RECT],
  settings?: Record<string, string>,
) {
  return harness({
    selection,
    geometry,
    pathAnchors: pathOf,
    ...(settings
      ? { toolSettings: { "paged.tool.freeTransform": settings } }
      : {}),
  });
}

type Msg = {
  message: string;
  gesture?: { kind: string };
  anchor?: Record<string, unknown>;
  delta?: number[];
  modifiers?: Record<string, boolean>;
};
const msgs = (fake: ReturnType<typeof harness>["fake"]): Msg[] =>
  fake.gestureMessages().map((m) => ({
    message: m.message,
    ...(m.payload as object),
  }));

describe("Free Transform tool [editor-tools.free-transform]", () => {
  it("a drag inside the box moves the selection: one translate gesture @level:gesture", async () => {
    covers("tool:paged.tool.freeTransform");
    const { fake, g } = setup();
    const mark = fake.mark();
    await g
      .tool(createFreeTransformHandler)
      .drag({ from: [150, 150], to: [190, 170], steps: 3 })
      .settle();
    const m = msgs(fake);
    expect(m[0]).toMatchObject({
      message: "beginGesture",
      gesture: { kind: "translate" },
      anchor: { pageId: "page-1", pointInPage: [150, 150] },
    });
    expect(m.filter((x) => x.message === "updateGesture").at(-1)).toMatchObject(
      {
        delta: [40, 20],
      },
    );
    expect(m.at(-1)?.message).toBe("commitGesture");
    expectOneCommit(fake, mark);
  });

  it("a corner scales from the opposite corner; Alt from the centre; Shift passes through @level:gesture", async () => {
    const { fake, g } = setup();
    await g
      .tool(createFreeTransformHandler)
      .drag({ from: [300, 200], to: [350, 230], mods: ["shift"] })
      .settle();
    const first = msgs(fake)[0]!;
    expect(first).toMatchObject({
      gesture: { kind: "scale" },
      anchor: { pointInPage: [300, 200], pivotInPage: [100, 100] },
    });
    expect(
      msgs(fake)
        .filter((x) => x.message === "updateGesture")
        .at(-1)!.modifiers,
    ).toMatchObject({ shift: true });

    const alt = setup();
    await alt.g
      .tool(createFreeTransformHandler)
      .drag({ from: [300, 150], to: [350, 150], mods: ["alt"] })
      .settle();
    expect(msgs(alt.fake)[0]).toMatchObject({
      gesture: { kind: "scale" },
      anchor: { pointInPage: [300, 150], pivotInPage: [200, 150] },
    });
  });

  it("the Constrain mode scales proportionally without Shift @level:gesture", async () => {
    const { fake, g } = setup([RECT], { mode: "constrain" });
    await g
      .tool(createFreeTransformHandler)
      .drag({ from: [300, 200], to: [350, 230] })
      .settle();
    expect(
      msgs(fake)
        .filter((x) => x.message === "updateGesture")
        .at(-1)!.modifiers,
    ).toMatchObject({ shift: true });
  });

  it("outside a corner rotates about the reference point (the 9-grid picks it) @level:gesture", async () => {
    const { fake, g } = setup();
    await g
      .tool(createFreeTransformHandler)
      .drag({ from: [312, 212], to: [250, 260], mods: ["shift"] })
      .settle();
    expect(msgs(fake)[0]).toMatchObject({
      gesture: { kind: "rotate" },
      anchor: { pointInPage: [312, 212], pivotInPage: [200, 150] },
    });
    const nw = setup([RECT], { reference: "nw" });
    await nw.g
      .tool(createFreeTransformHandler)
      .drag({ from: [312, 212], to: [250, 260] })
      .settle();
    expect(msgs(nw.fake)[0]!.anchor).toMatchObject({ pivotInPage: [100, 100] });
  });

  it("Cmd on a side shears about the opposite side: x for top/bottom, y for left/right @level:gesture", async () => {
    const top = setup();
    await top.g
      .tool(createFreeTransformHandler)
      .drag({ from: [200, 100], to: [240, 100], mods: ["cmd"] })
      .settle();
    expect(msgs(top.fake)[0]).toMatchObject({
      gesture: { kind: "shear" },
      anchor: {
        pointInPage: [200, 100],
        pivotInPage: [200, 200],
        shearAxis: "x",
      },
    });
    const side = setup();
    const mark = side.fake.mark();
    await side.g
      .tool(createFreeTransformHandler)
      .drag({ from: [300, 150], to: [300, 190], mods: ["cmd"] })
      .settle();
    expect(msgs(side.fake)[0]).toMatchObject({
      gesture: { kind: "shear" },
      anchor: {
        pointInPage: [300, 150],
        pivotInPage: [100, 150],
        shearAxis: "y",
      },
    });
    expectOneCommit(side.fake, mark);
  });

  it("Ctrl is Cmd off the Mac: Ctrl on a side shears @level:gesture", async () => {
    const { fake, g } = setup();
    await g
      .tool(createFreeTransformHandler)
      .drag({ from: [200, 100], to: [240, 100], mods: ["ctrl"] })
      .settle();
    expect(msgs(fake)[0]).toMatchObject({
      gesture: { kind: "shear" },
      anchor: { shearAxis: "x" },
    });
  });

  it("Cmd on a corner free-distorts the path: one framePath, the corner moved, no gesture @level:gesture", async () => {
    const { fake, g } = setup([POLY]);
    const mark = fake.mark();
    await g
      .tool(createFreeTransformHandler)
      .drag({ from: [300, 200], to: [340, 240], mods: ["cmd"] })
      .settle();
    expect(fake.gestureMessages()).toEqual([]);
    expectOneCommit(fake, mark);
    const write = leaves(fake).find((m) => m.op === "setElementProperty") as {
      args: {
        path: string;
        value: { value: { anchors: { anchor: number[] }[] } };
      };
    };
    expect(write.args.path).toBe("framePath");
    const a = write.args.value.value.anchors.map((x) => x.anchor);
    expect(a[2]).toEqual([340, 240]);
    expect(a[0]).toEqual([100, 100]);
    expect(a[1]).toEqual([300, 100]);
  });

  it("Cmd+Alt+Shift on a corner is perspective: the partner corner mirrors @level:gesture", async () => {
    const { fake, g } = setup([POLY]);
    await g
      .tool(createFreeTransformHandler)
      .drag({ from: [300, 100], to: [340, 104], mods: ["cmd", "alt", "shift"] })
      .settle();
    const write = leaves(fake).find((m) => m.op === "setElementProperty") as {
      args: { value: { value: { anchors: { anchor: number[] }[] } } };
    };
    const a = write.args.value.value.anchors.map((x) =>
      x.anchor.map((v) => Math.round(v * 1e6) / 1e6),
    );
    expect(a[1]).toEqual([340, 100]);
    expect(a[0]).toEqual([60, 100]);
    expect(a[2]).toEqual([300, 200]);
  });

  it("the Free Distort mode distorts without Cmd", async () => {
    const { fake, g } = setup([POLY], { mode: "freeDistort" });
    await g
      .tool(createFreeTransformHandler)
      .drag({ from: [100, 200], to: [80, 230] })
      .settle();
    expect(leaves(fake).map((m) => m.op)).toEqual(["setElementProperty"]);
  });

  it("distorting a text frame is refused with the reason on the canvas; nothing is written @level:gesture", async () => {
    const { fake, g } = setup([TEXT]);
    const mark = fake.mark();
    await g
      .tool(createFreeTransformHandler)
      .drag({ from: [300, 200], to: [340, 240], mods: ["cmd"] })
      .settle();
    expectNoCommit(fake, mark);
    const label = (fake.previews() as unknown[])
      .flat()
      .find((s) => (s as { kind?: string })?.kind === "text") as {
      text: string;
    };
    expect(label.text).toMatch(/text frame/);
  });

  it("INV-2: Escape mid-drag cancels the engine gesture @level:gesture", async () => {
    const { fake, g } = setup();
    const mark = fake.mark();
    await g
      .tool(createFreeTransformHandler)
      .drag({ from: [150, 150], to: [190, 170], release: false })
      .settle()
      .cancel()
      .up()
      .settle();
    expectNoCommit(fake, mark);
    expect(msgs(fake).map((m) => m.message)).toContain("cancelGesture");
  });

  it("the reference point draws as a centre handle and can be dragged", async () => {
    const { fake, g } = setup();
    await g
      .tool(createFreeTransformHandler)
      .drag({ from: [200, 150], to: [120, 110] })
      .settle();
    const centre = (fake.previews() as unknown[])
      .flat()
      .filter((s) => (s as { shape?: string })?.shape === "centre")
      .at(-1) as { x: number; y: number };
    expect([centre.x, centre.y]).toEqual([120, 110]);
    expect(fake.gestureMessages()).toEqual([]);
  });
});

describe("Free Transform geometry [editor-tools.free-transform]", () => {
  it("the box of one turned item is its own turned box; of several the union", () => {
    const c = Math.SQRT1_2;
    const one = freeTransformBoxOf([
      {
        id: RECT,
        pageId: "page-1",
        bounds: [0, 0, 10, 10],
        itemTransform: [c, c, -c, c, 50, 50],
      } as never,
    ])!;
    expect(one.quad[1][0]).toBeCloseTo(50 + 10 * c);
    expect(one.quad[1][1]).toBeCloseTo(50 + 10 * c);
    const two = freeTransformBoxOf([
      { id: RECT, pageId: "page-1", bounds: [0, 0, 10, 10] } as never,
      { id: POLY, pageId: "page-1", bounds: [20, 30, 40, 50] } as never,
    ])!;
    expect(two.quad).toEqual([
      [0, 0],
      [50, 0],
      [50, 40],
      [0, 40],
    ]);
    expect(two.targets).toHaveLength(2);
  });

  it("the nine reference points sit on the box's corners, sides and centre", () => {
    const q = freeTransformBoxOf([geometry(RECT) as never])!.quad;
    expect(referencePointOf(q, "nw")).toEqual([100, 100]);
    expect(referencePointOf(q, "s")).toEqual([200, 200]);
    expect(referencePointOf(q, "c")).toEqual([200, 150]);
  });

  it("the distort batch maps anchors AND handles through the item's own transform", () => {
    const path = {
      id: POLY,
      anchors: [{ anchor: [0, 0], left: [-5, 0], right: [5, 0] }],
      subpathStarts: [],
      // Inner (0,0) is page (100, 50).
      itemTransform: [1, 0, 0, 1, 100, 50],
    } as unknown as PathAnchorsResult;
    const batch = distortBatchFor([path], ([x, y]) => [x * 2, y + 10]) as {
      args: {
        value: { value: { anchors: { anchor: number[]; left: number[] }[] } };
      };
    };
    const a = batch.args.value.value.anchors[0]!;
    // page (100,50) → (200,60) → inner (100,10); left (95,50) → (190,60) → (90,10).
    expect(a.anchor).toEqual([100, 10]);
    expect(a.left).toEqual([90, 10]);
  });
});
