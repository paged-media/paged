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

// The command palette's ranking: by what a command is CALLED (title,
// then category, then id), word starts only, no scattered-letter match.

import { describe, expect, test } from "bun:test";

import { paletteScore } from "../../src/chrome/palette-score";

const rank = (
  search: string,
  commands: Array<[id: string, title: string, category: string]>,
) =>
  commands
    .map(([id, title, category]) => ({
      id,
      score: paletteScore(id, search, [title, category]),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((c) => c.id);

const COMMANDS: Array<[string, string, string]> = [
  ["paged.file.exportPdf", "Export PDF…", "File"],
  ["media.paged.draw.command.blendExpand", "Blend: Expand", "Draw"],
  ["paged.view.zoomIn", "Zoom in", "View"],
  ["paged.view.zoomOut", "Zoom out", "View"],
  ["paged.view.zoomFit", "Fit document", "View"],
  ["paged.object.bringToFront", "Bring to front", "Object"],
  ["paged.panel.show.paged.layers", "Show Layers", "Window"],
];

describe("paletteScore", () => {
  test("an empty query keeps everything at full score", () => {
    expect(paletteScore("x", "", ["X", "Y"])).toBe(1);
    expect(paletteScore("x", "   ", ["X", "Y"])).toBe(1);
  });

  test("'export' finds Export PDF, not Blend: Expand by scattered letters", () => {
    expect(rank("export", COMMANDS)).toEqual(["paged.file.exportPdf"]);
  });

  test("every query word must match: 'zoom out' is Zoom out alone", () => {
    expect(rank("zoom out", COMMANDS)).toEqual(["paged.view.zoomOut"]);
    // "zoom" opens two titles and is a word of Fit document's id: the
    // id match ranks last.
    expect(rank("zoom", COMMANDS)).toEqual([
      "paged.view.zoomIn",
      "paged.view.zoomOut",
      "paged.view.zoomFit",
    ]);
  });

  test("title beats category beats id", () => {
    const title = paletteScore("a.b", "fit", ["Fit document", "View"]);
    const category = paletteScore("a.b", "view", ["Fit document", "View"]);
    const id = paletteScore("paged.view.zoomFit", "zoom", [
      "Fit document",
      "Something",
    ]);
    expect(title).toBeGreaterThan(category);
    expect(category).toBeGreaterThan(id);
    expect(id).toBeGreaterThan(0);
  });

  test("a prefix of a title word counts; a 3+ letter substring of the title counts less", () => {
    const prefix = paletteScore("x", "lay", ["Show Layers", "Window"]);
    const inside = paletteScore("x", "ayer", ["Show Layers", "Window"]);
    expect(prefix).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(0);
    // Two letters inside a word are not enough.
    expect(paletteScore("x", "ay", ["Show Layers", "Window"])).toBe(0);
  });

  test("camelCase and dots split the id into words", () => {
    expect(
      paletteScore("paged.object.bringToFront", "front", ["", ""]),
    ).toBeGreaterThan(0);
    expect(paletteScore("paged.object.bringToFront", "ont", ["", ""])).toBe(0);
  });

  test("the whole query opening the title is a bonus", () => {
    const opens = paletteScore("x", "bring", ["Bring to front", "Object"]);
    const later = paletteScore("x", "front", ["Bring to front", "Object"]);
    expect(opens).toBeGreaterThan(later);
  });

  test("among titles the query does not open, the shorter one edges ahead", () => {
    const short = paletteScore("x", "page", ["Insert page", "Layout"]);
    const long = paletteScore("x", "page", [
      "Delete the current page",
      "Layout",
    ]);
    expect(short).toBeGreaterThan(long);
  });

  // Finding SH-7 (polish): the opening bonus pushes both scores past the
  // cap of 1, so two titles that both open with the query tie and the
  // "fewer words edge ahead" rule the scorer documents is lost; cmdk
  // then keeps registration order.
  test.failing(
    "SH-7: a shorter title that opens with the query still edges ahead",
    () => {
      const short = paletteScore("x", "zoom", ["Zoom", "View"]);
      const long = paletteScore("x", "zoom", [
        "Zoom to the page width",
        "View",
      ]);
      expect(short).toBeGreaterThan(long);
    },
  );

  test("scores stay inside (0, 1]", () => {
    for (const [id, title, category] of COMMANDS) {
      for (const q of ["e", "export pdf", "zoom", "show layers window"]) {
        const s = paletteScore(id, q, [title, category]);
        expect(s >= 0 && s <= 1).toBe(true);
      }
    }
  });
});
