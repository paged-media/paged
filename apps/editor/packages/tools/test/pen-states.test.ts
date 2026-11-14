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

// The Pen's named states (UXI-DRW-003, paged.draw ADR 370): start,
// draw, continue, close, join, dragHandle, finish, add and delete, each
// with its own cursor and hint; a click on the run's last anchor finishes
// the open path as one undo step.

import { describe, expect, it } from "bun:test";

import { covers, expectNoCommit, expectOneCommit } from "@paged-media/test-kit";

import { createPenHandler } from "../src/handlers/pen-tool";
import {
  overLastAnchor,
  penCursor,
  penHint,
  penStateOf,
  type PenState,
} from "../src/handlers/pen-states";
import { harness, leaves } from "./support";

const A: [number, number] = [100, 100];
const B: [number, number] = [220, 160];
const C: [number, number] = [150, 260];

const ALL: PenState[] = [
  "start",
  "draw",
  "continue",
  "close",
  "join",
  "dragHandle",
  "finish",
  "add",
  "delete",
];

const anchor = (p: [number, number]) => ({ anchor: p, left: p, right: p });
const snap = (
  anchors: number,
  intent: "draw" | "continue" | "close" | "join" | "add" | "delete",
) => ({
  active: true,
  intent,
  anchors: Array.from({ length: anchors }, (_, i) =>
    anchor([i * 10, i * 10] as [number, number]),
  ),
});
const idle = { pressed: false, dragging: false, overLastAnchor: false };

type HintLayer = { key?: string; method: string; value: unknown };
const hints = (fake: ReturnType<typeof harness>["fake"], since: number) =>
  fake
    .since(since)
    .filter(
      (e) =>
        (e as unknown as HintLayer).key === "paged.tool.pen.hint" &&
        (e as unknown as HintLayer).method === "setOverlayLayer",
    )
    .map(
      (e) =>
        ((e as unknown as HintLayer).value as Array<{ text: string }>)[0]!.text,
    );

describe("The Pen's states (UXI-DRW-003)", () => {
  it("Pen states — every state has a cursor of its own, and the states follow the machine @uxi:UXI-DRW-003 @level:unit", () => {
    covers("tool:paged.tool.pen");
    const specs = ALL.map((s) => JSON.stringify(penCursor(s)));
    expect(new Set(specs).size).toBe(ALL.length);
    // Nothing in progress: a press starts a path.
    expect(penStateOf(null, idle)).toBe("start");
    expect(penStateOf(snap(0, "draw"), idle)).toBe("start");
    // A run in progress: the next anchor.
    expect(penStateOf(snap(1, "draw"), idle)).toBe("draw");
    // The machine's intents come through as states.
    for (const i of ["continue", "close", "join", "add", "delete"] as const)
      expect(penStateOf(snap(2, i), idle)).toBe(i);
    // A held, moved press that placed an anchor pulls its handle; a press
    // that closes does not.
    const drag = { pressed: true, dragging: true, overLastAnchor: false };
    expect(penStateOf(snap(2, "draw"), drag)).toBe("dragHandle");
    expect(penStateOf(snap(2, "close"), drag)).toBe("close");
    // Over the last anchor, released: finish (not while the button is
    // down, not with one anchor).
    const last = { pressed: false, dragging: false, overLastAnchor: true };
    expect(penStateOf(snap(2, "draw"), last)).toBe("finish");
    expect(penStateOf(snap(1, "draw"), last)).toBe("draw");
    expect(penStateOf(snap(2, "draw"), { ...last, pressed: true })).toBe(
      "draw",
    );
    // Every state but the plain start says something beside the pointer.
    for (const s of ALL) expect(penHint(s) === null).toBe(s === "start");
    expect(
      overLastAnchor(
        { active: true, anchors: [anchor(A), anchor(B)] },
        [B[0] + 2, B[1] - 2],
        6,
      ),
    ).toBe(true);
    expect(
      overLastAnchor({ active: true, anchors: [anchor(A), anchor(B)] }, A, 6),
    ).toBe(false);
  });

  it("Pen states — on the canvas: start, draw, close and finish cursors, and the hint beside the pointer @uxi:UXI-DRW-003 @level:gesture", async () => {
    const { fake, g } = harness();
    const pen = createPenHandler();
    await g.tool(pen).hover([300, 300]).settle();
    expect(await g.cursorAt([300, 300])).toEqual(penCursor("start"));
    const mark = fake.mark();
    await g.click(A).settle().hover([300, 300]).settle();
    expect(await g.cursorAt([300, 300])).toEqual(penCursor("draw"));
    await g.click(B).settle().hover([101, 101]).settle();
    expect(await g.cursorAt([101, 101])).toEqual(penCursor("close"));
    await g.hover([221, 161]).settle();
    expect(await g.cursorAt([221, 161])).toEqual(penCursor("finish"));
    // The hint names each state in words.
    const texts = hints(fake, mark);
    expect(texts).toContain(
      "Click: corner · drag: smooth · Enter: finish · Esc: cancel",
    );
    expect(texts).toContain("Close the path");
    expect(texts).toContain("Finish the open path");
    expectNoCommit(fake);
  });

  it("Pen states — a held drag shows the handle being pulled @uxi:UXI-DRW-003 @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(createPenHandler)
      .click(A)
      .settle()
      .down(B)
      .move([240, 160])
      .move([270, 160])
      .settle();
    expect(await g.cursorAt([270, 160])).toEqual(penCursor("dragHandle"));
    await g.up([270, 160]).settle().key("Escape").settle();
    // Escape leaves nothing behind (UXI-DRW-001).
    expectNoCommit(fake);
  });

  it("Pen states — a click on the run's last anchor finishes the open path: one insertPath, one undo step @uxi:UXI-DRW-003 @uxi:UXI-DRW-006 @level:gesture", async () => {
    const { fake, g } = harness();
    const mark = fake.mark();
    await g
      .tool(createPenHandler)
      .click(A)
      .settle()
      .click(B)
      .settle()
      .click(C)
      .settle()
      .click([C[0] + 1, C[1] + 1])
      .settle();
    expectOneCommit(fake, mark);
    const path = leaves(fake).find((m) => m.op === "insertPath")?.args as {
      anchors: Array<{ anchor: number[] }>;
      open: boolean;
    };
    expect(path.open).toBe(true);
    expect(path.anchors.map((a) => a.anchor)).toEqual([A, B, C]);
    // The Pen stays the Pen, ready for the next path.
    await g.hover([300, 300]).settle();
    expect(await g.cursorAt([300, 300])).toEqual(penCursor("start"));
  });
});
