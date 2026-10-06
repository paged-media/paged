/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// @feat: plugin-platform.object-model
//
// ADR 131 — the TS mirror of core's address grammar and selectors. Table
// tests pin every form (canonical, alias, refusal); fast-check pins the two
// round-trip laws: parse(format(a)) = a for every well-formed parsed
// address, and format(parse(s)) = s for every canonical string.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ParsedAddress } from "@paged-media/plugin-api";
import {
  formatAddress,
  parseAddress,
  parseSelector,
  toElementId,
  fromElementId,
} from "../src/object-address";

describe("parseAddress — canonical forms (ADR 131)", () => {
  const table: Array<[string, ParsedAddress]> = [
    ["doc", { kind: "doc" }],
    ["textFrame:u12", { kind: "item", itemKind: "textFrame", id: "u12" }],
    ["rectangle:u1", { kind: "item", itemKind: "rectangle", id: "u1" }],
    ["oval:u1", { kind: "item", itemKind: "oval", id: "u1" }],
    ["polygon:u1", { kind: "item", itemKind: "polygon", id: "u1" }],
    ["graphicLine:u1", { kind: "item", itemKind: "graphicLine", id: "u1" }],
    ["group:u88", { kind: "item", itemKind: "group", id: "u88" }],
    ["page:ud3", { kind: "page", id: "ud3" }],
    ["page:#3", { kind: "pageIndex", index: 3 }],
    ["spread:ud1", { kind: "spread", id: "ud1" }],
    ["layer:ub3", { kind: "layer", id: "ub3" }],
    ["master:A", { kind: "master", id: "A" }],
    ["story:u1a", { kind: "story", id: "u1a" }],
    ["storyRange:u1a@0..6", { kind: "storyRange", story: "u1a", start: 0, end: 6 }],
    ["field:u1a@4", { kind: "field", story: "u1a", offset: 4 }],
    ["table:t7", { kind: "table", id: "t7" }],
    ["cell:t7/1,2", { kind: "cell", table: "t7", row: 1, col: 2 }],
    ["style:paragraph/ParagraphStyle/Body Text", { kind: "style", family: "paragraph", name: "ParagraphStyle/Body Text" }],
    ["swatch:Color/Red", { kind: "swatch", name: "Color/Red" }],
    ["gradient:Gradient/u9", { kind: "gradient", name: "Gradient/u9" }],
    ["colorGroup:Brand", { kind: "colorGroup", name: "Brand" }],
    ["numberingList:List/u2", { kind: "numberingList", name: "List/u2" }],
    ["guide:g1", { kind: "guide", id: "g1" }],
    ["condition:Condition/Print", { kind: "condition", name: "Condition/Print" }],
    ["conditionSet:Set 1", { kind: "conditionSet", name: "Set 1" }],
    ["section:s1", { kind: "section", id: "s1" }],
    ["hyperlink:h1", { kind: "hyperlink", id: "h1" }],
    ["textVariable:dTextVariablenPrice", { kind: "textVariable", id: "dTextVariablenPrice" }],
    ["story:Story/u1", { kind: "story", id: "Story/u1" }],
    ["storyRange:Story/u1@3..9", { kind: "storyRange", story: "Story/u1", start: 3, end: 9 }],
    ["layer:Layer/u0", { kind: "layer", id: "Layer/u0" }],
    [
      "master:A > textFrame:u5",
      { kind: "onMaster", master: "A", item: { kind: "item", itemKind: "textFrame", id: "u5" } },
    ],
    [
      "plugin:media.paged.image/layer/7",
      { kind: "plugin", plugin: "media.paged.image", objectKind: "layer", id: "7" },
    ],
    [
      "plugin:paged.sheet/cell/Sheet1!B4",
      { kind: "plugin", plugin: "paged.sheet", objectKind: "cell", id: "Sheet1!B4" },
    ],
    [
      "plugin:acme.x/note/a/b c",
      { kind: "plugin", plugin: "acme.x", objectKind: "note", id: "a/b c" },
    ],
    ["$h:f", { kind: "handle", name: "f" }],
  ];
  for (const [text, parsed] of table) {
    it(`${text}`, () => {
      expect(parseAddress(text)).toEqual(parsed);
      expect(formatAddress(parsed)).toBe(text);
    });
  }
});

describe("parseAddress — aliases parse, never emit", () => {
  const aliases: Array<[string, string]> = [
    ["frame:u1", "frame:u1"], // kind-agnostic: stays frame until resolved
    ["textframe:u1", "textFrame:u1"],
    ["rect:u1", "rectangle:u1"],
    ["graphicline:u1", "graphicLine:u1"],
    ["storyrange:u1@0..2", "storyRange:u1@0..2"],
    ["story:u1@0..2", "storyRange:u1@0..2"],
    ["textvariable:v1", "textVariable:v1"],
  ];
  for (const [alias, canonical] of aliases) {
    it(`${alias} → ${canonical}`, () => {
      const p = parseAddress(alias);
      expect(p).not.toBeNull();
      expect(formatAddress(p!)).toBe(canonical);
    });
  }
  it("frame: is the one alias with its own parsed kind", () => {
    expect(parseAddress("frame:u1")).toEqual({ kind: "frame", id: "u1" });
  });
});

describe("parseAddress — refusals", () => {
  for (const bad of [
    "",
    "nope",
    "doc:x",
    "textFrame:",
    "page:#0",
    "page:#x",
    "storyRange:u1@5..5",
    "storyRange:u1@6..2",
    "storyRange:u1@a..b",
    "cell:t7/1",
    "cell:t7/a,b",
    "style:bogus/Body",
    "style:paragraph/",
    "plugin:acme",
    "plugin:acme/kind",
    "plugin:acme/kind/",
    "plugin:/kind/1",
    "$h:",
    "storyRange:u1",
    "field:@3",
    "master: > textFrame:u1",
    "master:A > swatch:Red",
  ]) {
    it(JSON.stringify(bad), () => expect(parseAddress(bad)).toBeNull());
  }
});

describe("ids percent-escape only where they must stop at a delimiter (core protocol 71)", () => {
  it("a plain id runs to the end and is never escaped", () => {
    const p: ParsedAddress = { kind: "item", itemKind: "rectangle", id: "a/b@c[d]%" };
    expect(formatAddress(p)).toBe("rectangle:a/b@c[d]%");
    expect(parseAddress("rectangle:a/b@c[d]%")).toEqual(p);
  });
  it("escapes the delimiter that would end the id, and % itself, only there", () => {
    expect(formatAddress({ kind: "storyRange", story: "odd@id%", start: 1, end: 2 })).toBe("storyRange:odd%40id%25@1..2");
    expect(formatAddress({ kind: "cell", table: "t/1", row: 0, col: 0 })).toBe("cell:t%2F1/0,0");
    expect(parseAddress("cell:t%2F1/0,0")).toEqual({ kind: "cell", table: "t/1", row: 0, col: 0 });
  });
  it("rest forms carry slashes and spaces raw", () => {
    expect(formatAddress({ kind: "swatch", name: "Color/My Red" })).toBe("swatch:Color/My Red");
  });
  it("core's corpus: every idGrammar example of the vendored catalog parses and formats back byte-identically", () => {
    const catalog = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../plugin-api/src/catalog.json", import.meta.url)), "utf8"),
    ) as { idGrammar: { form: string; example: string }[] };
    expect(catalog.idGrammar.length).toBeGreaterThan(25);
    for (const g of catalog.idGrammar) {
      const p = parseAddress(g.example);
      expect(p, g.example).not.toBeNull();
      // `frame:` is core's kind-agnostic form: canonical in core, kept as is.
      expect(formatAddress(p!), g.example).toBe(g.example);
    }
  });
});

// ------------------------------------------------------------ property laws

const idChar = fc.constantFrom(..."abcuXYZ019_-.~!$&'()*+,;=/@:[]% ü€".split(""));
const id = fc.string({ unit: idChar, minLength: 1, maxLength: 12 });
/** A plain id that stays one kind on re-parse: not `#n` (a page number),
 *  no `@` (a story range), no ` > ` (a master scope). */
const plainId = id.filter((s) => !s.startsWith("#") && !s.includes("@") && !s.includes(" > "));
const rest = fc
  .string({ unit: fc.constantFrom(..."abc XYZ/09-_.!äé".split("")), minLength: 1, maxLength: 16 })
  .filter((s) => s.trim() === s && !s.includes(" > "));
const uint = fc.nat({ max: 100000 });
const itemKind = fc.constantFrom("textFrame", "rectangle", "oval", "polygon", "graphicLine", "group" as const);
const pluginId = fc.stringMatching(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,3}$/);
const kindName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,8}$/);

const itemAddr = fc.record({ kind: fc.constant("item" as const), itemKind, id: plainId });
const parsedArb: fc.Arbitrary<ParsedAddress> = fc.oneof(
  fc.constant({ kind: "doc" as const }),
  itemAddr,
  fc.record({ kind: fc.constantFrom("page", "spread", "layer", "master", "story", "table", "guide", "section", "hyperlink", "textVariable" as const), id: plainId }) as fc.Arbitrary<ParsedAddress>,
  fc.record({ kind: fc.constant("pageIndex" as const), index: fc.integer({ min: 1, max: 9999 }) }),
  fc
    .record({ story: id, start: uint, len: fc.integer({ min: 1, max: 1000 }) })
    .map(({ story, start, len }) => ({ kind: "storyRange" as const, story, start, end: start + len })),
  fc.record({ kind: fc.constant("field" as const), story: id, offset: uint }),
  fc.record({ kind: fc.constant("cell" as const), table: id, row: uint, col: uint }),
  fc.record({
    kind: fc.constant("style" as const),
    family: fc.constantFrom("paragraph", "character", "object", "cell", "table" as const),
    name: rest,
  }),
  fc.record({
    kind: fc.constantFrom("swatch", "gradient", "colorGroup", "numberingList", "condition", "conditionSet" as const),
    name: rest,
  }) as fc.Arbitrary<ParsedAddress>,
  fc.record({ kind: fc.constant("onMaster" as const), master: id, item: itemAddr }),
  fc.record({ kind: fc.constant("plugin" as const), plugin: pluginId, objectKind: kindName, id: rest }),
  fc.record({ kind: fc.constant("handle" as const), name: fc.stringMatching(/^[A-Za-z0-9_]{1,8}$/) }),
);

describe("round-trip laws (fast-check)", () => {
  it("parse(format(a)) = a", () => {
    fc.assert(
      fc.property(parsedArb, (a) => {
        expect(parseAddress(formatAddress(a))).toEqual(a);
      }),
      { numRuns: 2000 },
    );
  });
  it("format(parse(s)) = s for every canonical string", () => {
    fc.assert(
      fc.property(parsedArb, (a) => {
        const s = formatAddress(a);
        expect(formatAddress(parseAddress(s)!)).toBe(s);
      }),
      { numRuns: 2000 },
    );
  });
  it("arbitrary strings never throw", () => {
    fc.assert(fc.property(fc.string(), (s) => void parseAddress(s)), { numRuns: 2000 });
  });
});

describe("ElementId seam (today's wire)", () => {
  it("maps item, story range and back", () => {
    expect(toElementId({ kind: "item", itemKind: "oval", id: "u3" })).toEqual({ kind: "oval", id: "u3" });
    expect(toElementId({ kind: "storyRange", story: "u1", start: 0, end: 4 })).toEqual({
      kind: "storyRange",
      id: { story_id: "u1", start: 0, end: 4 },
    });
    expect(toElementId({ kind: "swatch", name: "Color/Red" })).toBeNull();
    expect(fromElementId({ kind: "group", id: "u9" })).toBe("group:u9");
    expect(fromElementId({ kind: "tableCell", id: { story_id: "s", table_id: "t", row: 1, col: 2 } })).toBe("cell:t/1,2");
  });
});

describe("parseSelector (ADR 131)", () => {
  it("kind + predicates", () => {
    expect(parseSelector('frame[name="price"]')).toEqual({
      steps: [{ head: { type: "kind", kind: "frame" }, predicates: [{ key: "name", op: "=", value: "price" }] }],
    });
  });
  it("child combinator with an address step", () => {
    const sel = parseSelector("page:#3 > frame");
    expect(sel?.steps).toHaveLength(2);
    expect(sel?.steps[0]!.head).toEqual({ type: "address", address: { kind: "pageIndex", index: 3 } });
    expect(sel?.steps[1]!.combinator).toBe("child");
  });
  it("descendant combinator, label key, ops, nth", () => {
    const sel = parseSelector('spread:s1 textFrame[label.x-paged:oid="a1b2"][name^=Pri]:nth(2)');
    expect(sel?.steps[1]).toEqual({
      combinator: "descendant",
      head: { type: "kind", kind: "textFrame" },
      predicates: [
        { key: "label.x-paged:oid", op: "=", value: "a1b2" },
        { key: "name", op: "^=", value: "Pri" },
      ],
      nth: 2,
    });
  });
  it("plugin kind step", () => {
    expect(parseSelector('plugin:media.paged.image/layer[name="Logo"]')?.steps[0]).toEqual({
      head: { type: "kind", kind: "plugin:media.paged.image/layer" },
      predicates: [{ key: "name", op: "=", value: "Logo" }],
    });
  });
  it("* and bad selectors", () => {
    expect(parseSelector("*")?.steps[0]!.head).toEqual({ type: "any" });
    expect(parseSelector("frame[name")).toBeNull();
    expect(parseSelector("")).toBeNull();
    expect(parseSelector("bogus")).toBeNull();
  });
});
