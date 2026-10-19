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

// The four built-in tools that carry no gesture handler: Selection, Direct
// Selection, Hand and Zoom. Their behaviour is the canvas's own pointer
// path (ViewportCanvas, wired by CanvasPanel), so they are driven here
// through the gesture DSL's DOM backend on a mounted canvas over the real
// engine (`canvas-dom.tsx`), and judged by the engine's model, the shell's
// selection and the camera.
//
// Each tool's contract, from its rail description:
//   Selection         "Select, move and resize whole objects."
//   Direct Selection  "Select the points of a path and reshape it."
//   Hand              "Drag to pan the view."
//   Zoom              "Click to zoom in; Alt-click zooms out."
// The invariants (gestures.md): one drag is one commit and one undo step;
// Escape mid-drag commits nothing.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import {
  covers,
  gestureFixture,
  GESTURE_TARGETS as T,
} from "@paged-media/test-kit";
import { dumpDiff } from "@paged-media/test-kit/headless";

import { mountCanvas, type MountedCanvas } from "./canvas-dom";

let c: MountedCanvas | null = null;
afterEach(() => {
  c?.dispose();
  c = null;
});

const targets = async () => (c = await mountCanvas(gestureFixture("targets")));

/** A point on page 1, page-local pt. */
const on = (at: readonly [number, number]) => ({
  page: 0,
  at: [at[0], at[1]] as [number, number],
});

const undo = async (m: MountedCanvas) => {
  await m.client.undo();
  await m.settle();
};

describe("Selection (paged.tool.select)", () => {
  test("a click on a frame selects it; a click on an empty spot deselects", async () => {
    covers("tool:paged.tool.select");
    const m = await targets();
    await m.g.tool("paged.tool.select").click(on(T.frame.at)).settle();
    expect(m.state.elementSelection).toEqual([T.frame.id]);
    await m.g.click(on(T.empty.at)).settle();
    expect(m.state.elementSelection).toEqual([]);
  });

  test("Shift+click adds a second item to the selection", async () => {
    covers("tool:paged.tool.select");
    const m = await targets();
    await m.g
      .tool("paged.tool.select")
      .click(on(T.frame.at))
      .click(on(T.group.at), { mods: ["shift"] })
      .settle();
    expect(m.state.elementSelection).toEqual([T.frame.id, T.group.id]);
  });

  test("dragging the selected frame moves it by the drag, in one undo step", async () => {
    covers("tool:paged.tool.select");
    const m = await targets();
    await m.g.tool("paged.tool.select").click(on(T.frame.at)).settle();
    const before = await m.dump();
    const [top, left, bottom, right] = await m.bounds(T.frame.id);
    await m.g
      .drag({
        from: on(T.frame.at),
        to: on([T.frame.at[0] + 40, T.frame.at[1] + 30]),
      })
      .settle();
    expect(await m.bounds(T.frame.id)).toEqual([
      top + 30,
      left + 40,
      bottom + 30,
      right + 40,
    ]);
    // Only the frame moved.
    const changed = dumpDiff(before, await m.dump(), 50);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((line) => line.includes("uframe"))).toBe(true);
    await undo(m);
    expect(dumpDiff(before, await m.dump())).toEqual([]);
    expect(m.state.elementSelection).toEqual([T.frame.id]);
  });

  test("Escape mid-drag commits nothing", async () => {
    covers("tool:paged.tool.select");
    const m = await targets();
    await m.g.tool("paged.tool.select").click(on(T.frame.at)).settle();
    const before = await m.dump();
    await m.g
      .drag({
        from: on(T.frame.at),
        to: on([T.frame.at[0] + 60, T.frame.at[1] + 10]),
        release: false,
      })
      .cancel()
      .up(on([T.frame.at[0] + 60, T.frame.at[1] + 10]))
      .settle();
    expect(dumpDiff(before, await m.dump())).toEqual([]);
  });

  test("a drag from an empty spot is a marquee: it selects the frame it encloses", async () => {
    covers("tool:paged.tool.select");
    const m = await targets();
    const [top, left, bottom, right] = T.frame.box;
    const before = await m.dump();
    await m.g
      .tool("paged.tool.select")
      .drag({
        from: on([left - 12, top - 12]),
        to: on([right + 12, bottom + 12]),
      })
      .settle();
    expect(m.state.elementSelection).toEqual([T.frame.id]);
    expect(dumpDiff(before, await m.dump())).toEqual([]);
  });

  // F-26: a press-drag on an UNSELECTED frame drew a marquee; the frame
  // ended up selected but unmoved, so a move took two gestures.
  test("F-26: a press-drag on an unselected frame selects it and moves it in one gesture, one undo step", async () => {
    covers("tool:paged.tool.select");
    const m = await targets();
    await m.g.tool("paged.tool.select").settle();
    expect(m.state.elementSelection).toEqual([]);
    const before = await m.dump();
    const [top, left, bottom, right] = await m.bounds(T.frame.id);
    await m.g
      .drag({
        from: on(T.frame.at),
        to: on([T.frame.at[0] + 40, T.frame.at[1] + 30]),
      })
      .settle();
    expect(m.state.elementSelection).toEqual([T.frame.id]);
    expect(await m.bounds(T.frame.id)).toEqual([
      top + 30,
      left + 40,
      bottom + 30,
      right + 40,
    ]);
    const changed = dumpDiff(before, await m.dump(), 50);
    expect(changed.every((line) => line.includes("uframe"))).toBe(true);
    await undo(m);
    expect(dumpDiff(before, await m.dump())).toEqual([]);
  });

  test("F-26: a press-drag on an unselected grouped shape moves its whole group", async () => {
    covers("tool:paged.tool.select");
    const m = await targets();
    const geometry = () =>
      m.client.elementGeometry([T.group.childA, T.group.childB] as never);
    const before = await m.dump();
    const g0 = await geometry();
    await m.g
      .tool("paged.tool.select")
      .drag({
        from: on(T.group.at),
        to: on([T.group.at[0] + 20, T.group.at[1] + 10]),
      })
      .settle();
    expect(m.state.elementSelection).toEqual([T.group.id]);
    const g1 = await geometry();
    expect(g1[0]).not.toEqual(g0[0]);
    expect(g1[1]).not.toEqual(g0[1]);
    const changed = dumpDiff(before, await m.dump(), 80);
    expect(changed.every((line) => /ug(roup|A|B)/.test(line))).toBe(true);
  });

  test("F-26: a drag from an empty spot is still a marquee, and Cmd-drag on a frame too", async () => {
    covers("tool:paged.tool.select");
    const m = await targets();
    const before = await m.dump();
    await m.g
      .tool("paged.tool.select")
      .drag({
        from: on(T.frame.at),
        to: on([T.frame.at[0] + 120, T.frame.at[1] + 60]),
        mods: ["cmd"],
      })
      .settle();
    expect(dumpDiff(before, await m.dump())).toEqual([]);
  });

  // F-29: a double-click on a grouped shape selects that shape (the
  // group is entered), not a context for the shape.
  test("F-29: a double-click on a grouped shape selects the shape", async () => {
    covers("tool:paged.tool.select");
    const m = await targets();
    await m.g
      .tool("paged.tool.select")
      .click(on(T.group.at))
      .settle()
      .dblclick(on(T.group.at))
      .settle();
    expect(m.state.elementSelection).toEqual([T.group.childA]);
  });
});

describe("Direct Selection (paged.tool.directSelect)", () => {
  const anchors = async (m: MountedCanvas) =>
    (await m.client.pathAnchors(T.path.id as never))?.anchors ?? [];

  test("a click on a path selects it and puts it in path-edit mode at once", async () => {
    covers("tool:paged.tool.directSelect");
    const m = await targets();
    const [x, y] = T.path.anchors[1];
    await m.g
      .tool("paged.tool.directSelect")
      .click(on([x, y - 20]))
      .settle();
    expect(m.state.elementSelection).toEqual([T.path.id]);
    expect(m.state.pathEditMode).toBe(true);
  });

  test("dragging an anchor moves that anchor only, in one undo step", async () => {
    covers("tool:paged.tool.directSelect");
    const m = await targets();
    const [x, y] = T.path.anchors[1];
    await m.g
      .tool("paged.tool.directSelect")
      .click(on([x, y - 20]))
      .settle();
    const before = await anchors(m);
    const dump = await m.dump();
    await m.g.drag({ from: on([x, y]), to: on([x + 10, y + 24]) }).settle();
    const after = await anchors(m);
    expect(after.map((a) => a.anchor)).toEqual([
      before[0].anchor,
      [before[1].anchor[0] + 10, before[1].anchor[1] + 24],
      before[2].anchor,
    ]);
    await undo(m);
    expect((await anchors(m)).map((a) => a.anchor)).toEqual(
      before.map((a) => a.anchor),
    );
    expect(dumpDiff(dump, await m.dump())).toEqual([]);
  });

  // F-29: Direct Selection on a grouped shape selected the whole group.
  test("F-29: a click on a grouped shape selects that shape, not its group", async () => {
    covers("tool:paged.tool.directSelect");
    const m = await targets();
    await m.g.tool("paged.tool.directSelect").click(on(T.group.at)).settle();
    expect(m.state.elementSelection).toEqual([T.group.childA]);
  });

  test("a click on a frame selects it without moving or reshaping anything", async () => {
    covers("tool:paged.tool.directSelect");
    const m = await targets();
    const before = await m.dump();
    await m.g.tool("paged.tool.directSelect").click(on(T.frame.at)).settle();
    expect(m.state.elementSelection).toEqual([T.frame.id]);
    expect(dumpDiff(before, await m.dump())).toEqual([]);
  });
});

describe("Hand (paged.tool.hand)", () => {
  test("a drag pans the view by the pointer's travel and edits nothing, over a frame too", async () => {
    covers("tool:paged.tool.hand");
    const m = await targets();
    await m.g.tool("paged.tool.hand").zoom(1).settle();
    const before = await m.dump();
    const start = m.state.camera;
    await m.g
      .drag({
        from: on(T.frame.at),
        to: on([T.frame.at[0] + 50, T.frame.at[1] - 20]),
      })
      .settle();
    expect(m.state.camera).toEqual({
      scale: start.scale,
      tx: start.tx + 50,
      ty: start.ty - 20,
    });
    expect(m.state.elementSelection).toEqual([]);
    expect(dumpDiff(before, await m.dump())).toEqual([]);
  });

  test("the pan follows the pointer in screen px at any zoom", async () => {
    covers("tool:paged.tool.hand");
    const m = await targets();
    await m.g.tool("paged.tool.hand").zoom(2).settle();
    await m.g.drag({ from: on([100, 100]), to: on([130, 110]) }).settle();
    // 30 × 10 pt of document at 200 % is 60 × 20 px of screen.
    expect(m.state.camera).toEqual({ scale: 2, tx: 60, ty: 20 });
  });

  // Finding GT-5: a click with the Hand tool ran the Selection tool's
  // click (ViewportCanvas's click branch hit-tested for every legacy tool
  // but Zoom), so it selected the frame under the pointer. The Hand only
  // pans: its description is "Drag to pan the view", and InDesign's Hand
  // selects nothing.
  test("GT-5: a click with the Hand tool selects nothing", async () => {
    covers("tool:paged.tool.hand");
    const m = await targets();
    await m.g.tool("paged.tool.hand").click(on(T.frame.at)).settle();
    expect(m.state.elementSelection).toEqual([]);
  });
});

describe("Zoom (paged.tool.zoom)", () => {
  /** The document point under a screen point. */
  const docAt = (
    cam: { scale: number; tx: number; ty: number },
    [cx, cy]: readonly [number, number],
  ) => [(cx - cam.tx) / cam.scale, (cy - cam.ty) / cam.scale];

  test("a click zooms in by 1.25 and keeps the clicked point under the pointer", async () => {
    covers("tool:paged.tool.zoom");
    const m = await targets();
    await m.g.tool("paged.tool.zoom").zoom(1).settle();
    const before = await m.dump();
    await m.g.click(on(T.frame.at)).settle();
    const cam = m.state.camera;
    expect(cam.scale).toBeCloseTo(1.25, 10);
    // The pointer was at screen (144, 136) at 100 %.
    const [x, y] = docAt(cam, T.frame.at);
    expect(x).toBeCloseTo(T.frame.at[0], 9);
    expect(y).toBeCloseTo(T.frame.at[1], 9);
    expect(m.state.elementSelection).toEqual([]);
    expect(dumpDiff(before, await m.dump())).toEqual([]);
  });

  test("Alt-click zooms out by the same step", async () => {
    covers("tool:paged.tool.zoom");
    const m = await targets();
    await m.g.tool("paged.tool.zoom").zoom(2).settle();
    await m.g.click(on([200, 200]), { mods: ["alt"] }).settle();
    const cam = m.state.camera;
    expect(cam.scale).toBeCloseTo(2 / 1.25, 10);
    const [x, y] = docAt(cam, [400, 400]);
    expect(x).toBeCloseTo(200, 9);
    expect(y).toBeCloseTo(200, 9);
  });

  test("a drag pans instead of zooming", async () => {
    covers("tool:paged.tool.zoom");
    const m = await targets();
    await m.g.tool("paged.tool.zoom").zoom(1).settle();
    await m.g.drag({ from: on([300, 300]), to: on([280, 340]) }).settle();
    expect(m.state.camera).toEqual({ scale: 1, tx: -20, ty: 40 });
  });
});

describe("Rotate (paged.tool.rotate) on the mounted canvas", () => {
  // GM-2: the handler held the editor handle it was activated with, one
  // render's snapshot, so a selection made after the tool was picked
  // (the Layers panel, Select All) was ignored.
  test("GM-2: a drag rotates the selection made AFTER the tool was picked", async () => {
    covers("tool:paged.tool.rotate");
    const m = await targets();
    await m.g.tool("paged.tool.select").click(on(T.frame.at)).settle();
    await m.g.tool("paged.tool.rotate").settle();
    // The selection moves to the rotated frame while Rotate is held, as
    // the Layers panel moves it.
    await act(async () => {
      const ids = await m.client.setElementSelection(
        [T.rotated.id] as never,
        "replace",
      );
      m.state.paged.selection.setElementSelection(ids);
    });
    await m.settle();
    const geometry = async (id: unknown) =>
      (await m.client.elementGeometry([id] as never))[0]!;
    const frame0 = await geometry(T.frame.id);
    const rot0 = await geometry(T.rotated.id);
    await m.g
      .drag({
        from: on([T.rotated.at[0] - 43, T.rotated.at[1] + 65]),
        to: on([T.rotated.at[0] + 77, T.rotated.at[1] + 145]),
      })
      .settle();
    expect(await geometry(T.frame.id)).toEqual(frame0);
    expect((await geometry(T.rotated.id)).itemTransform).not.toEqual(
      rot0.itemTransform,
    );
  });
});
