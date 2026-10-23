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

// Cell references in a formula being typed (sheet ADR 510): where they are,
// so the frame surface can colour them in the grid as Excel does, and
// whether the caret sits where clicking a cell should insert one. Pure
// text addressing; the engine still parses and validates the formula.

import { cellOfA1 } from "../../../sheet-host-model/src";

/** One reference in a formula: its text span and the cells it covers. */
export interface FormulaRef {
  start: number;
  end: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
  /** Index into {@link REF_COLORS}, by order of first appearance. */
  color: number;
}

/** Excel's reference colours, cycled. */
export const REF_COLORS = [
  "#3a6ee8",
  "#d33f2f",
  "#7b46c9",
  "#2f8f4a",
  "#c45c9a",
  "#1f8a99",
  "#b8741a",
];

const REF =
  /(\$?[A-Za-z]{1,3}\$?[0-9]{1,7})(?::(\$?[A-Za-z]{1,3}\$?[0-9]{1,7}))?/g;

/** The plain A1 references of `formula` (no sheet-qualified ones, none
 *  inside string literals). Empty unless it starts with `=`. */
export function formulaRefs(formula: string): FormulaRef[] {
  if (!formula.startsWith("=")) return [];
  const out: FormulaRef[] = [];
  const seen = new Map<string, number>();
  // Blank out string literals so a "B2" inside quotes is not a reference.
  const masked = formula.replace(/"[^"]*"?/g, (m) => " ".repeat(m.length));
  for (const m of masked.matchAll(REF)) {
    const start = m.index ?? 0;
    const before = masked[start - 1] ?? "";
    const after = masked[start + m[0].length] ?? "";
    // Part of a longer name (a function, a defined name) or sheet-qualified.
    if (/[A-Za-z0-9_.!]/.test(before) || /[A-Za-z0-9_(]/.test(after)) continue;
    const a = cellOfA1(m[1]!);
    const b = m[2] ? cellOfA1(m[2]) : a;
    if (!a || !b) continue;
    const key = m[0].replaceAll("$", "").toUpperCase();
    if (!seen.has(key)) seen.set(key, seen.size);
    out.push({
      start,
      end: start + m[0].length,
      top: Math.min(a.row, b.row),
      left: Math.min(a.col, b.col),
      bottom: Math.max(a.row, b.row),
      right: Math.max(a.col, b.col),
      color: seen.get(key)! % REF_COLORS.length,
    });
  }
  return out;
}

/** Would a click on a cell insert a reference at `caret` (Excel's "point
 *  mode")? True right after `=`, an operator, `(`, `,` or `;` — or when the
 *  caret ends a reference that a click should replace. */
export function refInsertable(formula: string, caret: number): boolean {
  if (!formula.startsWith("=") || caret < 1) return false;
  const head = formula.slice(0, caret).trimEnd();
  const last = head[head.length - 1] ?? "";
  if ("=+-*/^&<>(,;:%".includes(last)) return true;
  return refEndingAt(formula, caret) !== null;
}

/** The reference that ends exactly at `caret` (to replace it while the
 *  user clicks around), or null. */
export function refEndingAt(formula: string, caret: number): FormulaRef | null {
  return formulaRefs(formula).find((r) => r.end === caret) ?? null;
}

/** 0-based column index → letters. */
function letters(col: number): string {
  let n = col;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** The A1 text of a cell or a range. */
export function a1Of(
  top: number,
  left: number,
  bottom = top,
  right = left,
): string {
  const a = `${letters(left)}${top + 1}`;
  return top === bottom && left === right
    ? a
    : `${a}:${letters(right)}${bottom + 1}`;
}

/** F4: cycle the reference ending at (or containing) `caret` through
 *  A1 → $A$1 → A$1 → $A1 → A1, as Excel does. Returns the new text and
 *  caret, or null when the caret is not on a reference. */
export function cycleAbsolute(
  formula: string,
  caret: number,
): { text: string; caret: number } | null {
  const masked = formula.replace(/"[^"]*"?/g, (m) => " ".repeat(m.length));
  for (const m of masked.matchAll(REF)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (caret < start || caret > end) continue;
    const cycle = (part: string): string => {
      const p = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)$/.exec(part);
      if (!p) return part;
      const [, dc, c, dr, r] = p;
      const state = (dc ? 2 : 0) + (dr ? 1 : 0); // 0 A1, 3 $A$1, 1 A$1, 2 $A1
      const next = { 0: 3, 3: 1, 1: 2, 2: 0 }[state as 0 | 1 | 2 | 3];
      return `${next & 2 ? "$" : ""}${c}${next & 1 ? "$" : ""}${r}`;
    };
    const replaced = m[2] ? `${cycle(m[1]!)}:${cycle(m[2])}` : cycle(m[1]!);
    return {
      text: formula.slice(0, start) + replaced + formula.slice(end),
      caret: start + replaced.length,
    };
  }
  return null;
}
