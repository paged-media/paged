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

// The B-04 GROUP wire shapes — `createGroup { memberIds }` and
// `dissolveGroup { groupId }`, pinned so the three features that
// compose them (Pattern Editing's re-plan, Symbols' instance grouping,
// Image Trace's contour grouping) all emit the same thing.
//
// THE COMMAND CONFORMANCE MOVED. "Group selection" / "Ungroup" used to
// be paged.draw commands, and their round-trip against the real engine
// was proven here. They are the HOST's commands now
// (`paged.object.group` / `paged.object.ungroup`), and their coverage
// moved with them to the editor's
// `apps/canvas/tests/e2e/object-commands.spec.ts` — same round trip,
// same undo-x2-is-pristine proof, driven through the real command
// registry against the real engine. What is left here is the wire
// shape, which paged.draw still owns because paged.draw still emits it.
//
// CLIPPING MASKS — the verified verdict, kept here so the suite carries
// it: the wire `GroupSpec` has NO clip semantics (selfId / members +
// the W1.20 inverse-only parent+itemTransform) and core's `Group`
// carries members + transparency + item_transform only; core clipping
// exists solely as `ClippingPathSettings` on placed images. A clip
// group is NOT representable end-to-end, so nothing here fakes one
// (commands/group.ts names the RFI gap).

import { describe, expect, it } from "vitest";

import type { ElementId, Mutation } from "@paged-media/plugin-api";

import { groupMutationFor, ungroupMutationFor } from "../../src";

const RECT = { kind: "rectangle", id: "u1" } as unknown as ElementId;
const POLY = { kind: "polygon", id: "u2" } as unknown as ElementId;

describe("draw conformance — the group wire shapes (B-04)", () => {
  it("groupMutationFor → createGroup{ memberIds }", () => {
    const m = groupMutationFor([RECT, POLY]) as Extract<
      Mutation,
      { op: "createGroup" }
    >;
    expect(m.op).toBe("createGroup");
    expect(m.args.memberIds).toEqual([RECT, POLY]);
  });

  it("ungroupMutationFor → dissolveGroup{ groupId }", () => {
    const m = ungroupMutationFor("u123") as Extract<
      Mutation,
      { op: "dissolveGroup" }
    >;
    expect(m.op).toBe("dissolveGroup");
    expect(m.args.groupId).toBe("u123");
  });
});
