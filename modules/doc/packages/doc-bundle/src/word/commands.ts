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

// Word's formatting commands and shortcuts (doc ADR 608, extensions ADR
// 348): each command reads the selection's effective values through
// `host.text.properties` and writes through `host.text.format` /
// `applyStyle` (one undo step each), and each shortcut is scoped to the
// `wordDocument` edit context, so inside a Word document it outranks the
// host's key and the text input — and outside one it does not exist.
//
// What is NOT bound, and why (the plan's map minus these):
//   · keys the browser keeps for itself and never hands a page: Cmd+1/2/5
//     (tab switching), Cmd+T / Cmd+Shift+T, Cmd+M, Cmd+Q, Cmd+H, Cmd+N /
//     Cmd+Shift+N, Cmd+W; the control bar carries line spacing, the
//     indents and the Normal style instead, and Word for Mac's own
//     alternatives are bound where it has one (Ctrl+Shift+M indent,
//     Cmd+Alt+C/V for copy/paste formatting — Cmd+Shift+C opens the
//     browser's inspector);
//   · Cmd+Shift+= (superscript): with Shift the key reports "+", which a
//     combo cannot name; the control bar's button does it;
//   · keys whose target the engine does not have yet: double underline and
//     hidden text (no underline kinds or hidden attribute), clear paragraph
//     formatting (no way to drop an override), Cmd+D (no Font dialog),
//     Cmd+Shift+S (the host's Save As stays), the structure keys (page and
//     column breaks, nbsp and Alt+Shift+arrows need an insertion and a
//     paragraph move host.text does not offer), find and replace (the
//     engine's FindReplace op is not on main), fields, notes, links,
//     comments and track changes (waves 2 and 3).

import type {
  BundleHost,
  TextPropertyRead,
  TextPropertyWrite,
  Value,
} from "@paged-media/plugin-api";

import {
  ALIGNMENTS,
  leadingFor,
  stepFontSize,
  steppedIndent,
  styleNamed,
  toggledFontStyle,
  type Alignment,
  type Read,
  type StyleRow,
} from "./format.js";

/** The edit context every Word contribution is scoped to. */
export const WORD_CONTEXT = "wordDocument";

const ID = "media.paged.doc.command.word";

/** The command ids (also the manifest's `contributes.commands`). */
export const WORD_COMMAND = {
  bold: `${ID}.bold`,
  italic: `${ID}.italic`,
  underline: `${ID}.underline`,
  strikethrough: `${ID}.strikethrough`,
  subscript: `${ID}.subscript`,
  superscript: `${ID}.superscript`,
  allCaps: `${ID}.allCaps`,
  smallCaps: `${ID}.smallCaps`,
  clearCharacter: `${ID}.clearCharacter`,
  growFont: `${ID}.growFont`,
  shrinkFont: `${ID}.shrinkFont`,
  alignLeft: `${ID}.alignLeft`,
  alignCenter: `${ID}.alignCenter`,
  alignRight: `${ID}.alignRight`,
  justify: `${ID}.justify`,
  spaceBefore: `${ID}.spaceBefore`,
  increaseIndent: `${ID}.increaseIndent`,
  decreaseIndent: `${ID}.decreaseIndent`,
  heading1: `${ID}.heading1`,
  heading2: `${ID}.heading2`,
  heading3: `${ID}.heading3`,
  normal: `${ID}.normal`,
  bullets: `${ID}.bullets`,
  numbering: `${ID}.numbering`,
  listLevelDown: `${ID}.listLevelDown`,
  listLevelUp: `${ID}.listLevelUp`,
  copyFormat: `${ID}.copyFormat`,
  pasteFormat: `${ID}.pasteFormat`,
  lineSpacing1: `${ID}.lineSpacing1`,
  lineSpacing15: `${ID}.lineSpacing15`,
  lineSpacing2: `${ID}.lineSpacing2`,
} as const;
export type WordCommandName = keyof typeof WORD_COMMAND;

/**
 * The shortcuts. A table the surface gate reads through the loop that
 * registers it (`contributeWordKeys`). `list: true` binds only while the
 * caret's paragraph is a list item (Tab and Shift+Tab are a tab and focus
 * otherwise).
 */
export const WORD_KEYS: ReadonlyArray<{
  key: string;
  command: string;
  list?: boolean;
}> = [
  { key: "cmd+b", command: WORD_COMMAND.bold },
  { key: "cmd+i", command: WORD_COMMAND.italic },
  { key: "cmd+u", command: WORD_COMMAND.underline },
  { key: "cmd+=", command: WORD_COMMAND.subscript },
  { key: "cmd+shift+a", command: WORD_COMMAND.allCaps },
  { key: "cmd+shift+k", command: WORD_COMMAND.smallCaps },
  { key: "cmd+space", command: WORD_COMMAND.clearCharacter },
  { key: "cmd+shift+>", command: WORD_COMMAND.growFont },
  { key: "cmd+shift+<", command: WORD_COMMAND.shrinkFont },
  { key: "cmd+l", command: WORD_COMMAND.alignLeft },
  { key: "cmd+e", command: WORD_COMMAND.alignCenter },
  { key: "cmd+r", command: WORD_COMMAND.alignRight },
  { key: "cmd+j", command: WORD_COMMAND.justify },
  { key: "cmd+0", command: WORD_COMMAND.spaceBefore },
  { key: "ctrl+shift+m", command: WORD_COMMAND.increaseIndent },
  { key: "cmd+shift+m", command: WORD_COMMAND.decreaseIndent },
  { key: "cmd+alt+1", command: WORD_COMMAND.heading1 },
  { key: "cmd+alt+2", command: WORD_COMMAND.heading2 },
  { key: "cmd+alt+3", command: WORD_COMMAND.heading3 },
  { key: "cmd+shift+l", command: WORD_COMMAND.bullets },
  { key: "tab", command: WORD_COMMAND.listLevelDown, list: true },
  { key: "shift+tab", command: WORD_COMMAND.listLevelUp, list: true },
  { key: "cmd+alt+c", command: WORD_COMMAND.copyFormat },
  { key: "cmd+alt+v", command: WORD_COMMAND.pasteFormat },
];

/** The character paths Copy formatting carries. */
const FORMAT_PATHS = [
  "characterFontFamily",
  "characterFontStyle",
  "characterFontSize",
  "characterUnderline",
  "characterStrikethru",
  "characterPosition",
  "characterCase",
  "characterFillColor",
] as const;

const WIRE: Record<(typeof FORMAT_PATHS)[number], Value["type"]> = {
  characterFontFamily: "text",
  characterFontStyle: "text",
  characterFontSize: "length",
  characterUnderline: "bool",
  characterStrikethru: "bool",
  characterPosition: "text",
  characterCase: "text",
  characterFillColor: "colorRef",
};

/** A read as a plain value (`null` for mixed or unreadable). */
function plain<T>(r: TextPropertyRead | null | undefined): Read<T> {
  if (r === "mixed") return "mixed";
  if (!r) return null;
  return r.value as T;
}

/** Where the commands keep Copy formatting's format between keys. */
export interface WordCommandState {
  copied: TextPropertyWrite[] | null;
}

const text = (value: string): Value => ({ type: "text", value });
const length = (value: number | null): Value => ({ type: "length", value });
const bool = (value: boolean): Value => ({ type: "bool", value });

/** The no-character-style id the engine's IDML styles name. */
export const NO_CHARACTER_STYLE = "CharacterStyle/$ID/[No character style]";

async function readOne<T>(host: BundleHost, path: string): Promise<Read<T>> {
  const props = await host.text.properties([path as never]);
  return plain<T>(props?.[path as never]);
}

async function toggleBool(host: BundleHost, path: string): Promise<unknown> {
  const now = await readOne<boolean>(host, path);
  return host.text.format([{ path: path as never, value: bool(now !== true) }]);
}

async function toggleEnum(
  host: BundleHost,
  path: string,
  on: string,
  off: string,
): Promise<unknown> {
  const now = await readOne<string>(host, path);
  return host.text.format([
    { path: path as never, value: text(now === on ? off : on) },
  ]);
}

async function styleByName(
  host: BundleHost,
  names: readonly string[],
): Promise<StyleRow | null> {
  const styles = (await host.document.collection(
    "paragraphStyles",
  )) as unknown as StyleRow[];
  for (const n of names) {
    const s = styleNamed(styles, n);
    if (s) return s;
  }
  return null;
}

async function applyNamedStyle(
  host: BundleHost,
  names: readonly string[],
): Promise<unknown> {
  const style = await styleByName(host, names);
  if (!style) {
    host.log.warn(`paged.doc: the document has no "${names[0]}" style`);
    return { applied: false };
  }
  return host.text.applyStyle("paragraph", style.selfId);
}

async function align(host: BundleHost, a: Alignment): Promise<unknown> {
  return host.text.format([
    { path: "paragraphJustification", value: text(ALIGNMENTS[a]) },
  ]);
}

async function lineSpacing(host: BundleHost, multiple: number) {
  const size = await readOne<number>(host, "characterFontSize");
  if (typeof size !== "number") return { applied: false };
  return host.text.format([
    {
      path: "characterLeading",
      value: length(leadingFor(size, multiple)),
      extent: "paragraphs",
    },
  ]);
}

async function listLevel(host: BundleHost, delta: 1 | -1) {
  const level = await readOne<number>(host, "paragraphNumberingLevel");
  const at = typeof level === "number" ? level : 1;
  return host.text.format([
    {
      path: "paragraphNumberingLevel",
      value: length(Math.min(9, Math.max(1, at + delta))),
    },
  ]);
}

/** Run a Word command against the selection. */
export async function runWordCommand(
  host: BundleHost,
  name: WordCommandName,
  state: WordCommandState,
): Promise<unknown> {
  switch (name) {
    case "bold":
    case "italic": {
      const now = await readOne<string>(host, "characterFontStyle");
      return host.text.format([
        {
          path: "characterFontStyle",
          value: text(
            toggledFontStyle(now, name === "bold" ? "Bold" : "Italic"),
          ),
        },
      ]);
    }
    case "underline":
      return toggleBool(host, "characterUnderline");
    case "strikethrough":
      return toggleBool(host, "characterStrikethru");
    case "subscript":
      return toggleEnum(host, "characterPosition", "Subscript", "Normal");
    case "superscript":
      return toggleEnum(host, "characterPosition", "Superscript", "Normal");
    case "allCaps":
      return toggleEnum(host, "characterCase", "AllCaps", "Normal");
    case "smallCaps":
      return toggleEnum(host, "characterCase", "SmallCaps", "Normal");
    case "clearCharacter":
      return host.text.applyStyle("character", NO_CHARACTER_STYLE);
    case "growFont":
    case "shrinkFont": {
      const size = await readOne<number>(host, "characterFontSize");
      if (typeof size !== "number") return { applied: false };
      return host.text.format([
        {
          path: "characterFontSize",
          value: length(stepFontSize(size, name === "growFont" ? 1 : -1)),
        },
      ]);
    }
    case "alignLeft":
      return align(host, "left");
    case "alignCenter":
      return align(host, "center");
    case "alignRight":
      return align(host, "right");
    case "justify":
      return align(host, "justify");
    case "spaceBefore": {
      const now = await readOne<number>(host, "paragraphSpaceBefore");
      return host.text.format([
        {
          path: "paragraphSpaceBefore",
          value: length(typeof now === "number" && now > 0 ? 0 : 12),
        },
      ]);
    }
    case "increaseIndent":
    case "decreaseIndent": {
      const now = await readOne<number>(host, "paragraphLeftIndent");
      return host.text.format([
        {
          path: "paragraphLeftIndent",
          value: length(
            steppedIndent(
              typeof now === "number" ? now : 0,
              name === "increaseIndent" ? 1 : -1,
            ),
          ),
        },
      ]);
    }
    case "heading1":
      return applyNamedStyle(host, ["Heading 1"]);
    case "heading2":
      return applyNamedStyle(host, ["Heading 2"]);
    case "heading3":
      return applyNamedStyle(host, ["Heading 3"]);
    case "normal":
      return applyNamedStyle(host, ["Normal", "[Basic Paragraph]"]);
    case "bullets":
      return toggleEnum(host, "paragraphListType", "BulletList", "NoList");
    case "numbering":
      return toggleEnum(host, "paragraphListType", "NumberedList", "NoList");
    case "listLevelDown":
      return listLevel(host, 1);
    case "listLevelUp":
      return listLevel(host, -1);
    case "copyFormat": {
      const props = await host.text.properties([...FORMAT_PATHS]);
      if (!props) return { applied: false };
      state.copied = FORMAT_PATHS.flatMap((path) => {
        const r = props[path];
        if (!r || r === "mixed" || r.value === null) return [];
        return [{ path, value: { type: WIRE[path], value: r.value } as Value }];
      });
      return { applied: true };
    }
    case "pasteFormat":
      if (!state.copied || state.copied.length === 0) return { applied: false };
      return host.text.format(state.copied);
    case "lineSpacing1":
      return lineSpacing(host, 1);
    case "lineSpacing15":
      return lineSpacing(host, 1.5);
    case "lineSpacing2":
      return lineSpacing(host, 2);
  }
}
