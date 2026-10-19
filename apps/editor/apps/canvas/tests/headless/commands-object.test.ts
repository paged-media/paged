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
    covers(
      "command:paged.object.hide",
      "command:paged.object.showAllOnSpread",
    );
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
  test("Make clipping mask nests the content in the topmost path; Release pops it out; each one undo step", async () => {
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
    expect(e.state.selection.elementSelection).toEqual([T.path.id]);
    await expectOneUndoStep(e, make.before);

    // Make it again and release it.
    await e.select([T.frame.id, T.path.id]);
    await e.invoke("paged.object.makeClippingMask");
    await e.idle();
    await e.select([T.path.id]);
    const release = await run(e, "paged.object.releaseClippingMask");
    expect(e.problems()).toEqual([]);
    expect(pageOne(release.after)).toContain(FRAME);
    await expectOneUndoStep(e, release.before);
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

  test("the wrong kind: Ungroup on frames, Release on a frame that clips nothing, a clip with a group as content", async () => {
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
        /^Release clipping mask refused: rectangle uframe holds no content/,
      ),
    ]);
    await e.select([T.group.id, T.path.id]);
    await e.invoke("paged.object.makeClippingMask");
    await e.idle();
    expect(e.problems().map((p) => p.message)).toEqual([
      expect.stringMatching(
        /^Make clipping mask refused: group ugroup cannot be clipped/,
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
