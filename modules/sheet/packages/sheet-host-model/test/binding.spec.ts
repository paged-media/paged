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

// sheet.plugin.binding.metadata — the frame-binding envelope: round-trip
// through make/parse, the fixed namespace key, and defensive rejection
// of every malformed shape (a foreign/corrupt metadata blob degrades to
// "not a sheet frame", never a crash).

import { describe, expect, it } from "bun:test";

import {
  BINDING_KEY,
  BINDING_VERSION,
  cellOfA1,
  contentHash,
  makeBinding,
  parseBinding,
  rangeTopLeft,
  withView,
} from "../src";

/** The v2 fields a binding made without options carries. */
const V2_DEFAULTS = {
  print: { headings: false, gridlines: false },
  sizing: "fit" as const,
};
/** What a v1 envelope reads as: its range's top-left, locked. */
function migrated(range: string) {
  return { ...V2_DEFAULTS, view: { topLeft: rangeTopLeft(range), lock: true } };
}

describe("sheet_plugin_binding_metadata: key + version", () => {
  it("the binding key is this plugin's own derived namespace", () => {
    expect(BINDING_KEY).toBe("x-paged:media.paged.sheet");
  });
  it("the envelope version is 2", () => {
    expect(BINDING_VERSION).toBe(2);
  });
});

describe("sheet_plugin_binding_metadata: round-trip", () => {
  it("make → parse is the identity for a valid binding", () => {
    const b = makeBinding("Budget 2026", "A1:F40", 12);
    expect(b).toEqual({
      v: 2,
      data: {
        sheet: "Budget 2026",
        range: "A1:F40",
        contentVersion: 12,
        ...V2_DEFAULTS,
        view: { topLeft: "A1", lock: false },
      },
    });
    expect(parseBinding(b)).toEqual(b);
  });

  it("survives JSON serialisation (the metadata carrier form)", () => {
    const b = makeBinding("Sheet1", "B2:C9", 0);
    expect(parseBinding(JSON.parse(JSON.stringify(b)))).toEqual(b);
  });
});

describe("sheet_plugin_binding_metadata: rejects garbage", () => {
  const garbage: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "A1:B2"],
    ["an array", [1, 2, 3]],
    [
      "unknown version",
      { v: 3, data: { sheet: "S", range: "A1", contentVersion: 1 } },
    ],
    ["missing data", { v: 1 }],
    ["data not an object", { v: 1, data: "A1" }],
    ["missing sheet", { v: 1, data: { range: "A1", contentVersion: 1 } }],
    [
      "sheet not a string",
      { v: 1, data: { sheet: 1, range: "A1", contentVersion: 1 } },
    ],
    ["missing range", { v: 1, data: { sheet: "S", contentVersion: 1 } }],
    [
      "range not a string",
      { v: 1, data: { sheet: "S", range: 5, contentVersion: 1 } },
    ],
    [
      "contentVersion not a number",
      { v: 1, data: { sheet: "S", range: "A1", contentVersion: "x" } },
    ],
    [
      "contentVersion NaN",
      { v: 1, data: { sheet: "S", range: "A1", contentVersion: NaN } },
    ],
  ];

  for (const [label, value] of garbage) {
    it(`returns null for ${label}`, () => {
      expect(parseBinding(value)).toBeNull();
    });
  }

  it("strips extra fields — parse normalises to the contract shape", () => {
    const dirty = {
      v: 1,
      data: { sheet: "S", range: "A1:B2", contentVersion: 3, extra: "ignored" },
      stray: true,
    };
    expect(parseBinding(dirty)).toEqual({
      v: 2,
      data: { sheet: "S", range: "A1:B2", contentVersion: 3, ...migrated("A1:B2") },
    });
  });

  it("carries a table record (Wave 9) and drops a malformed one, never the binding [sheet.plugin.persistence]", () => {
    const table = {
      storyId: "Story/u9",
      tableId: "t3",
      hash: "0badf00d",
      widths: [40, 52.5],
    };
    const b = makeBinding("S", "A1:B2", 4, table);
    expect(parseBinding(JSON.parse(JSON.stringify(b)))).toEqual(b);
    const bad = {
      v: 1,
      data: {
        sheet: "S",
        range: "A1:B2",
        contentVersion: 4,
        table: { storyId: 1 },
      },
    };
    expect(parseBinding(bad)).toEqual({
      v: 2,
      data: { sheet: "S", range: "A1:B2", contentVersion: 4, ...migrated("A1:B2") },
    });
  });

  it("a one-batch placement's record carries no ids; half a pair is malformed [sheet.plugin.persistence]", () => {
    const table = { hash: "0badf00d", widths: [40] };
    const b = makeBinding("S", "A1:B2", 4, table);
    expect(parseBinding(JSON.parse(JSON.stringify(b)))).toEqual(b);
    const half = {
      v: 1,
      data: {
        sheet: "S",
        range: "A1",
        contentVersion: 1,
        table: { storyId: "Story/u1", hash: "x", widths: [] },
      },
    };
    expect(parseBinding(half)?.data.table).toBeUndefined();
  });

  it("contentHash is stable and content-sensitive [sheet.plugin.persistence]", () => {
    const a = { rows: [{ cells: [{ text: "1" }] }] };
    expect(contentHash(a)).toBe(contentHash(JSON.parse(JSON.stringify(a))));
    expect(contentHash(a)).toMatch(/^[0-9a-f]{8}$/);
    expect(contentHash({ rows: [{ cells: [{ text: "2" }] }] })).not.toBe(
      contentHash(a),
    );
  });
});

describe("sheet_frame_view_binding: v2 view, print, freeze, sizing (ADR 510)", () => {
  it("a v1 envelope reads as v2 with its range's top-left, locked, measured widths", () => {
    const v1 = { v: 1, data: { sheet: "S", range: "$c$3:F9", contentVersion: 2 } };
    expect(parseBinding(v1)?.data).toEqual({
      sheet: "S",
      range: "$c$3:F9",
      contentVersion: 2,
      view: { topLeft: "C3", lock: true },
      print: { headings: false, gridlines: false },
      sizing: "fit",
    });
  });

  it("v2 fields round-trip through JSON", () => {
    const b = makeBinding("Q3", "C14:H30", 5, undefined, {
      view: { topLeft: "C14", lock: true },
      print: { headings: true, gridlines: false },
      freeze: { rows: 1, cols: 2 },
      sizing: "window",
    });
    expect(parseBinding(JSON.parse(JSON.stringify(b)))).toEqual(b);
  });

  it("malformed v2 fields fall back to their defaults, never the binding", () => {
    const b = parseBinding({
      v: 2,
      data: {
        sheet: "S",
        range: "B2:C3",
        contentVersion: 1,
        view: { topLeft: "not a cell", lock: "yes" },
        print: { headings: 1 },
        freeze: { rows: -1, cols: 0 },
        sizing: "stretch",
      },
    });
    expect(b?.data.view).toEqual({ topLeft: "B2", lock: false });
    expect(b?.data.print).toEqual({ headings: false, gridlines: false });
    expect(b?.data.freeze).toBeUndefined();
    expect(b?.data.sizing).toBe("fit");
  });

  it("withView changes only what it is given", () => {
    const b = makeBinding("S", "A1:B2", 3, { hash: "h", widths: [10] });
    const moved = withView(b, { view: { topLeft: "D40" } });
    expect(moved.data.view).toEqual({ topLeft: "D40", lock: false });
    expect(moved.data.table).toEqual(b.data.table);
    expect(moved.data.range).toBe("A1:B2");
    expect(withView(moved, { view: { lock: true } }).data.view).toEqual({ topLeft: "D40", lock: true });
  });

  it("rangeTopLeft strips sheet prefixes and dollar signs", () => {
    expect(rangeTopLeft("A1")).toBe("A1");
    expect(rangeTopLeft("'Q 3'!$b$2:$d$9")).toBe("B2");
    expect(rangeTopLeft("XFD1048576")).toBe("XFD1048576");
  });

  it("cellOfA1 reads zero-based row and column, and rejects cells outside the grid", () => {
    expect(cellOfA1("A1")).toEqual({ row: 0, col: 0 });
    expect(cellOfA1("$c$14")).toEqual({ row: 13, col: 2 });
    expect(cellOfA1("XFD1048576")).toEqual({ row: 1048575, col: 16383 });
    expect(cellOfA1("XFE1")).toBeNull();
    expect(cellOfA1("A0")).toBeNull();
    expect(cellOfA1("A1:B2")).toBeNull();
  });
});
