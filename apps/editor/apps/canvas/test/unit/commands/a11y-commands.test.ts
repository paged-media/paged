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
// tree"): the selection cycle's arithmetic and the box it asks under, the
// commands' ids, menus and keys. The browser half is
// tests/e2e/uxi-accessibility.spec.ts.

import { describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  A11Y_KEYBINDINGS,
  A11Y_MENU_ITEMS,
  A11Y_TREE_COMMAND,
  SELECT_NEXT_ABOVE_COMMAND,
  SELECT_NEXT_BELOW_COMMAND,
  buildA11yCommands,
  nextInStack,
  unionBox,
} from "../../../src/a11y-commands";

describe("the selection cycle", () => {
  test("steps down and up the stack and wraps; with nothing selected below starts on top", () => {
    covers("command:paged.object.selectNextBelow");
    covers("command:paged.object.selectNextAbove");
    expect(nextInStack(3, -1, "below")).toBe(0);
    expect(nextInStack(3, -1, "above")).toBe(2);
    expect(nextInStack(3, 0, "below")).toBe(1);
    expect(nextInStack(3, 2, "below")).toBe(0);
    expect(nextInStack(3, 0, "above")).toBe(2);
    expect(nextInStack(0, -1, "below")).toBe(-1);
  });

  test("asks under the selection's box on its first item's page, transforms applied", () => {
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
      [A11Y_TREE_COMMAND, SELECT_NEXT_BELOW_COMMAND, SELECT_NEXT_ABOVE_COMMAND],
    );
    expect(A11Y_MENU_ITEMS.map((m) => [m.path, m.command])).toEqual([
      ["View/Go to object tree", A11Y_TREE_COMMAND],
      ["Object/Select next object below", SELECT_NEXT_BELOW_COMMAND],
      ["Object/Select next object above", SELECT_NEXT_ABOVE_COMMAND],
    ]);
    expect(A11Y_KEYBINDINGS.map((k) => [k.key, k.command])).toEqual([
      ["alt+shift+o", A11Y_TREE_COMMAND],
      ["cmd+alt+[", SELECT_NEXT_BELOW_COMMAND],
      ["ctrl+alt+[", SELECT_NEXT_BELOW_COMMAND],
      ["cmd+alt+]", SELECT_NEXT_ABOVE_COMMAND],
      ["ctrl+alt+]", SELECT_NEXT_ABOVE_COMMAND],
    ]);
    // The cycle needs a document; at the document root only.
    const cycle = buildA11yCommands({ showPanel: () => {} })[1]!.when as (
      state: unknown,
    ) => boolean;
    expect(cycle({ document: { handle: null } })).toBe(false);
    expect(
      cycle({
        document: { handle: {} },
        editContext: null,
        selection: {},
      }),
    ).toBe(true);
    expect(
      cycle({ document: { handle: {} }, editContext: { type: "x" } }),
    ).toBe(false);
  });
});
