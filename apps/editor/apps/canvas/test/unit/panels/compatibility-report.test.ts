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

// The compatibility report's model (editor ADR 1222, UXI-FIL-002): codes
// read into areas, the summary line after an import, the round-trip risk,
// and the bundles' loss rows on the diagnostics channel read as reports.

import { describe, expect, test } from "bun:test";

import type { LossEntry } from "@paged-media/plugin-api";

import {
  areaOf,
  explainLoss,
  operationOfKey,
  roundTripRisk,
  sortLosses,
  summarizeLosses,
  summaryLine,
  type CompatReport,
} from "../../../src/panels/compatibility-report";
import { reportsFromProblems } from "../../../src/panels/compatibility-report-store";

const FONT: LossEntry = {
  code: "pptx.font.embedded",
  count: 2,
  severity: "approximated",
  message: "Gill Sans drawn in a substitute",
};
const EFFECT: LossEntry = {
  code: "dml.3d.camera",
  count: 1,
  severity: "dropped",
};
const CONVERTED: LossEntry = {
  code: "idml.gradient.conic",
  count: 3,
  severity: "approximated",
  pages: [2],
  items: ["u1a3"],
};
const NOTE: LossEntry = {
  code: "idml.liveShape.pie",
  count: 1,
  severity: "info",
};

describe("areas", () => {
  test("every producer's vocabulary reads into an area", () => {
    expect(areaOf(FONT)).toBe("fonts");
    expect(areaOf(EFFECT)).toBe("effects");
    expect(areaOf({ code: "filter", count: 1 })).toBe("effects");
    expect(areaOf({ code: "Drop Shadow", count: 1 })).toBe("effects");
    expect(areaOf(CONVERTED)).toBe("paint");
    expect(areaOf({ code: "shading.sampled", count: 1 })).toBe("paint");
    expect(areaOf({ code: "idml.image.link", count: 1 })).toBe("pictures");
    expect(areaOf({ code: "idml.story.text", count: 1 })).toBe("text");
    expect(areaOf({ code: "pptx.shape.unknown", count: 1 })).toBe("structure");
    expect(areaOf({ code: "xyz", count: 1 })).toBe("other");
  });

  test("a legacy or tier code reads its area from the message", () => {
    expect(
      areaOf({ code: "docx.tier3", count: 1, message: "a table cell style" }),
    ).toBe("text");
  });

  test("the producer's sentence explains; an unworded code gets the area's", () => {
    expect(explainLoss(FONT)).toBe("Gill Sans drawn in a substitute");
    expect(explainLoss(EFFECT)).toBe(
      "Something in the effects of the file could not be carried and was left out.",
    );
  });
});

describe("the summary after an import (strategy §6.4)", () => {
  test("font substitutions, unsupported effects, converted objects", () => {
    const report: CompatReport = {
      id: "r",
      direction: "import",
      format: "pptx",
      name: "deck.pptx",
      at: 0,
      losses: [FONT, EFFECT, CONVERTED, NOTE],
      source: "media.paged.slide",
    };
    expect(summarizeLosses(report.losses)).toEqual({
      fontSubstitutions: 2,
      unsupportedEffects: 1,
      convertedObjects: 3,
      leftOut: 0,
      notes: 1,
      total: 7,
    });
    expect(summaryLine(report)).toBe(
      "Imported deck.pptx · 2 font substitutions · 1 unsupported effect · 3 converted objects · 1 note",
    );
    expect(summaryLine({ ...report, losses: [] })).toBe(
      "Imported deck.pptx · nothing was lost",
    );
  });

  test("left out first, then converted, then notes", () => {
    expect(sortLosses([NOTE, CONVERTED, EFFECT]).map((l) => l.code)).toEqual([
      EFFECT.code,
      CONVERTED.code,
      NOTE.code,
    ]);
  });

  test("each format states its round-trip risk", () => {
    expect(roundTripRisk("idml")).toContain("InDesign");
    expect(roundTripRisk("pdf")).toContain("never edits the original");
    expect(roundTripRisk("dxf")).toContain("DXF");
  });
});

describe("the bundles' loss rows are reports", () => {
  test("one report per bundle key, with direction and format", () => {
    const reports = reportsFromProblems(
      [
        {
          bundleId: "media.paged.slide",
          key: "media.paged.slide/import",
          severity: "warning",
          message: "x",
          loss: FONT,
        },
        {
          bundleId: "media.paged.slide",
          key: "media.paged.slide/import",
          severity: "warning",
          message: "y",
          loss: EFFECT,
        },
        {
          bundleId: "media.paged.slide",
          key: "media.paged.slide/export",
          severity: "warning",
          message: "z",
          loss: NOTE,
        },
        // A row without a loss is no part of a report.
        {
          bundleId: "media.paged.doc",
          key: "media.paged.doc/open",
          severity: "warning",
          message: "w",
        },
      ],
      5,
    );
    expect(
      reports.map((r) => [r.id, r.direction, r.format, r.losses.length]),
    ).toEqual([
      ["media.paged.slide|media.paged.slide/import", "import", "pptx", 2],
      ["media.paged.slide|media.paged.slide/export", "export", "pptx", 1],
    ]);
    expect(
      operationOfKey("media.paged.pdf", "media.paged.pdf.vectors"),
    ).toEqual({ direction: "import", format: "pdf" });
  });
});
