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

// The pending placement (pending-placement.ts): Insert ▸ … and Place
// arm a placement and wait for the user's click (or drag) on the canvas.
// A click resolves the point, a drag the box; Escape, a right-click or a
// click outside the canvas resolve null, and the caller places nothing.
// While armed, <html> carries `data-paged-placement` and a copy cursor.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  awaitPlacementPoint,
  cancelPendingPlacement,
  placementArmed,
} from "../../src/state/pending-placement";

let viewport: HTMLElement;
let outside: HTMLElement;

const root = () => document.documentElement;

function pointer(
  type: string,
  target: EventTarget,
  x: number,
  y: number,
  button = 0,
) {
  // happy-dom's PointerEvent carries clientX/Y and button; dispatch on
  // the target so the capture listener on window sees `e.target`.
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button,
    }),
  );
}

beforeEach(() => {
  viewport = document.createElement("div");
  viewport.setAttribute("data-paged-viewport", "");
  outside = document.createElement("div");
  document.body.append(viewport, outside);
  root().style.removeProperty("cursor");
});
afterEach(() => {
  cancelPendingPlacement();
  viewport.remove();
  outside.remove();
});

describe("pending placement", () => {
  test("armed: the flag, the attribute and the copy cursor; restored after", async () => {
    root().style.setProperty("cursor", "wait");
    const point = awaitPlacementPoint();
    expect(placementArmed()).toBe(true);
    expect(root().getAttribute("data-paged-placement")).toBe("armed");
    expect(root().style.getPropertyValue("cursor")).toBe("copy");
    pointer("pointerdown", viewport, 10, 20);
    pointer("pointerup", viewport, 10, 20);
    expect(await point).toEqual({ clientX: 10, clientY: 20 });
    expect(placementArmed()).toBe(false);
    expect(root().hasAttribute("data-paged-placement")).toBe(false);
    expect(root().style.getPropertyValue("cursor")).toBe("wait");
  });

  test("a click inside the canvas resolves its point", async () => {
    const point = awaitPlacementPoint();
    pointer("pointerdown", viewport, 100, 50);
    pointer("pointermove", viewport, 102, 51); // under the drag threshold
    pointer("pointerup", viewport, 102, 51);
    expect(await point).toEqual({ clientX: 100, clientY: 50 });
  });

  test("a drag resolves the box, with a live preview that ends with null", async () => {
    const previews: unknown[] = [];
    const point = awaitPlacementPoint({
      onDrag: (from, to) => previews.push(to ? [from, to] : null),
    });
    pointer("pointerdown", viewport, 100, 100);
    pointer("pointermove", viewport, 140, 130);
    pointer("pointerup", viewport, 200, 180);
    expect(await point).toEqual({
      clientX: 100,
      clientY: 100,
      to: { clientX: 200, clientY: 180 },
    });
    expect(previews).toEqual([
      [
        { clientX: 100, clientY: 100 },
        { clientX: 140, clientY: 130 },
      ],
      null,
    ]);
  });

  test("Escape, a right-click or a click outside the canvas resolve null", async () => {
    const esc = awaitPlacementPoint();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await esc).toBeNull();

    const right = awaitPlacementPoint();
    pointer("pointerdown", viewport, 5, 5, 2);
    expect(await right).toBeNull();

    const away = awaitPlacementPoint();
    pointer("pointerdown", outside, 5, 5);
    expect(await away).toBeNull();
    expect(placementArmed()).toBe(false);
  });

  test("other keys do not cancel", async () => {
    const point = awaitPlacementPoint();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(placementArmed()).toBe(true);
    pointer("pointerdown", viewport, 1, 2);
    pointer("pointerup", viewport, 1, 2);
    expect(await point).toEqual({ clientX: 1, clientY: 2 });
  });

  test("cancelPendingPlacement stands an armed placement down (File > New / Open)", async () => {
    const point = awaitPlacementPoint();
    cancelPendingPlacement();
    expect(await point).toBeNull();
    // With nothing armed it is a no-op.
    cancelPendingPlacement();
    expect(placementArmed()).toBe(false);
  });
});
