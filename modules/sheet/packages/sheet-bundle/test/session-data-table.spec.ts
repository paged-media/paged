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

// PM-0015 step 7 — paged.sheet as the data editor: a table of the
// document's data (`host.data`, data@1, extensions ADR 343) opens as the
// workbook, and a committed body cell is written back to the table. The
// table is served by the SDK's `fakeDataService` through a REAL bundle host
// (the data door's gate and routing), the sheet engine is the recording
// fake below.

import { stubFrameWindow } from "./frame-window-stub";
import { beforeEach, describe, expect, it, vi, mock } from "bun:test";
import { importActual } from "@paged-media/test-kit";

import type { BundleHost, PluginManifest } from "@paged-media/plugin-api";
import {
  createBundleHost,
  createDataRegistry,
  fakeDataService,
  silentConsole,
} from "@paged-media/plugin-sdk";
import { createFakeEditor } from "@paged-media/plugin-sdk/gesture-kit";

import type { SheetEngine } from "../src";
import { createWorkbookSession } from "../src";
import manifest from "../manifest.json";

const setCellCalls: Array<[number, number, number, string]> = [];

function makeFakeEngine(): SheetEngine {
  return {
    loadXlsx() {},
    saveXlsx: () => new Uint8Array(),
    setCell: (sheet, row, col, input) => {
      setCellCalls.push([sheet, row, col, input]);
      return { changed: [{ sheet, row, col, display: input }] };
    },
    getCellDisplay: () => "",
    getCellInput: () => "",
    sortRange: () => ({ changed: [], edits: [] }),
    findAll: () => [],
    replaceAll: () => ({ occurrences: 0, changed: [], edits: [], skipped: [] }),
    getRangeLowered: () => ({
      cols: [],
      rows: [],
      rules: { h: [], v: [] },
      merges: [],
    }),
    getRangeStyled: () => ({
      cols: [],
      rows: [],
      rules: { h: [], v: [] },
      merges: [],
    }),
    getRangeValues: () => [],
    paginate: () => [],
    getFrameWindow: stubFrameWindow,
    getGridScene: () => ({
      viewport: {
        firstRow: 0,
        firstCol: 0,
        rows: 0,
        cols: 0,
        xOffsets: [0],
        yOffsets: [0],
      },
      cells: [],
      styles: [],
      gridlines: { h: [], v: [] },
      selection: null,
    }),
    setGridSelection() {},
    // The seeded extent the panel/range default reads back. 3 cols × 3 rows
    // (header + 2 data rows) matches the fixture below.
    listSheets: () => [{ id: 0, name: "Sheet1", rows: 3, cols: 3 }],
    listCharts: () => [],
    chartKinds: () => ["column"],
    addChart: () => 0,
    listFreezePanes: () => [],
    listDataValidations: () => [],
    listComments: () => [],
    listFunctions: () => [],
    getChartGeometry: () => ({ widthPt: 0, heightPt: 0, prims: [] }),
    dispose() {},
  };
}

const actualEngine = await importActual(() => import("../src/engine"));
mock.module("../src/engine", () => ({
  ...actualEngine,
  bootEmptyEngine: vi.fn(async () => makeFakeEngine()),
}));

const SERVER: PluginManifest = {
  id: "media.paged.data",
  name: "data",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { data: { serve: true } },
};

function setup() {
  const backend = createDataRegistry();
  const editor = createFakeEditor().editor;
  const quiet = silentConsole;
  const server = createBundleHost(() => editor, SERVER, {
    console: quiet,
    data: backend,
  }).host;
  const fake = fakeDataService({
    products: {
      fields: [
        { name: "sku", ty: "text" },
        { name: "price", ty: "float" },
      ],
      rows: [
        { sku: "A-1", price: 9.5 },
        { sku: "B-2", price: 12 },
      ],
    },
    view: {
      kind: "query",
      fields: [{ name: "n", ty: "int" }],
      rows: [{ n: 2 }],
    },
  });
  const handle = server.data.serve(fake);
  const host: BundleHost = createBundleHost(
    () => editor,
    manifest as PluginManifest,
    { console: quiet, data: backend },
  ).host;
  return { host, fake, handle };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setCellCalls.length = 0;
});

describe("the sheet edits a table of the document's data [sheet.data.edit-table]", () => {
  it("lists the tables, opens one as sheet 0 and writes a committed cell back", async () => {
    const { host, fake } = setup();
    const session = createWorkbookSession(host);
    expect(
      (await session.dataTables()).map((t) => [t.name, t.writable]),
    ).toEqual([
      ["products", true],
      ["view", false],
    ]);
    expect(await session.sourceFromDataTable("products")).toBe(true);
    expect(session.state().dataSource).toMatchObject({
      providerId: "products",
      kind: "table",
    });
    // Row 0 the field names, rows 1.. the records.
    const seeded = new Map(setCellCalls.map(([, r, c, v]) => [`${r},${c}`, v]));
    expect([
      seeded.get("0,0"),
      seeded.get("0,1"),
      seeded.get("1,0"),
      seeded.get("2,1"),
    ]).toEqual(["sku", "price", "A-1", "12"]);

    expect(session.editCell(0, 2, 1, "13.5")).toBe(true);
    await flush();
    expect(fake.rows("products")[1]).toEqual({ sku: "B-2", price: "13.5" });
    // A formula and a header edit stay in the sheet.
    session.editCell(0, 1, 1, "=B3*2");
    session.editCell(0, 0, 0, "code");
    await flush();
    expect(fake.rows("products")[0]).toEqual({ sku: "A-1", price: 9.5 });
  });

  it("a change made elsewhere re-pulls the table; the sheet's own write does not", async () => {
    const { host, fake, handle } = setup();
    const session = createWorkbookSession(host);
    await session.sourceFromDataTable("products");
    session.editCell(0, 1, 1, "10");
    await flush();
    const own = (await host.data.tables())[0]!.revision;
    setCellCalls.length = 0;
    handle.changed({ table: "products", revision: own });
    await flush();
    expect(setCellCalls).toEqual([]);
    await fake.write!("products", [
      { op: "insert", values: { sku: "C-3", price: 1 } },
    ]);
    handle.changed({ table: "products", revision: "elsewhere" });
    await flush();
    await flush();
    expect(
      setCellCalls.some(([, r, c, v]) => r === 3 && c === 0 && v === "C-3"),
    ).toBe(true);
  });

  it("a derived table opens read only, and no data service is refused honestly", async () => {
    const { host, fake } = setup();
    const session = createWorkbookSession(host);
    await session.sourceFromDataTable("view");
    session.editCell(0, 1, 0, "5");
    await flush();
    expect(fake.rows("view")[0]).toEqual({ n: 2 });

    const lone = createWorkbookSession(
      createBundleHost(
        () => createFakeEditor().editor,
        manifest as PluginManifest,
        {
          console: silentConsole,
        },
      ).host,
    );
    expect(await lone.dataTables()).toEqual([]);
    expect(await lone.sourceFromDataTable("products")).toBe(false);
  });
});
