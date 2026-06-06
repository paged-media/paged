import { describe, expect, it } from "vitest";

import type { CanvasPointerEvent } from "@paged-media/plugin-api";

import { beginPageDrag, endLocalFor, pxToPt } from "../src/gestures";

function evt(over: Partial<CanvasPointerEvent>): CanvasPointerEvent {
  return {
    pageId: "p1",
    pagePoint: [10, 20],
    docPoint: [110, 220],
    modifiers: { shift: false, alt: false, cmd: false, ctrl: false },
    maxDelta: 0,
    button: 0,
    target: null,
    ...over,
  };
}

describe("beginPageDrag", () => {
  it("anchors to the page under the pointer", () => {
    const drag = beginPageDrag(evt({}));
    expect(drag).toEqual({
      pageId: "p1",
      pageOrigin: [100, 200],
      startLocal: [10, 20],
    });
  });

  it("returns null off-page and for non-primary buttons", () => {
    expect(beginPageDrag(evt({ pageId: null, pagePoint: null }))).toBeNull();
    expect(beginPageDrag(evt({ button: 1 }))).toBeNull();
  });
});

describe("endLocalFor", () => {
  it("resolves any later event against the START page", () => {
    const drag = beginPageDrag(evt({}))!;
    // Pointer released over the pasteboard: still resolves into the
    // start page's local space.
    const end = endLocalFor(
      drag,
      evt({ pageId: null, pagePoint: null, docPoint: [150, 260] }),
    );
    expect(end).toEqual([50, 60]);
  });
});

describe("pxToPt", () => {
  it("divides by the scale", () => {
    expect(pxToPt(2, 6)).toBe(3);
  });
  it("falls back to 1:1 before the camera initialises", () => {
    expect(pxToPt(0, 6)).toBe(6);
  });
});
