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

// Guided export (editor ADR 1221), against the real engine: the readiness
// check the PDF dialog runs before it starts says exactly what the engine's
// exporter would answer. A document with no output intent cannot be
// PDF/X-4: the check refuses it, and the exporter refuses it too, at begin,
// with no PDF written (UXI-FIL-004, ADR 238). PDF 1.7 passes the check and
// the exporter writes a PDF (`%PDF-`), changing nothing in the document.

import { afterEach, describe, expect, test } from "bun:test";

import { pdfReadiness, printOutputFacts } from "@paged-media/shell";

import { createHeadlessEditor, type HeadlessEditor } from "./harness";

let ed: HeadlessEditor | null = null;
afterEach(async () => {
  await ed?.dispose();
  ed = null;
});

const plan = (standard: "pdfx4" | "pdf17") => ({
  standard,
  outputIntentProfile: "",
  colorPolicy: "preserveNumbers" as const,
  pageScope: "all" as const,
  pageFrom: "1",
  pageTo: "1",
  useDocumentBleed: true,
  bleedPt: "0",
  downsample: "off" as const,
});

describe("UXI-T68 — the readiness check agrees with the engine's exporter", () => {
  test("UXI-T68 — PDF/X-4 with no output intent: blocked before the start, refused by the engine at begin, nothing written @feat:the-renderer.pdf-export @level:edge", async () => {
    ed = await createHeadlessEditor({ blank: [612, 792] });
    const meta = await ed.client.documentMeta();
    const facts = {
      loaded: true,
      pageCount: meta.pageCount,
      currentPage: 0,
      print: printOutputFacts(meta),
      pages: null,
      fonts: null,
      links: null,
      oversetStories: null,
      documentName: meta.documentName,
    };
    const checks = pdfReadiness(plan("pdfx4"), facts);
    expect(checks.find((c) => c.id === "standard")?.level).toBe("blocker");
    const before = await ed.dump();
    let refused: string | null = null;
    await ed.client.beginPdfExport({ standard: "pdfx4" }).then(
      () => {
        refused = null;
      },
      (err: unknown) => {
        refused = err instanceof Error ? err.message : String(err);
      },
    );
    expect(refused).toContain("output intent");
    expect(await ed.dump()).toEqual(before);

    // The standard the document can meet passes the check and is written.
    expect(
      pdfReadiness(plan("pdf17"), facts).some((c) => c.level === "blocker"),
    ).toBe(false);
    const { bytes } = await ed.client.exportPdf({ standard: "pdf17" });
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    expect(await ed.dump()).toEqual(before);
  });
});
