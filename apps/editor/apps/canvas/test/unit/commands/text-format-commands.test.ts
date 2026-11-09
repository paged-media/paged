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

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  TEXT_FORMAT_MENU_ITEMS,
  TEXT_FORMAT_VERBS,
  applyTextVerb,
  buildTextFormatCommands,
} from "../../../src/text-format-commands";

/** A fake client over one story, "Hello world" and "Second line". */
function fake(
  sel: { storyId: string; start: number; end?: number; cell?: unknown } | null,
  values: Record<string, unknown> = {},
  mutateReply: unknown = { kind: "mutationApplied", payload: {} },
  paragraphs: string[][] = [["Hello ", "world"], ["Second line"]],
) {
  const sent: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const mutations: Array<{ op: string; args: Record<string, unknown> }> = [];
  const deps = {
    getSelection: () => sel,
    client: {
      send: async (m: { kind: string; payload: Record<string, unknown> }) => {
        sent.push(m);
        if (m.kind === "requestStoryContent")
          return {
            kind: "storyContentResult",
            payload: {
              content: {
                paragraphs: paragraphs.map((runs) => ({
                  runs: runs.map((text) => ({ text })),
                })),
              },
            },
          };
        return {
          kind: "propertyValue",
          payload: {
            value: { value: values[String(m.payload.path)] ?? null },
            error: null,
          },
        };
      },
      mutate: async (m: { op: string; args: Record<string, unknown> }) => {
        mutations.push(m);
        return mutateReply;
      },
    },
  } as never;
  return { deps, sent, mutations };
}

const range = (m: { args: Record<string, unknown> }) => {
  const { start, end } = (
    m.args.elementId as { id: { start: number; end: number } }
  ).id;
  return { start, end };
};

describe("the host text-format verbs", () => {
  test("bold over a range reads the story range and writes it back", async () => {
    const { deps, sent, mutations } = fake(
      { storyId: "u1", start: 0, end: 5 },
      { characterFontStyle: "Regular" },
    );
    expect(await applyTextVerb(deps, "bold")).toBeNull();
    const get = sent.find((s) => s.kind === "requestGet")!;
    expect(get.payload.address).toBe("storyRange:u1@0..5");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.op).toBe("setElementProperty");
    expect(mutations[0]!.args.path).toBe("characterFontStyle");
    expect(mutations[0]!.args.value).toEqual({ type: "text", value: "Bold" });
    expect(range(mutations[0]!)).toEqual({ start: 0, end: 5 });
  });

  test("a caret formats the word around it", async () => {
    const { deps, mutations } = fake(
      { storyId: "u1", start: 8 },
      { characterFontStyle: "Regular" },
    );
    await applyTextVerb(deps, "italic");
    expect(range(mutations[0]!)).toEqual({ start: 6, end: 11 });
  });

  test("a paragraph path takes the selection, line spacing every touched paragraph", async () => {
    const { deps, mutations } = fake(
      { storyId: "u1", start: 3, end: 14 },
      { characterFontSize: 10 },
    );
    await applyTextVerb(deps, "alignCenter");
    await applyTextVerb(deps, "lineSpacing2");
    expect(mutations[0]!.args.path).toBe("paragraphJustification");
    expect(range(mutations[0]!)).toEqual({ start: 3, end: 13 });
    expect(mutations[1]!.args.path).toBe("characterLeading");
    expect(range(mutations[1]!)).toEqual({ start: 0, end: 23 });
  });

  test("no selection, or a selection in a table cell, writes nothing", async () => {
    for (const sel of [null, { storyId: "u1", start: 0, end: 4, cell: "c" }]) {
      const { deps, mutations } = fake(sel, { characterFontStyle: "Regular" });
      await applyTextVerb(deps, "bold");
      expect(mutations).toEqual([]);
    }
  });

  test("between words nothing is written and the reason is given", async () => {
    const { deps, mutations } = fake(
      { storyId: "u1", start: 2 },
      { characterUnderline: false },
      undefined,
      [["a  b"]],
    );
    expect(await applyTextVerb(deps, "underline")).toContain("between");
    expect(mutations).toEqual([]);
  });

  test("the engine's refusal comes back in words", async () => {
    const { deps } = fake(
      { storyId: "u1", start: 0, end: 5 },
      { characterFontStyle: "Regular" },
      { kind: "mutationFailed", payload: { error: "nope" } },
    );
    expect(await applyTextVerb(deps, "bold")).toContain("ope");
  });

  test("one command and one Type > Format entry per verb", async () => {
    const { deps, mutations } = fake(
      { storyId: "u1", start: 0, end: 5 },
      { characterFontStyle: "Regular" },
    );
    let cleared = 0;
    const commands = buildTextFormatCommands(
      deps,
      () => {},
      () => cleared++,
    );
    expect(commands.map((c) => c.id)).toEqual(
      TEXT_FORMAT_VERBS.map((v) => `paged.text.${v}`),
    );
    await commands[0]!.handler(undefined as never);
    expect(cleared).toBe(1);
    expect(mutations).toHaveLength(1);
    expect(TEXT_FORMAT_MENU_ITEMS.map((m) => m.command)).toEqual(
      commands.map((c) => c.id),
    );
    expect(
      TEXT_FORMAT_MENU_ITEMS.every((m) => m.path.startsWith("Type/Format/")),
    ).toBe(true);
  });

  test("every command writes its verb's property over the selection", async () => {
    covers(
      "command:paged.text.bold",
      "command:paged.text.italic",
      "command:paged.text.underline",
      "command:paged.text.strikethrough",
      "command:paged.text.subscript",
      "command:paged.text.superscript",
      "command:paged.text.allCaps",
      "command:paged.text.smallCaps",
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
    // What each command writes, from a plain 10 pt left-aligned paragraph.
    const expected: Record<string, [string, unknown]> = {
      bold: ["characterFontStyle", { type: "text", value: "Bold" }],
      italic: ["characterFontStyle", { type: "text", value: "Italic" }],
      underline: ["characterUnderline", { type: "bool", value: true }],
      strikethrough: ["characterStrikethru", { type: "bool", value: true }],
      subscript: ["characterPosition", { type: "text", value: "Subscript" }],
      superscript: [
        "characterPosition",
        { type: "text", value: "Superscript" },
      ],
      allCaps: ["characterCase", { type: "text", value: "AllCaps" }],
      smallCaps: ["characterCase", { type: "text", value: "SmallCaps" }],
      growFont: ["characterFontSize", { type: "length", value: 10.5 }],
      shrinkFont: ["characterFontSize", { type: "length", value: 9 }],
      alignLeft: [
        "paragraphJustification",
        { type: "text", value: "LeftAlign" },
      ],
      alignCenter: [
        "paragraphJustification",
        { type: "text", value: "CenterAlign" },
      ],
      alignRight: [
        "paragraphJustification",
        { type: "text", value: "RightAlign" },
      ],
      justify: [
        "paragraphJustification",
        { type: "text", value: "LeftJustified" },
      ],
      increaseIndent: ["paragraphLeftIndent", { type: "length", value: 36 }],
      decreaseIndent: ["paragraphLeftIndent", { type: "length", value: 0 }],
      lineSpacing1: ["characterLeading", { type: "length", value: 12 }],
      lineSpacing15: ["characterLeading", { type: "length", value: 18 }],
      lineSpacing2: ["characterLeading", { type: "length", value: 24 }],
    };
    for (const verb of TEXT_FORMAT_VERBS) {
      const { deps, mutations } = fake(
        { storyId: "u1", start: 0, end: 5 },
        {
          characterFontStyle: "Regular",
          characterUnderline: false,
          characterStrikethru: false,
          characterPosition: "Normal",
          characterCase: "Normal",
          characterFontSize: 10,
          paragraphJustification: "LeftAlign",
          paragraphLeftIndent: 0,
        },
      );
      const reported: string[] = [];
      const command = buildTextFormatCommands(
        deps,
        (m) => reported.push(m),
        () => {},
      ).find((c) => c.id === `paged.text.${verb}`)!;
      await command.handler(undefined as never);
      expect({ verb, reported }).toEqual({ verb, reported: [] });
      expect({
        verb,
        writes: mutations.map((m) => [m.args.path, m.args.value]),
      }).toEqual({ verb, writes: [expected[verb]!] });
    }
  });
});
