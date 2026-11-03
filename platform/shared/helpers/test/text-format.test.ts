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

import { describe, expect, test } from "bun:test";

import {
  runTextVerb,
  type TextDoor,
  type TextVerbWrite,
} from "../src/text-format.ts";

function door(values: Record<string, unknown>) {
  const writes: TextVerbWrite[][] = [];
  const d: TextDoor = {
    read: async (path) => (values[path] ?? null) as never,
    format: async (w) => {
      writes.push([...w]);
      return { applied: true };
    },
  };
  return { d, writes };
}

describe("runTextVerb", () => {
  test("bold toggles the font style, keeping the slant", async () => {
    const a = door({ characterFontStyle: "Italic" });
    await runTextVerb(a.d, "bold");
    expect(a.writes[0]![0]!.value).toEqual({
      type: "text",
      value: "Bold Italic",
    });
    const b = door({ characterFontStyle: "Bold Italic" });
    await runTextVerb(b.d, "bold");
    expect(b.writes[0]![0]!.value).toEqual({ type: "text", value: "Italic" });
    const c = door({ characterFontStyle: "mixed" });
    await runTextVerb(c.d, "italic");
    expect(c.writes[0]![0]!.value).toEqual({ type: "text", value: "Italic" });
  });

  test("underline and the enum toggles flip what they read", async () => {
    const a = door({ characterUnderline: true, characterPosition: "Normal" });
    await runTextVerb(a.d, "underline");
    await runTextVerb(a.d, "superscript");
    expect(a.writes.map((w) => w[0]!.value)).toEqual([
      { type: "bool", value: false },
      { type: "text", value: "Superscript" },
    ]);
  });

  test("font size steps along the list and needs a readable size", async () => {
    const a = door({ characterFontSize: 11 });
    await runTextVerb(a.d, "growFont");
    await runTextVerb(a.d, "shrinkFont");
    expect(a.writes.map((w) => w[0]!.value)).toEqual([
      { type: "length", value: 12 },
      { type: "length", value: 10.5 },
    ]);
    const none = door({ characterFontSize: "mixed" });
    expect(await runTextVerb(none.d, "growFont")).toEqual({ applied: false });
    expect(none.writes).toEqual([]);
  });

  test("alignment, indent and line spacing write their paths", async () => {
    const a = door({
      paragraphLeftIndent: 0,
      characterFontSize: 10,
    });
    await runTextVerb(a.d, "justify");
    await runTextVerb(a.d, "increaseIndent");
    await runTextVerb(a.d, "lineSpacing15");
    expect(
      a.writes.map((w) => [w[0]!.path, w[0]!.value, w[0]!.extent]),
    ).toEqual([
      [
        "paragraphJustification",
        { type: "text", value: "LeftJustified" },
        undefined,
      ],
      ["paragraphLeftIndent", { type: "length", value: 36 }, undefined],
      ["characterLeading", { type: "length", value: 18 }, "paragraphs"],
    ]);
  });
});
