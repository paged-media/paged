/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

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
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    pointerType: "mouse",
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

describe("B-08 pointer pressure/tilt", () => {
  it("carries pen pressure + tilt + pointerType on the event", () => {
    // The gesture kit forwards the whole CanvasPointerEvent object;
    // pressure/tilt/pointerType ride it untouched (no SAB lane — that
    // contract is wasm-coupled). A draw-tool shim reads these straight
    // off the event the host built.
    const pen = evt({
      pressure: 0.82,
      tiltX: -12,
      tiltY: 30,
      pointerType: "pen",
    });
    expect(pen.pressure).toBe(0.82);
    expect(pen.tiltX).toBe(-12);
    expect(pen.tiltY).toBe(30);
    expect(pen.pointerType).toBe("pen");
    // beginPageDrag is pressure-agnostic but must not drop the field —
    // the drag still anchors and the source event still carries it.
    const drag = beginPageDrag(pen);
    expect(drag).not.toBeNull();
    expect(pen.pressure).toBe(0.82);
  });

  it("defaults to mouse semantics (0.5 pressure, no tilt)", () => {
    const mouse = evt({});
    expect(mouse.pressure).toBe(0.5);
    expect(mouse.tiltX).toBe(0);
    expect(mouse.tiltY).toBe(0);
    expect(mouse.pointerType).toBe("mouse");
  });
});
