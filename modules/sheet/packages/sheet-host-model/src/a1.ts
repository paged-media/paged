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

// A1 addressing, the one place the sheet packages do it: column letters,
// cells and ranges as text, both ways. Pure text addressing inside Excel's
// grid; the engine parses and validates real references.

/** The last row of the grid, zero-based (row 1048576). */
export const MAX_ROW = 1_048_575;
/** The last column of the grid, zero-based (column XFD). */
export const MAX_COL = 16_383;

/** A rectangle of cells, zero-based and inclusive. */
export interface A1Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** 0-based column index → letters (0 → A, 25 → Z, 26 → AA). */
export function columnLetters(index: number): string {
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/** Column letters → 0-based index (`A` → 0, `aa` → 26), or null when they
 *  are not one to three letters naming a column of the grid. */
export function columnIndex(letters: string): number | null {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return null;
  let col = 0;
  for (const ch of letters.toUpperCase())
    col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1 > MAX_COL ? null : col - 1;
}

/** The zero-based `(row, col)` of an A1 cell (`"C14"` -> `{row: 13, col: 2}`,
 *  `$` signs and case aside), or null when it is not a cell inside Excel's
 *  grid. */
export function cellOfA1(a1: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(a1.trim());
  if (!m) return null;
  const col = columnIndex(m[1]!);
  const row = Number(m[2]) - 1;
  if (col === null || row > MAX_ROW) return null;
  return { row, col };
}

/** The A1 address of a 0-based cell (`(13, 2)` → `C14`). */
export function a1OfCell(row: number, col: number): string {
  return `${columnLetters(col)}${row + 1}`;
}

/** The A1 text of a cell or a range (`B2`, `B2:D9`); one cell when the
 *  corners coincide. */
export function a1OfRange(
  top: number,
  left: number,
  bottom = top,
  right = left,
): string {
  const a = a1OfCell(top, left);
  return top === bottom && left === right
    ? a
    : `${a}:${a1OfCell(bottom, right)}`;
}

/** The cells an A1 cell or range covers (`C3`, `B2:D9`, `$A$1:$B$2`, with
 *  or without a `Sheet!` prefix), corners in order; null when it is not one
 *  inside the grid. */
export function rectOfA1(text: string): A1Rect | null {
  const body = text.slice(text.lastIndexOf("!") + 1);
  const parts = body.split(":");
  if (parts.length > 2) return null;
  const a = cellOfA1(parts[0]!);
  const b = parts.length === 2 ? cellOfA1(parts[1]!) : a;
  if (!a || !b) return null;
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.col, b.col),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.col, b.col),
  };
}
