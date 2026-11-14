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

// The objects under the pointer (editor ADR 235, amended by IC6;
// `UXI-HIT-006`): Select next object below takes the item under the one
// selected at the pointer, top-first, and wraps; nothing selected there,
// the topmost. The default click keeps the topmost (the e2e layer,
// tests/e2e/uxi-selection.spec.ts).

import { describe, expect, test } from "bun:test";
import type { ElementId } from "@paged-media/client";
import {
  CANVAS_POINTER,
  createEditorScope,
  nextBelow,
} from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import {
  PAGED_EDIT_SELECT_BELOW,
  SELECT_BELOW_COMMAND,
} from "../../src/canvas-context-menu";

const rect = (id: string): ElementId =>
  ({ kind: "rectangle", id }) as ElementId;

describe("Select next object below [editor-tools.select.click-marquee]", () => {
  test("nextBelow walks the stack top-first and wraps", () => {
    const stack = [rect("top"), rect("mid"), rect("low")];
    expect(nextBelow(stack, [])).toEqual(rect("top"));
    expect(nextBelow(stack, [rect("top")])).toEqual(rect("mid"));
    expect(nextBelow(stack, [rect("mid")])).toEqual(rect("low"));
    expect(nextBelow(stack, [rect("low")])).toEqual(rect("top"));
    expect(nextBelow(stack, [rect("elsewhere")])).toEqual(rect("top"));
    expect(nextBelow([], [rect("top")])).toBeNull();
  });

  test("the command asks for the objects under the pointer in the entered group and selects the next one", async () => {
    covers("command:paged.edit.selectBelow");
    expect(SELECT_BELOW_COMMAND.id).toBe(PAGED_EDIT_SELECT_BELOW);
    const scope = createEditorScope();
    scope
      .get(CANVAS_POINTER)
      .set({ pageId: "p1", pagePoint: [40, 60], docPoint: [40, 60] });
    const asked: unknown[] = [];
    let selection: ElementId[] = [rect("top")];
    const paged = {
      scope,
      client: {
        marqueeHits: async (...args: unknown[]) => {
          asked.push(args);
          return [rect("top"), rect("low")];
        },
        setElementSelection: async (ids: ElementId[]) => ids,
        elementGeometry: async () => [],
      },
      selection: {
        activeGroup: "g1",
        get elementSelection() {
          return selection;
        },
        setElementSelection: (ids: ElementId[]) => {
          selection = ids;
        },
        setElementGeometry: () => {},
      },
    };
    await SELECT_BELOW_COMMAND.handler(paged as never);
    expect(selection).toEqual([rect("low")]);
    expect(asked).toEqual([
      [
        "p1",
        [59.5, 39.5, 60.5, 40.5],
        { mode: "intersect", scope: { kind: "group", id: "g1" } },
      ],
    ]);
    // Again: it wraps to the top.
    await SELECT_BELOW_COMMAND.handler(paged as never);
    expect(selection).toEqual([rect("top")]);
  });

  test("off the pages the command does nothing", async () => {
    const scope = createEditorScope();
    let asked = false;
    const paged = {
      scope,
      client: {
        marqueeHits: async () => {
          asked = true;
          return [];
        },
      },
      selection: { activeGroup: null, elementSelection: [] },
    };
    await SELECT_BELOW_COMMAND.handler(paged as never);
    expect(asked).toBe(false);
  });
});
