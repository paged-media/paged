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

// `paged.object.*` — the nineteen object verbs, invoked THROUGH the command
// registry (so each `when` gate is the one every surface shares), wired to
// the real runners exactly as the canvas app wires them, over the recording
// fake. Each verb is held to: the exact mutation it sends, ONE mutation (one
// undo step) however many objects it touches, the empty selection and the
// wrong-type selection, the edit-context refusal, and the engine's refusal
// reported in words.

import { describe, expect, test } from "bun:test";

import type { ElementId, ElementProperties } from "@paged-media/client";
import { createCommandRegistry } from "@paged-media/shell";
import {
  covers,
  expectNoCommit,
  expectOneCommit,
  type ShellFakeEditor,
} from "@paged-media/test-kit";

import {
  arrangeSelection,
  buildObjectCommands,
  deleteKeyApplies,
  deleteSelection,
  groupSelection,
  makeClippingMask,
  nudgeKeyApplies,
  nudgeSelection,
  objectVerbApplies,
  OBJECT_METADATA_KEY,
  releaseClippingMask,
  selectParentGroup,
  ungroupSelection,
  type ObjectCommandDeps,
} from "../../../src/object-commands";
import {
  appliedWith,
  group,
  id,
  key,
  layer,
  leaf,
  page,
  refused,
  scriptedFake,
  spread,
  typedClient,
  type ScriptedDocument,
} from "./support";

type Report = ["error" | "info", string];

interface Harness {
  fake: ShellFakeEditor;
  invoke: (command: string) => Promise<unknown>;
  reports: Report[];
  selection: () => ElementId[];
  deps: ObjectCommandDeps;
  state: Record<string, unknown>;
  refreshes: () => number;
}

function objects(
  doc: ScriptedDocument & {
    selection?: ElementId[];
    editContext?: { type: string } | null;
    geometry?: (id: ElementId) => {
      id: ElementId;
      pageId: string;
      bounds: [number, number, number, number];
      itemTransform: number[] | null;
    } | null;
  },
): Harness {
  const fake = scriptedFake(doc, {
    selection: doc.selection,
    geometry: doc.geometry as never,
  });
  const client = typedClient((m) => fake.editor.client.send(m));
  let selection: ElementId[] = [...(doc.selection ?? [])];
  const reports: Report[] = [];
  let refreshes = 0;
  const state: Record<string, unknown> = {
    editContext: doc.editContext ?? null,
    contentSelection: { contentSelection: null },
    selection: { pathEditMode: false },
  };
  const deps: ObjectCommandDeps = {
    client,
    getSelection: () => selection,
    setSelection: async (ids) => {
      selection = await client.setElementSelection(ids, "replace");
    },
    report: (severity, message) => void reports.push([severity, message]),
    activeEditContext: () =>
      (state.editContext as { type: string } | null) ?? null,
    refreshSelectionGeometry: async () => {
      refreshes++;
    },
  };
  // The canvas app's wiring (main.tsx): every verb runs its runner.
  const registry = createCommandRegistry(() => state);
  for (const c of buildObjectCommands({
    bringToFront: () => arrangeSelection(deps, "front"),
    bringForward: () => arrangeSelection(deps, "forward"),
    sendBackward: () => arrangeSelection(deps, "backward"),
    sendToBack: () => arrangeSelection(deps, "back"),
    group: () => groupSelection(deps),
    ungroup: () => ungroupSelection(deps),
    selectParentGroup: () => selectParentGroup(deps),
    delete: () => deleteSelection(deps),
    nudge: (direction, large) => nudgeSelection(deps, direction, large),
    makeClippingMask: () => makeClippingMask(deps),
    releaseClippingMask: () => releaseClippingMask(deps),
  }))
    registry.register(c);
  return {
    fake,
    invoke: async (command) => {
      const r = await registry.invoke(command);
      await fake.settle();
      return r;
    },
    reports,
    selection: () => selection,
    deps,
    state,
    refreshes: () => refreshes,
  };
}

const A = id("rectangle", "uA");
const B = id("rectangle", "uB");
const C = id("oval", "uC");
const T = id("textFrame", "uT");
const G = id("group", "uG");
const STORY = { kind: "story", id: "uS" } as unknown as ElementId;

/** A, B, C on one page, back to front. */
const flat = () => [
  spread(
    page(leaf("rectangle", "uA"), leaf("rectangle", "uB"), leaf("oval", "uC")),
  ),
];

// ── Arrange ─────────────────────────────────────────────────────────

describe("Arrange: bring to front / forward, send backward / to back", () => {
  const verbs = [
    ["paged.object.bringToFront", "front"],
    ["paged.object.bringForward", "forward"],
    ["paged.object.sendBackward", "backward"],
    ["paged.object.sendToBack", "back"],
  ] as const;

  test("one selected object: one reorderElement to the verb's target", async () => {
    covers(
      "command:paged.object.bringToFront",
      "command:paged.object.bringForward",
      "command:paged.object.sendBackward",
      "command:paged.object.sendToBack",
    );
    for (const [command, to] of verbs) {
      const h = objects({ tree: flat(), selection: [B] });
      await h.invoke(command);
      expect(h.fake.mutations()).toEqual([
        { op: "reorderElement", args: { elementId: B, to } },
      ]);
      expectOneCommit(h.fake, 0, command);
      expect(h.reports).toEqual([]);
    }
  });

  test("a multi-selection is ONE batch, applied in the order that keeps its relative stacking", async () => {
    covers(
      "command:paged.object.bringToFront",
      "command:paged.object.sendToBack",
    );
    // Bring to front walks back-to-front, send to back front-to-back,
    // whatever order the user selected in.
    const front = objects({ tree: flat(), selection: [C, A, B] });
    await front.invoke("paged.object.bringToFront");
    expect(front.fake.mutations()).toEqual([
      {
        op: "batch",
        args: {
          ops: [A, B, C].map((elementId) => ({
            op: "reorderElement",
            args: { elementId, to: "front" },
          })),
        },
      },
    ]);
    expectOneCommit(front.fake);

    const back = objects({ tree: flat(), selection: [A, C, B] });
    await back.invoke("paged.object.sendToBack");
    expect(
      (
        back.fake.mutations()[0] as { args: { ops: { args: unknown }[] } }
      ).args.ops.map((o) => (o.args as { elementId: ElementId }).elementId),
    ).toEqual([C, B, A]);
  });

  test("objects already at the end of their list do not step past each other", async () => {
    covers(
      "command:paged.object.bringForward",
      "command:paged.object.sendBackward",
    );
    // B and C are the two frontmost: forward has nowhere to go.
    const forward = objects({ tree: flat(), selection: [B, C] });
    await forward.invoke("paged.object.bringForward");
    expectNoCommit(forward.fake);
    expect(forward.fake.mutations()).toEqual([]);
    // A and B are the two backmost: backward has nowhere to go.
    const backward = objects({ tree: flat(), selection: [A, B] });
    await backward.invoke("paged.object.sendBackward");
    expect(backward.fake.mutations()).toEqual([]);
  });

  test("with more than one layer the arrange applies and says it stays within the layer", async () => {
    covers("command:paged.object.bringToFront");
    const h = objects({
      tree: flat(),
      selection: [A],
      layers: [layer("uL1", 0), layer("uL2", 1)],
    });
    await h.invoke("paged.object.bringToFront");
    expectOneCommit(h.fake);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0][0]).toBe("info");
    expect(h.reports[0][1]).toMatch(
      /^Arrange is within a layer\. This document has 2 layers/,
    );
  });

  test("the engine's refusal is reported, not swallowed", async () => {
    covers("command:paged.object.sendToBack");
    const h = objects({
      tree: flat(),
      selection: [A],
      mutate: () => refused("no such element"),
    });
    await h.invoke("paged.object.sendToBack");
    expect(h.reports).toEqual([["error", "Arrange refused: no such element"]]);
  });

  test("empty selection: nothing sent, nothing reported", async () => {
    covers(
      "command:paged.object.bringToFront",
      "command:paged.object.bringForward",
      "command:paged.object.sendBackward",
      "command:paged.object.sendToBack",
    );
    for (const [command] of verbs) {
      const h = objects({ tree: flat(), selection: [] });
      await h.invoke(command);
      expect(h.fake.mutations()).toEqual([]);
      expect(h.reports).toEqual([]);
    }
  });

  test("an unreadable tree still arranges a single selection", async () => {
    covers("command:paged.object.bringToFront");
    const h = objects({ selection: [A] }); // no tree scripted → read fails
    await h.invoke("paged.object.bringToFront");
    expect(h.fake.mutations()).toEqual([
      { op: "reorderElement", args: { elementId: A, to: "front" } },
    ]);
  });
});

// ── Group / Ungroup / Select parent group ───────────────────────────

describe("Group, Ungroup, Select parent group", () => {
  test("Group: two or more page items become one createGroup, and the new group is selected", async () => {
    covers("command:paged.object.group");
    const h = objects({
      tree: flat(),
      selection: [A, B],
      mutate: (m) => (m.op === "createGroup" ? appliedWith(G) : undefined),
    });
    await h.invoke("paged.object.group");
    expect(h.fake.mutations()).toEqual([
      { op: "createGroup", args: { memberIds: [A, B] } },
    ]);
    expectOneCommit(h.fake);
    expect(h.selection()).toEqual([G]);
  });

  test("Group: fewer than two objects is an honest no-op", async () => {
    covers("command:paged.object.group");
    for (const selection of [[], [A]]) {
      const h = objects({ tree: flat(), selection });
      await h.invoke("paged.object.group");
      expect(h.fake.mutations()).toEqual([]);
      expect(h.reports).toEqual([]);
    }
  });

  test("Group: a refusal is reported and the selection stays", async () => {
    covers("command:paged.object.group");
    const h = objects({
      tree: flat(),
      selection: [A, STORY],
      mutate: () => refused("a story range cannot be grouped"),
    });
    await h.invoke("paged.object.group");
    expect(h.reports).toEqual([
      ["error", "Group refused: a story range cannot be grouped"],
    ]);
    expect(h.selection()).toEqual([A, STORY]);
  });

  test("Ungroup: every selected group dissolves in ONE batch and its direct members are selected", async () => {
    covers("command:paged.object.ungroup");
    const tree = [
      spread(
        page(
          group("uG", leaf("rectangle", "uA"), group("uH", leaf("oval", "uC"))),
          group("uK", leaf("textFrame", "uT")),
          leaf("rectangle", "uB"),
        ),
      ),
    ];
    const K = id("group", "uK");
    const H = id("group", "uH");
    const h = objects({ tree, selection: [G, K, B] });
    await h.invoke("paged.object.ungroup");
    expect(h.fake.mutations()).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            { op: "dissolveGroup", args: { groupId: "uG" } },
            { op: "dissolveGroup", args: { groupId: "uK" } },
          ],
        },
      },
    ]);
    expectOneCommit(h.fake);
    // Non-groups kept; a nested group comes back as a group, not its leaves.
    expect(h.selection()).toEqual([B, A, H, T]);
  });

  test("Ungroup: a selection without a group is a no-op", async () => {
    covers("command:paged.object.ungroup");
    for (const selection of [[], [A, B], [STORY]]) {
      const h = objects({ tree: flat(), selection });
      await h.invoke("paged.object.ungroup");
      expect(h.fake.mutations()).toEqual([]);
      expect(h.reports).toEqual([]);
    }
  });

  test("Select parent group climbs one level, and is pure selection", async () => {
    covers("command:paged.object.selectParentGroup");
    const tree = [
      spread(
        page(
          group("uG", group("uH", leaf("oval", "uC"))),
          leaf("rectangle", "uA"),
        ),
      ),
    ];
    const H = id("group", "uH");
    const h = objects({ tree, selection: [C] });
    await h.invoke("paged.object.selectParentGroup");
    expect(h.selection()).toEqual([H]);
    await h.invoke("paged.object.selectParentGroup");
    expect(h.selection()).toEqual([G]);
    // At the top: an honest no-op.
    await h.invoke("paged.object.selectParentGroup");
    expect(h.selection()).toEqual([G]);
    // A free object has no parent.
    const free = objects({ tree, selection: [A] });
    await free.invoke("paged.object.selectParentGroup");
    expect(free.selection()).toEqual([A]);
    expect(h.fake.mutations()).toEqual([]);
    expect(free.fake.mutations()).toEqual([]);
  });

  test("Select parent group: empty selection reads nothing", async () => {
    covers("command:paged.object.selectParentGroup");
    const h = objects({ tree: flat(), selection: [] });
    await h.invoke("paged.object.selectParentGroup");
    expect(
      h.fake
        .ofChannel("send")
        .filter((e) => e.message.kind === "requestSceneTree"),
    ).toEqual([]);
  });
});

// ── Delete ──────────────────────────────────────────────────────────

describe("Delete", () => {
  test("leaves go in ONE batch; the selection is emptied", async () => {
    covers("command:paged.object.delete");
    const h = objects({ tree: flat(), selection: [A, C] });
    await h.invoke("paged.object.delete");
    expect(h.fake.mutations()).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            { op: "deleteFrame", args: { frameId: "uA" } },
            { op: "deleteFrame", args: { frameId: "uC" } },
          ],
        },
      },
    ]);
    expectOneCommit(h.fake);
    expect(h.selection()).toEqual([]);
  });

  test("a selected group is dissolved, then its leaves deleted, in the same batch", async () => {
    covers("command:paged.object.delete");
    const tree = [
      spread(
        page(
          group("uG", leaf("rectangle", "uA"), leaf("oval", "uC")),
          leaf("rectangle", "uB"),
        ),
      ),
    ];
    const h = objects({ tree, selection: [G, A] });
    await h.invoke("paged.object.delete");
    expect(h.fake.mutations()).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            { op: "dissolveGroup", args: { groupId: "uG" } },
            { op: "deleteFrame", args: { frameId: "uA" } },
            { op: "deleteFrame", args: { frameId: "uC" } },
          ],
        },
      },
    ]);
  });

  test("deleting every member of an unselected group dissolves the emptied group first", async () => {
    covers("command:paged.object.delete");
    const tree = [
      spread(
        page(group("uG", leaf("rectangle", "uA")), leaf("rectangle", "uB")),
      ),
    ];
    const h = objects({ tree, selection: [A] });
    await h.invoke("paged.object.delete");
    expect(h.fake.mutations()).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            { op: "dissolveGroup", args: { groupId: "uG" } },
            { op: "deleteFrame", args: { frameId: "uA" } },
          ],
        },
      },
    ]);
  });

  test("a clipping path takes its clipped content with it (released first, deepest first)", async () => {
    covers("command:paged.object.delete");
    const inside = id("oval", "uIn");
    const index: ElementProperties = {
      entries: [
        {
          path: "pluginMetadata",
          value: {
            type: "pluginMetadata",
            value: {
              key: OBJECT_METADATA_KEY,
              value: JSON.stringify({ v: 1, data: { clipContent: [inside] } }),
            },
          },
        },
      ],
    } as unknown as ElementProperties;
    const h = objects({
      tree: flat(),
      selection: [A],
      properties: { [key(A)]: index },
      // The nested item exists (geometry answers) but is not in the tree.
      geometry: (e) =>
        key(e) === key(inside)
          ? {
              id: inside,
              pageId: "page-1",
              bounds: [0, 0, 1, 1],
              itemTransform: null,
            }
          : null,
    });
    await h.invoke("paged.object.delete");
    expect(h.fake.mutations()).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            { op: "releaseFrom", args: { childId: inside } },
            { op: "deleteFrame", args: { frameId: "uIn" } },
            { op: "deleteFrame", args: { frameId: "uA" } },
          ],
        },
      },
    ]);
  });

  test("empty selection and a selection of content addresses: nothing sent", async () => {
    covers("command:paged.object.delete");
    for (const selection of [[], [STORY]]) {
      const h = objects({ tree: flat(), selection });
      await h.invoke("paged.object.delete");
      expect(h.fake.mutations()).toEqual([]);
      expect(h.reports).toEqual([]);
    }
  });

  test("an unreadable tree refuses rather than guessing", async () => {
    covers("command:paged.object.delete");
    const h = objects({ selection: [A] });
    await h.invoke("paged.object.delete");
    expect(h.fake.mutations()).toEqual([]);
    expect(h.reports).toEqual([
      [
        "error",
        "Delete refused: the document structure could not be read, so nothing was removed.",
      ],
    ]);
  });

  test("the engine's refusal is reported and the selection kept", async () => {
    covers("command:paged.object.delete");
    const h = objects({
      tree: flat(),
      selection: [A],
      mutate: () => refused("release it before removing"),
    });
    await h.invoke("paged.object.delete");
    expect(h.reports).toEqual([
      ["error", "Delete refused: release it before removing"],
    ]);
    expect(h.selection()).toEqual([A]);
  });
});

// ── Nudge ───────────────────────────────────────────────────────────

describe("Nudge ×8", () => {
  const steps = [
    ["paged.object.nudgeLeft", [-1, 0]],
    ["paged.object.nudgeRight", [1, 0]],
    ["paged.object.nudgeUp", [0, -1]],
    ["paged.object.nudgeDown", [0, 1]],
    ["paged.object.nudgeLeftLarge", [-10, 0]],
    ["paged.object.nudgeRightLarge", [10, 0]],
    ["paged.object.nudgeUpLarge", [0, -10]],
    ["paged.object.nudgeDownLarge", [0, 10]],
  ] as const;

  const at = (tx: number, ty: number) => (e: ElementId) => ({
    id: e,
    pageId: "page-1",
    bounds: [ty, tx, ty + 10, tx + 10] as [number, number, number, number],
    itemTransform: [1, 0, 0, 1, tx, ty],
  });

  test("each nudge moves a leaf by its step: one moveFrame with the translated transform", async () => {
    covers(
      "command:paged.object.nudgeLeft",
      "command:paged.object.nudgeRight",
      "command:paged.object.nudgeUp",
      "command:paged.object.nudgeDown",
      "command:paged.object.nudgeLeftLarge",
      "command:paged.object.nudgeRightLarge",
      "command:paged.object.nudgeUpLarge",
      "command:paged.object.nudgeDownLarge",
    );
    for (const [command, [dx, dy]] of steps) {
      const h = objects({
        tree: flat(),
        selection: [A],
        geometry: at(100, 50),
      });
      await h.invoke(command);
      expect({ command, sent: h.fake.mutations() }).toEqual({
        command,
        sent: [
          {
            op: "moveFrame",
            args: { frameId: "uA", transform: [1, 0, 0, 1, 100 + dx, 50 + dy] },
          },
        ],
      });
      expectOneCommit(h.fake, 0, command);
      expect(h.refreshes()).toBe(1);
    }
  });

  test("a group rides setGroupTransform from its own stored transform", async () => {
    covers("command:paged.object.nudgeRight");
    const groupProps = {
      entries: [
        {
          path: "frameTransform",
          value: { type: "transform", value: [1, 0, 0, 1, 5, 5] },
        },
      ],
    } as unknown as ElementProperties;
    const h = objects({
      tree: [spread(page(group("uG", leaf("rectangle", "uA"))))],
      selection: [G],
      properties: { [key(G)]: groupProps },
      geometry: (e) =>
        key(e) === key(G)
          ? {
              id: G,
              pageId: "page-1",
              bounds: [5, 5, 15, 15],
              itemTransform: [1, 0, 0, 1, 5, 5],
            }
          : null,
    });
    await h.invoke("paged.object.nudgeRight");
    expect(h.fake.mutations()).toEqual([
      {
        op: "setGroupTransform",
        args: { groupId: "uG", transform: [1, 0, 0, 1, 6, 5] },
      },
    ]);
  });

  test("a selected group's own members are not moved twice", async () => {
    covers("command:paged.object.nudgeDown");
    const groupProps = {
      entries: [
        { path: "frameTransform", value: { type: "transform", value: null } },
      ],
    } as unknown as ElementProperties;
    const h = objects({
      tree: [
        spread(
          page(group("uG", leaf("rectangle", "uA")), leaf("rectangle", "uB")),
        ),
      ],
      selection: [G, A, B],
      properties: { [key(G)]: groupProps },
      geometry: at(0, 0),
    });
    await h.invoke("paged.object.nudgeDown");
    const [only] = h.fake.mutations() as Array<{
      op: string;
      args: { ops: Array<{ op: string; args: Record<string, unknown> }> };
    }>;
    expect(only.op).toBe("batch");
    expect(
      only.args.ops.map((o) => [o.op, o.args.frameId ?? o.args.groupId]),
    ).toEqual([
      ["moveFrame", "uB"],
      ["setGroupTransform", "uG"],
    ]);
  });

  test("presses made while a nudge is in flight fold into ONE next batch", async () => {
    covers("command:paged.object.nudgeRight");
    const h = objects({ tree: flat(), selection: [A], geometry: at(0, 0) });
    await Promise.all([
      h.invoke("paged.object.nudgeRight"),
      h.invoke("paged.object.nudgeRight"),
      h.invoke("paged.object.nudgeRight"),
    ]);
    // Three presses before the drain started: one write of +3.
    expect(h.fake.mutations()).toEqual([
      {
        op: "moveFrame",
        args: { frameId: "uA", transform: [1, 0, 0, 1, 3, 0] },
      },
    ]);
  });

  test("no geometry for a leaf refuses the nudge in words", async () => {
    covers("command:paged.object.nudgeLeft");
    const h = objects({ tree: flat(), selection: [A] });
    await h.invoke("paged.object.nudgeLeft");
    expect(h.fake.mutations()).toEqual([]);
    expect(h.reports).toEqual([
      [
        "error",
        "Nudge refused: the engine reports no geometry for rectangle uA, so there is no position to move.",
      ],
    ]);
  });

  test("empty selection and content addresses: nothing moves", async () => {
    covers("command:paged.object.nudgeUp");
    for (const selection of [[], [STORY]]) {
      const h = objects({ tree: flat(), selection, geometry: at(0, 0) });
      await h.invoke("paged.object.nudgeUp");
      expect(h.fake.mutations()).toEqual([]);
      expect(h.reports).toEqual([]);
    }
  });
});

// ── Clipping masks ──────────────────────────────────────────────────

describe("Make / release clipping mask", () => {
  test("Make: the topmost object clips the rest, pasted back to front, plus the index, in ONE batch", async () => {
    covers("command:paged.object.makeClippingMask");
    const h = objects({ tree: flat(), selection: [A, C, B] });
    await h.invoke("paged.object.makeClippingMask");
    expect(h.fake.mutations()).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            { op: "pasteInto", args: { containerId: C, childId: A } },
            { op: "pasteInto", args: { containerId: C, childId: B } },
            {
              op: "setPluginMetadata",
              args: {
                elementId: C,
                key: OBJECT_METADATA_KEY,
                value: JSON.stringify({
                  v: 1,
                  data: {
                    clipContent: [
                      { kind: "rectangle", id: "uA" },
                      { kind: "rectangle", id: "uB" },
                    ],
                  },
                }),
              },
            },
          ],
        },
      },
    ]);
    expectOneCommit(h.fake);
    expect(h.selection()).toEqual([C]);
  });

  test("Make: one object, a text frame on top, or a group as content are refused before the wire", async () => {
    covers("command:paged.object.makeClippingMask");
    const cases: Array<[ElementId[], RegExp, ReturnType<typeof flat>]> = [
      [[A], /needs two or more objects/, flat()],
      [
        [A, T],
        /the topmost object, text frame uT, cannot be a clipping path/,
        [spread(page(leaf("rectangle", "uA"), leaf("textFrame", "uT")))],
      ],
      [
        [G, B],
        /group uG cannot be clipped/,
        [
          spread(
            page(group("uG", leaf("oval", "uC")), leaf("rectangle", "uB")),
          ),
        ],
      ],
    ];
    for (const [selection, reason, tree] of cases) {
      const h = objects({ tree, selection });
      await h.invoke("paged.object.makeClippingMask");
      expect(h.fake.mutations()).toEqual([]);
      expect(h.reports).toHaveLength(1);
      expect(h.reports[0][1]).toMatch(reason);
    }
  });

  test("Make: the empty selection and content addresses do nothing", async () => {
    covers("command:paged.object.makeClippingMask");
    for (const selection of [[], [STORY]]) {
      const h = objects({ tree: flat(), selection });
      await h.invoke("paged.object.makeClippingMask");
      expect(h.fake.mutations()).toEqual([]);
      expect(h.reports).toEqual([]);
    }
  });

  test("Release: pops the indexed content out beneath its path and clears the index, in ONE batch", async () => {
    covers("command:paged.object.releaseClippingMask");
    const inside = id("rectangle", "uIn");
    const index = {
      entries: [
        {
          path: "pluginMetadata",
          value: {
            type: "pluginMetadata",
            value: {
              key: OBJECT_METADATA_KEY,
              value: JSON.stringify({ v: 1, data: { clipContent: [inside] } }),
            },
          },
        },
      ],
    } as unknown as ElementProperties;
    const h = objects({
      tree: flat(),
      selection: [C],
      properties: { [key(C)]: index },
      geometry: (e) =>
        key(e) === key(inside)
          ? {
              id: inside,
              pageId: "page-1",
              bounds: [0, 0, 1, 1],
              itemTransform: null,
            }
          : null,
    });
    await h.invoke("paged.object.releaseClippingMask");
    expect(h.fake.mutations()).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            { op: "releaseFrom", args: { childId: inside } },
            // C sat at index 2 of [A, B, C]: the released item lands at 2,
            // directly beneath it.
            {
              op: "reorderElement",
              args: { elementId: inside, to: { index: 2 } },
            },
            {
              op: "setPluginMetadata",
              args: { elementId: C, key: OBJECT_METADATA_KEY, value: null },
            },
          ],
        },
      },
    ]);
    expectOneCommit(h.fake);
    expect(h.selection()).toEqual([inside, C]);
  });

  test("Release: no clipping-path kind selected, or no index, is reported", async () => {
    covers("command:paged.object.releaseClippingMask");
    const noPath = objects({ tree: flat(), selection: [T] });
    await noPath.invoke("paged.object.releaseClippingMask");
    expect(noPath.reports[0]?.[1]).toMatch(/select a clipping path/);
    const noIndex = objects({ tree: flat(), selection: [A] });
    await noIndex.invoke("paged.object.releaseClippingMask");
    expect(noIndex.fake.mutations()).toEqual([]);
    expect(noIndex.reports[0]?.[1]).toMatch(
      /holds no content this editor clipped/,
    );
    const empty = objects({ tree: flat(), selection: [] });
    await empty.invoke("paged.object.releaseClippingMask");
    expect(empty.reports).toEqual([]);
  });
});

// ── ADR 024: the edit-context gate and the key-owner predicates ──────

describe("inside an edit context the object verbs do not apply", () => {
  const ALL = [
    "paged.object.bringToFront",
    "paged.object.bringForward",
    "paged.object.sendBackward",
    "paged.object.sendToBack",
    "paged.object.group",
    "paged.object.ungroup",
    "paged.object.selectParentGroup",
    "paged.object.delete",
    "paged.object.nudgeLeft",
    "paged.object.nudgeRight",
    "paged.object.nudgeUp",
    "paged.object.nudgeDown",
    "paged.object.nudgeLeftLarge",
    "paged.object.nudgeRightLarge",
    "paged.object.nudgeUpLarge",
    "paged.object.nudgeDownLarge",
    "paged.object.makeClippingMask",
    "paged.object.releaseClippingMask",
  ];

  test("through the registry: every verb refuses silently (its `when` is false)", async () => {
    covers(
      "command:paged.object.bringToFront",
      "command:paged.object.bringForward",
      "command:paged.object.sendBackward",
      "command:paged.object.sendToBack",
      "command:paged.object.group",
      "command:paged.object.ungroup",
      "command:paged.object.selectParentGroup",
      "command:paged.object.delete",
      "command:paged.object.nudgeLeft",
      "command:paged.object.nudgeRight",
      "command:paged.object.nudgeUp",
      "command:paged.object.nudgeDown",
      "command:paged.object.nudgeLeftLarge",
      "command:paged.object.nudgeRightLarge",
      "command:paged.object.nudgeUpLarge",
      "command:paged.object.nudgeDownLarge",
      "command:paged.object.makeClippingMask",
      "command:paged.object.releaseClippingMask",
    );
    for (const command of ALL) {
      const h = objects({
        tree: flat(),
        selection: [A, B],
        editContext: { type: "sheet" },
      });
      await h.invoke(command);
      expect({ command, sent: h.fake.mutations() }).toEqual({
        command,
        sent: [],
      });
      expect(h.reports).toEqual([]);
    }
  });

  test("a shortcut that reaches the runner anyway is told why, in words", async () => {
    covers("command:paged.object.group");
    const h = objects({
      tree: flat(),
      selection: [A, B],
      editContext: { type: "vectorGraphic" },
    });
    await groupSelection(h.deps);
    expect(h.fake.mutations()).toEqual([]);
    expect(h.reports).toEqual([
      [
        "info",
        "Group arranges page items, and you are editing inside a vectorGraphic. Leave the frame (Esc) to arrange it in the document.",
      ],
    ]);
  });

  test("a text caret or path-edit mode takes Delete and the nudges, not the arrange verbs", async () => {
    covers(
      "command:paged.object.delete",
      "command:paged.object.nudgeLeft",
      "command:paged.object.bringToFront",
    );
    const caret = {
      editContext: null,
      contentSelection: {
        contentSelection: { storyId: "uS", start: 0, end: 0 },
      },
    };
    const pathEdit = { editContext: null, selection: { pathEditMode: true } };
    expect(objectVerbApplies(caret)).toBe(false);
    expect(objectVerbApplies(pathEdit)).toBe(false);
    expect(objectVerbApplies({})).toBe(true);
    for (const state of [caret, pathEdit]) {
      const h = objects({ tree: flat(), selection: [A] });
      Object.assign(h.state, state);
      await h.invoke("paged.object.delete");
      await h.invoke("paged.object.nudgeLeft");
      expect(h.fake.mutations()).toEqual([]);
      // Arrange is still offered with a caret: it reads `notInsideAnEditContext`.
      await h.invoke("paged.object.bringToFront");
      expect(h.fake.mutations()).toHaveLength(1);
    }
  });

  test("the keys yield to the Page tool (Delete) and to a drag in progress (arrows)", () => {
    covers("command:paged.object.delete", "command:paged.object.nudgeRight");
    expect(
      deleteKeyApplies({ tool: { effectiveTool: "paged.tool.page" } }),
    ).toBe(false);
    expect(
      deleteKeyApplies({ tool: { effectiveTool: "paged.tool.select" } }),
    ).toBe(true);
    expect(
      nudgeKeyApplies({
        overlaySignals: { toolPreview: { rect: [0, 0, 1, 1] } },
      }),
    ).toBe(false);
    expect(
      nudgeKeyApplies({ overlaySignals: { marqueeRect: [0, 0, 1, 1] } }),
    ).toBe(false);
    expect(
      nudgeKeyApplies({
        overlaySignals: { toolPreview: null, marqueeRect: null },
      }),
    ).toBe(true);
  });
});
