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

// paged.sheet's file handlers: the .xlsx and .csv/.tsv IMPORTERS and the
// .xlsx EXPORTER, driven through the contributions the real bundle
// registers (what the editor's File ▸ Open, drag-drop and Export Center
// call). Fixtures are built in code: the xlsx bytes by the real sheet
// engine (perf/workload.ts `authorWorkbook`), the CSV as text.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import { covers } from "@paged-media/test-kit";

import { P, unitEnv, value, type SheetEnv } from "./conformance/env";
import { PANEL, cell, column, openBook } from "./conformance/scenarios";
import { ENGINE_BUILT, WASM, authorWorkbook } from "./perf/workload";

if (process.env.REQUIRE_REAL_ENGINE === "1" && !ENGINE_BUILT) {
  describe("sheet importers/exporter (wasm artifact) — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the wasm artifact is missing", () => {
      throw new Error(`REQUIRE_REAL_ENGINE=1 but ${WASM} is missing`);
    });
  });
}

const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const enc = new TextEncoder();
const workbookOpen = (env: SheetEnv) =>
  (
    env.command("media.paged.sheet.command.copySelection").when as (
      s: unknown,
    ) => boolean
  )(null);

describe.skipIf(!ENGINE_BUILT)(
  "paged.sheet importers and exporter (unavailable without the sheet wasm: bash scripts/build-wasm.sh)",
  () => {
    setDefaultTimeout(30_000);
    let env: SheetEnv;
    beforeEach(() => {
      env = unitEnv();
    });
    afterEach(() => env.dispose());

    it("the .xlsx importer opens the workbook, every sheet and value, and shows the workbook panel", async () => {
      covers("importer:media.paged.sheet.importer.xlsx");
      const imp = env.importer("media.paged.sheet.importer.xlsx");
      expect(imp.extensions).toEqual([".xlsx"]);
      expect(imp.mimeTypes).toEqual([XLSX]);
      expect(workbookOpen(env)).toBe(false);
      const bytes = await authorWorkbook(
        3,
        2,
        (r, c) => (r === 0 ? ["k", "n"][c]! : c === 0 ? `r${r}` : String(r)),
        [[3, 1, "=SUM(B2:B3)"]],
      );
      await imp.import({ name: "q3.xlsx", bytes, mimeType: XLSX });
      await env.settle();
      expect(workbookOpen(env)).toBe(true);
      expect(env.opened).toEqual([PANEL.workbook]);
      expect(await env.objects.query(`${P}/sheet` as never)).toEqual([
        `${P}/sheet/Sheet1`,
      ]);
      expect(await value(env, `${P}/cell/Sheet1!A2`, "value")).toBe("r1");
      // A formula arrives as a formula, computed by the engine.
      expect(await value(env, `${P}/cell/Sheet1!B4`, "formula")).toBe(
        "=SUM(B2:B3)",
      );
      expect(await value(env, `${P}/cell/Sheet1!B4`, "value")).toBe("3");
      // The importer does not replace the document: nothing was mutated
      // but the workbook's own container part.
      expect(
        env.mutationsSince(0).filter((m) => m.op !== "setDocumentMetadata"),
      ).toEqual([]);
    });

    it("the .xlsx importer refuses bytes that are not a workbook, and says so", async () => {
      covers("importer:media.paged.sheet.importer.xlsx");
      await env
        .importer("media.paged.sheet.importer.xlsx")
        .import({ name: "x.xlsx", bytes: enc.encode("nope"), mimeType: XLSX });
      await env.settle();
      expect(
        env.logs.some((l) => l.text.includes("workbook load failed")),
      ).toBe(true);
      // Nothing of the file arrived: the verbs that need a workbook refuse.
      await env
        .command("media.paged.sheet.command.copySelection")
        .handler(env.host.editor);
      await env.settle();
      expect(
        env.logs.some((l) => l.text.includes("open a workbook first")),
      ).toBe(true);
    });

    it.failing(
      "SHT-3 — after a failed import no workbook verb is offered",
      async () => {
        // Today the engine has booted, so `when` (engine !== null) answers
        // true and the palette offers Copy, Paste, Fill, … over an empty
        // default Sheet1 the user never opened; running one then says "open
        // a workbook first". The gate and the handler disagree.
        await env.importer("media.paged.sheet.importer.xlsx").import({
          name: "x.xlsx",
          bytes: enc.encode("nope"),
          mimeType: XLSX,
        });
        await env.settle();
        expect(workbookOpen(env)).toBe(false);
      },
    );

    it("the .csv importer types each value, names the sheet after the file, and takes .tsv too", async () => {
      covers("importer:media.paged.sheet.importer.csv");
      const imp = env.importer("media.paged.sheet.importer.csv");
      expect(imp.extensions).toEqual([".csv", ".tsv"]);
      expect(imp.mimeTypes).toEqual(["text/csv", "text/tab-separated-values"]);
      await openBook(env);
      expect(env.opened).toEqual([PANEL.workbook]);
      expect(await column(env, "A")).toEqual([
        "name",
        "Apples",
        "Pears",
        "Figs",
      ]);
      // "12" is typed as a number by the engine: it sums.
      await env.objects.set(
        `${P}/cell/book!C1` as never,
        "formula",
        "=SUM(B2:B4)",
      );
      expect(await cell(env, "C1")).toBe("22");
      await imp.import({
        name: "tabs.tsv",
        bytes: enc.encode("a\tb\n1\t2\n"),
        mimeType: "text/tab-separated-values",
      });
      await env.settle();
      expect(await value(env, `${P}/cell/tabs!B2`, "value")).toBe("2");
    });

    it("the .xlsx exporter answers nothing without a workbook, and the workbook as an .xlsx package after one", async () => {
      covers("exporter:media.paged.sheet.exporter.xlsx");
      const exp = env.exporter("media.paged.sheet.exporter.xlsx");
      expect(exp.extension).toBe(".xlsx");
      expect(exp.mimeType).toBe(XLSX);
      expect(await exp.export()).toBeNull();
      await openBook(env);
      await env.objects.set(`${P}/cell/book!B3` as never, "value", "30");
      const out = await exp.export();
      expect(out).not.toBeNull();
      expect(out!.fileName).toMatch(/\.xlsx$/);
      // A ZIP (PK\x03\x04) — an OOXML package.
      expect([...out!.bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      // Round trip: the exported bytes open again through the importer,
      // with the edit in them.
      const again = unitEnv();
      try {
        await again
          .importer("media.paged.sheet.importer.xlsx")
          .import({ name: out!.fileName, bytes: out!.bytes, mimeType: XLSX });
        await again.settle();
        expect(await value(again, `${P}/cell/book!A3`, "value")).toBe("Pears");
        expect(await value(again, `${P}/cell/book!B3`, "value")).toBe("30");
      } finally {
        again.dispose();
      }
    });
  },
);
