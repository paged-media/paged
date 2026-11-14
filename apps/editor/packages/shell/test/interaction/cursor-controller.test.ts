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

// The cursor contract (editor ADR 1227, IC9; `UXI-OVR-010`):
// the canvas's cursor is the first of its layers that is set — the session
// that holds the pointer, a held modifier, what is under the pointer, the
// tool — and the controller is the one writer of it.

import { describe, expect, it } from "bun:test";

import {
  createCursorController,
  holdCursor,
  writeCursor,
} from "../../src/tools/cursor";

/** An element's style, as far as the cursor goes. */
function fakeElement() {
  const props = new Map<string, { value: string; priority: string }>();
  const style = {
    getPropertyValue: (k: string) => props.get(k)?.value ?? "",
    getPropertyPriority: (k: string) => props.get(k)?.priority ?? "",
    setProperty: (k: string, value: string, priority = "") =>
      void props.set(k, { value, priority }),
    removeProperty: (k: string) => void props.delete(k),
  };
  return {
    element: { style } as unknown as HTMLElement,
    cursor: () => props.get("cursor")?.value ?? "",
    priority: () => props.get("cursor")?.priority ?? "",
  };
}

describe("the cursor controller", () => {
  it("shows the first layer set: session, modifier, hover, tool; else the fallback", () => {
    const el = fakeElement();
    const c = createCursorController("grab");
    c.attach(el.element);
    expect(el.cursor()).toBe("grab");
    c.set("tool", "crosshair");
    expect(el.cursor()).toBe("crosshair");
    c.set("hover", "pointer");
    expect(el.cursor()).toBe("pointer");
    c.set("modifier", "copy");
    expect(el.cursor()).toBe("copy");
    c.set("session", "nwse-resize");
    expect(el.cursor()).toBe("nwse-resize");
    expect(c.current()).toBe("nwse-resize");
    c.set("session", null);
    c.set("modifier", null);
    expect(el.cursor()).toBe("pointer");
    c.set("hover", null);
    expect(el.cursor()).toBe("crosshair");
    expect(c.layers()).toEqual({ tool: "crosshair" });
  });

  it("writes the element it is attached to, and none when detached", () => {
    const a = fakeElement();
    const b = fakeElement();
    const c = createCursorController();
    c.set("tool", "text");
    c.attach(a.element);
    expect(a.cursor()).toBe("text");
    c.attach(null);
    c.set("tool", "move");
    expect(a.cursor()).toBe("text");
    c.attach(b.element);
    expect(b.cursor()).toBe("move");
  });

  it("holdCursor shows a mode's cursor over everything and puts back what was there", () => {
    const el = fakeElement();
    writeCursor(el.element, "wait");
    const release = holdCursor(el.element, "copy");
    expect(el.cursor()).toBe("copy");
    expect(el.priority()).toBe("important");
    release();
    expect(el.cursor()).toBe("wait");
    expect(el.priority()).toBe("");
    const bare = fakeElement();
    holdCursor(bare.element, "copy")();
    expect(bare.cursor()).toBe("");
  });
});
