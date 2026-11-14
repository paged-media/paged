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

// The Pen's nine states on the cursor contract (paged.draw ADR 370, editor
// ADR 1227): the hover's states reach the controller's hover layer, and the
// state of a press — a handle being pulled — its session layer for as long
// as the press holds the pointer, on the mounted canvas over the real
// engine. One write site: the controller writes the host's cursor.

import { afterEach, describe, expect, test } from "bun:test";

import { covers, gestureFixture } from "@paged-media/test-kit";
import {
  CURSOR_CONTROLLER,
  resolveCursorCss,
  scopeOf,
} from "@paged-media/shell";
import { penCursor } from "@paged-media/tools";

import { mountCanvas, type MountedCanvas } from "./canvas-dom";

let c: MountedCanvas | null = null;
afterEach(() => {
  c?.dispose();
  c = null;
});

const on = (at: readonly [number, number]) => ({
  page: 0,
  at: [at[0], at[1]] as [number, number],
});
const css = (state: Parameters<typeof penCursor>[0]) =>
  resolveCursorCss(penCursor(state));

describe("the Pen's state cursors (paged.draw ADR 370; editor ADR 1227)", () => {
  test("pulling a handle shows its cursor for the whole press, in the session layer; the release gives the canvas back", async () => {
    covers("tool:paged.tool.pen");
    const m = (c = await mountCanvas(gestureFixture("targets")));
    await m.g.tool("paged.tool.pen").settle();
    // A first anchor, a click.
    await m.g.click(on([300, 400])).settle();
    const controller = scopeOf(m.state.paged).get(CURSOR_CONTROLLER);
    // The second press, held and pulled past the drag threshold: the handle.
    await m.g
      .down(on([400, 400]))
      .move(on([430, 400]))
      .move(on([460, 400]))
      .settle();
    expect(controller.layers().session).toBe(css("dragHandle"));
    expect(m.host().style.cursor).toBe(css("dragHandle"));
    await m.g.up(on([460, 400])).settle();
    // The press ended: its layer is cleared, the canvas shows the hover's.
    expect(controller.layers().session).toBeUndefined();
    expect(m.host().style.cursor).not.toBe(css("dragHandle"));
    await m.g.key("Escape").settle();
  });
});
