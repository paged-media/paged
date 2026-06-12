// Phase 2d — Group selection / Ungroup conformance (the B-04 wire
// consumers) against the REAL engine: `createGroup { memberIds }` over
// the live selection, `dissolveGroup { groupId }` back, the round-trip
// asserted through `document.tree()` and unwound through the engine's
// own undo stack.
//
// CLIPPING MASKS — the verified verdict, pinned here so the suite
// carries it: the wire `GroupSpec` has NO clip semantics (selfId /
// members / inverse-only parent+itemTransform) and core's `Group`
// carries members + transparency + item_transform only; core clipping
// exists solely as `ClippingPathSettings` on placed images. A clip
// group is NOT representable end-to-end, so the bundle ships the
// honest group/ungroup subset (commands/group.ts names the RFI gap).

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  CommandContribution,
  ElementId,
  Mutation,
  SceneTreeNode,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle } from "../../src";
import { groupMutationFor, ungroupMutationFor } from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: F1_MULTI_SHAPE.ids.rectangle! } as const;
const POLY = { kind: "polygon", id: F1_MULTI_SHAPE.ids.polygon! } as const;
const LINE = {
  kind: "graphicLine",
  id: F1_MULTI_SHAPE.ids.graphicLine!,
} as const;

/** Pull the `value` of a recorded command contribution by id. */
function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

/** Every group node in the scene tree, with its direct child ids. */
function groupsInTree(
  roots: SceneTreeNode[],
): Array<{ id: string; memberIds: string[] }> {
  const found: Array<{ id: string; memberIds: string[] }> = [];
  const walk = (nodes: SceneTreeNode[]) => {
    for (const node of nodes) {
      if (node.id && node.id.kind === "group") {
        found.push({
          id: node.id.id as string,
          memberIds: (node.children ?? [])
            .map((c) => c.id)
            .filter((id): id is ElementId => id != null)
            .map((id) => id.id as string),
        });
      }
      if (node.children) walk(node.children);
    }
  };
  walk(roots);
  return found;
}

describe("draw conformance — group / ungroup commands (B-04)", () => {
  describe("the exact wire shapes the commands emit", () => {
    it("groupMutationFor → createGroup{ memberIds }", () => {
      const m = groupMutationFor([RECT, POLY] as unknown as ElementId[]) as Extract<
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

  describe("round-trip on the real engine", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("group two shapes → ungroup → undo ×2 restores the pristine tree", async () => {
      // Pristine: no groups in the fixture.
      expect(groupsInTree(await h.host.document.tree())).toHaveLength(0);

      // GROUP: select rect + poly, fire the recorded command handler.
      await h.host.selection.set([RECT, POLY] as never);
      const group = commandFor(h, "media.paged.draw.command.groupSelection");
      await group.handler(undefined);

      // The tree now holds ONE group wrapping exactly the two members.
      const grouped = groupsInTree(await h.host.document.tree());
      expect(grouped).toHaveLength(1);
      expect(grouped[0].memberIds.sort()).toEqual(
        [RECT.id, POLY.id].sort(),
      );
      // The line stayed outside the group.
      expect(grouped[0].memberIds).not.toContain(LINE.id);
      // The command selected the minted group (createdId echoed).
      const selection = h.host.selection.get();
      expect(selection).toHaveLength(1);
      expect(selection[0].kind).toBe("group");
      expect((selection[0] as { id: string }).id).toBe(grouped[0].id);

      // UNGROUP: fire the recorded handler on the group selection.
      const ungroup = commandFor(h, "media.paged.draw.command.ungroup");
      await ungroup.handler(undefined);

      // The group is gone; the members are re-selected.
      expect(groupsInTree(await h.host.document.tree())).toHaveLength(0);
      const reselected = h.host.selection
        .get()
        .map((id) => (id as { id: string }).id)
        .sort();
      expect(reselected).toEqual([RECT.id, POLY.id].sort());

      // UNDO the dissolve — the group is back, members intact.
      await h.host.document.undo();
      const restored = groupsInTree(await h.host.document.tree());
      expect(restored).toHaveLength(1);
      expect(restored[0].memberIds.sort()).toEqual(
        [RECT.id, POLY.id].sort(),
      );

      // UNDO the create — pristine again (the B-04 inverse proof).
      await h.host.document.undo();
      expect(groupsInTree(await h.host.document.tree())).toHaveLength(0);
    });

    it("Group selection with < 2 selected elements is a no-op (no throw, no group)", async () => {
      await h.host.selection.set([RECT] as never);
      const group = commandFor(h, "media.paged.draw.command.groupSelection");
      await expect(group.handler(undefined)).resolves.toBeUndefined();
      expect(groupsInTree(await h.host.document.tree())).toHaveLength(0);
    });

    it("Ungroup with no group in the selection is a no-op (no throw)", async () => {
      await h.host.selection.set([RECT, POLY] as never);
      const ungroup = commandFor(h, "media.paged.draw.command.ungroup");
      await expect(ungroup.handler(undefined)).resolves.toBeUndefined();
      // Selection untouched by the no-op.
      expect(h.host.selection.get()).toHaveLength(2);
    });
  });
});
