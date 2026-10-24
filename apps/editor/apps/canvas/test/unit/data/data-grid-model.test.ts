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

// Editor ADR 291 — the Data panel's model: the SQL the grid asks the data
// service for, the header-click sort, and grouping.

import { describe, expect, test } from "bun:test";

import {
  gridSql,
  groupRows,
  nextSort,
  sqlLiteral,
} from "../../../src/panels/data-grid-model";

describe("the Data panel's queries [editor-shell.data-panel]", () => {
  test("a table, filtered all or any, sorted", () => {
    expect(gridSql("products", [], "all", [])).toBe('SELECT * FROM "products"');
    expect(
      gridSql(
        "products",
        [
          { field: "price", op: ">", value: "10" },
          { field: "name", op: "contains", value: "Pro" },
          { field: "note", op: "blank", value: "" },
        ],
        "any",
        [
          { field: "cat", desc: false },
          { field: "price", desc: true },
        ],
      ),
    ).toBe(
      `SELECT * FROM "products" WHERE "price" > 10 OR instr(lower(CAST("name" AS TEXT)), lower('Pro')) > 0 OR ("note" IS NULL OR "note" = '') ORDER BY "cat", "price" DESC`,
    );
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(gridSql('we"ird', [], "all", [])).toBe('SELECT * FROM "we""ird"');
  });

  test("a header click sorts; shift-click sorts within", () => {
    let s = nextSort([], "a", false);
    expect(s).toEqual([{ field: "a", desc: false }]);
    s = nextSort(s, "a", false);
    expect(s).toEqual([{ field: "a", desc: true }]);
    s = nextSort(s, "b", true);
    expect(s).toEqual([
      { field: "a", desc: true },
      { field: "b", desc: false },
    ]);
    s = nextSort(s, "b", true);
    expect(s[1]).toEqual({ field: "b", desc: true });
    expect(nextSort(s, "c", false)).toEqual([{ field: "c", desc: false }]);
  });

  test("grouped rows: a header per run with its count; a closed group hides its records", () => {
    const values = ["A", "A", "B", null];
    expect(groupRows(values, 4, new Set())).toEqual([
      { kind: "group", value: "A", count: 2, open: true },
      { kind: "record", index: 0 },
      { kind: "record", index: 1 },
      { kind: "group", value: "B", count: 1, open: true },
      { kind: "record", index: 2 },
      { kind: "group", value: "", count: 1, open: true },
      { kind: "record", index: 3 },
    ]);
    expect(groupRows(values, 4, new Set(["A"])).slice(0, 2)).toEqual([
      { kind: "group", value: "A", count: 2, open: false },
      { kind: "group", value: "B", count: 1, open: true },
    ]);
    expect(groupRows(null, 2, new Set())).toEqual([
      { kind: "record", index: 0 },
      { kind: "record", index: 1 },
    ]);
  });
});
