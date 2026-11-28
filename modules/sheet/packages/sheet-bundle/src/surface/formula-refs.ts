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

const CELL = String.raw`\$?[A-Za-z]{1,3}\$?[0-9]{1,7}`;
const REF = new RegExp(`(${CELL})(?::(${CELL}))?`, "g");
/** A character of a name: a function, a defined name or an unquoted sheet
 *  name is letters of any script, digits, `_` and `.`. */
const NAME_CHAR = /[\p{L}\p{N}_.]/u;

/** A cell or range reference found in a formula's text. */
interface RefSpan {
  start: number;
  end: number;
  /** The text of each corner (`$B$2`); `b` only for a range. */
  a: string;
  b: string | undefined;
  /** Follows a `Sheet!` qualifier. */
  qualified: boolean;
}

/** The one reference finder: the cell and range references of `formula`,
 *  in order. A reference is not text inside a string literal or a quoted
 *  sheet name, not part of a longer name (`LOG10(`, `Tax2024`, `A1.total`),
 *  not a sheet name (`ABC1!A1`), and it names cells inside the grid. */
function refSpans(formula: string): RefSpan[] {
  // Blank out string literals and quoted sheet names, so a "B2" inside
  // quotes is not a reference; the spans keep their positions.
  const masked = formula.replace(/"[^"]*"?|'(?:[^']|'')*'?/g, (m) =>
    " ".repeat(m.length),
  );
  const out: RefSpan[] = [];
  for (const m of masked.matchAll(REF)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const before = masked[start - 1] ?? "";
    const after = masked[end] ?? "";
    // Part of a longer name, a call, or a sheet name before its `!`.
    if (NAME_CHAR.test(before) || before === "$") continue;
    if (after !== "" && (NAME_CHAR.test(after) || "($!".includes(after)))
      continue;
    if (!cellOfA1(m[1]!) || (m[2] !== undefined && !cellOfA1(m[2]))) continue;
    out.push({ start, end, a: m[1]!, b: m[2], qualified: before === "!" });
  }
  return out;
}

/** The plain A1 references of `formula` (no sheet-qualified ones, none
 *  inside string literals). Empty unless it starts with `=`. */
export function formulaRefs(formula: string): FormulaRef[] {
  if (!formula.startsWith("=")) return [];
  const out: FormulaRef[] = [];
  const seen = new Map<string, number>();
  for (const span of refSpans(formula)) {
    if (span.qualified) continue;
    const a = cellOfA1(span.a)!;
    const b = span.b === undefined ? a : cellOfA1(span.b)!;
    const key = formula
      .slice(span.start, span.end)
      .replaceAll("$", "")
      .toUpperCase();
    if (!seen.has(key)) seen.set(key, seen.size);
    out.push({
      start: span.start,
      end: span.end,
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

/** One corner's next step of A1 → $A$1 → A$1 → $A1 → A1. */
function cycleCorner(part: string): string {
  const p = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)$/.exec(part);
  if (!p) return part;
  const [, dc, c, dr, r] = p;
  const state = (dc ? 2 : 0) + (dr ? 1 : 0); // 0 A1, 3 $A$1, 1 A$1, 2 $A1
  const next = { 0: 3, 3: 1, 1: 2, 2: 0 }[state as 0 | 1 | 2 | 3];
  return `${next & 2 ? "$" : ""}${c}${next & 1 ? "$" : ""}${r}`;
}

/** F4: cycle the reference ending at (or containing) `caret` through
 *  A1 → $A$1 → A$1 → $A1 → A1, as Excel does, a sheet-qualified one
 *  included. Returns the new text and caret, or null when the caret is not
 *  on a reference: a function name that reads like a cell (`LOG10(`) and a
 *  defined name are not references. */
export function cycleAbsolute(
  formula: string,
  caret: number,
): { text: string; caret: number } | null {
  const span = refSpans(formula).find(
    (r) => caret >= r.start && caret <= r.end,
  );
  if (!span) return null;
  const replaced =
    span.b === undefined
      ? cycleCorner(span.a)
      : `${cycleCorner(span.a)}:${cycleCorner(span.b)}`;
  return {
    text: formula.slice(0, span.start) + replaced + formula.slice(span.end),
    caret: span.start + replaced.length,
  };
}
