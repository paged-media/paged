// Phase 2d — GROUP / UNGROUP as commands (the B-04 wire consumers).
//
// `createGroup { memberIds }` and `dissolveGroup { groupId }` are on the
// wire (B-04; protocol ≥ 35, nesting since W1.20). "Group selection"
// wraps the current selection (≥ 2 page items — the InDesign floor) in
// a new group whose z-slot is its topmost member's; "Ungroup" dissolves
// every selected group back into its members, z-order preserved (the
// engine's `frames_in_order` surgery on both sides).
//
// CLIPPING MASKS — VERIFIED NOT REPRESENTABLE, honestly omitted: the
// wire `GroupSpec` carries only `selfId` / `members` + the W1.20
// inverse-only fields (`parent`, `itemTransform`), and core's parsed
// `Group` (paged-parse `spread.rs`) carries members + transparency +
// item_transform — NO clip flag, NO mask member, NO clip path. Core's
// only clipping today is `ClippingPathSettings` on PLACED IMAGES (and
// paragraph-shading `clip_to_frame`), neither of which a group can
// claim. So a clip-group / "paste into" cannot be expressed end-to-end;
// faking one (e.g. metadata-tagging a plain group as a "mask") would
// render nothing and lie on save. The gap belongs to the cross-repo RFI
// (`thoughts/docs/paged/plugin-platform/rfi-core-sdk-gaps.md`) as a
// core GroupSpec/scene extension; this module ships the honest subset.
//
// Host-agnostic: imports only plugin-api types; every engine touch is a
// `host.*` facade (`document.mutate` / `document.tree` / `selection`).

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  SceneTreeNode,
} from "@paged-media/plugin-api";

/** The command category the group commands group under. */
export const GROUP_COMMAND_CATEGORY = "Arrange";

export const GROUP_COMMAND_ID = "media.paged.draw.command.groupSelection";
export const UNGROUP_COMMAND_ID = "media.paged.draw.command.ungroup";

/** The contributed command ids, in registration order. */
export const GROUP_COMMAND_IDS = [GROUP_COMMAND_ID, UNGROUP_COMMAND_ID];

/** The `createGroup{ memberIds }` mutation "Group selection" commits.
 *  Exported so the conformance spec asserts the EXACT wire shape the
 *  live command emits (no second copy to drift from). */
export function groupMutationFor(memberIds: ElementId[]): Mutation {
  return { op: "createGroup", args: { memberIds } };
}

/** The `dissolveGroup{ groupId }` mutation "Ungroup" commits per
 *  selected group. */
export function ungroupMutationFor(groupId: string): Mutation {
  return { op: "dissolveGroup", args: { groupId } };
}

/** Walk the scene tree for the group node with `groupId` and return its
 *  direct selectable children — the members "Ungroup" re-selects after
 *  the dissolve (a facade-only read; the wire's `requestGroupLeaves`
 *  flattens to LEAVES, which would lose nested sub-groups). */
function memberIdsFromTree(
  roots: SceneTreeNode[],
  groupId: string,
): ElementId[] {
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id && node.id.kind === "group" && node.id.id === groupId) {
      return (node.children ?? [])
        .map((c) => c.id)
        .filter((id): id is ElementId => id != null);
    }
    if (node.children) stack.push(...node.children);
  }
  return [];
}

/** "Group selection": wrap the current selection (≥ 2 elements) in a
 *  new group and select it. Fewer than two ⇒ no-op (a debug log, never
 *  a throw — the dash-command convention). */
export async function applyGroupSelection(host: BundleHost): Promise<void> {
  const selection = host.selection.get();
  if (selection.length < 2) {
    host.log.debug(
      `${GROUP_COMMAND_ID}: needs ≥ 2 selected elements (have ${selection.length}) — no-op`,
    );
    return;
  }
  const outcome = await host.document.mutate(groupMutationFor(selection));
  if (!outcome.applied) {
    host.log.warn(
      `${GROUP_COMMAND_ID} rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return;
  }
  // The engine echoes the minted group id (a page-item create reports
  // `createdId`) — select the new group so follow-up commands (move,
  // Ungroup) address it.
  if (outcome.createdId) {
    await host.selection.set([outcome.createdId]);
  }
}

/** "Ungroup": dissolve every selected GROUP back into its members and
 *  select those members. Selection without a group ⇒ no-op (debug log).
 *  Non-group selection entries are left out of the dissolve but kept in
 *  the re-selection. */
export async function applyUngroup(host: BundleHost): Promise<void> {
  const selection = host.selection.get();
  const groups = selection.filter((id) => id.kind === "group");
  if (groups.length === 0) {
    host.log.debug(`${UNGROUP_COMMAND_ID}: selection holds no group — no-op`);
    return;
  }
  // Capture each group's direct members BEFORE the dissolve (the group
  // node vanishes from the tree afterwards).
  const tree = await host.document.tree();
  const nextSelection: ElementId[] = selection.filter(
    (id) => id.kind !== "group",
  );
  for (const group of groups) {
    const members = memberIdsFromTree(tree, group.id as string);
    const outcome = await host.document.mutate(
      ungroupMutationFor(group.id as string),
    );
    if (!outcome.applied) {
      host.log.warn(
        `${UNGROUP_COMMAND_ID} rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
      continue;
    }
    nextSelection.push(...members);
  }
  await host.selection.set(nextSelection);
}

/** Register the two group commands. Each handler ignores its
 *  `(paged, payload)` args and drives the bundle's own `host` (the
 *  dash-command pattern). Returns a Disposable dropping both
 *  registrations (the host also tracks them for teardown). */
export function contributeGroupCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: GROUP_COMMAND_ID,
      title: "Group selection",
      category: GROUP_COMMAND_CATEGORY,
      handler: () => applyGroupSelection(host),
    }),
    host.contribute.command({
      id: UNGROUP_COMMAND_ID,
      title: "Ungroup",
      category: GROUP_COMMAND_CATEGORY,
      handler: () => applyUngroup(host),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
