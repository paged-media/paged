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

// sheet ADR 510 / extensions ADR 334 — the sheet's frame surface as a
// component: it windows the grid to the cell area (the content box minus
// the heading strips), maps a click through the host's content mapping
// and past the headings to a cell point, sends keys through the grid's
// key map, and leaves the frame on an Esc with no cell edit open.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";

import type { FrameSurfaceProps } from "@paged-media/plugin-api";

import {
  DEFAULT_HEADING_STYLE,
  rowHeadingWidthPt,
  type GridScene,
} from "../../sheet-host-model/src";
import {
  makeSheetFrameSurface,
  type FrameSurfaceSession,
} from "../src/surface/sheet-frame-surface";

afterEach(cleanup);

function fakeSession() {
  const calls: Array<[string, ...unknown[]]> = [];
  let sink: ((s: GridScene) => void) | null = null;
  let editing = false;
  const session: FrameSurfaceSession = {
    attachFrameSurface(s, area) {
      sink = s;
      calls.push(["attach", area]);
      return () => calls.push(["detach"]);
    },
    pointerDownInFrame: (x, y, m) => {
      calls.push(["down", x, y, m]);
      return true;
    },
    pointerMoveInFrame: (x, y) => {
      calls.push(["move", x, y]);
      return true;
    },
    pointerUpInFrame: (x, y) => {
      calls.push(["up", x, y]);
      return true;
    },
    wheelInFrame: (dx, dy) => {
      calls.push(["wheel", dx, dy]);
      return true;
    },
    handleGridKey: (e) => {
      calls.push(["key", e.key]);
      if (e.key === "a") editing = true;
      return true;
    },
    isCellEditing: () => editing,
  };
  return { session, calls, push: (s: GridScene) => sink?.(s) };
}

function props(over: Partial<FrameSurfaceProps> = {}): FrameSurfaceProps {
  return {
    elementId: "f1",
    widthPt: 300,
    heightPt: 200,
    pxPerPt: 1,
    presentation: "frame",
    // The client position IS the content point in this test.
    toContentPt: (x, y) => [x, y],
    requestPresentation: () => {},
    exit: () => {},
    ...over,
  };
}

describe("sheet frame surface", () => {
  it("windows the grid to the content box minus the heading strips", () => {
    const { session, calls } = fakeSession();
    render(createElement(makeSheetFrameSurface(session), props()));
    expect(calls[0]).toEqual([
      "attach",
      {
        wPt: 300 - rowHeadingWidthPt(0),
        hPt: 200 - DEFAULT_HEADING_STYLE.colHeightPt,
      },
    ]);
  });

  it("a click on the cells reaches the session in cell-area points; a click on a heading does not", () => {
    const { session, calls } = fakeSession();
    const r = render(createElement(makeSheetFrameSurface(session), props()));
    const root = r.getByTestId("sheet-frame-surface");
    const hw = rowHeadingWidthPt(0);
    const hh = DEFAULT_HEADING_STYLE.colHeightPt;
    fireEvent.pointerDown(root, {
      button: 0,
      clientX: hw + 10,
      clientY: hh + 5,
      shiftKey: true,
    });
    fireEvent.pointerUp(root, { button: 0, clientX: hw + 10, clientY: hh + 5 });
    expect(calls).toContainEqual(["down", 10, 5, { shift: true }]);
    expect(calls).toContainEqual(["up", 10, 5]);
    const before = calls.length;
    fireEvent.pointerDown(root, { button: 0, clientX: 5, clientY: 5 });
    expect(calls.slice(before).some((c) => c[0] === "down")).toBe(false);
  });

  it("keys go through the grid's key map; Esc with no open edit leaves the frame", () => {
    const { session, calls } = fakeSession();
    const exits: boolean[] = [];
    const r = render(
      createElement(
        makeSheetFrameSurface(session),
        props({ exit: ({ commit }) => exits.push(commit) }),
      ),
    );
    const root = r.getByTestId("sheet-frame-surface");
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(calls).toContainEqual(["key", "ArrowDown"]);
    fireEvent.keyDown(root, { key: "Escape" });
    expect(exits).toEqual([true]);
    // With a cell edit open, Esc is the grid's (it cancels the edit).
    fireEvent.keyDown(root, { key: "a" });
    fireEvent.keyDown(root, { key: "Escape" });
    expect(exits).toEqual([true]);
    expect(calls).toContainEqual(["key", "Escape"]);
  });

  it("a wheel scrolls the window in content points; Cmd/Ctrl-wheel is left to the canvas", () => {
    const { session, calls } = fakeSession();
    const r = render(
      createElement(makeSheetFrameSurface(session), props({ pxPerPt: 2 })),
    );
    const root = r.getByTestId("sheet-frame-surface");
    fireEvent.wheel(root, { deltaY: 30, deltaMode: 0 });
    expect(calls).toContainEqual(["wheel", 0, 15]);
    const before = calls.length;
    // happy-dom's WheelEvent drops modifier keys from its init; set it.
    const zoom = new WheelEvent("wheel", {
      deltaY: 30,
      deltaMode: 0,
      bubbles: true,
    });
    Object.defineProperty(zoom, "ctrlKey", { value: true });
    fireEvent(root, zoom);
    expect(calls.slice(before)).toEqual([]);
  });

  it("detaches on unmount", () => {
    const { session, calls } = fakeSession();
    const r = render(createElement(makeSheetFrameSurface(session), props()));
    act(() => r.unmount());
    expect(calls.at(-1)).toEqual(["detach"]);
  });
});
