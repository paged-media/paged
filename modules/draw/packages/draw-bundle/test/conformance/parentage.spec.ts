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

// PARENTAGE conformance — `parentGroupOf`, the pure resolver Appearance
// bake and Symbols read to find the group an element lives in.
//
// THE COMMAND CONFORMANCE MOVED. This resolver used to back paged.draw's
// "Select: Parent group"; that command is the HOST's now
// (`paged.object.selectParentGroup`), and the against-the-real-engine
// half of this file — climb from a member to its group, an honest no-op
// at the top of the chain, an honest no-op with nothing selected —
// moved with it to the editor's
// `apps/canvas/tests/e2e/object-commands.spec.ts`. The pure walk stays
// here because paged.draw still walks it.

import { describe, expect, it } from "vitest";

import type { ElementId, SceneTreeNode } from "@paged-media/plugin-api";

import { parentGroupOf } from "../../src";

describe("draw conformance — tree parentage", () => {
  it("parentGroupOf resolves the NEAREST group ancestor (pure)", () => {
    const leaf = (id: string): SceneTreeNode => ({
      id: { kind: "polygon", id } as ElementId,
      kind: "Polygon",
      label: id,
    });
    const roots: SceneTreeNode[] = [
      {
        kind: "Spread",
        label: "spread",
        children: [
          {
            id: { kind: "group", id: "gOuter" } as ElementId,
            kind: "Group",
            label: "outer",
            children: [
              {
                id: { kind: "group", id: "gInner" } as ElementId,
                kind: "Group",
                label: "inner",
                children: [leaf("deep")],
              },
              leaf("shallow"),
            ],
          },
          leaf("free"),
        ],
      },
    ];
    expect(parentGroupOf(roots, { kind: "polygon", id: "deep" } as ElementId)).toEqual({
      kind: "group",
      id: "gInner",
    });
    expect(
      parentGroupOf(roots, { kind: "polygon", id: "shallow" } as ElementId),
    ).toEqual({ kind: "group", id: "gOuter" });
    // Cycling: the inner group's own parent is the outer group.
    expect(parentGroupOf(roots, { kind: "group", id: "gInner" } as ElementId)).toEqual({
      kind: "group",
      id: "gOuter",
    });
    // Top level (or unknown) → null.
    expect(parentGroupOf(roots, { kind: "polygon", id: "free" } as ElementId)).toBeNull();
    expect(parentGroupOf(roots, { kind: "group", id: "gOuter" } as ElementId)).toBeNull();
    expect(parentGroupOf(roots, { kind: "polygon", id: "ghost" } as ElementId)).toBeNull();
  });
});
