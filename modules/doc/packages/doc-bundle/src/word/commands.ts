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
//     (tab switching), Cmd+T / Cmd+Shift+T, Cmd+M, Cmd+Q, Cmd+N /
//     Cmd+Shift+N, Cmd+W; the control bar carries line spacing, the
//     indents, Clear paragraph formatting and the Normal style instead, and
//     Word for Mac's own alternatives are bound where it has one
//     (Ctrl+Shift+M indent, Cmd+Alt+C/V for copy/paste formatting —
//     Cmd+Shift+C opens the browser's inspector). Cmd+H (Replace) is bound,
//     for the browsers that hand it over; Cmd+Alt+F, the host's own
//     Find/Change key, opens the same dialog everywhere;
//   · Cmd+Shift+= (superscript): with Shift the key reports "+", which a
//     combo cannot name; the control bar's button does it;
//   · Cmd+Shift+S (the style box, Word's "Apply Styles"): the host keeps it
//     for Save As (a reserved key); the `applyStyles` command and the Styles
//     menu put the focus in the control bar's style box instead;
//   · keys whose target the engine does not have yet: Cmd+D (no Font
//     dialog), the structure keys (page and column breaks, nbsp and
//     Alt+Shift+arrows need an insertion and a paragraph move host.text
//     does not offer), fields, notes, links, comments and track changes
//     (waves 2 and 3).
//
// Find, Replace and Go To are the HOST's commands (editor ADR 303: one
// Find & Replace for every text document); the Word keys below only name
// them (`WORD_HOST_KEYS`).

import type {
  BundleHost,
  TextPropertyRead,
  TextPropertyWrite,
  Value,
} from "@paged-media/plugin-api";

import { LIST_PRESETS, type ListPresetId } from "./lists.js";
import { readShowHidden } from "./word-state.js";
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
  // Doc ADR 608 amendment 1 — what engine ADR 1018 made possible.
  doubleUnderline: `${ID}.doubleUnderline`,
  hidden: `${ID}.hidden`,
  highlight: `${ID}.highlight`,
  shading: `${ID}.shading`,
  borderBottom: `${ID}.borderBottom`,
  borderBox: `${ID}.borderBox`,
  borderNone: `${ID}.borderNone`,
  showHidden: `${ID}.showHidden`,
  clearParagraph: `${ID}.clearParagraph`,
  restartNumbering: `${ID}.restartNumbering`,
  continueNumbering: `${ID}.continueNumbering`,
  listOutline: `${ID}.listOutline`,
  listLegal: `${ID}.listLegal`,
  listBullets: `${ID}.listBullets`,
  styleUpdate: `${ID}.styleUpdate`,
  styleModify: `${ID}.styleModify`,
  styleNew: `${ID}.styleNew`,
  applyStyles: `${ID}.applyStyles`,
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
  { key: "cmd+shift+d", command: WORD_COMMAND.doubleUnderline },
  { key: "cmd+shift+h", command: WORD_COMMAND.hidden },
];

/** The host's Find & Replace commands (editor ADR 303). */
export const HOST_FIND = {
  find: "paged.edit.find",
  replace: "paged.edit.replace",
  goTo: "paged.edit.goTo",
} as const;

/**
 * Word's find keys, scoped to a Word document like the rest, naming the
 * host's commands: Cmd+H Replace, Cmd+G Go To (which inside a Word
 * document takes the key from the host's Group). Cmd+F needs no binding
 * here: the host's own Cmd+F already runs Find in every document.
 */
export const WORD_HOST_KEYS: ReadonlyArray<{ key: string; command: string }> = [
  { key: "cmd+h", command: HOST_FIND.replace },
  { key: "cmd+g", command: HOST_FIND.goTo },
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

/** Where the commands keep Copy formatting's format between keys, and
 *  what the chrome lends them. */
export interface WordCommandState {
  copied: TextPropertyWrite[] | null;
  /** The highlight colour the Highlight button applies (Word's last
   *  used); absent: the document's yellow, made when it has none. */
  highlight?: string | null;
  /** The shading colour the Shading button applies; absent: black at
   *  15 % (Word's light grey). */
  shading?: string | null;
  /** Put the focus in the control bar's style box (Apply Styles). */
  focusStyleBox?: () => void;
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

/** Tab / Shift+Tab in a list: the engine's `setListLevel` by a delta on
 *  every paragraph the selection touches (engine ADR 1018), one undo step;
 *  the level clamps to 1–9 there. */
async function listLevel(host: BundleHost, delta: 1 | -1) {
  const r = await host.text.characterRange();
  if (!r) return { applied: false };
  return mutateOutcome(host, {
    op: "setListLevel",
    args: { storyId: r.storyId, start: r.start, end: r.end, delta },
  });
}

async function mutateOutcome(
  host: BundleHost,
  m: unknown,
): Promise<{ applied: boolean; error?: string }> {
  const out = await host.document.mutate(m as never);
  return out.applied
    ? { applied: true }
    : { applied: false, error: String(out.error ?? "refused") };
}

/** The paragraph paths Clear paragraph formatting drops (an empty text or
 *  a `null` length clears a paragraph override, so the style shows
 *  through), and the per-character leading line spacing writes. */
const CLEAR_PARAGRAPH: TextPropertyWrite[] = [
  { path: "paragraphJustification", value: text("") },
  { path: "paragraphLeftIndent", value: length(null) },
  { path: "paragraphRightIndent", value: length(null) },
  { path: "paragraphFirstLineIndent", value: length(null) },
  { path: "paragraphSpaceBefore", value: length(null) },
  { path: "paragraphSpaceAfter", value: length(null) },
  { path: "characterLeading", value: length(null), extent: "paragraphs" },
];

/** The paths Update to Match / New Style carry from the selection into
 *  the paragraph style, with their wire types. */
const STYLE_PATHS: Record<string, Value["type"]> = {
  characterFontFamily: "text",
  characterFontStyle: "text",
  characterFontSize: "length",
  characterLeading: "length",
  characterCase: "text",
  characterPosition: "text",
  characterUnderline: "bool",
  characterStrikethru: "bool",
  characterFillColor: "colorRef",
  paragraphJustification: "text",
  paragraphLeftIndent: "length",
  paragraphRightIndent: "length",
  paragraphFirstLineIndent: "length",
  paragraphSpaceBefore: "length",
  paragraphSpaceAfter: "length",
};

/** The selection's effective values as `setStyleProperty` writes onto
 *  paragraph style `styleId` (mixed and unreadable paths left out). */
async function styleWrites(host: BundleHost, styleId: string) {
  const paths = Object.keys(STYLE_PATHS);
  const props = await host.text.properties(paths as never);
  if (!props) return [];
  return paths.flatMap((path) => {
    const r = props[path as never] as TextPropertyRead | null | undefined;
    if (!r || r === "mixed" || r.value === null || r.value === undefined)
      return [];
    return [
      {
        op: "setStyleProperty",
        args: {
          collection: "paragraph",
          styleId,
          path,
          value: { type: STYLE_PATHS[path], value: r.value } as Value,
        },
      },
    ];
  });
}

/** The caret's paragraph style (`null` for none or mixed). */
async function currentStyle(host: BundleHost): Promise<string | null> {
  const s = await readOne<string>(host, "appliedParagraphStyle");
  return typeof s === "string" && s !== "mixed" ? s : null;
}

/** The host's Style Options panel on paragraph style `styleId`. */
function openStyleOptions(host: BundleHost, styleId: string): boolean {
  if (!host.supports("shell.openPanel@1")) return false;
  host.shell.openPanel("paged.style-options", {
    target: `style:paragraph/${styleId}`,
  });
  return true;
}

/** A style name the document does not have yet ("Style 1", "Style 2"…). */
async function freshStyleName(host: BundleHost): Promise<string> {
  const styles = (await host.document.collection(
    "paragraphStyles",
  )) as unknown as StyleRow[];
  const names = new Set(styles.map((s) => s.name));
  for (let n = 1; ; n++) if (!names.has(`Style ${n}`)) return `Style ${n}`;
}

/** The swatch Highlight applies when none was chosen: the document's
 *  yellow, made (one undo step of its own) when it has none. */
async function yellowSwatch(host: BundleHost): Promise<string | null> {
  const swatches = (await host.document.collection(
    "swatches",
  )) as unknown as Array<{ selfId: string; name: string }>;
  const found = swatches.find((s) =>
    /^yellow$/i.test(s.name.replace(/^\$ID\//, "")),
  );
  if (found) return found.selfId;
  const out = await host.document.mutate({
    op: "createSwatch",
    args: {
      spec: {
        selfId: "Color/word-highlight-yellow",
        name: "Yellow",
        space: "RGB",
        value: [255, 255, 0],
      },
    },
  } as never);
  return out.applied ? "Color/word-highlight-yellow" : null;
}

const NO_HIGHLIGHT = "Swatch/None";

/** A half-point black rule a little below the last line: Word's bottom
 *  border. */
const RULE_BELOW: Value = {
  type: "paragraphRule",
  value: { on: true, weight: 0.5, color: "Color/Black", offset: 4 },
};
const NO_RULE: Value = { type: "paragraphRule", value: { on: false } };

async function showHiddenNow(host: BundleHost): Promise<boolean> {
  try {
    return await readShowHidden(host);
  } catch {
    return false;
  }
}

/** Apply a multilevel list preset to the touched paragraphs: the list is
 *  made once per document, then the paragraphs take it (and a numbered or
 *  bullet list type) in one batch. */
async function applyListPreset(host: BundleHost, id: ListPresetId) {
  const preset = LIST_PRESETS[id];
  const lists = (await host.document
    .collection("numberingLists")
    .catch(() => [])) as unknown as Array<{ selfId: string }>;
  if (!lists.some((l) => l.selfId === preset.selfId)) {
    const made = await host.document.mutate({
      op: "createNumberingList",
      args: {
        spec: {
          selfId: preset.selfId,
          name: preset.name,
          levels: preset.levels,
        },
      },
    } as never);
    if (!made.applied) return { applied: false };
  }
  return host.text.format([
    { path: "paragraphAppliedNumberingList", value: text(preset.selfId) },
    { path: "paragraphListType", value: text(preset.listType) },
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
    case "doubleUnderline": {
      const now = await readOne<string>(host, "characterUnderlineType");
      return host.text.format([
        {
          path: "characterUnderlineType",
          value: text(now === "double" ? "none" : "double"),
        },
      ]);
    }
    case "hidden":
      return toggleBool(host, "characterHidden");
    case "highlight": {
      const now = await readOne<string>(host, "characterHighlightColor");
      const on = typeof now === "string" && now !== "" && now !== NO_HIGHLIGHT;
      const swatch = on
        ? NO_HIGHLIGHT
        : (state.highlight ?? (await yellowSwatch(host)));
      if (!swatch) return { applied: false };
      return host.text.format([
        {
          path: "characterHighlightColor",
          value: { type: "colorRef", value: swatch },
        },
      ]);
    }
    case "shading": {
      const now = await readOne<boolean>(host, "paragraphShadingOn");
      if (now === true) {
        return host.text.format([
          { path: "paragraphShadingOn", value: bool(false) },
        ]);
      }
      return host.text.format([
        { path: "paragraphShadingOn", value: bool(true) },
        {
          path: "paragraphShadingColor",
          value: { type: "colorRef", value: state.shading ?? "Color/Black" },
        },
        {
          path: "paragraphShadingTint",
          value: length(state.shading ? 100 : 15),
        },
      ]);
    }
    case "borderBottom":
      // Word's bottom border is InDesign's rule below the paragraph.
      return host.text.format([
        { path: "paragraphBorderOn", value: bool(false) },
        { path: "paragraphRuleBelow", value: RULE_BELOW },
      ]);
    case "borderBox":
      return host.text.format([
        { path: "paragraphRuleBelow", value: NO_RULE },
        { path: "paragraphBorderOn", value: bool(true) },
        { path: "paragraphBorderWeight", value: length(0.5) },
        {
          path: "paragraphBorderColor",
          value: { type: "colorRef", value: "Color/Black" },
        },
      ]);
    case "borderNone":
      return host.text.format([
        { path: "paragraphBorderOn", value: bool(false) },
        { path: "paragraphRuleBelow", value: NO_RULE },
      ]);
    case "showHidden": {
      const now = await showHiddenNow(host);
      return mutateOutcome(host, {
        op: "set",
        args: {
          address: "doc",
          path: "documentShowHiddenText",
          value: bool(!now),
        },
      });
    }
    case "clearParagraph":
      return host.text.format(CLEAR_PARAGRAPH);
    case "restartNumbering":
    case "continueNumbering": {
      const r = await host.text.characterRange();
      if (!r) return { applied: false };
      return mutateOutcome(host, {
        op: "restartNumbering",
        args: {
          storyId: r.storyId,
          start: r.start,
          end: r.end,
          ...(name === "restartNumbering"
            ? { startAt: 1 }
            : { continueNumbering: true }),
        },
      });
    }
    case "listOutline":
      return applyListPreset(host, "outline");
    case "listLegal":
      return applyListPreset(host, "legal");
    case "listBullets":
      return applyListPreset(host, "bullets");
    case "styleUpdate": {
      // Update to Match Selection: the caret's paragraph style takes the
      // selection's format, one batch = one undo step.
      const style = await currentStyle(host);
      if (!style) return { applied: false };
      const ops = await styleWrites(host, style);
      if (ops.length === 0) return { applied: false };
      return mutateOutcome(host, { op: "batch", args: { ops } });
    }
    case "styleModify": {
      const style = await currentStyle(host);
      return { applied: style !== null && openStyleOptions(host, style) };
    }
    case "styleNew": {
      // New Style from Selection: a style based on the paragraph's, with
      // the selection's format, applied to the paragraph; then its options
      // open so it can be named.
      const based = await currentStyle(host);
      const name = await freshStyleName(host);
      const made = await host.document.mutate({
        op: "createParagraphStyle",
        args: { name, ...(based ? { basedOn: based } : {}) },
      } as never);
      if (!made.applied) return { applied: false };
      const styles = (await host.document.collection(
        "paragraphStyles",
      )) as unknown as StyleRow[];
      const created = styles.find((s) => s.name === name);
      if (!created) return { applied: false };
      const ops = await styleWrites(host, created.selfId);
      if (ops.length > 0) {
        await mutateOutcome(host, { op: "batch", args: { ops } });
      }
      const applied = await host.text.applyStyle("paragraph", created.selfId);
      openStyleOptions(host, created.selfId);
      return applied;
    }
    case "applyStyles":
      state.focusStyleBox?.();
      return { applied: state.focusStyleBox !== undefined };
  }
}
