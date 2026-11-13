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
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// `paged.text.*` — the text-format verbs (Type ▸ Format, the Word chords)
// against the REAL engine (the headless editor): each verb through the
// registry on a selected word of a story, its effect read back from the
// engine through the same property reads the verbs use, and one undo puts
// the value and the model back. Then the cases a user meets by accident:
// no text selection writes nothing and says why.

import { afterEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";
import { dumpDiff } from "@paged-media/test-kit/headless";

import { textDoorOf } from "../../src/text-format-commands";
import { createHeadlessEditor, type HeadlessEditor } from "./harness";

let ed: HeadlessEditor | null = null;
afterEach(async () => {
  await ed?.dispose();
  ed = null;
});

/** A blank page with a text frame whose story holds "Hello world", "Hello"
 *  selected. */
async function withWord() {
  const e = (ed = await createHeadlessEditor({ blank: [612, 792] }));
  await e.invoke("paged.insert.textFrame");
  await e.idle();
  const storyId = (
    (await e.dump()).collections.stories as Array<{ selfId: string }>
  )[0]!.selfId;
  await e.client.mutate({
    op: "insertText",
    args: { storyId, offset: 0, text: "Hello world" },
  } as never);
  await e.idle();
  e.state.contentSelection.setContentSelection({ storyId, start: 0, end: 5 });
  const door = textDoorOf({
    client: e.client as never,
    getSelection: () => e.state.contentSelection.contentSelection,
  });
  return { e, read: (path: string) => door.read(path) };
}

/** Run one verb: the value reads back changed, one undo puts the value and
 *  the model back. (The canonical dump carries character runs but not
 *  paragraph attributes, so the engine's read is the measure.) */
async function expectVerb(
  e: HeadlessEditor,
  read: (path: string) => Promise<unknown>,
  verb: string,
  path: string,
  check: (value: unknown) => boolean,
) {
  const before = await e.dump();
  const was = await read(path);
  expect({ verb, was, ok: check(was) }).toEqual({ verb, was, ok: false });
  await e.invoke(`paged.text.${verb}`);
  await e.idle();
  expect({ verb, problems: e.problems() }).toEqual({ verb, problems: [] });
  const value = await read(path);
  expect({ verb, value, ok: check(value) }).toEqual({ verb, value, ok: true });
  await e.invoke("paged.editor.undo");
  await e.idle();
  expect({ verb, undone: await read(path) }).toEqual({ verb, undone: was });
  expect({ verb, undone: dumpDiff(before, await e.dump()) }).toEqual({
    verb,
    undone: [],
  });
  // Leave it applied: the next verb starts from here.
  await e.invoke("paged.editor.redo");
  await e.idle();
  expect({ verb, redone: await read(path) }).toEqual({ verb, redone: value });
}

const hasWord = (v: unknown, w: string) =>
  typeof v === "string" && v.split(/\s+/).includes(w);

describe("paged.text.* on a selected word", () => {
  test("the character verbs: bold, italic, underline, strikethrough, position, case", async () => {
    covers(
      "command:paged.text.bold",
      "command:paged.text.italic",
      "command:paged.text.underline",
      "command:paged.text.strikethrough",
      "command:paged.text.subscript",
      "command:paged.text.superscript",
      "command:paged.text.allCaps",
      "command:paged.text.smallCaps",
    );
    const { e, read } = await withWord();
    await expectVerb(e, read, "bold", "characterFontStyle", (v) =>
      hasWord(v, "Bold"),
    );
    await expectVerb(
      e,
      read,
      "italic",
      "characterFontStyle",
      (v) => hasWord(v, "Bold") && hasWord(v, "Italic"),
    );
    await expectVerb(
      e,
      read,
      "underline",
      "characterUnderline",
      (v) => v === true,
    );
    await expectVerb(
      e,
      read,
      "strikethrough",
      "characterStrikethru",
      (v) => v === true,
    );
    await expectVerb(
      e,
      read,
      "subscript",
      "characterPosition",
      (v) => v === "Subscript",
    );
    await expectVerb(
      e,
      read,
      "superscript",
      "characterPosition",
      (v) => v === "Superscript",
    );
    await expectVerb(
      e,
      read,
      "allCaps",
      "characterCase",
      (v) => v === "AllCaps",
    );
    await expectVerb(
      e,
      read,
      "smallCaps",
      "characterCase",
      (v) => v === "SmallCaps",
    );
  });

  test("the size steps, the alignments, the indent steps and line spacing", async () => {
    covers(
      "command:paged.text.growFont",
      "command:paged.text.shrinkFont",
      "command:paged.text.alignLeft",
      "command:paged.text.alignCenter",
      "command:paged.text.alignRight",
      "command:paged.text.justify",
      "command:paged.text.increaseIndent",
      "command:paged.text.decreaseIndent",
      "command:paged.text.lineSpacing1",
      "command:paged.text.lineSpacing15",
      "command:paged.text.lineSpacing2",
    );
    const { e, read } = await withWord();
    const size = (await read("characterFontSize")) as number;
    expect(typeof size).toBe("number");
    await expectVerb(
      e,
      read,
      "growFont",
      "characterFontSize",
      (v) => typeof v === "number" && v > size,
    );
    await expectVerb(
      e,
      read,
      "shrinkFont",
      "characterFontSize",
      (v) => v === size,
    );
    await expectVerb(
      e,
      read,
      "alignCenter",
      "paragraphJustification",
      (v) => v === "CenterAlign",
    );
    await expectVerb(
      e,
      read,
      "alignRight",
      "paragraphJustification",
      (v) => v === "RightAlign",
    );
    await expectVerb(
      e,
      read,
      "justify",
      "paragraphJustification",
      (v) => v === "LeftJustified",
    );
    await expectVerb(
      e,
      read,
      "alignLeft",
      "paragraphJustification",
      (v) => v === "LeftAlign",
    );
    await expectVerb(
      e,
      read,
      "increaseIndent",
      "paragraphLeftIndent",
      (v) => v === 36,
    );
    await expectVerb(
      e,
      read,
      "decreaseIndent",
      "paragraphLeftIndent",
      (v) => v === 0,
    );
    const leading = (m: number) => Math.round(size * 1.2 * m * 100) / 100;
    await expectVerb(
      e,
      read,
      "lineSpacing2",
      "characterLeading",
      (v) => v === leading(2),
    );
    await expectVerb(
      e,
      read,
      "lineSpacing15",
      "characterLeading",
      (v) => v === leading(1.5),
    );
    await expectVerb(
      e,
      read,
      "lineSpacing1",
      "characterLeading",
      (v) => v === leading(1),
    );
  });

  test("UX audit F-34: the leading and tracking steps (Alt+arrows) write the story's leading and tracking", async () => {
    covers(
      "command:paged.text.increaseLeading",
      "command:paged.text.decreaseLeading",
      "command:paged.text.increaseTracking",
      "command:paged.text.decreaseTracking",
    );
    const { e, read } = await withWord();
    const size = (await read("characterFontSize")) as number;
    const set = await read("characterLeading");
    const leading = typeof set === "number" ? set : size * 1.2;
    await expectVerb(
      e,
      read,
      "increaseLeading",
      "characterLeading",
      (v) => typeof v === "number" && Math.abs(v - (leading + 2)) < 0.011,
    );
    await expectVerb(
      e,
      read,
      "decreaseLeading",
      "characterLeading",
      // Each verb is left applied: the step back lands where it began.
      (v) => typeof v === "number" && Math.abs(v - leading) < 0.011,
    );
    const tracking = await read("characterTracking");
    const base = typeof tracking === "number" ? tracking : 0;
    await expectVerb(
      e,
      read,
      "increaseTracking",
      "characterTracking",
      (v) => v === base + 20,
    );
    await expectVerb(
      e,
      read,
      "decreaseTracking",
      "characterTracking",
      (v) => v === base,
    );
  });

  test("without a text selection a verb writes nothing and says why", async () => {
    covers("command:paged.text.bold", "command:paged.text.alignCenter");
    const { e } = await withWord();
    e.state.contentSelection.setContentSelection(null);
    for (const verb of ["bold", "alignCenter"]) {
      const before = await e.dump();
      await e.invoke(`paged.text.${verb}`);
      await e.idle();
      expect(dumpDiff(before, await e.dump())).toEqual([]);
      expect(e.problems().map((p) => p.message)).toEqual(["no text selection"]);
    }
  });
});
