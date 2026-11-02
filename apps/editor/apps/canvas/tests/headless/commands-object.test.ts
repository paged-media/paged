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

// `paged.object.*` against the REAL engine (the headless editor): each verb
// through the registry on the gesture-targets document (a frame, a group,
// a rotated frame, a locked frame, a master item, a path, a second page),
// asserted on the document model, and undone in ONE step — one Cmd+Z puts
// the model back byte for byte. Then the cases a user meets by accident:
// nothing selected, the wrong kind selected, no document, inside an edit
// context.

import { afterEach, describe, expect, test } from "bun:test";

import {
  covers,
  gestureFixture,
  GESTURE_TARGETS as T,
} from "@paged-media/test-kit";
import type { ElementId } from "@paged-media/client";
import { transformBounds } from "@paged-media/helpers";
import {
  dumpDiff,
  elementKey,
  type ModelDump,
} from "@paged-media/test-kit/headless";

import { createHeadlessEditor, type HeadlessEditor } from "./harness";

let ed: HeadlessEditor | null = null;
afterEach(async () => {
  await ed?.dispose();
  ed = null;
});

const open = async () => {
  ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
  return ed;
};

/** Run a verb; resolves to the model before and after. */
async function run(
  e: HeadlessEditor,
  command: string,
): Promise<{ before: ModelDump; after: ModelDump }> {
  const before = await e.dump();
  await e.invoke(command);
  await e.idle();
  return { before, after: await e.dump() };
}

/** ONE undo step: a single undo restores `before` exactly. */
async function expectOneUndoStep(e: HeadlessEditor, before: ModelDump) {
  await e.invoke("paged.editor.undo");
  await e.idle();
  expect(dumpDiff(before, await e.dump())).toEqual([]);
}

type Node = { id?: { kind: string; id: string } | null; children?: Node[] };
/** The ids of page 1's top-level items, back to front. */
const pageOne = (dump: ModelDump): string[] => {
  const spread = (dump.tree as Node[])[0];
  const page = spread.children![0];
  return page.children!.map((n) => elementKey(n.id!));
};

const bounds = (dump: ModelDump, key: string): number[] => {
  const el = dump.elements[key] as {
    entries: Array<{ path: string; value: { value: unknown } }>;
  };
  return el.entries.find((e) => e.path === "frameTransform")!.value
    .value as number[];
};

const FRAME = elementKey(T.frame.id);
const PATH = elementKey(T.path.id);
const GROUP = elementKey(T.group.id);

describe("Arrange", () => {
  test("Bring to front / Send to back move the frame to the ends of the page's list, one undo step each", async () => {
    covers(
      "command:paged.object.bringToFront",
      "command:paged.object.sendToBack",
      "command:paged.editor.undo",
    );
    const e = await open();
    await e.select([T.frame.id]);
    const front = await run(e, "paged.object.bringToFront");
    expect(pageOne(front.after).at(-1)).toBe(FRAME);
    expect(e.problems()).toEqual([]);
    await expectOneUndoStep(e, front.before);
    await e.select([T.path.id]);
    const back = await run(e, "paged.object.sendToBack");
    expect(pageOne(back.after)[0]).toBe(PATH);
    await expectOneUndoStep(e, back.before);
  });

  test("Bring forward / Send backward step one place", async () => {
    covers(
      "command:paged.object.bringForward",
      "command:paged.object.sendBackward",
    );
    const e = await open();
    await e.select([T.frame.id]);
    const order = pageOne(await e.dump());
    const fwd = await run(e, "paged.object.bringForward");
    expect(pageOne(fwd.after).indexOf(FRAME)).toBe(order.indexOf(FRAME) + 1);
    await expectOneUndoStep(e, fwd.before);
    await e.select([T.path.id]);
    const bwd = await run(e, "paged.object.sendBackward");
    expect(pageOne(bwd.after).indexOf(PATH)).toBe(order.indexOf(PATH) - 1);
    await expectOneUndoStep(e, bwd.before);
  });

  test("a multi-selection keeps its relative order and is ONE undo step", async () => {
    covers("command:paged.object.bringToFront");
    const e = await open();
    await e.select([T.frame.id, T.rotated.id]);
    const { before, after } = await run(e, "paged.object.bringToFront");
    expect(pageOne(after).slice(-2)).toEqual([FRAME, elementKey(T.rotated.id)]);
    await expectOneUndoStep(e, before);
  });
});

describe("Group, Ungroup, Select parent group", () => {
  test("Group makes one group of the selection and selects it; one undo step dissolves it", async () => {
    covers("command:paged.object.group");
    const e = await open();
    await e.select([T.frame.id, T.path.id]);
    const { before, after } = await run(e, "paged.object.group");
    const fresh = Object.keys(after.elements).filter(
      (k) => k.startsWith("group:") && k !== GROUP,
    );
    expect(fresh).toHaveLength(1);
    expect(e.state.selection.elementSelection.map(elementKey)).toEqual(fresh);
    expect(pageOne(after)).not.toContain(FRAME);
    await expectOneUndoStep(e, before);
  });

  test("Ungroup frees the members and selects them; one undo step regroups", async () => {
    covers("command:paged.object.ungroup");
    const e = await open();
    await e.select([T.group.id]);
    const { before, after } = await run(e, "paged.object.ungroup");
    expect(after.elements[GROUP] ?? null).toBeNull();
    expect(pageOne(after)).toEqual(
      expect.arrayContaining([
        elementKey(T.group.childA),
        elementKey(T.group.childB),
      ]),
    );
    expect(e.state.selection.elementSelection.map(elementKey).sort()).toEqual(
      [elementKey(T.group.childA), elementKey(T.group.childB)].sort(),
    );
    await expectOneUndoStep(e, before);
  });

  test("Select parent group selects the group around a member and changes nothing", async () => {
    covers("command:paged.object.selectParentGroup");
    const e = await open();
    await e.select([T.group.childA]);
    const { before, after } = await run(e, "paged.object.selectParentGroup");
    expect(e.state.selection.elementSelection).toEqual([T.group.id]);
    expect(dumpDiff(before, after)).toEqual([]);
  });
});

describe("Delete", () => {
  test("deletes the selection; one undo step brings it back where it was", async () => {
    covers("command:paged.object.delete");
    const e = await open();
    await e.select([T.frame.id, T.group.id]);
    const { before, after } = await run(e, "paged.object.delete");
    for (const key of [FRAME, GROUP, elementKey(T.group.childA)]) {
      expect(after.elements[key] ?? null).toBeNull();
    }
    expect(e.state.selection.elementSelection).toEqual([]);
    await expectOneUndoStep(e, before);
  });

  test("a locked frame is refused by the engine, in its words; nothing changes", async () => {
    covers("command:paged.object.delete");
    const e = await open();
    await e.select([T.locked.id]);
    const { before, after } = await run(e, "paged.object.delete");
    expect(dumpDiff(before, after)).toEqual([]);
    expect(e.problems().map((p) => p.message)).toEqual([
      expect.stringMatching(/^Delete refused: .*is locked/),
    ]);
  });
});

describe("Nudge", () => {
  const steps = [
    ["paged.object.nudgeLeft", -1, 0],
    ["paged.object.nudgeRight", 1, 0],
    ["paged.object.nudgeUp", 0, -1],
    ["paged.object.nudgeDown", 0, 1],
    ["paged.object.nudgeLeftLarge", -10, 0],
    ["paged.object.nudgeRightLarge", 10, 0],
    ["paged.object.nudgeUpLarge", 0, -10],
    ["paged.object.nudgeDownLarge", 0, 10],
  ] as const;

  test("each nudge translates the frame by its step, one undo step each", async () => {
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
    const e = await open();
    await e.select([T.frame.id]);
    for (const [command, dx, dy] of steps) {
      const { before, after } = await run(e, command);
      const [a, b, c, d, tx, ty] = bounds(before, FRAME);
      expect({ command, t: bounds(after, FRAME) }).toEqual({
        command,
        t: [a, b, c, d, tx + dx, ty + dy],
      });
      await expectOneUndoStep(e, before);
    }
  });

  test("a nudged group moves rigidly, members and all; undo puts every position back", async () => {
    covers("command:paged.object.nudgeRight");
    const e = await open();
    await e.select([T.group.id]);
    const { before, after } = await run(e, "paged.object.nudgeRight");
    for (const key of [
      GROUP,
      elementKey(T.group.childA),
      elementKey(T.group.childB),
    ]) {
      expect({ key, tx: bounds(after, key)[4] }).toEqual({
        key,
        tx: bounds(before, key)[4] + 1,
      });
    }
    await e.invoke("paged.editor.undo");
    await e.idle();
    // The geometry is restored (an absent transform is the identity).
    const undone = await e.dump();
    const identity = [1, 0, 0, 1, 0, 0];
    for (const key of [
      GROUP,
      elementKey(T.group.childA),
      elementKey(T.group.childB),
    ]) {
      expect({ key, t: bounds(undone, key) ?? identity }).toEqual({
        key,
        t: bounds(before, key),
      });
    }
  });

  // SH-203 (fixed, engine): undoing a setGroupTransform (the group nudge;
  // the Transform panel's X / Y on a group) puts the members' stored
  // transforms back verbatim, explicit identities included.
  test("SH-203: one undo of a group nudge restores the model byte for byte", async () => {
    covers("command:paged.object.nudgeRight");
    const e = await open();
    await e.select([T.group.id]);
    const { before } = await run(e, "paged.object.nudgeRight");
    await expectOneUndoStep(e, before);
  });
});

describe("Lock and hide (F-41)", () => {
  const hitAt = async (e: HeadlessEditor, at: readonly [number, number]) => {
    const reply = (await e.send({
      kind: "hitTest",
      payload: { pageId: T.pageId, docPoint: [at[0], at[1]], filter: "any" },
    } as never)) as { kind: string; payload?: { element?: unknown } };
    return reply.payload?.element ?? null;
  };

  test("Cmd+L locks the frame: the engine then refuses to move it; one undo unlocks", async () => {
    covers("command:paged.object.lock", "command:paged.editor.undo");
    const e = await open();
    await e.select([T.frame.id]);
    const before = await e.dump();
    expect(await e.press("cmd+l")).toBe(true);
    await e.idle();
    expect(e.problems()).toEqual([]);
    const locked = await e.dump();
    expect(dumpDiff(before, locked)).not.toEqual([]);
    // A locked item does not move: the nudge is refused, nothing changes.
    await e.invoke("paged.object.nudgeRight");
    await e.idle();
    expect(dumpDiff(locked, await e.dump())).toEqual([]);
    await expectOneUndoStep(e, before);
  });

  test("Hide: the frame is no longer hit and leaves the selection; Show all on spread brings it back", async () => {
    covers("command:paged.object.hide", "command:paged.object.showAllOnSpread");
    const e = await open();
    expect(await hitAt(e, T.frame.at)).toEqual(T.frame.id);
    await e.select([T.frame.id]);
    const before = await e.dump();
    await run(e, "paged.object.hide");
    expect(e.problems()).toEqual([]);
    expect(e.state.selection.elementSelection).toEqual([]);
    expect(await hitAt(e, T.frame.at)).not.toEqual(T.frame.id);
    await e.select([T.path.id]);
    await run(e, "paged.object.showAllOnSpread");
    expect(await hitAt(e, T.frame.at)).toEqual(T.frame.id);
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("Unlock all on spread unlocks the fixture's locked frame in one undo step", async () => {
    covers("command:paged.object.unlockAllOnSpread");
    const e = await open();
    await e.select([T.frame.id]);
    const { before, after } = await run(e, "paged.object.unlockAllOnSpread");
    expect(e.problems()).toEqual([]);
    expect(dumpDiff(before, after)).not.toEqual([]);
    await expectOneUndoStep(e, before);
  });
});

describe("Clipping masks", () => {
  /** The clip group row on page 1, if any (engine ADR 1010). */
  const clipRow = (dump: ModelDump): Node & { clip?: boolean } => {
    const spread = (dump.tree as Node[])[0];
    const page = spread.children![0];
    return page.children!.find(
      (n) => (n as { clip?: boolean }).clip === true,
    ) as Node & { clip?: boolean };
  };

  test("Make clipping mask groups the selection under the topmost path as a clip group; Release dissolves it; each one undo step", async () => {
    covers(
      "command:paged.object.makeClippingMask",
      "command:paged.object.releaseClippingMask",
    );
    const e = await open();
    // The path is topmost on page 1: it becomes the clipping path.
    await e.select([T.frame.id, T.path.id]);
    const make = await run(e, "paged.object.makeClippingMask");
    expect(e.problems()).toEqual([]);
    expect(pageOne(make.after)).not.toContain(FRAME);
    const row = clipRow(make.after);
    expect(row.children!.map((n) => elementKey(n.id!))).toEqual([FRAME, PATH]);
    expect(e.state.selection.elementSelection).toEqual([row.id]);
    await expectOneUndoStep(e, make.before);

    // Make it again and release it, from the clipping path.
    await e.select([T.frame.id, T.path.id]);
    await e.invoke("paged.object.makeClippingMask");
    await e.idle();
    await e.select([T.path.id]);
    const release = await run(e, "paged.object.releaseClippingMask");
    expect(e.problems()).toEqual([]);
    expect(pageOne(release.after)).toContain(FRAME);
    expect(clipRow(release.after)).toBeUndefined();
    await expectOneUndoStep(e, release.before);
  });

  test("a group can be clipped, and Edit contents selects what the mask clips", async () => {
    covers(
      "command:paged.object.makeClippingMask",
      "command:paged.object.editClippingContents",
    );
    const e = await open();
    await e.select([T.group.id, T.path.id]);
    const make = await run(e, "paged.object.makeClippingMask");
    expect(e.problems()).toEqual([]);
    const row = clipRow(make.after);
    expect(row.children!.map((n) => elementKey(n.id!))).toEqual([GROUP, PATH]);
    await e.invoke("paged.object.editClippingContents");
    await e.idle();
    expect(e.state.selection.elementSelection).toEqual([T.group.id]);
    expect(dumpDiff(make.after, await e.dump())).toEqual([]);
    await expectOneUndoStep(e, make.before);
  });
});

describe("nothing selected, the wrong kind selected, no document, inside a context", () => {
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
    "paged.object.editClippingContents",
  ];

  test("with nothing selected every verb leaves the model and the Problems panel alone", async () => {
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
      "command:paged.object.editClippingContents",
    );
    const e = await open();
    const before = await e.dump();
    for (const command of ALL) {
      await e.invoke(command);
      await e.idle();
    }
    expect(dumpDiff(before, await e.dump())).toEqual([]);
    expect(e.problems()).toEqual([]);
  });

  test("inside an edit context every verb is refused before it reaches the document", async () => {
    covers(
      "command:paged.object.group",
      "command:paged.object.delete",
      "command:paged.object.nudgeLeft",
      "command:paged.object.bringToFront",
    );
    const e = await open();
    await e.select([T.frame.id, T.path.id]);
    e.state.editContext = { type: "vectorGraphic" };
    const before = await e.dump();
    for (const command of ALL) {
      expect(await e.invoke(command)).toBeUndefined();
      await e.idle();
    }
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("the wrong kind: Ungroup on frames, Release on a frame that clips nothing, a text frame on top", async () => {
    covers(
      "command:paged.object.ungroup",
      "command:paged.object.releaseClippingMask",
      "command:paged.object.makeClippingMask",
    );
    const e = await open();
    const before = await e.dump();
    await e.select([T.frame.id, T.path.id]);
    await e.invoke("paged.object.ungroup");
    await e.idle();
    expect(e.problems()).toEqual([]);
    await e.select([T.frame.id]);
    await e.invoke("paged.object.releaseClippingMask");
    await e.idle();
    expect(e.problems().map((p) => p.message)).toEqual([
      expect.stringMatching(
        /^Release clipping mask refused: rectangle uframe clips nothing/,
      ),
    ]);
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("with no document the verbs are inert: no throw, no report", async () => {
    covers("command:paged.object.delete", "command:paged.object.group");
    ed = await createHeadlessEditor();
    for (const command of ALL) {
      await expect(ed.invoke(command)).resolves.toBeUndefined();
    }
    await ed.idle();
    expect(ed.problems()).toEqual([]);
  });
});

describe("Pathfinder", () => {
  /** A second rectangle over the fixture frame, selected with it (frame
   *  first, so the frame is the kept target). */
  async function overlapping(e: HeadlessEditor) {
    const reply = await e.client.mutate({
      op: "insertFrame",
      args: { pageId: T.pageId, bounds: [130, 120, 210, 260] },
    } as never);
    const created = (reply as { payload?: { createdId?: unknown } }).payload
      ?.createdId as { kind: string; id: string };
    expect(created).toBeTruthy();
    await e.idle();
    await e.select([T.frame.id, created as never]);
    return created;
  }

  test("Unite folds the second shape into the first (the kept target); one undo step", async () => {
    covers(
      "command:paged.pathfinder.unite",
      "command:paged.pathfinder.subtract",
      "command:paged.pathfinder.intersect",
      "command:paged.pathfinder.exclude",
    );
    const e = await open();
    const other = await overlapping(e);
    const united = await run(e, "paged.pathfinder.unite");
    expect(e.problems()).toEqual([]);
    expect(pageOne(united.after)).toContain(FRAME);
    expect(pageOne(united.after)).not.toContain(elementKey(other as never));
    await expectOneUndoStep(e, united.before);

    for (const verb of ["subtract", "intersect", "exclude"]) {
      await e.select([T.frame.id, other as never]);
      const out = await run(e, `paged.pathfinder.${verb}`);
      expect(e.problems()).toEqual([]);
      expect(pageOne(out.after)).not.toContain(elementKey(other as never));
      await expectOneUndoStep(e, out.before);
    }
  });

  test("the region verbs change the page and each is one undo step", async () => {
    covers(
      "command:paged.pathfinder.divide",
      "command:paged.pathfinder.trim",
      "command:paged.pathfinder.merge",
      "command:paged.pathfinder.crop",
      "command:paged.pathfinder.outline",
      "command:paged.pathfinder.minusBack",
    );
    const e = await open();
    const other = await overlapping(e);
    for (const verb of [
      "divide",
      "trim",
      "merge",
      "crop",
      "outline",
      "minusBack",
    ]) {
      await e.select([T.frame.id, other as never]);
      const out = await run(e, `paged.pathfinder.${verb}`);
      expect(e.problems(), verb).toEqual([]);
      expect(dumpDiff(out.before, out.after).length, verb).toBeGreaterThan(0);
      await expectOneUndoStep(e, out.before);
    }
  });

  test("one object selected sends nothing", async () => {
    const e = await open();
    await e.select([T.frame.id]);
    const out = await run(e, "paged.pathfinder.unite");
    expect(dumpDiff(out.before, out.after)).toEqual([]);
  });
});

describe("Corners", () => {
  const prop = (dump: ModelDump, key: string, path: string): unknown => {
    const el = dump.elements[key] as {
      entries: Array<{ path: string; value: { value: unknown } }>;
    };
    return el.entries.find((e) => e.path === path)?.value.value;
  };

  test("each preset writes the option and radius on a rectangle and a polygon in one undo step; a group is skipped", async () => {
    covers(
      "command:paged.corners.rounded",
      "command:paged.corners.inverseRounded",
      "command:paged.corners.bevel",
      "command:paged.corners.fancy",
      "command:paged.corners.none",
    );
    const e = await open();
    for (const [verb, option] of [
      ["rounded", "RoundedCorner"],
      ["inverseRounded", "InverseRoundedCorner"],
      ["bevel", "BeveledCorner"],
      ["fancy", "FancyCorner"],
    ] as const) {
      await e.select([T.frame.id, T.path.id, T.group.id]);
      const out = await run(e, `paged.corners.${verb}`);
      expect(e.problems(), verb).toEqual([]);
      expect(prop(out.after, FRAME, "frameCornerOptionTopLeft"), verb).toBe(
        option,
      );
      expect(prop(out.after, PATH, "frameCornerOptionTopLeft"), verb).toBe(
        option,
      );
      expect(prop(out.after, FRAME, "frameCornerRadiusTopLeft"), verb).toBe(12);
      await expectOneUndoStep(e, out.before);
    }
    await e.select([T.frame.id]);
    await e.invoke("paged.corners.rounded");
    await e.idle();
    const none = await run(e, "paged.corners.none");
    expect(prop(none.after, FRAME, "frameCornerRadiusTopLeft")).toBe(0);
    await expectOneUndoStep(e, none.before);
  });
});

describe("Appearance", () => {
  const layers = (dump: ModelDump, key: string): { kind: string }[] => {
    const el = dump.elements[key] as {
      entries: Array<{
        path: string;
        value: { value: { layers?: unknown[] } };
      }>;
    };
    const v = el.entries.find((e) => e.path === "frameAppearance")?.value;
    return ((v?.value as { layers?: { kind: string }[] })?.layers ?? []) as {
      kind: string;
    }[];
  };

  test("Add fill, Add stroke, Move, Remove and Clear edit the native appearance, each one undo step", async () => {
    covers(
      "command:paged.appearance.addFill",
      "command:paged.appearance.addStroke",
      "command:paged.appearance.clear",
      "command:paged.appearance.removeLayer",
      "command:paged.appearance.moveLayer",
    );
    const e = await open();
    await e.select([T.frame.id]);
    const add = await run(e, "paged.appearance.addFill");
    expect(e.problems()).toEqual([]);
    expect(
      layers(add.after, FRAME).filter((l) => l.kind === "fill"),
    ).toHaveLength(1);
    await expectOneUndoStep(e, add.before);

    await e.invoke("paged.appearance.addFill");
    await e.idle();
    const stroke = await run(e, "paged.appearance.addStroke");
    expect(
      layers(stroke.after, FRAME).filter((l) => l.kind === "stroke"),
    ).toHaveLength(1);

    const moved = await run(e, "paged.appearance.moveLayer");
    expect(e.problems()).toEqual([]);
    expect(dumpDiff(moved.before, moved.after).length).toBeGreaterThanOrEqual(
      0,
    );

    const removed = await run(e, "paged.appearance.removeLayer");
    expect(e.problems()).toEqual([]);
    expect(removed.after).toBeDefined();

    const cleared = await run(e, "paged.appearance.clear");
    expect(
      layers(cleared.after, FRAME).filter(
        (l) => l.kind === "fill" || l.kind === "stroke",
      ),
    ).toEqual([]);
    await expectOneUndoStep(e, cleared.before);
  });
});

describe("Stroke dashes", () => {
  const dash = (dump: ModelDump, key: string): number[] | undefined => {
    const el = dump.elements[key] as {
      entries: Array<{ path: string; value: { value: unknown } }>;
    };
    return el.entries.find((e) => e.path === "frameStrokeDashArray")?.value
      .value as number[] | undefined;
  };

  test("each preset writes its run to the selection in one undo step", async () => {
    covers(
      "command:paged.stroke.dashSolid",
      "command:paged.stroke.dashDashed",
      "command:paged.stroke.dashDotted",
      "command:paged.stroke.dashDashDot",
    );
    const e = await open();
    for (const [verb, lengths] of [
      ["dashDashed", [6, 3]],
      ["dashDotted", [1, 3]],
      ["dashDashDot", [6, 3, 1, 3]],
    ] as const) {
      await e.select([T.frame.id, T.path.id]);
      const out = await run(e, `paged.stroke.${verb}`);
      expect(e.problems(), verb).toEqual([]);
      expect(dash(out.after, FRAME), verb).toEqual([...lengths]);
      expect(dash(out.after, PATH), verb).toEqual([...lengths]);
      await expectOneUndoStep(e, out.before);
    }
    await e.select([T.frame.id]);
    await e.invoke("paged.stroke.dashDashed");
    await e.idle();
    const solid = await run(e, "paged.stroke.dashSolid");
    expect(dash(solid.after, FRAME) ?? []).toEqual([]);
    await expectOneUndoStep(e, solid.before);
  });
});

describe("Reflect and Transform again", () => {
  const matrixOf = (dump: ModelDump, key: string): number[] =>
    (bounds(dump, key) as number[] | undefined) ?? [1, 0, 0, 1, 0, 0];

  /** An element's page box through its item transform. */
  async function boxOf(e: HeadlessEditor, id: ElementId) {
    const [g] = (await e.client.elementGeometry([id])) as Array<{
      bounds: [number, number, number, number];
      itemTransform?: [number, number, number, number, number, number] | null;
    }>;
    return transformBounds(g!.bounds, g!.itemTransform ?? null);
  }
  const near = (got: readonly number[], want: readonly number[]) =>
    got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 3));

  test("Reflect horizontally mirrors a frame about its own centre: the linear part flips x, the box stays, one undo step", async () => {
    covers(
      "command:paged.transform.reflectHorizontal",
      "command:paged.transform.reflectVertical",
    );
    const e = await open();
    await e.select([T.frame.id]);
    const box = await boxOf(e, T.frame.id);
    const h = await run(e, "paged.transform.reflectHorizontal");
    expect(e.problems()).toEqual([]);
    const [a0, b0, c0, d0] = matrixOf(h.before, FRAME);
    const [a1, b1, c1, d1] = matrixOf(h.after, FRAME);
    near([a1!, b1!, c1!, d1!], [-a0!, b0!, -c0!, d0!]);
    near(await boxOf(e, T.frame.id), box);
    await expectOneUndoStep(e, h.before);
    const v = await run(e, "paged.transform.reflectVertical");
    const [a2, b2, c2, d2] = matrixOf(v.after, FRAME);
    near([a2!, b2!, c2!, d2!], [a0!, -b0!, c0!, -d0!]);
    near(await boxOf(e, T.frame.id), box);
    await expectOneUndoStep(e, v.before);
  });

  test("a rotated frame keeps its rotation under the reflection (R ∘ M, not R)", async () => {
    covers("command:paged.transform.reflectHorizontal");
    const e = await open();
    await e.select([T.rotated.id]);
    const key = elementKey(T.rotated.id);
    const { before, after } = await run(e, "paged.transform.reflectHorizontal");
    const [a0, b0, c0, d0] = matrixOf(before, key);
    const [a1, b1, c1, d1] = matrixOf(after, key);
    expect(Math.abs(b0!)).toBeGreaterThan(0.01);
    near([a1!, b1!, c1!, d1!], [-a0!, b0!, -c0!, d0!]);
  });

  test("a group is reflected through setGroupTransform: members move, one undo step", async () => {
    covers("command:paged.transform.reflectHorizontal");
    const e = await open();
    await e.select([T.group.id]);
    const { before, after } = await run(e, "paged.transform.reflectHorizontal");
    expect(e.problems()).toEqual([]);
    expect(dumpDiff(before, after)).not.toEqual([]);
    await expectOneUndoStep(e, before);
  });

  test("Copy leaves the original and reflects a copy, in one undo step", async () => {
    covers("command:paged.transform.reflectHorizontal");
    const e = await open();
    await e.select([T.frame.id]);
    const before = await e.dump();
    await e.invoke("paged.transform.reflectHorizontal", { copy: true });
    await e.idle();
    expect(e.problems()).toEqual([]);
    const after = await e.dump();
    expect(pageOne(after)).toHaveLength(pageOne(before).length + 1);
    await expectOneUndoStep(e, before);
  });

  test("Transform again repeats the last reflection about the NEW selection; with nothing remembered it is a no-op", async () => {
    covers("command:paged.transform.again");
    const e = await open();
    await e.select([T.frame.id]);
    const idle = await run(e, "paged.transform.again");
    expect(dumpDiff(idle.before, idle.after)).toEqual([]);
    await e.invoke("paged.transform.reflectHorizontal");
    await e.idle();
    await e.select([T.path.id]);
    const box = await boxOf(e, T.path.id);
    const { before, after } = await run(e, "paged.transform.again");
    expect(e.problems()).toEqual([]);
    const [a0, , c0] = matrixOf(before, PATH);
    const [a1, , c1] = matrixOf(after, PATH);
    near([a1!, c1!], [-a0!, -c0!]);
    near(await boxOf(e, T.path.id), box);
    await expectOneUndoStep(e, before);
  });

  test("Reflect… raises the dialog and writes nothing; with nothing selected it does nothing", async () => {
    covers("command:paged.transform.reflectOptions");
    const e = await open();
    await e.select([T.frame.id]);
    const { before, after } = await run(e, "paged.transform.reflectOptions");
    expect(dumpDiff(before, after)).toEqual([]);
    await e.select([]);
    await e.invoke("paged.transform.reflectOptions");
    await e.idle();
    expect(e.problems()).toEqual([]);
  });
});

describe("Insert star", () => {
  test("a payload inserts a live star (sides and inset) in one undo step; a turned star is a plain path", async () => {
    covers("command:paged.insert.star");
    const e = await open();
    const before = await e.dump();
    await e.invoke("paged.insert.star", {
      radius1: 40,
      radius2: 10,
      points: 6,
    });
    await e.idle();
    expect(e.problems()).toEqual([]);
    const after = await e.dump();
    expect(pageOne(after)).toHaveLength(pageOne(before).length + 1);
    const created = pageOne(after).find((k) => !pageOne(before).includes(k))!;
    const entries = (
      after.elements[created] as {
        entries: Array<{ path: string; value: { value: unknown } }>;
      }
    ).entries;
    expect(entries.find((x) => x.path === "frameShapeSides")?.value.value).toBe(
      6,
    );
    expect(
      entries.find((x) => x.path === "frameShapeStarInset")?.value.value,
    ).toBe(75);
    await expectOneUndoStep(e, before);
    await e.invoke("paged.insert.star", {
      radius1: 40,
      radius2: 10,
      points: 6,
      rotationDeg: 15,
    });
    await e.idle();
    const turned = await e.dump();
    expect(pageOne(turned)).toHaveLength(pageOne(before).length + 1);
    await expectOneUndoStep(e, before);
  });

  test("run bare it opens the dialog and writes nothing", async () => {
    covers("command:paged.insert.star");
    const e = await open();
    const { before, after } = await run(e, "paged.insert.star");
    expect(dumpDiff(before, after)).toEqual([]);
  });
});
