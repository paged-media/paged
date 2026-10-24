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

// Editor ADR 292 — the bind popover's modes compiled to the binding language.
// The data door's real-stack spec (modules/data, data-door-real-core) has the
// engine evaluate the same expressions.

import { describe, expect, test } from "bun:test";

import {
  compileMap,
  compileRules,
  fieldRef,
  literal,
  quote,
} from "../../src/catalog/bind-expr";

describe("the bind popover's expressions [editor-shell.bind-popover]", () => {
  test("a value is a number, an expression or a string", () => {
    expect(literal("14")).toBe("14");
    expect(literal("-0.5")).toBe("-0.5");
    expect(literal("=MM(4)")).toBe("MM(4)");
    expect(literal('"Red"')).toBe('"Red"');
    expect(literal("Sale price")).toBe('"Sale price"');
    expect(literal('say "hi"')).toBe('"say ""hi"""');
    expect(literal("")).toBe('""');
    expect(quote('a"b')).toBe('"a""b"');
  });

  test("a field is its bare name, or cannot be read", () => {
    expect(fieldRef("price")).toBe("price");
    expect(fieldRef("unit price")).toBeNull();
  });

  test("rules are nested IFs, first match wins", () => {
    expect(
      compileRules(
        [
          { field: "cat", op: "=", value: "Sale", result: "14" },
          { field: "price", op: ">", value: "100", result: "12" },
        ],
        "10",
      ),
    ).toEqual({ expr: 'IF(cat = "Sale", 14, IF(price > 100, 12, 10))' });
    expect(
      compileRules(
        [{ field: "name", op: "contains", value: "Pro", result: "Bold" }],
        "Regular",
      ),
    ).toEqual({
      expr: 'IF(IFERROR(FIND("Pro", name), 0) > 0, "Bold", "Regular")',
    });
    expect(
      compileRules([{ field: "x", op: "blank", value: "", result: "0" }], "1"),
    ).toEqual({
      expr: "IF(ISBLANK(x), 0, 1)",
    });
    expect(compileRules([], "10")).toEqual({ expr: "10" });
    expect(
      "error" in
        compileRules([{ field: "a b", op: "=", value: "1", result: "2" }], "3"),
    ).toBe(true);
  });

  test("a map is a SWITCH with a default", () => {
    expect(
      compileMap(
        "cat",
        [
          { key: "Sale", value: "Red" },
          { key: "New", value: '=SWATCH("Green")' },
        ],
        "Black",
      ),
    ).toEqual({
      expr: 'SWITCH(cat, "Sale", "Red", "New", SWATCH("Green"), "Black")',
    });
    expect(compileMap("cat", [], "Black")).toEqual({ expr: '"Black"' });
  });
});
