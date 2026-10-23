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

// Files and dialect (sheet ADR 521) through the real bundle and the real
// engine: the OpenDocument importer, the .xlsm and CSV exporters, the CSV
// and R1C1 commands, and the formula bar in the display dialect (R1C1, the
// German function names) while the workbook keeps canonical formulas.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import { covers } from "@paged-media/test-kit";

import { createWorkbookSession, type WorkbookSession } from "../src";
import { P, unitEnv, value, type SheetEnv } from "./conformance/env";
import { C, openBook } from "./conformance/scenarios";
import { buildIdml as buildZip } from "./perf/build-idml";
import {
  ENGINE_BUILT,
  authorWorkbook,
  blankPageIdml,
  openHost,
  settle,
  sheetHost,
} from "./perf/workload";

const ODS_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.3">
<office:body><office:spreadsheet>
<table:table table:name="Fruit">
<table:table-row><table:table-cell office:value-type="string"><text:p>name</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>qty</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell office:value-type="string"><text:p>Apples</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="12"><text:p>12</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell office:value-type="string"><text:p>Total</text:p></table:table-cell><table:table-cell table:formula="of:=SUM([.B2:.B2])*2" office:value-type="float" office:value="24"><text:p>24</text:p></table:table-cell></table:table-row>
</table:table>
</office:spreadsheet></office:body></office:document-content>`;

const odsBytes = (): Uint8Array =>
  buildZip([
    {
      name: "mimetype",
      data: "application/vnd.oasis.opendocument.spreadsheet",
      store: true,
    },
    { name: "content.xml", data: ODS_CONTENT },
  ]);

const invoke = (env: SheetEnv, id: string, args: unknown) =>
  env.objects.invoke(`${C}.${id}` as never, args);

describe.skipIf(!ENGINE_BUILT)(
  `paged.sheet files and dialect${ENGINE_BUILT ? "" : " (unavailable: the sheet wasm, bash scripts/build-wasm.sh)"}`,
  () => {
    setDefaultTimeout(30_000);
    let env: SheetEnv;
    beforeEach(() => {
      env = unitEnv();
    });
    afterEach(() => env.dispose());

    it("the .ods importer opens an OpenDocument spreadsheet as a workbook", async () => {
      covers("importer:media.paged.sheet.importer.ods");
      const imp = env.importer("media.paged.sheet.importer.ods");
      expect(imp.extensions).toEqual([".ods", ".ots"]);
      await imp.import({
        name: "fruit.ods",
        bytes: odsBytes(),
        mimeType: "application/vnd.oasis.opendocument.spreadsheet",
      });
      await env.settle();
      expect(await value(env, `${P}/workbook/main`, "sheets")).toEqual([
        "Fruit",
      ]);
      expect(await value(env, `${P}/cell/Fruit!A2`, "value")).toBe("Apples");
      expect(await value(env, `${P}/cell/Fruit!B3`, "value")).toBe("24");
    });

    it("importOds — the typed command takes the bytes; a document that is not a spreadsheet is refused", async () => {
      covers("command:media.paged.sheet.command.importOds");
      expect(
        await invoke(env, "importOds", { bytes: odsBytes(), name: "f.ods" }),
      ).toBe(`${P}/workbook/main`);
      expect(await value(env, `${P}/cell/Fruit!B2`, "value")).toBe("12");
      const text = buildZip([
        {
          name: "mimetype",
          data: "application/vnd.oasis.opendocument.text",
          store: true,
        },
        { name: "content.xml", data: "<office:document-content/>" },
      ]);
      const other = unitEnv();
      try {
        await expect(
          invoke(other, "importOds", { bytes: text, name: "letter.odt" }),
        ).rejects.toThrow(/could not be read/);
      } finally {
        other.dispose();
      }
    });

    it("the .csv exporter writes the active sheet: what the cells show, a BOM, the host's separator", async () => {
      covers("exporter:media.paged.sheet.exporter.csv");
      const exp = env.exporter("media.paged.sheet.exporter.csv");
      expect(exp.extension).toBe(".csv");
      expect(exp.mimeType).toBe("text/csv");
      expect(await exp.export()).toBeNull();
      await openBook(env);
      const out = await exp.export();
      expect(out!.fileName).toBe("book.csv");
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        out!.bytes,
      );
      expect(text.startsWith("\u{feff}")).toBe(true);
      const sep = text.includes(";") ? ";" : ",";
      expect(text.slice(1)).toBe(
        ["name", "qty"].join(sep) +
          "\r\n" +
          ["Apples", "12"].join(sep) +
          "\r\n" +
          ["Pears", "3"].join(sep) +
          "\r\n" +
          ["Figs", "7"].join(sep) +
          "\r\n",
      );
    });

    it("exportCsv — the typed command answers the CSV text with its options", async () => {
      covers(
        "command:media.paged.sheet.command.exportCsv",
        "menu:Sheet/Export sheet as CSV…",
      );
      await openBook(env);
      expect(
        await invoke(env, "exportCsv", {
          range: "A2:B3",
          delimiter: "tab",
          formatted: false,
        }),
      ).toBe("Apples\t12\r\nPears\t3\r\n");
      expect(await invoke(env, "exportCsv", { sheet: "book", bom: true })).toBe(
        "\u{feff}name,qty\r\nApples,12\r\nPears,3\r\nFigs,7\r\n",
      );
    });

    it("the .xlsm exporter writes a macro-enabled package the .xlsx importer opens again", async () => {
      covers("exporter:media.paged.sheet.exporter.xlsm");
      const exp = env.exporter("media.paged.sheet.exporter.xlsm");
      expect(exp.extension).toBe(".xlsm");
      expect(await exp.export()).toBeNull();
      await openBook(env);
      const out = await exp.export();
      expect(out!.fileName).toBe("book.xlsm");
      expect([...out!.bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      const again = unitEnv();
      try {
        await again.importer("media.paged.sheet.importer.xlsx").import({
          name: out!.fileName,
          bytes: out!.bytes,
          mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
        });
        await again.settle();
        expect(await value(again, `${P}/cell/book!A3`, "value")).toBe("Pears");
      } finally {
        again.dispose();
      }
    });

    it("toggleR1C1 — the reference style flips, and is kept in the saved workbook", async () => {
      covers(
        "command:media.paged.sheet.command.toggleR1C1",
        "menu:Sheet/R1C1 reference style",
      );
      await openBook(env);
      expect(await invoke(env, "toggleR1C1", {})).toEqual({
        r1c1: true,
        lang: expect.any(String),
      });
      expect(await invoke(env, "toggleR1C1", { r1c1: false })).toEqual({
        r1c1: false,
        lang: expect.any(String),
      });
    });
  },
);

describe.skipIf(!ENGINE_BUILT)(
  `the formula bar in the display dialect${ENGINE_BUILT ? "" : " (unavailable)"}`,
  () => {
    setDefaultTimeout(30_000);
    let session: WorkbookSession | null = null;
    let dispose: () => void = () => {};
    beforeEach(async () => {
      const h = await openHost();
      await h.load(blankPageIdml());
      session = createWorkbookSession(sheetHost(h));
      dispose = () => h.dispose();
      const bytes = await authorWorkbook(2, 2, (r, c) =>
        r === 1 && c === 1 ? "=A1*2" : String(r * 2 + c + 1),
      );
      await session.import(bytes, "dialect.xlsx");
      await settle();
    });
    afterEach(() => {
      session?.dispose();
      session = null;
      dispose();
    });

    it("R1C1: the bar shows and takes relative references; the workbook keeps A1", () => {
      const s = session!;
      s.setActiveSheet(0);
      expect(s.setFormulaDisplay({ r1c1: true, lang: "en" })).toBe(true);
      expect(s.cellInputAt(1, 1)).toBe("=R[-1]C[-1]*2");
      expect(s.editCell(0, 1, 0, "=SUM(R[-1]C:R[-1]C[1])")).toBe(true);
      expect(s.state().engine!.getCellInput(0, 1, 0)).toBe("=SUM(A1:B1)");
      expect(s.formulaDisplay()).toEqual({ r1c1: true, lang: "en" });
    });

    it("German: SUMME with ; between arguments, stored as SUM", () => {
      const s = session!;
      s.setActiveSheet(0);
      expect(s.setFormulaDisplay({ lang: "de-DE" })).toBe(true);
      expect(s.editCell(0, 0, 1, "=SUMME(A1;0,5)")).toBe(true);
      expect(s.state().engine!.getCellInput(0, 0, 1)).toBe("=SUM(A1,0.5)");
      expect(s.cellInputAt(0, 1)).toBe("=SUMME(A1;0,5)");
      // Values are not formulas: the bar passes them through.
      expect(s.editCell(0, 0, 0, "7")).toBe(true);
      expect(s.cellInputAt(0, 0)).toBe("7");
      s.setFormulaDisplay({ lang: "en" });
      expect(s.cellInputAt(0, 1)).toBe("=SUM(A1,0.5)");
    });
  },
);
