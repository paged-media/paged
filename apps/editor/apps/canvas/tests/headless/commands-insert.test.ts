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

// `paged.insert.*` against the real engine: each insert lands the element
// it promises on the page in view, selected, painted with the graphic
// default where it is a shape, and one undo step takes it away again.
// Pages: Add page and Delete page change the page list and undo in one
// step; the last page is refused. With no document or inside an edit
// context nothing reaches the engine.

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

const blank = async () =>
  (ed = await createHeadlessEditor({ blank: [612, 792] }));

async function run(e: HeadlessEditor, command: string) {
  const before = await e.dump();
  const outcome = await e.invoke(command);
  await e.idle();
  return { before, after: await e.dump(), outcome };
}

async function expectOneUndoStep(e: HeadlessEditor, before: ModelDump) {
  await e.invoke("paged.editor.undo");
  await e.idle();
  expect(dumpDiff(before, await e.dump())).toEqual([]);
}

const created = (before: ModelDump, after: ModelDump) =>
  Object.keys(after.elements).filter((k) => !(k in before.elements));

type Entry = { path: string; value: { value: unknown } };
const prop = (dump: ModelDump, key: string, path: string) =>
  ((dump.elements[key] as { entries: Entry[] }).entries.find(
    (e) => e.path === path,
  )?.value.value ?? null) as unknown;

describe("the shape inserts", () => {
  const cases = [
    ["paged.insert.textFrame", "textFrame", [336, 186, 456, 426], null],
    [
      "paged.insert.rectangle",
      "rectangle",
      [316, 226, 476, 386],
      "Color/Black",
    ],
    ["paged.insert.ellipse", "oval", [316, 226, 476, 386], "Color/Black"],
  ] as const;

  test("text frame, rectangle, ellipse: one new element centred on the page, selected, one undo step", async () => {
    covers(
      "command:paged.insert.textFrame",
      "command:paged.insert.rectangle",
      "command:paged.insert.ellipse",
    );
    const e = await blank();
    for (const [command, kind, box, stroke] of cases) {
      const { before, after, outcome } = await run(e, command);
      const fresh = created(before, after).filter((k) =>
        k.startsWith(`${kind}:`),
      );
      expect({ command, n: fresh.length }).toEqual({ command, n: 1 });
      const [geometry] = await e.client.elementGeometry([
        e.state.selection.elementSelection[0],
      ]);
      expect({ command, bounds: geometry?.bounds }).toEqual({
        command,
        bounds: [...box],
      });
      if (stroke)
        expect(prop(after, fresh[0], "frameStrokeColor")).toBe(stroke);
      expect((outcome as { applied: boolean }).applied).toBe(true);
      expect(e.state.selection.elementSelection.map(elementKey)).toEqual(fresh);
      expect(e.problems()).toEqual([]);
      await expectOneUndoStep(e, before);
    }
  });

  test("line: a horizontal graphic line through the page centre, one undo step", async () => {
    covers("command:paged.insert.line");
    const e = await blank();
    const { before, after } = await run(e, "paged.insert.line");
    const fresh = created(before, after);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatch(/^graphicLine:/);
    expect(prop(after, fresh[0], "frameStrokeColor")).toBe("Color/Black");
    await expectOneUndoStep(e, before);
  });

  test("table without a caret: a text frame holding a 4 × 3 table, one undo step (SH-202)", async () => {
    covers("command:paged.insert.table");
    const e = await blank();
    const { before, after, outcome } = await run(e, "paged.insert.table");
    expect((outcome as { applied: boolean }).applied).toBe(true);
    expect(created(before, after).some((k) => k.startsWith("textFrame:"))).toBe(
      true,
    );
    const table = (
      outcome as { createdId: { kind: string; id: { table_id: string } } }
    ).createdId;
    expect(table.kind).toBe("table");
    // The caret is in A1 of the new table, ready to type.
    expect(e.state.contentSelection.contentSelection).toMatchObject({
      start: 0,
      end: 0,
      cell: { tableId: table.id.table_id, row: 0, col: 0 },
    });
    await expectOneUndoStep(e, before);
  });
});

describe("pages", () => {
  test("Add page adds one page after the page in view; one undo step removes it", async () => {
    covers("command:paged.insert.newPage");
    const e = await blank();
    const { before, after } = await run(e, "paged.insert.newPage");
    expect((after.collections.pages as unknown[]).length).toBe(2);
    await expectOneUndoStep(e, before);
  });

  test("Delete page removes the page in view; one undo step restores it with its items", async () => {
    covers("command:paged.insert.deletePage");
    ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
    // The view on page 2 (pages stack with a 24 pt gap).
    ed.state.camera.setCamera({ scale: 1, tx: 0, ty: -(792 + 24) });
    const { before, after } = await run(ed, "paged.insert.deletePage");
    expect(
      (after.collections.pages as Array<{ selfId: string }>).map(
        (p) => p.selfId,
      ),
    ).toEqual([T.pageId]);
    expect(after.elements[elementKey(T.secondFrame.id)] ?? null).toBeNull();
    await expectOneUndoStep(ed, before);
  });

  test("the only page is refused, in words", async () => {
    covers("command:paged.insert.deletePage");
    const e = await blank();
    const { before, after } = await run(e, "paged.insert.deletePage");
    expect(dumpDiff(before, after)).toEqual([]);
    expect(e.problems().map((p) => p.message)).toEqual([
      expect.stringMatching(
        /^Delete page refused: this is the document's only page/,
      ),
    ]);
  });
});

describe("no document, inside an edit context", () => {
  const ALL = [
    "paged.insert.textFrame",
    "paged.insert.rectangle",
    "paged.insert.ellipse",
    "paged.insert.line",
    "paged.insert.table",
    "paged.insert.deletePage",
    "paged.insert.placeImage",
    "paged.insert.newPage",
  ];

  test("with no document every insert is inert", async () => {
    covers(
      "command:paged.insert.textFrame",
      "command:paged.insert.rectangle",
      "command:paged.insert.ellipse",
      "command:paged.insert.line",
      "command:paged.insert.table",
      "command:paged.insert.deletePage",
      "command:paged.insert.placeImage",
      "command:paged.insert.newPage",
    );
    ed = await createHeadlessEditor();
    const reported = ed.problems().length;
    for (const command of ALL) {
      await expect(ed.invoke(command)).resolves.toBeUndefined();
    }
    expect(ed.problems()).toHaveLength(reported);
  });

  test("inside an edit context no insert reaches the document", async () => {
    covers(
      "command:paged.insert.textFrame",
      "command:paged.insert.rectangle",
      "command:paged.insert.newPage",
      "command:paged.insert.placeImage",
    );
    const e = await blank();
    e.state.editContext = { type: "sheet" };
    const before = await e.dump();
    for (const command of ALL) {
      expect(await e.invoke(command)).toBeUndefined();
    }
    await e.idle();
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });
});
