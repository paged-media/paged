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

// The Data panel's model (editor ADR 291): what the grid asks the data
// service for. Sorting and filtering are SQL the service runs (its guard
// checks it, the store answers), so a 100 000-row table is sorted where it
// lives and only the window the grid shows crosses; grouping folds the
// sorted rows the grid has.

/** A sort key: a field, ascending or descending. */
export interface SortKey {
  field: string;
  desc: boolean;
}

export type FilterOp =
  "=" | "<>" | "<" | "<=" | ">" | ">=" | "contains" | "blank" | "notBlank";

export interface FilterRow {
  field: string;
  op: FilterOp;
  value: string;
}

/** A double-quoted SQL identifier. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A SQL literal: a number as it is, anything else as a string. */
export function sqlLiteral(v: string): string {
  const t = v.trim();
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return t;
  return `'${v.replace(/'/g, "''")}'`;
}

function condition(f: FilterRow): string {
  const c = ident(f.field);
  switch (f.op) {
    case "blank":
      return `(${c} IS NULL OR ${c} = '')`;
    case "notBlank":
      return `(${c} IS NOT NULL AND ${c} <> '')`;
    case "contains":
      return `instr(lower(CAST(${c} AS TEXT)), lower(${sqlLiteral(f.value)})) > 0`;
    default:
      return `${c} ${f.op} ${sqlLiteral(f.value)}`;
  }
}

/** The query the grid shows: the table, filtered (all or any), sorted. */
export function gridSql(
  table: string,
  filters: readonly FilterRow[],
  match: "all" | "any",
  sort: readonly SortKey[],
): string {
  const where = filters.filter((f) => f.field !== "");
  let sql = `SELECT * FROM ${ident(table)}`;
  if (where.length > 0)
    sql += ` WHERE ${where.map(condition).join(match === "all" ? " AND " : " OR ")}`;
  if (sort.length > 0)
    sql += ` ORDER BY ${sort.map((s) => `${ident(s.field)}${s.desc ? " DESC" : ""}`).join(", ")}`;
  return sql;
}

/** A header click: toggles the field's direction; with `add` (shift) it
 *  joins the keys as a sub-sort, else it becomes the only key. */
export function nextSort(
  sort: readonly SortKey[],
  field: string,
  add: boolean,
): SortKey[] {
  const at = sort.findIndex((s) => s.field === field);
  if (add) {
    if (at < 0) return [...sort, { field, desc: false }];
    return sort.map((s, i) => (i === at ? { ...s, desc: !s.desc } : s));
  }
  if (at === 0 && sort.length === 1) return [{ field, desc: !sort[0]!.desc }];
  return [{ field, desc: false }];
}

/** A row of the grid: a record, or a group's header. */
export type GridRow =
  | { kind: "record"; index: number }
  | { kind: "group"; value: string; count: number; open: boolean };

/** The rows the grid shows: records, or, grouped by a field, each group's
 *  header with its count and, when open, its records (in the sorted order;
 *  a group is the run of equal values the sort put together). */
export function groupRows(
  values: readonly unknown[] | null,
  count: number,
  closed: ReadonlySet<string>,
): GridRow[] {
  if (!values)
    return Array.from({ length: count }, (_, index) => ({
      kind: "record",
      index,
    }));
  const out: GridRow[] = [];
  let i = 0;
  while (i < count) {
    const v = String(values[i] ?? "");
    let j = i;
    while (j < count && String(values[j] ?? "") === v) j++;
    const open = !closed.has(v);
    out.push({ kind: "group", value: v, count: j - i, open });
    if (open)
      for (let k = i; k < j; k++) out.push({ kind: "record", index: k });
    i = j;
  }
  return out;
}
