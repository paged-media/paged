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

// paged.sheet's layout commands (plan G4), the UNIT layer: the real bundle
// on the SDK's in-process host over the recording fake editor, the sheet
// engine real. What each command wrote is read back from the workbook
// version the document's label names.

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
import { BOOK_CSV, C, openBook } from "./conformance/scenarios";
import { ENGINE_BUILT } from "./perf/workload";
import { savedWorkbook } from "./saved-workbook";

const invoke = (env: SheetEnv, id: string, args: unknown) =>
  env.objects.invoke(`${C}.${id}` as never, args);

describe.skipIf(!ENGINE_BUILT)(
  `paged.sheet layout commands on the fake editor${ENGINE_BUILT ? "" : " (unavailable: the sheet wasm, bash scripts/build-wasm.sh)"}`,
  () => {
    setDefaultTimeout(30_000);
    let env: SheetEnv;
    beforeEach(() => {
      env = unitEnv();
    });
    afterEach(() => env.dispose());

    it("importCsv — delimited text becomes a one-sheet workbook; nothing readable is refused", async () => {
      covers("command:media.paged.sheet.command.importCsv");
      expect(
        await invoke(env, "importCsv", { text: BOOK_CSV, name: "book.csv" }),
      ).toBe(`${P}/workbook/main`);
      expect(await value(env, `${P}/workbook/main`, "sheets")).toEqual([
        "book",
      ]);
      expect(await value(env, `${P}/cell/book!A4`, "value")).toBe("Figs");
    });

    it("mergeCells / unmergeCells — the engine's merge, one version each", async () => {
      covers(
        "command:media.paged.sheet.command.mergeCells",
        "command:media.paged.sheet.command.unmergeCells",
      );
      await openBook(env);
      const m = env.mark();
      await invoke(env, "mergeCells", { range: "book!A1:B1" });
      expect(env.mutationsSince(m).map((x) => x.op)).toEqual([
        "setDocumentMetadata",
      ]);
      expect((await savedWorkbook(env)).sheet).toContain(
        '<mergeCell ref="A1:B1"/>',
      );
      expect(await invoke(env, "unmergeCells", { range: "book!A1:B1" })).toBe(
        1,
      );
      expect((await savedWorkbook(env)).sheet).not.toContain("<mergeCell ");
      await expect(
        invoke(env, "mergeCells", { range: "nosheet!A1:B1" }),
      ).rejects.toThrow(/no sheet/);
    });

    it("setBorders — every cell's edges, or the outline only", async () => {
      covers("command:media.paged.sheet.command.setBorders");
      await openBook(env);
      await invoke(env, "setBorders", { range: "book!A1:B2" });
      expect((await savedWorkbook(env)).styles).toContain(
        '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom>',
      );
      await invoke(env, "setBorders", {
        range: "book!A3:B4",
        edges: "bottom",
        style: "double",
      });
      expect((await savedWorkbook(env)).styles).toMatch(
        /<border><left\/><right\/><top\/><bottom style="double">/,
      );
    });

    it("setColumnWidth / setRowHeight — sizes set, and cleared without a size", async () => {
      covers(
        "command:media.paged.sheet.command.setColumnWidth",
        "command:media.paged.sheet.command.setRowHeight",
      );
      await openBook(env);
      await invoke(env, "setColumnWidth", {
        sheet: "book",
        first: 1,
        size: 18,
      });
      await invoke(env, "setRowHeight", { sheet: "book", first: 0, size: 24 });
      let x = await savedWorkbook(env);
      expect(x.sheet).toMatch(/<col min="2" max="2" width="18"/);
      expect(x.sheet).toMatch(/<row r="1"[^>]*ht="24"/);
      await invoke(env, "setColumnWidth", { sheet: "book", first: 1 });
      x = await savedWorkbook(env);
      expect(x.sheet).not.toContain("<col ");
      await expect(
        invoke(env, "setColumnWidth", { sheet: "book", first: 2, last: 1 }),
      ).rejects.toThrow(/invalidValue/);
    });
  },
);
