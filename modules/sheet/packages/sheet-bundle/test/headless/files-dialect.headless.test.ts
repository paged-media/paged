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

// Files and dialect (sheet ADR 521) on the HEADLESS editor: the typed
// OpenDocument import, CSV export and R1C1 commands through the real engine.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import { covers } from "@paged-media/test-kit";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { headlessEnv, P, value, type SheetEnv } from "../conformance/env";
import { C, openBook } from "../conformance/scenarios";
import { buildIdml as buildZip } from "../perf/build-idml";
import { ENGINE_BUILT } from "../perf/workload";

type Env = SheetEnv & { h: HeadlessHost };

const ODS = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.3"><office:body><office:spreadsheet>
<table:table table:name="Data"><table:table-row><table:table-cell office:value-type="float" office:value="20"><text:p>20</text:p></table:table-cell><table:table-cell table:formula="of:=[.A1]+1" office:value-type="float" office:value="21"><text:p>21</text:p></table:table-cell></table:table-row></table:table>
</office:spreadsheet></office:body></office:document-content>`;

describe.skipIf(!ENGINE_BUILT)(
  "paged.sheet files and dialect (headless)",
  () => {
    setDefaultTimeout(60_000);
    let env: Env;
    beforeEach(async () => {
      env = (await headlessEnv()) as Env;
    });
    afterEach(() => env.dispose());

    it("importOds — an OpenDocument spreadsheet becomes the workbook, its formula recalculated", async () => {
      covers("command:media.paged.sheet.command.importOds");
      const bytes = buildZip([
        {
          name: "mimetype",
          data: "application/vnd.oasis.opendocument.spreadsheet",
          store: true,
        },
        { name: "content.xml", data: ODS },
      ]);
      expect(
        await env.objects.invoke(`${C}.importOds` as never, {
          bytes,
          name: "data.ods",
        }),
      ).toBe(`${P}/workbook/main`);
      expect(await value(env, `${P}/workbook/main`, "sheets")).toEqual([
        "Data",
      ]);
      expect(await value(env, `${P}/cell/Data!B1`, "value")).toBe("21");
    });

    it("exportCsv — the sheet as CSV text, quoted as RFC 4180 asks", async () => {
      covers("command:media.paged.sheet.command.exportCsv");
      await openBook(env);
      expect(
        await env.objects.invoke(`${C}.exportCsv` as never, {
          delimiter: ";",
          range: "A1:B2",
        }),
      ).toBe("name;qty\r\nApples;12\r\n");
    });

    it("toggleR1C1 — flips the workbook's reference style and reports it", async () => {
      covers("command:media.paged.sheet.command.toggleR1C1");
      await openBook(env);
      const on = (await env.objects.invoke(`${C}.toggleR1C1` as never, {})) as {
        r1c1: boolean;
      };
      expect(on.r1c1).toBe(true);
      const off = (await env.objects.invoke(
        `${C}.toggleR1C1` as never,
        {},
      )) as {
        r1c1: boolean;
      };
      expect(off.r1c1).toBe(false);
    });
  },
);
