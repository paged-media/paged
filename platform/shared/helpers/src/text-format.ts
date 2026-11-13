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

// The text-format verbs as values and as a runner (capability register,
// "Host tools and panels"): what Bold does to a font style, the size steps,
// the four alignments, line spacing and indent steps, and `runTextVerb`,
// which reads the selection's effective value through a `TextDoor` and
// writes the answer. One implementation for the host's `paged.text.*`
// commands and for doc's Word skin (its keys and control bar run the same
// verbs through `host.text`). Pure: the door is the only way out. These are
// the editor's formatting verbs, not DOCX semantics.

/** A read value of the selection: a value, mixed, or nothing to read. */
export type Read<T> = T | "mixed" | null;

const hasWord = (style: string, word: string) =>
  style.split(/\s+/).some((w) => w.toLowerCase() === word.toLowerCase());

/** Is a font style bold (`Bold`, `Bold Italic`, …)? */
export function isBold(style: Read<string>): boolean {
  return (
    typeof style === "string" && style !== "mixed" && hasWord(style, "Bold")
  );
}

/** Is a font style italic (`Italic`, `Oblique`, `Bold Italic`)? */
export function isItalic(style: Read<string>): boolean {
  return (
    typeof style === "string" &&
    style !== "mixed" &&
    (hasWord(style, "Italic") || hasWord(style, "Oblique"))
  );
}

/**
 * The font style Bold or Italic toggles to. A mixed selection takes the
 * attribute on (Word's rule: Cmd+B over part-bold text bolds all of it);
 * otherwise the word comes off when present and goes on when absent,
 * keeping the other: `Italic` + Bold is `Bold Italic`, `Bold Italic` −
 * Bold is `Italic`, and a style left empty is `Regular`.
 */
export function toggledFontStyle(
  current: Read<string>,
  attribute: "Bold" | "Italic",
): string {
  const style =
    typeof current === "string" && current !== "mixed" ? current : "Regular";
  const on = attribute === "Bold" ? isBold(style) : isItalic(style);
  const words = style
    .split(/\s+/)
    .filter(
      (w) =>
        w !== "" &&
        w.toLowerCase() !== "regular" &&
        w.toLowerCase() !== "normal" &&
        w.toLowerCase() !== "roman",
    );
  const turnOff = current !== "mixed" && on;
  let next = turnOff
    ? words.filter(
        (w) =>
          w.toLowerCase() !== attribute.toLowerCase() &&
          !(attribute === "Italic" && w.toLowerCase() === "oblique"),
      )
    : [...words, attribute];
  // Word order as fonts name their faces: weight before slant.
  const bold = next.some((w) => w.toLowerCase() === "bold");
  const italic = next.some((w) => w.toLowerCase() === "italic");
  next = next.filter(
    (w) => w.toLowerCase() !== "bold" && w.toLowerCase() !== "italic",
  );
  if (bold) next.push("Bold");
  if (italic) next.push("Italic");
  return next.length === 0 ? "Regular" : next.join(" ");
}

/** The font-size list (the size box and the grow / shrink verbs). */
export const TEXT_SIZES: readonly number[] = [
  8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72,
];

/** The next size up or down Word's list; past 72, steps of 10. */
export function stepFontSize(size: number, direction: 1 | -1): number {
  if (direction > 0) {
    const next = TEXT_SIZES.find((s) => s > size + 1e-6);
    return next ?? Math.floor(size / 10) * 10 + 10;
  }
  if (size > 72 + 1e-6) return Math.max(72, Math.ceil(size / 10) * 10 - 10);
  const below = [...TEXT_SIZES].reverse().find((s) => s < size - 1e-6);
  return below ?? Math.max(1, size - 1);
}

/** Word's four alignments as the engine's `paragraphJustification`.
 *  Word's Justify leaves the last line ragged: `LeftJustified`. */
export const ALIGNMENTS = {
  left: "LeftAlign",
  center: "CenterAlign",
  right: "RightAlign",
  justify: "LeftJustified",
} as const;
export type Alignment = keyof typeof ALIGNMENTS;

/** The alignment button a justification lights (null for none of them). */
export function alignmentOf(justification: Read<string>): Alignment | null {
  for (const [k, v] of Object.entries(ALIGNMENTS))
    if (v === justification) return k as Alignment;
  return null;
}

/** Word's indent step (Increase/Decrease indent): half an inch. */
export const INDENT_STEP_PT = 36;

/** The left indent after an indent step, never below zero, snapped to the
 *  step grid as Word snaps it. */
export function steppedIndent(indent: number, direction: 1 | -1): number {
  const at = Math.round(indent / INDENT_STEP_PT);
  const onGrid = Math.abs(indent - at * INDENT_STEP_PT) < 0.01;
  const base = onGrid
    ? at
    : direction > 0
      ? Math.floor(indent / INDENT_STEP_PT)
      : Math.ceil(indent / INDENT_STEP_PT);
  return Math.max(0, (base + direction) * INDENT_STEP_PT);
}

/** Word's line-spacing multiples. */
export const LINE_SPACINGS = [1, 1.5, 2] as const;

/**
 * The leading a line-spacing multiple gives text of `sizePt`: Word's single
 * line is about 1.2 em for its text faces (the engine holds Word's spacing
 * as a fixed `characterLeading`, docx-lower's `line_pitch_pt`).
 */
export function leadingFor(sizePt: number, multiple: number): number {
  return Math.round(sizePt * 1.2 * multiple * 100) / 100;
}

/** The multiple a leading reads as, when it is one of Word's three. */
export function lineSpacingOf(
  leading: Read<number>,
  sizePt: Read<number>,
): number | null {
  if (typeof leading !== "number" || typeof sizePt !== "number") return null;
  for (const m of LINE_SPACINGS)
    if (Math.abs(leadingFor(sizePt, m) - leading) < 0.26) return m;
  return null;
}

/** A value written to a text path (the wire's `Value`, narrowed to what
 *  the verbs write). */
export type TextVerbValue =
  | { type: "text"; value: string }
  | { type: "length"; value: number | null }
  | { type: "bool"; value: boolean };

export interface TextVerbWrite {
  path: string;
  value: TextVerbValue;
  /** `"paragraphs"`: a character path over every touched paragraph. */
  extent?: "paragraphs";
}

/** What a verb needs of the selection: read one effective value, write a
 *  batch in one undo step. */
export interface TextDoor {
  read(path: string): Promise<Read<unknown>>;
  format(
    writes: readonly TextVerbWrite[],
  ): Promise<{ applied: boolean; error?: string }>;
}

/** The verbs `runTextVerb` runs. */
export const TEXT_VERBS = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "subscript",
  "superscript",
  "allCaps",
  "smallCaps",
  "growFont",
  "shrinkFont",
  "alignLeft",
  "alignCenter",
  "alignRight",
  "justify",
  "increaseIndent",
  "decreaseIndent",
  "lineSpacing1",
  "lineSpacing15",
  "lineSpacing2",
  "increaseLeading",
  "decreaseLeading",
  "increaseTracking",
  "decreaseTracking",
] as const;
export type TextVerb = (typeof TEXT_VERBS)[number];

/** InDesign's keyboard increments (Preferences ▸ Units & Increments): the
 *  leading step in points and the kerning/tracking step in thousandths of
 *  an em. */
export const LEADING_STEP_PT = 2;
export const TRACKING_STEP = 20;

/** Auto leading: 120 % of the size, InDesign's default. */
export const AUTO_LEADING = 1.2;

/** The leading one step from `leading` (Auto reads as 120 % of `sizePt`),
 *  never below one point. */
export function steppedLeading(
  leading: Read<number>,
  sizePt: Read<number>,
  direction: 1 | -1,
): number | null {
  const now =
    typeof leading === "number"
      ? leading
      : typeof sizePt === "number"
        ? sizePt * AUTO_LEADING
        : null;
  if (now === null) return null;
  return Math.max(
    1,
    Math.round((now + direction * LEADING_STEP_PT) * 100) / 100,
  );
}

const text = (value: string): TextVerbValue => ({ type: "text", value });
const length = (value: number | null): TextVerbValue => ({
  type: "length",
  value,
});
const bool = (value: boolean): TextVerbValue => ({ type: "bool", value });

const LINE_SPACING_OF: Record<string, number> = {
  lineSpacing1: 1,
  lineSpacing15: 1.5,
  lineSpacing2: 2,
};

/** Run one verb against the selection. `{ applied: false }` when there is
 *  nothing to read (no selection, or a size the verb needs is unreadable). */
export async function runTextVerb(
  door: TextDoor,
  verb: TextVerb,
): Promise<{ applied: boolean; error?: string }> {
  const toggleBool = async (path: string) =>
    door.format([{ path, value: bool((await door.read(path)) !== true) }]);
  const toggleEnum = async (path: string, on: string, off: string) =>
    door.format([
      { path, value: text((await door.read(path)) === on ? off : on) },
    ]);
  switch (verb) {
    case "bold":
    case "italic": {
      const now = (await door.read("characterFontStyle")) as Read<string>;
      return door.format([
        {
          path: "characterFontStyle",
          value: text(
            toggledFontStyle(now, verb === "bold" ? "Bold" : "Italic"),
          ),
        },
      ]);
    }
    case "underline":
      return toggleBool("characterUnderline");
    case "strikethrough":
      return toggleBool("characterStrikethru");
    case "subscript":
      return toggleEnum("characterPosition", "Subscript", "Normal");
    case "superscript":
      return toggleEnum("characterPosition", "Superscript", "Normal");
    case "allCaps":
      return toggleEnum("characterCase", "AllCaps", "Normal");
    case "smallCaps":
      return toggleEnum("characterCase", "SmallCaps", "Normal");
    case "growFont":
    case "shrinkFont": {
      const size = await door.read("characterFontSize");
      if (typeof size !== "number") return { applied: false };
      return door.format([
        {
          path: "characterFontSize",
          value: length(stepFontSize(size, verb === "growFont" ? 1 : -1)),
        },
      ]);
    }
    case "alignLeft":
    case "alignCenter":
    case "alignRight":
    case "justify": {
      const a: Alignment =
        verb === "alignLeft"
          ? "left"
          : verb === "alignCenter"
            ? "center"
            : verb === "alignRight"
              ? "right"
              : "justify";
      return door.format([
        { path: "paragraphJustification", value: text(ALIGNMENTS[a]) },
      ]);
    }
    case "increaseIndent":
    case "decreaseIndent": {
      const now = await door.read("paragraphLeftIndent");
      return door.format([
        {
          path: "paragraphLeftIndent",
          value: length(
            steppedIndent(
              typeof now === "number" ? now : 0,
              verb === "increaseIndent" ? 1 : -1,
            ),
          ),
        },
      ]);
    }
    case "increaseLeading":
    case "decreaseLeading": {
      const leading = (await door.read("characterLeading")) as Read<number>;
      const size = (await door.read("characterFontSize")) as Read<number>;
      const next = steppedLeading(
        leading,
        size,
        verb === "increaseLeading" ? 1 : -1,
      );
      if (next === null) return { applied: false };
      return door.format([
        { path: "characterLeading", value: length(next), extent: "paragraphs" },
      ]);
    }
    case "increaseTracking":
    case "decreaseTracking": {
      const now = await door.read("characterTracking");
      const base = typeof now === "number" ? now : 0;
      return door.format([
        {
          path: "characterTracking",
          value: length(
            base +
              (verb === "increaseTracking" ? TRACKING_STEP : -TRACKING_STEP),
          ),
        },
      ]);
    }
    case "lineSpacing1":
    case "lineSpacing15":
    case "lineSpacing2": {
      const size = await door.read("characterFontSize");
      if (typeof size !== "number") return { applied: false };
      return door.format([
        {
          path: "characterLeading",
          value: length(leadingFor(size, LINE_SPACING_OF[verb]!)),
          extent: "paragraphs",
        },
      ]);
    }
  }
}
