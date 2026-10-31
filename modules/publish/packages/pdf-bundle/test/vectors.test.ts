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

// Place as vectors (publish ADR 658), the pure halves: the loss report's
// words, the placement of a placed PDF's page box, a font name read as a
// family and style, and the mapper's refusals.

import { describe, expect, it } from "bun:test";

import { splitFontName } from "../src/pdfium";
import { refusalOf } from "../src/vectors/ir";
import { WORDED_LOSS_CODES, lossLines } from "../src/vectors/losses";
import { frameOutline, placedPdfPlacement } from "../src/vectors/place";

/** Every loss code the Rust side can emit (`vectors/` and `lower.rs`). */
const MAPPER_CODES = [
  "shading.function_sampled",
  "shading.mesh_sampled",
  "shading.focal_sampled",
  "shading.skewed_sampled",
  "shading.degenerate",
  "shading.no_extend",
  "pattern.tiling_expanded",
  "pattern.tiling_flattened",
  "pattern.too_deep",
  "stroke.nonuniform",
  "stroke.pattern",
  "stroke.gradient",
  "stroke.hairline",
  "stroke.dash_phase",
  "gradient.nonuniform",
  "text.invisible",
  "text.stroked",
  "text.type3_as_paths",
  "text.pattern_fill",
  "text.unmatched_outlined",
  "text.rotated_outlined",
  "text.missing_font_outlined",
  "text.missing_font",
  "text.nonuniform_scale",
  "mask.too_deep",
  "mask.backdrop",
  "mask.transfer",
  "mask.complex_dropped",
  "mask.text_target",
  "mask.per_item",
  "mask.nested_dropped",
  "image.stencil_pattern",
  "image.undecodable",
];

describe("[editor-shell.import-svg-pdf-vectors] the loss report", () => {
  it("words every code the mapper emits", () => {
    expect([...WORDED_LOSS_CODES].sort()).toEqual([...MAPPER_CODES].sort());
  });

  it("counts, adds the shared facts, and keeps an unknown code", () => {
    const lines = lossLines(
      [
        { code: "shading.focal_sampled", count: 2 },
        { code: "something.new", count: 1 },
      ],
      {
        format: "ai",
        pages: [],
        ai: { pdf_compatible: true, has_private_data: true },
      },
      ["Minion Pro"],
    );
    expect(lines.map((l) => l.code)).toEqual([
      "shading.focal_sampled",
      "something.new",
      "colours",
      "aiPrivate",
      "outlinedFonts",
    ]);
    expect(lines[0]!.message).toContain("2 radial gradients");
    expect(lines[1]!.message).toContain("something.new");
    expect(lines[4]!.message).toContain("Minion Pro");
  });
});

describe("[editor-shell.import-svg-pdf-vectors] a placed PDF's page box on the page", () => {
  it("composes the frame's and the image's transforms, page origin off", () => {
    const m = placedPdfPlacement(
      [0, 0, 100, 200],
      [1, 0, 0, 1, 50, 70],
      [0.5, 0, 0, 0.5, 10, 20],
      [400, 200],
      [30, 40],
    );
    // A page-box point (100, 100) → image (60, 70) → spread (110, 140) →
    // page (80, 100).
    expect(m).toEqual([0.5, 0, 0, 0.5, 30, 50]);
  });

  it("stretches the box over the frame without an image transform", () => {
    const m = placedPdfPlacement(
      [10, 20, 110, 220],
      null,
      null,
      [400, 200],
      [0, 0],
    );
    expect(m).toEqual([0.5, 0, 0, 0.5, 20, 10]);
    expect(
      placedPdfPlacement([0, 0, 1, 1], null, null, [0, 0], [0, 0]),
    ).toBeNull();
  });

  it("outlines the frame on the page", () => {
    expect(frameOutline([0, 0, 10, 20], [1, 0, 0, 1, 5, 5], [5, 0])).toEqual([
      [0, 5],
      [20, 5],
      [20, 15],
      [0, 15],
    ]);
  });
});

describe("[editor-shell.import-svg-pdf-vectors] font names and refusals", () => {
  it("reads a PostScript name as family and style", () => {
    expect(splitFontName("ABCDEF+Helvetica-BoldOblique")).toEqual({
      family: "Helvetica",
      bold: true,
      italic: true,
    });
    expect(splitFontName("ArialMT")).toEqual({
      family: "Arial",
      bold: false,
      italic: false,
    });
    expect(splitFontName("TimesNewRomanPS-ItalicMT").italic).toBe(true);
  });

  it("splits a mapper error into code and message", () => {
    expect(refusalOf(new Error("aiWithoutPdf: no PDF"))).toEqual({
      code: "aiWithoutPdf",
      message: "no PDF",
    });
    expect(refusalOf("garbled").code).toBe("unreadable");
  });
});
