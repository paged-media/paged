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

import { describe, expect, it } from "bun:test";

import { attachInput, type InputSink } from "../src/input.js";
import { fakeCanvas } from "./fake-session.js";

type Call =
  | { op: "zoomAt"; factor: number; anchor: { x: number; y: number } }
  | { op: "panBy"; dx: number; dy: number }
  | { op: "zoomStep"; direction: number; anchor?: { x: number; y: number } }
  | { op: "fit" | "home" | "end" }
  | { op: "pageStep"; direction: number };

function recorder(): { calls: Call[]; sink: InputSink } {
  const calls: Call[] = [];
  return {
    calls,
    sink: {
      zoomAt: (factor, anchor) => calls.push({ op: "zoomAt", factor, anchor }),
      panBy: (dx, dy) => calls.push({ op: "panBy", dx, dy }),
      zoomStep: (direction, anchor) =>
        calls.push(
          anchor
            ? { op: "zoomStep", direction, anchor }
            : { op: "zoomStep", direction },
        ),
      fit: () => calls.push({ op: "fit" }),
      pageStep: (direction) => calls.push({ op: "pageStep", direction }),
      home: () => calls.push({ op: "home" }),
      end: () => calls.push({ op: "end" }),
    },
  };
}

/** An event as the handlers read it: a type, fields, `preventDefault`. */
function fire(
  canvas: HTMLCanvasElement,
  type: string,
  fields: Record<string, unknown> = {},
): { prevented: boolean } {
  const state = { prevented: false };
  canvas.dispatchEvent({
    type,
    preventDefault: () => {
      state.prevented = true;
    },
    ...fields,
  } as unknown as Event);
  return state;
}

const pointer = (
  id: number,
  x: number,
  y: number,
  pointerType = "touch",
  button = 0,
) => ({ pointerId: id, clientX: x, clientY: y, pointerType, button });

describe("wheel", () => {
  it("pans on a plain wheel and zooms to the cursor with ctrl", () => {
    const canvas = fakeCanvas();
    const { calls, sink } = recorder();
    attachInput(canvas, {}, sink);

    const plain = fire(canvas, "wheel", { deltaX: 3, deltaY: 10 });
    expect(plain.prevented).toBe(true);
    expect(calls).toEqual([{ op: "panBy", dx: -3, dy: -10 }]);

    fire(canvas, "wheel", {
      deltaX: 0,
      deltaY: -100,
      ctrlKey: true,
      clientX: 40,
      clientY: 50,
    });
    const zoom = calls[1];
    expect(zoom?.op).toBe("zoomAt");
    if (zoom?.op !== "zoomAt") throw new Error("expected zoomAt");
    expect(zoom.factor).toBeCloseTo(Math.exp(0.24), 9);
    expect(zoom.anchor).toEqual({ x: 40, y: 50 });
  });
});

describe("pointers", () => {
  it("one pointer pans by its movement", () => {
    const canvas = fakeCanvas();
    const { calls, sink } = recorder();
    attachInput(canvas, {}, sink);

    fire(canvas, "pointerdown", pointer(1, 100, 100));
    fire(canvas, "pointermove", pointer(1, 110, 95));
    fire(canvas, "pointerup", pointer(1, 110, 95));
    fire(canvas, "pointermove", pointer(1, 200, 200)); // up: ignored

    expect(calls).toEqual([{ op: "panBy", dx: 10, dy: -5 }]);
  });

  it("a mouse pans with its primary button only", () => {
    const canvas = fakeCanvas();
    const { calls, sink } = recorder();
    attachInput(canvas, {}, sink);

    fire(canvas, "pointerdown", pointer(1, 0, 0, "mouse", 2));
    fire(canvas, "pointermove", pointer(1, 30, 30, "mouse", 2));
    expect(calls).toEqual([]);
  });

  it("two pointers zoom about their midpoint and pan with it", () => {
    const canvas = fakeCanvas();
    const { calls, sink } = recorder();
    attachInput(canvas, {}, sink);

    fire(canvas, "pointerdown", pointer(1, 100, 300));
    fire(canvas, "pointerdown", pointer(2, 300, 300));
    // The second finger moves out: the span goes 200 → 400, the
    // midpoint 200 → 300.
    fire(canvas, "pointermove", pointer(2, 500, 300));

    expect(calls).toEqual([
      { op: "panBy", dx: 100, dy: 0 },
      { op: "zoomAt", factor: 2, anchor: { x: 300, y: 300 } },
    ]);
  });

  it("after a pinch the remaining finger pans without a jump", () => {
    const canvas = fakeCanvas();
    const { calls, sink } = recorder();
    attachInput(canvas, {}, sink);

    fire(canvas, "pointerdown", pointer(1, 100, 300));
    fire(canvas, "pointerdown", pointer(2, 300, 300));
    fire(canvas, "pointerup", pointer(2, 300, 300));
    fire(canvas, "pointermove", pointer(1, 104, 300));

    expect(calls).toEqual([{ op: "panBy", dx: 4, dy: 0 }]);
  });

  it("a third pointer is ignored", () => {
    const canvas = fakeCanvas();
    const { calls, sink } = recorder();
    attachInput(canvas, {}, sink);

    fire(canvas, "pointerdown", pointer(1, 100, 300));
    fire(canvas, "pointerdown", pointer(2, 300, 300));
    fire(canvas, "pointerdown", pointer(3, 400, 400));
    fire(canvas, "pointermove", pointer(3, 450, 450));
    expect(calls).toEqual([]);
  });

  it("pinchZoom: false leaves two pointers without effect", () => {
    const canvas = fakeCanvas();
    const { calls, sink } = recorder();
    attachInput(canvas, { pinchZoom: false }, sink);

    fire(canvas, "pointerdown", pointer(1, 100, 300));
    fire(canvas, "pointerdown", pointer(2, 300, 300));
    fire(canvas, "pointermove", pointer(2, 500, 300));
    expect(calls).toEqual([]);
  });

  it("dragPan: false keeps the pinch and drops the one-pointer pan", () => {
    const canvas = fakeCanvas();
    const { calls, sink } = recorder();
    attachInput(canvas, { dragPan: false }, sink);

    fire(canvas, "pointerdown", pointer(1, 100, 300));
    fire(canvas, "pointermove", pointer(1, 120, 300));
    expect(calls).toEqual([]);
    fire(canvas, "pointerdown", pointer(2, 320, 300));
    fire(canvas, "pointermove", pointer(2, 520, 300));
    expect(calls.map((c) => c.op)).toEqual(["panBy", "zoomAt"]);
  });

  it("takes touch gestures from the browser and gives them back", () => {
    const canvas = fakeCanvas();
    const detach = attachInput(canvas, {}, recorder().sink);
    expect(canvas.style.touchAction).toBe("none");
    detach();
    expect(canvas.style.touchAction).toBe("");
  });
});

describe("double click and keyboard", () => {
  it("double click steps the zoom at the cursor; shift steps out", () => {
    const canvas = fakeCanvas();
    const { calls, sink } = recorder();
    attachInput(canvas, {}, sink);

    fire(canvas, "dblclick", { clientX: 5, clientY: 6 });
    fire(canvas, "dblclick", { clientX: 5, clientY: 6, shiftKey: true });
    expect(calls).toEqual([
      { op: "zoomStep", direction: 1, anchor: { x: 5, y: 6 } },
      { op: "zoomStep", direction: -1, anchor: { x: 5, y: 6 } },
    ]);
  });

  it("maps keys to zoom, pan and page steps", () => {
    const canvas = fakeCanvas();
    const { calls, sink } = recorder();
    attachInput(canvas, {}, sink);

    const keys = [
      "+",
      "-",
      "0",
      "ArrowLeft",
      "ArrowDown",
      "PageUp",
      "PageDown",
      "Home",
      "End",
    ];
    for (const key of keys) {
      expect(fire(canvas, "keydown", { key }).prevented).toBe(true);
    }
    expect(fire(canvas, "keydown", { key: "a" }).prevented).toBe(false);

    expect(calls).toEqual([
      { op: "zoomStep", direction: 1 },
      { op: "zoomStep", direction: -1 },
      { op: "fit" },
      { op: "panBy", dx: 48, dy: 0 },
      { op: "panBy", dx: 0, dy: -48 },
      { op: "pageStep", direction: -1 },
      { op: "pageStep", direction: 1 },
      { op: "home" },
      { op: "end" },
    ]);
  });

  it("a disabled lane attaches no listener", () => {
    const canvas = fakeCanvas();
    attachInput(
      canvas,
      { wheelZoom: false, dragPan: false, pinchZoom: false, keyboard: false },
      recorder().sink,
    );
    const counts = canvas as unknown as { listenerCount(t: string): number };
    expect(counts.listenerCount("wheel")).toBe(0);
    expect(counts.listenerCount("pointerdown")).toBe(0);
    expect(counts.listenerCount("keydown")).toBe(0);
    expect(counts.listenerCount("dblclick")).toBe(1);
  });
});
