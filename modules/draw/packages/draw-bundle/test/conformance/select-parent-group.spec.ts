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

// Wave 2 conformance — selectParentGroup: parentage read through the
// SCENE TREE door (the only click-free parentage door — the
// commands/select-parent-group.ts header records the per-element
// parentOf door gap). Against the real engine: group two quads, select
// a member, cycle up to the group; at the top the command is an honest
// no-op (selection unchanged).

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  CommandContribution,
  ElementId,
  SceneTreeNode,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  parentGroupOf,
  SELECT_PARENT_GROUP_COMMAND_ID,
} from "../../src";
import { F4_OVERLAP } from "../fixtures/corpus";
import { openHost } from "./host";

const UA = { kind: "polygon", id: "ua" } as ElementId;
const UB = { kind: "polygon", id: "ub" } as ElementId;

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

describe("draw conformance — selectParentGroup (wave 2)", () => {
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

  describe("against the real engine (F4 + createGroup)", () => {
    let h: HeadlessHost;
    let groupId: string;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
      h.loadBundle(drawBundle);
      const grouped = await h.host.document.mutate({
        op: "createGroup",
        args: { memberIds: [UA, UB] },
      });
      if (!grouped.applied || !grouped.createdId) {
        throw new Error("createGroup failed");
      }
      groupId = grouped.createdId.id as string;
    });
    afterAll(() => h?.dispose());

    it("a grouped member's selection climbs to the group", async () => {
      await h.host.selection.set([UA]);
      await commandFor(h, SELECT_PARENT_GROUP_COMMAND_ID).handler(
        undefined,
        undefined,
      );
      const sel = h.host.selection.get();
      expect(sel).toHaveLength(1);
      expect(sel[0].kind).toBe("group");
      expect(sel[0].id).toBe(groupId);
    });

    it("at the top of the chain the command is an honest no-op", async () => {
      await h.host.selection.set([{ kind: "group", id: groupId } as ElementId]);
      await commandFor(h, SELECT_PARENT_GROUP_COMMAND_ID).handler(
        undefined,
        undefined,
      );
      const sel = h.host.selection.get();
      expect(sel).toHaveLength(1);
      expect(sel[0].id).toBe(groupId);
    });

    it("no selection → no-op", async () => {
      await h.host.selection.set([]);
      await commandFor(h, SELECT_PARENT_GROUP_COMMAND_ID).handler(
        undefined,
        undefined,
      );
      expect(h.host.selection.get()).toHaveLength(0);
    });
  });
});
