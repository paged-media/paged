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

// `paged.core.*` — the typed core commands' menu and palette doors, end to
// end over the real engine. A door opens the typed-command form on its op
// with its prefill; the form adds what the selection or the caret names
// (`contextPrefill`) and runs the command (`invokeCoreCommand`). Here the
// form's open is observed, its submit is played with exactly those
// arguments, and the result is asserted on the document: the command
// applies as ONE undo step and one undo takes it back.
//
// The dialog's React form is not rendered (no DOM); everything around it
// is the app's own code.

import { afterEach, describe, expect, mock, test } from "bun:test";

import { CORE_WIRE_OPS } from "@paged-media/plugin-sdk";
import {
  covers,
  gestureFixture,
  GESTURE_TARGETS as T,
} from "@paged-media/test-kit";
import { dumpDiff } from "@paged-media/test-kit/headless";

const asked: Array<{ op: string | null; prefill: Record<string, unknown> }> =
  [];
const dialog = await import("../../src/core-command-dialog");
mock.module("../../src/core-command-dialog", () => ({
  ...dialog,
  openCoreCommand: (op: string | null, prefill: Record<string, unknown> = {}) =>
    void asked.push({ op, prefill }),
}));
const { contextPrefill, newMasterPrefill } = dialog;
const { createHeadlessEditor } = await import("./harness");
const { CORE_COMMAND_ENTRIES } = await import("../../src/core-command-entries");
const { addressOfElement } = await import("../../src/object-model");
const { STRUCTURE, structureIdml } =
  await import("../../test/panels/support/structure");

type Editor = Awaited<ReturnType<typeof createHeadlessEditor>>;

let ed: Editor | null = null;
afterEach(async () => {
  await ed?.dispose();
  ed = null;
});

/** What the model shows of an edit: the canonical dump, plus what it does
 *  not carry (path anchors, and whether created addresses exist). */
async function snapshot(e: Editor, created: readonly string[] = []) {
  const anchors = await Promise.all(
    ["upath"].map((id) =>
      e.client.pathAnchors({ kind: "polygon", id } as never).catch(() => null),
    ),
  );
  (e.objects as { core?: { invalidate(): void } | null }).core?.invalidate();
  const exists = await Promise.all(
    created.map(async (a) => {
      // A page item exists when the engine has geometry for it, or (an
      // anchored frame, which has none) when its address still resolves;
      // anything else (a master, a text variable) when its address does.
      const item =
        /^(rectangle|oval|polygon|graphicLine|textFrame|group):(.+)$/.exec(a);
      if (item) {
        const found = await e.client.elementGeometry([
          { kind: item[1], id: item[2] } as never,
        ]);
        if (found.length > 0) return true;
        const read = (await e.objects.get(
          a as never,
          "frameBounds" as never,
        )) as {
          code?: string;
        };
        return read.code !== "unknownAddress";
      }
      const v = (await e.objects.get(a as never, "name" as never)) as {
        code?: string;
      };
      return v.code !== "unknownAddress";
    }),
  );
  return { dump: await e.dump(), anchors: JSON.stringify(anchors), exists };
}

/** Invoke the DOOR, then submit the form as the dialog would. */
async function throughDoor(
  e: Editor,
  op: string,
  extra: Record<string, unknown> = {},
): Promise<{ created: string[]; undoSteps: number }> {
  asked.length = 0;
  await e.invoke(`paged.core.${op}`);
  expect(asked).toHaveLength(1);
  expect(asked[0].op).toBe(op);
  const fields = (CORE_WIRE_OPS[op]?.args.fields ?? {}) as never;
  const caret = e.state.contentSelection.contentSelection;
  const ctx = {
    items: e.state.selection.elementSelection.map((id) => addressOfElement(id)),
    caret: caret
      ? { storyId: caret.storyId, start: caret.start, end: caret.end }
      : null,
  };
  const args = {
    ...asked[0].prefill,
    ...contextPrefill(fields, ctx),
    ...extra,
  };
  // The app's object registry is one per page life and indexes the items of
  // the FIRST client it saw; each headless editor has its own client, so the
  // index is dropped here, as a document change drops it in the app.
  (e.objects as { core?: { invalidate(): void } | null }).core?.invalidate();
  const result = (await e.invokeCore(op, args)) as {
    created: string[];
    undoSteps: number;
  };
  await e.idle();
  return result;
}

/** The door's command applied (the model moved) in ONE undo step. */
async function expectAppliedOnce(
  e: Editor,
  op: string,
  extra: Record<string, unknown> = {},
  /** Addresses the command deletes (their existence is the change). */
  watch: readonly string[] = [],
) {
  const before = await snapshot(e, watch);
  const result = await throughDoor(e, op, extra);
  expect({ op, undoSteps: result.undoSteps }).toEqual({ op, undoSteps: 1 });
  const seen = [...watch, ...result.created];
  const after = await snapshot(e, seen);
  const existed = [...before.exists, ...result.created.map(() => false)];
  const moved =
    dumpDiff(before.dump, after.dump).length > 0 ||
    before.anchors !== after.anchors ||
    after.exists.some((x, i) => x !== existed[i]);
  expect({ op, moved }).toEqual({ op, moved: true });
  await e.invoke("paged.editor.undo");
  await e.idle();
  const undone = await snapshot(e, seen);
  expect({ op, diff: dumpDiff(before.dump, undone.dump) }).toEqual({
    op,
    diff: [],
  });
  expect(undone.anchors).toBe(before.anchors);
  expect(undone.exists).toEqual(existed);
}

const targets = async () =>
  (ed = await createHeadlessEditor({ idml: gestureFixture("targets") }));

/** A blank page with a text frame whose story holds "Hello world", the
 *  caret at `start`..`end`. */
async function withStory(start = 0, end = start) {
  const e = (ed = await createHeadlessEditor({ blank: [612, 792] }));
  await e.invoke("paged.insert.textFrame");
  await e.idle();
  const storyId = (
    (await e.dump()).collections.stories as Array<{ selfId: string }>
  )[0].selfId;
  await e.client.mutate({
    op: "insertText",
    args: { storyId, offset: 0, text: "Hello world" },
  } as never);
  await e.idle();
  e.state.contentSelection.setContentSelection({ storyId, start, end });
  return { e, storyId };
}

describe("the doors open the form on their op with their prefill", () => {
  test("every door, invoked through the registry, asks for its own op", async () => {
    covers("command:paged.core.runCommand");
    const e = await targets();
    asked.length = 0;
    await e.invoke("paged.core.runCommand");
    expect(asked).toEqual([{ op: null, prefill: {} }]);
    for (const entry of CORE_COMMAND_ENTRIES) {
      asked.length = 0;
      await e.invoke(`paged.core.${entry.op}`);
      expect(asked).toEqual([{ op: entry.op, prefill: entry.prefill ?? {} }]);
    }
  });
});

describe("path doors (the selected path)", () => {
  test("insert, remove and move a point; close, outline, offset", async () => {
    covers(
      "command:paged.core.pathPointInsert",
      "command:paged.core.pathPointRemove",
      "command:paged.core.pathPointSet",
      "command:paged.core.closePath",
      "command:paged.core.outlineStroke",
      "command:paged.core.offsetPath",
    );
    const e = await targets();
    await e.select([T.path.id]);
    await expectAppliedOnce(e, "pathPointInsert");
    await expectAppliedOnce(e, "pathPointRemove");
    // The form asks for the new position; the door prefills index + role.
    await expectAppliedOnce(e, "pathPointSet", { position: [80, 600] });
    await expectAppliedOnce(e, "closePath");
    await expectAppliedOnce(e, "outlineStroke");
    await expectAppliedOnce(e, "offsetPath");
  });

  test("join two open paths (the paths fixture)", async () => {
    covers("command:paged.core.joinPaths");
    ed = await createHeadlessEditor({ idml: gestureFixture("paths") });
    await ed.select([
      { kind: "polygon", id: "uopen" },
      { kind: "graphicLine", id: "uline" },
    ] as never);
    await expectAppliedOnce(ed, "joinPaths");
  });

  test("an opacity mask: make (path masked by the frame), then release", async () => {
    covers(
      "command:paged.core.applyOpacityMask",
      "command:paged.core.releaseOpacityMask",
    );
    const e = await targets();
    await e.select([T.path.id, T.frame.id]);
    await expectAppliedOnce(e, "applyOpacityMask");
    await throughDoor(e, "applyOpacityMask");
    await e.select([T.path.id]);
    await expectAppliedOnce(e, "releaseOpacityMask");
  });

  test("step and repeat duplicates the selection by the prefilled offset", async () => {
    covers("command:paged.core.duplicateElements");
    const e = await targets();
    await e.select([T.frame.id, T.path.id]);
    await expectAppliedOnce(e, "duplicateElements");
  });

  test("pathfinder keeps the chosen faces of two overlapping shapes", async () => {
    covers("command:paged.core.pathfinderFaces");
    const e = (ed = await createHeadlessEditor({ blank: [612, 792] }));
    await e.invoke("paged.insert.rectangle");
    await e.idle();
    const rect = e.state.selection.elementSelection[0];
    await e.invoke("paged.insert.ellipse");
    await e.idle();
    const oval = e.state.selection.elementSelection[0];
    await e.select([rect, oval]);
    // The faces the arrangement has, as the Pathfinder panel reads them.
    const reply = (await e.send({
      kind: "requestPlanarRegions",
      payload: { elementIds: [rect, oval], point: null },
    } as never)) as unknown as {
      payload: {
        result: {
          found: boolean;
          faces: Array<{ id: string; signature: number[] }>;
        };
      };
    };
    expect(reply.payload.result.found).toBe(true);
    // The face both shapes cover (their intersection).
    const both = reply.payload.result.faces.filter(
      (f) => f.signature.length === 2,
    );
    expect(both.length).toBeGreaterThan(0);
    await expectAppliedOnce(e, "pathfinderFaces", {
      faces: both.map((f) => f.id),
    });
  });

  test("a path door on something that is no editable path is refused, nothing changes", async () => {
    covers(
      "command:paged.core.closePath",
      "command:paged.core.detachTextFromPath",
    );
    const e = await targets();
    const before = await e.dump();
    await e.select([T.path.id, T.frame.id]);
    await expect(throughDoor(e, "joinPaths")).rejects.toThrow(
      /uframe\\?"\) has no editable open path/,
    );
    await e.select([T.path.id]);
    await expect(throughDoor(e, "detachTextFromPath")).rejects.toThrow(
      /hosts no text-on-a-path/,
    );
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });
});

describe("text doors (the caret)", () => {
  test("insert a field and an anchored frame at the caret", async () => {
    covers(
      "command:paged.core.insertField",
      "command:paged.core.insertAnchoredFrame",
    );
    const { e } = await withStory(0, 5);
    await expectAppliedOnce(e, "insertField");
    await expectAppliedOnce(e, "insertAnchoredFrame");
  });

  test("insert a hyperlink over the selected text; undo removes it and keeps the text", async () => {
    covers("command:paged.core.insertHyperlink");
    const { e, storyId } = await withStory(0, 5);
    const before = await e.dump();
    const result = await throughDoor(e, "insertHyperlink", {
      url: "https://paged.media/",
    });
    expect(result.undoSteps).toBe(1);
    const after = await e.dump();
    const links = (d: typeof before) =>
      (d.collections.hyperlinks as unknown[]).length;
    expect(links(after)).toBe(links(before) + 1);
    await e.invoke("paged.editor.undo");
    await e.idle();
    const undone = await e.dump();
    expect(links(undone)).toBe(links(before));
    const text = (d: typeof before) =>
      (
        d.stories[storyId] as {
          paragraphs: Array<{ runs: Array<{ text: string }> }>;
        }
      ).paragraphs.map((p) => p.runs.map((r) => r.text).join(""));
    expect(text(undone)).toEqual(text(before));
  });

  // Finding SH-204 (engine): undoing insertHyperlink leaves the story's run
  // split at the link's boundary ("Hello world" comes back as "Hello" +
  // " world"): same text, a different model — an IDML saved after the
  // undo has two character ranges where the original had one.
  test.failing(
    "SH-204: one undo of Insert hyperlink restores the story byte for byte",
    async () => {
      covers("command:paged.core.insertHyperlink");
      const { e } = await withStory(0, 5);
      await expectAppliedOnce(e, "insertHyperlink", {
        url: "https://paged.media/",
      });
    },
  );

  test("set field value with no placeholder at the caret is refused in the engine's words", async () => {
    covers("command:paged.core.setFieldValue");
    const { e } = await withStory(0);
    await expect(
      throughDoor(e, "setFieldValue", { value: "7" }),
    ).rejects.toThrow(/no placeholder field at offset/);
  });

  test("type on a path: attach the story to the path, then detach", async () => {
    covers(
      "command:paged.core.attachTextToPath",
      "command:paged.core.detachTextFromPath",
    );
    const e = (ed = await createHeadlessEditor({
      idml: gestureFixture("targets"),
    }));
    // A story flows in exactly one place: free one from its frame first
    // (deleting a text frame keeps its story).
    await e.invoke("paged.insert.textFrame");
    await e.idle();
    await e.invoke("paged.object.delete");
    await e.idle();
    const story = (
      (await e.dump()).collections.stories as Array<{ selfId: string }>
    ).at(-1)!.selfId;
    await e.select([T.path.id]);
    e.state.contentSelection.setContentSelection(null);
    const before = await e.dump();
    const attach = await throughDoor(e, "attachTextToPath", {
      storyId: `story:${story}`,
    });
    expect(attach.undoSteps).toBe(1);
    // Attached: the path now hosts text, so detach applies (one step).
    const detach = await throughDoor(e, "detachTextFromPath");
    expect(detach.undoSteps).toBe(1);
    // Undo the detach, then the attach: the path hosts no text again.
    await e.invoke("paged.editor.undo");
    await e.invoke("paged.editor.undo");
    await e.idle();
    expect(dumpDiff(before, await e.dump())).toEqual([]);
    await expect(throughDoor(e, "detachTextFromPath")).rejects.toThrow(
      /hosts no text-on-a-path/,
    );
  });

  test("delete table: the table the caret is in", async () => {
    covers("command:paged.core.deleteTable");
    const e = (ed = await createHeadlessEditor({ blank: [612, 792] }));
    await e.invoke("paged.insert.table");
    await e.idle();
    const caret = e.state.contentSelection.contentSelection as unknown as {
      storyId: string;
      cell: { tableId: string };
    };
    await expectAppliedOnce(e, "deleteTable", {
      tableId: `table:${caret.cell.tableId}`,
    });
  });
});

describe("document doors", () => {
  test("move page: page 2 to the front", async () => {
    covers("command:paged.core.movePage");
    const e = await targets();
    await expectAppliedOnce(e, "movePage", {
      page: `page:${T.secondPageId}`,
      after: null,
    });
  });

  test("masters: new (the dialog's own prefill), rename; delete refuses a master in use", async () => {
    covers(
      "command:paged.core.createMaster",
      "command:paged.core.renameMaster",
      "command:paged.core.deleteMaster",
    );
    const e = await targets();
    await expectAppliedOnce(e, "createMaster", newMasterPrefill([612, 792]));
    await expectAppliedOnce(e, "renameMaster", {
      master: "master:um",
      name: "Z",
    });
    await expect(
      throughDoor(e, "deleteMaster", { master: "um" }),
    ).rejects.toThrow(/the master is applied to a page/);
    const made = await throughDoor(
      e,
      "createMaster",
      newMasterPrefill([612, 792]),
    );
    await expectAppliedOnce(
      e,
      "deleteMaster",
      { master: made.created[0] },
      made.created,
    );
  });

  test("sections: delete the section a page starts", async () => {
    covers("command:paged.core.deleteSection");
    const e = await targets();
    await e.invokeCore("insertSection", {
      atPage: `page:${T.secondPageId}`,
      prefix: "B",
    });
    await e.idle();
    const section = (
      (await e.dump()).collections.sections as Array<{ selfId: string }>
    ).at(-1)!.selfId;
    await expectAppliedOnce(e, "deleteSection", { sectionId: section });
  });

  test("conditions: hide a visible condition, show a hidden one, each one undo step", async () => {
    covers("command:paged.core.setConditionVisible");
    // No mutation creates a condition, so the document is the structure
    // fixture (built in code: Draft visible, Final hidden).
    const e = (ed = await createHeadlessEditor({ idml: structureIdml() }));
    const visible = async () =>
      Object.fromEntries(
        (
          (await e.dump()).collections.conditions as Array<{
            selfId: string;
            visible: boolean;
          }>
        ).map((c) => [c.selfId, c.visible]),
      );
    expect(await visible()).toEqual({
      [STRUCTURE.conditions.draft]: true,
      [STRUCTURE.conditions.final]: false,
    });
    await expectAppliedOnce(e, "setConditionVisible", {
      condition: STRUCTURE.conditions.draft,
      visible: false,
    });
    const hidden = await throughDoor(e, "setConditionVisible", {
      condition: STRUCTURE.conditions.draft,
      visible: false,
    });
    expect(hidden.undoSteps).toBe(1);
    expect(await visible()).toEqual({
      [STRUCTURE.conditions.draft]: false,
      [STRUCTURE.conditions.final]: false,
    });
    await e.invoke("paged.editor.undo");
    await e.idle();
    await expectAppliedOnce(e, "setConditionVisible", {
      condition: STRUCTURE.conditions.final,
      visible: true,
    });
  });

  test("text variables, gradients, cell and table styles: create, then delete", async () => {
    covers(
      "command:paged.core.createTextVariable",
      "command:paged.core.deleteTextVariable",
      "command:paged.core.createGradient",
      "command:paged.core.deleteGradient",
      "command:paged.core.createCellStyle",
      "command:paged.core.deleteCellStyle",
      "command:paged.core.createTableStyle",
      "command:paged.core.deleteTableStyle",
    );
    const e = await targets();
    await expectAppliedOnce(e, "createTextVariable", { name: "Client" });
    const variable = await throughDoor(e, "createTextVariable", {
      name: "Client",
    });
    await expectAppliedOnce(
      e,
      "deleteTextVariable",
      { variableId: variable.created[0] },
      variable.created,
    );

    await expectAppliedOnce(e, "createGradient");
    await throughDoor(e, "createGradient");
    const gradient = (
      (await e.dump()).collections.gradients as Array<{ selfId: string }>
    ).at(-1)!;
    await expectAppliedOnce(e, "deleteGradient", {
      gradientId: gradient.selfId,
    });

    for (const [create, remove, collection] of [
      ["createCellStyle", "deleteCellStyle", "cellStyles"],
      ["createTableStyle", "deleteTableStyle", "tableStyles"],
    ] as const) {
      await expectAppliedOnce(e, create, { name: "Head" });
      await throughDoor(e, create, { name: "Head" });
      const style = (
        (await e.dump()).collections[collection] as Array<{ selfId: string }>
      ).at(-1)!;
      await expectAppliedOnce(e, remove, { styleId: style.selfId });
    }
  });
});
