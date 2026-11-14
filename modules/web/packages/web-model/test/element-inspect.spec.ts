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

// Web ADR 416 — the inspector's source side: where an element is, which
// rules apply to it, and what a printed page cannot show.

import { describe, expect, it } from "bun:test";

import {
  cssRules,
  elementInfo,
  placeholderNames,
  printNotes,
  rulesFor,
  selectorMatches,
} from "../src/element-inspect";
import { tagOutline } from "../src/outline";

const HTML = [
  '<div class="card wide" id="main">',
  "  <h1>Title</h1>",
  '  <p class="lead">One <b>two</b></p>',
  '  <img src="a.png">',
  "  <p>Three</p>",
  "</div>",
].join("\n");

describe("elementInfo", () => {
  it("names an element by line, open tag and its ancestors", () => {
    const outline = tagOutline(HTML);
    const b = outline.findIndex((e) => e.tag === "b");
    const info = elementInfo(HTML, b, outline)!;
    expect(info.line).toBe(3);
    expect(info.openTag).toBe("<b>");
    expect(info.selector).toBe("div#main.card.wide > p.lead > b");
    // A void element closes nothing: the second <p> is the div's child.
    const p2 = outline.map((e) => e.tag).lastIndexOf("p");
    expect(elementInfo(HTML, p2, outline)!.selector).toBe(
      "div#main.card.wide > p",
    );
    expect(elementInfo(HTML, 99, outline)).toBeNull();
    // Never throws on bad input.
    expect(elementInfo("<div><p", 0)).not.toBeUndefined();
  });
});

describe("cssRules and rulesFor", () => {
  const CSS = [
    "/* the card */",
    ".card { padding: 4pt }",
    "p { margin: 0 }",
    "div > p.lead, h1 { font-size: 14pt }",
    "@media print { #main p { color: black } }",
    "@font-face { font-family: X; src: url(x.woff2) }",
    "p:first-child { color: red }",
    "section p { color: blue }",
  ].join("\n");

  it("reads rules with their lines, flattening @media and skipping other at-rules", () => {
    const rules = cssRules(CSS);
    expect(rules.map((r) => r.selector)).toEqual([
      ".card",
      "p",
      "div > p.lead, h1",
      "#main p",
      "p:first-child",
      "section p",
    ]);
    expect(rules[0].line).toBe(2);
    expect(rules[3].media).toBe("print");
  });

  it("lists the rules that apply, and the ones it cannot evaluate", () => {
    const outline = tagOutline(HTML);
    const lead = outline.findIndex((e) => e.tag === "p");
    const path = elementInfo(HTML, lead, outline)!.path;
    const got = rulesFor(CSS, path).map((m) => [m.rule.selector, m.status]);
    expect(got).toEqual([
      ["p", "matched"],
      ["div > p.lead, h1", "matched"],
      ["#main p", "matched"],
      ["p:first-child", "unevaluated"],
    ]);
  });

  it("matches compound selectors with descendant and child combinators", () => {
    const path = [
      { tag: "div", id: "main", classes: ["card"] },
      { tag: "section", id: null, classes: [] },
      { tag: "p", id: null, classes: ["lead"] },
    ];
    expect(selectorMatches("div p", path)).toBe(true);
    expect(selectorMatches("div > p", path)).toBe(false);
    expect(selectorMatches("#main .lead", path)).toBe(true);
    expect(selectorMatches("p.lead.other", path)).toBe(false);
    expect(selectorMatches("*", path)).toBe(true);
    expect(selectorMatches("p[lang]", path)).toBeNull();
    expect(selectorMatches("h1 + p", path)).toBeNull();
  });
});

describe("printNotes", () => {
  it("names motion, interaction states, fixed positioning and pointer styling, with lines", () => {
    const notes = printNotes(
      [
        "a:hover { color: red }",
        ".x { transition: color 1s; cursor: pointer }",
        "@keyframes spin { to { transform: rotate(1turn) } }",
        ".bar { position: sticky; top: 0 }",
        "/* animation: none */ .y { animation: spin 2s }",
      ].join("\n"),
    );
    expect(notes.map((n) => [n.code, n.line])).toEqual([
      ["interaction", 1],
      ["transition", 2],
      ["pointer", 2],
      ["animation", 3],
      ["fixedPosition", 4],
      ["animation", 5],
    ]);
    expect(printNotes("p { color: red }")).toEqual([]);
  });
});

describe("placeholderNames", () => {
  it("the names the placeholders use, first use first, each once", () => {
    expect(
      placeholderNames(
        "<h1>{{ title | upper }}</h1><p>{{body}}</p><i>{{title}}</i>{{ 9bad }}",
      ),
    ).toEqual(["title", "body"]);
    expect(placeholderNames("")).toEqual([]);
  });
});
