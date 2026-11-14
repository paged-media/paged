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

// The keyboard's way to the objects (editor ADR "An accessible object
// tree"): the reach command, its menu and key, and the selection cycle's
// keyboard half — IC6's commands (`paged.edit.selectBelow`, `.selectAbove`)
// on ⌥⌘[ and ⌥⌘], their stepping and the box they ask under when no
// pointer says where. The browser half is tests/e2e/uxi-accessibility.spec.ts.

import { describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { nextAbove, nextBelow } from "@paged-media/shell";

import {
  A11Y_KEYBINDINGS,
  A11Y_MENU_ITEMS,
  A11Y_TREE_COMMAND,
  buildA11yCommands,
} from "../../../src/a11y-commands";
import {
  PAGED_EDIT_SELECT_ABOVE,
  PAGED_EDIT_SELECT_BELOW,
  unionBox,
} from "../../../src/canvas-context-menu";

describe("the selection cycle", () => {
  test("steps down and up the stack and wraps; with nothing selected below starts on top, above at the bottom", () => {
    covers("command:paged.edit.selectBelow");
    covers("command:paged.edit.selectAbove");
    const id = (n: string) => ({ kind: "rectangle", id: n }) as never;
    const stack = [id("a"), id("b"), id("c")];
    expect(nextBelow(stack, [])).toEqual(id("a"));
    expect(nextAbove(stack, [])).toEqual(id("c"));
    expect(nextBelow(stack, [id("a")])).toEqual(id("b"));
    expect(nextBelow(stack, [id("c")])).toEqual(id("a"));
    expect(nextAbove(stack, [id("a")])).toEqual(id("c"));
    expect(nextAbove(stack, [id("b")])).toEqual(id("a"));
    expect(nextAbove([], [])).toBeNull();
  });

  test("from the keyboard it asks under the selection's box on its first item's page, transforms applied", () => {
    expect(
      unionBox([
        { pageId: "p1", bounds: [0, 0, 10, 20], itemTransform: null },
        // Turned 90° about the origin and moved: x' = -y + 100, y' = x.
        {
          pageId: "p1",
          bounds: [0, 0, 10, 20],
          itemTransform: [0, 1, -1, 0, 100, 0],
        },
        { pageId: "p2", bounds: [500, 500, 600, 600], itemTransform: null },
      ]),
    ).toEqual({ pageId: "p1", box: [0, 0, 20, 100] });
    expect(unionBox([{ pageId: null, bounds: [0, 0, 1, 1] }])).toBeNull();
  });
});

describe("the commands", () => {
  test("ids, menus and keys", () => {
    covers("command:paged.view.objectTree");
    covers("menu:View/Go to object tree");
    covers("menu:Object/Select next object below");
    covers("menu:Object/Select next object above");
    expect(buildA11yCommands({ showPanel: () => {} }).map((c) => c.id)).toEqual(
      [A11Y_TREE_COMMAND],
    );
    expect(A11Y_MENU_ITEMS.map((m) => [m.path, m.command])).toEqual([
      ["View/Go to object tree", A11Y_TREE_COMMAND],
      ["Object/Select next object below", PAGED_EDIT_SELECT_BELOW],
      ["Object/Select next object above", PAGED_EDIT_SELECT_ABOVE],
    ]);
    expect(A11Y_KEYBINDINGS.map((k) => [k.key, k.command])).toEqual([
      ["alt+shift+o", A11Y_TREE_COMMAND],
      ["cmd+alt+[", PAGED_EDIT_SELECT_BELOW],
      ["ctrl+alt+[", PAGED_EDIT_SELECT_BELOW],
      ["cmd+alt+]", PAGED_EDIT_SELECT_ABOVE],
      ["ctrl+alt+]", PAGED_EDIT_SELECT_ABOVE],
    ]);
    // The cycle's menu rows and keys need a document, at the document root.
    const cycle = A11Y_MENU_ITEMS[1]!.when as (state: unknown) => boolean;
    expect(cycle({ document: { handle: null } })).toBe(false);
    expect(
      cycle({ document: { handle: {} }, editContext: null, selection: {} }),
    ).toBe(true);
    expect(
      cycle({ document: { handle: {} }, editContext: { type: "x" } }),
    ).toBe(false);
  });
});
