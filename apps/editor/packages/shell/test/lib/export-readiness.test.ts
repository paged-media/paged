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

// The guided export's readiness check and preview facts (editor ADR 1221;
// UXI-FIL-004): blockers refuse with a reason, warnings are said, the
// facts are what the exporter does.

import { describe, expect, test } from "bun:test";

import {
  customBleedPt,
  exportAllowed,
  pageSpan,
  pdfPreviewFacts,
  pdfReadiness,
  type PdfDocumentFacts,
  type PdfExportPlan,
} from "../../src/lib/export-readiness";
import { printOutputFacts } from "../../src/lib/print-output";

const plan: PdfExportPlan = {
  standard: "pdf17",
  outputIntentProfile: "",
  colorPolicy: "preserveNumbers",
  pageScope: "all",
  pageFrom: "1",
  pageTo: "1",
  useDocumentBleed: true,
  bleedPt: "0",
  downsample: "off",
};

const doc: PdfDocumentFacts = {
  loaded: true,
  pageCount: 3,
  currentPage: 1,
  print: printOutputFacts({ cmykProfileName: null, cmykProfileActive: false }),
  pages: [
    {
      sizePt: [595.28, 841.89],
      bleedTopPt: 8.5,
      bleedLeftPt: 8.5,
      bleedBottomPt: 8.5,
      bleedRightPt: 8.5,
    },
    { sizePt: [595.28, 841.89] },
    { sizePt: [595.28, 841.89] },
  ],
  fonts: [{ family: "Plex" }, { family: "Gone", isMissing: true }],
  links: [
    { status: "missing" },
    { status: "ok", effectivePpi: 96 },
    { status: "ok", effectivePpi: 300 },
  ],
  oversetStories: 2,
  documentName: "Annual",
};

const levels = (p: PdfExportPlan, d: PdfDocumentFacts) =>
  pdfReadiness(p, d).map((c) => `${c.level}:${c.id}`);

describe("the readiness check (UXI-FIL-004)", () => {
  test("PDF/X-4 without an output intent is refused with its reason and its fix (ADR 238)", () => {
    const checks = pdfReadiness({ ...plan, standard: "pdfx4" }, doc);
    expect(checks[0]).toEqual({
      id: "standard",
      level: "blocker",
      text: "PDF/X-4 needs an output intent profile and this document has none: load one in Color settings, or export PDF 1.7.",
      fix: { label: "Color settings", panel: "paged.color-settings" },
    });
    expect(exportAllowed(checks)).toBe(false);
  });

  test("an output intent makes PDF/X-4 possible: a registered profile or an active working space", () => {
    expect(
      exportAllowed(
        pdfReadiness(
          { ...plan, standard: "pdfx4", outputIntentProfile: "FOGRA39" },
          doc,
        ),
      ),
    ).toBe(true);
    const active = {
      ...doc,
      print: printOutputFacts({
        cmykProfileName: "FOGRA39",
        cmykProfileActive: true,
      }),
    };
    expect(
      pdfReadiness({ ...plan, standard: "pdfx4" }, active).find(
        (c) => c.id === "standard",
      ),
    ).toMatchObject({
      level: "ok",
      text: "PDF/X-4 embeds FOGRA39 as its output intent.",
    });
  });

  test("warnings are said, blockers first, and the export may go ahead", () => {
    expect(levels(plan, doc)).toEqual([
      "warning:fonts",
      "warning:links",
      "warning:resolution",
      "warning:overset",
      "ok:standard",
    ]);
    expect(exportAllowed(pdfReadiness(plan, doc))).toBe(true);
    expect(pdfReadiness(plan, doc).map((c) => c.fix?.panel)).toEqual([
      "paged.fonts",
      "paged.links",
      "paged.links",
      "paged.stories",
      undefined,
    ]);
  });

  test("a range outside the document and a custom bleed that is no length block", () => {
    const bad = {
      ...plan,
      pageScope: "range" as const,
      pageFrom: "2",
      pageTo: "9",
    };
    expect(levels(bad, doc)[0]).toBe("blocker:range");
    expect(pageSpan({ ...bad, pageTo: "3" }, 3, 0)).toEqual({ from: 1, to: 2 });
    expect(pageSpan({ ...plan, pageScope: "current" }, 3, 1)).toEqual({
      from: 1,
      to: 1,
    });
    expect(customBleedPt({ bleedPt: "-1" })).toBeNull();
    expect(customBleedPt({ bleedPt: "9" })).toBe(9);
    expect(
      levels({ ...plan, useDocumentBleed: false, bleedPt: "abc" }, doc)[0],
    ).toBe("blocker:bleed");
  });

  test("no document: one blocker", () => {
    expect(levels(plan, { ...doc, loaded: false })).toEqual([
      "blocker:document",
    ]);
  });
});

describe("the preview facts", () => {
  test("what the file will be, as the exporter makes it", () => {
    const facts = Object.fromEntries(
      pdfPreviewFacts({ ...plan, downsample: "150" }, doc).map((f) => [
        f.id,
        f.value,
      ]),
    );
    expect(facts).toEqual({
      pages: "all 3 pages",
      size: "595.3 × 841.9 pt (210 × 297 mm)",
      bleed: "8.5 pt on every side",
      color: "PDF 1.7 · no output intent · colour numbers kept",
      fonts: "2 families embedded as subsets · 1 substituted",
      transparency: "Kept live, not flattened",
      images: "Downsampled to 150 ppi where finer",
      destination: "Download: Annual.pdf",
    });
  });

  test("the page in view, a custom bleed, PDF/X-4 with its intent", () => {
    const facts = Object.fromEntries(
      pdfPreviewFacts(
        {
          ...plan,
          standard: "pdfx4",
          outputIntentProfile: "FOGRA39",
          pageScope: "current",
          useDocumentBleed: false,
          bleedPt: "3",
          colorPolicy: "convertToDestination",
        },
        doc,
      ).map((f) => [f.id, f.value]),
    );
    expect(facts.pages).toBe("page 2");
    expect(facts.bleed).toBe("3 pt on every side");
    expect(facts.color).toBe(
      "PDF/X-4 · output intent FOGRA39 · converted to the output intent",
    );
  });
});
