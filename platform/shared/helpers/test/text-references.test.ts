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

import { describe, expect, it } from "bun:test";

import {
  insertReference,
  referenceTypedCommands,
  topicOf,
  type ReferenceDoor,
} from "../src/index.ts";

function door(withCaret = true) {
  const sent: unknown[] = [];
  const d: ReferenceDoor = {
    selection: () => (withCaret ? { storyId: "s1", start: 7, end: 7 } : null),
    characterRange: async () =>
      withCaret ? { storyId: "s1", start: 5, end: 6 } : null,
    mutate: async (m) => {
      sent.push(m);
      return { applied: true };
    },
  };
  return { d, sent };
}

describe("insertReference", () => {
  it("writes each kind as one engine op at the caret", async () => {
    const { d, sent } = door();
    await insertReference(d, { kind: "footnote", text: "n" });
    await insertReference(d, { kind: "endnote" });
    await insertReference(d, { kind: "bookmark", name: " Intro " });
    await insertReference(d, {
      kind: "crossReference",
      target: { bookmark: "Intro" },
      referTo: "pageNumber",
    });
    await insertReference(d, { kind: "indexEntry", topic: ["Main", "Sub"] });
    const at = { storyId: "s1", offset: 0, contentOffset: 7 };
    expect(sent).toEqual([
      {
        op: "insertFootnote",
        args: { storyId: "s1", offset: 6, text: "n" },
      },
      { op: "insertEndnote", args: { storyId: "s1", offset: 6, text: "" } },
      { op: "insertTextAnchor", args: { ...at, name: "Intro" } },
      {
        op: "insertCrossReference",
        args: {
          ...at,
          target: { bookmark: "Intro" },
          referTo: "pageNumber",
          hyperlink: true,
        },
      },
      { op: "insertIndexMarker", args: { ...at, topic: ["Main", "Sub"] } },
    ]);
  });

  it("refuses without a caret, an unnamed bookmark and a topic of no or five levels", async () => {
    expect(await insertReference(door(false).d, { kind: "footnote" })).toEqual({
      applied: false,
      error: "no caret",
    });
    const { d, sent } = door();
    expect(
      (await insertReference(d, { kind: "bookmark", name: " " })).applied,
    ).toBe(false);
    expect(
      (await insertReference(d, { kind: "indexEntry", topic: [] })).applied,
    ).toBe(false);
    expect(
      (
        await insertReference(d, {
          kind: "indexEntry",
          topic: ["a", "b", "c", "d", "e"],
        })
      ).applied,
    ).toBe(false);
    expect(sent).toEqual([]);
    expect(topicOf(" Main : Sub ::Detail")).toEqual(["Main", "Sub", "Detail"]);
  });

  it("the typed commands run it and throw a refusal", async () => {
    const { d, sent } = door();
    const cmds = referenceTypedCommands(d);
    const xref = cmds.find((c) => c.id === "paged.insert.crossReference")!;
    expect(
      await xref.handler(undefined, { storyId: "s2", paragraph: 3 } as never),
    ).toEqual({ applied: true });
    expect((sent[0] as { args: { target: unknown } }).args.target).toEqual({
      storyId: "s2",
      paragraph: 3,
    });
    const bookmark = referenceTypedCommands(door(false).d).find(
      (c) => c.id === "paged.insert.bookmark",
    )!;
    await expect(
      bookmark.handler(undefined, { name: "x" } as never),
    ).rejects.toThrow(/no caret/);
  });
});
