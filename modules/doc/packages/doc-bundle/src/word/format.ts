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

// Word's formatting commands as values (doc ADR 608): what Bold does to a
// font style, Word's font-size steps, its alignments, line spacing and
// indent steps, and which of the document's styles the style box offers
// first. Pure: the commands (commands.ts) read the selection's effective
// values through host.text and write what these answer. These are the
// editor's formatting verbs, not DOCX semantics — the document they act on
// is engine text.

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

/** Word's font-size list (the size box and Cmd+Shift+> / <). */
export const WORD_SIZES: readonly number[] = [
  8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72,
];

/** The next size up or down Word's list; past 72, steps of 10. */
export function stepFontSize(size: number, direction: 1 | -1): number {
  if (direction > 0) {
    const next = WORD_SIZES.find((s) => s > size + 1e-6);
    return next ?? Math.floor(size / 10) * 10 + 10;
  }
  if (size > 72 + 1e-6) return Math.max(72, Math.ceil(size / 10) * 10 - 10);
  const below = [...WORD_SIZES].reverse().find((s) => s < size - 1e-6);
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

/** A paragraph style as the engine's collection lists it. */
export interface StyleRow {
  selfId: string;
  name: string;
}

/** Styles the lowering generates for direct formatting (`docx-auto-*`,
 *  named "docx direct format N"), never offered. */
const GENERATED = /\/docx-auto-/i;
/** The document defaults' style and the host's built-ins: offered last. */
const BUILT_IN = (s: StyleRow) =>
  styleLabel(s).startsWith("[") || /\/docx-Default$/.test(s.selfId);

/** The style's display name: the engine's name, without the `$ID/` the
 *  built-in styles carry. */
export function styleLabel(style: StyleRow): string {
  return style.name.replace(/^\$ID\//, "");
}

/**
 * The style box's list: the document's own styles first (Word's, by name),
 * then the document defaults and the host's bracketed built-ins
 * (`[No paragraph style]`); the generated
 * direct-formatting styles never.
 */
export function styleBoxOrder(styles: readonly StyleRow[]): StyleRow[] {
  const offered = styles.filter((s) => !GENERATED.test(s.selfId));
  return [
    ...offered.filter((s) => !BUILT_IN(s)),
    ...offered.filter((s) => BUILT_IN(s)),
  ];
}

/** A style by its name, Word's way: case-blind (`heading 1` is Word's own
 *  spelling in styles.xml, `Heading 1` its display). */
export function styleNamed(
  styles: readonly StyleRow[],
  name: string,
): StyleRow | null {
  const want = name.toLowerCase();
  return (
    styles.find((s) => styleLabel(s).toLowerCase() === want) ??
    styles.find((s) => s.selfId.toLowerCase().endsWith(`/${want}`)) ??
    null
  );
}
