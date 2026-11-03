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

// Word's style-box helpers (doc ADR 608): which of the document's styles
// the style box offers first. The formatting verbs themselves (what Bold
// does to a font style, the size steps, alignments, indent and line
// spacing) are the shared `text-format` module of `@paged-media/helpers`,
// re-exported here for the Word skin.

export {
  TEXT_ALIGNMENTS as ALIGNMENTS,
  INDENT_STEP_PT,
  LINE_SPACINGS,
  TEXT_SIZES as WORD_SIZES,
  alignmentOf,
  isBold,
  isItalic,
  leadingFor,
  lineSpacingOf,
  stepFontSize,
  steppedIndent,
  toggledFontStyle,
  type TextAlignment as Alignment,
  type TextRead as Read,
} from "@paged-media/helpers";

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
