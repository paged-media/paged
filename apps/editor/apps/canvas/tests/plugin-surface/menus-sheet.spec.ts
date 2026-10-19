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

// PLUGIN MENUS — paged.sheet (modules/sheet/packages/sheet-bundle/src/menu.ts).
//
// Nineteen entries: Object ▸ Insert spreadsheet… (filed under Insert ▸
// Spreadsheet…) and eighteen under the Sheet menu, which the bar folds into
// Plugins ▸ Sheet (and shows as a context menu while a sheet frame is
// selected or entered).
//
// ORDER MATTERS here (serial): the document starts WITHOUT a workbook, which
// is where MNU-1 shows; the New blank workbook entry then opens one through
// its own click, and every later entry runs against it.
//
// WHAT EVERY ENTRY OWES, asserted per entry through the real menu bar
// (menu-driver.ts says where an entry shows and how a click is observed):
//
//   · without a document it is GREYED and a click runs nothing (the SDK
//     scopes every plugin entry to "a document is open");
//   · with one it is enabled, and a click runs exactly its command, once,
//     with no payload, and the handler settles without throwing;
//   · what the click then does, where the editor can see it: the panel it
//     raises (`host.shell.openPanel`), the file it asks for
//     (`host.shell.pickFile`, answered "cancelled"), the document it changes
//     (an IDML export digest) and that ONE Undo takes that change back.
//
// What a command does to a richer document than the one set up here is
// the command's own suite (the bundle's unit and headless tests); this file
// is about the menu entry: reachable, gated, wired to its command.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import {
  clickEntry,
  closeMenus,
  isGreyed,
  openLeaf,
  routeOf,
  documentDigest,
  expectGreyedAndInert,
  expectOneUndoRestores,
  openMenuPages,
} from "./menu-driver";

test.describe.serial("plugin menus — paged.sheet", () => {
  let bare: Page;
  let live: Page;
  let close: () => Promise<void>;

  test.beforeAll(async ({ browser }, info) => {
    ({ bare, live, close } = await openMenuPages(browser, info.project.use));
  });
  test.afterAll(async () => {
    await close();
  });

  // ── no workbook yet ──

  test("Object/Insert spreadsheet… — Insert ▸ Spreadsheet… asks for one .xlsx / .csv / .tsv file", async () => {
    covers("menu:Object/Insert spreadsheet…");
    await expectGreyedAndInert(bare, "Object/Insert spreadsheet…");
    const out = await clickEntry(
      live,
      "Object/Insert spreadsheet…",
      "media.paged.sheet.command.importXlsx",
    );
    expect(out.shell).toEqual([
      {
        door: "pickFile",
        arg: '{"accept":[".xlsx","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",".csv",".tsv","text/csv","text/tab-separated-values"],"multiple":false}',
      },
    ]);
    expect(out.after, "a cancelled pick leaves the document alone").toBe(
      out.before,
    );
  });

  test("MNU-1 — an entry whose command needs an open workbook is offered, and does nothing, while none is open", async () => {
    test.fail(
      true,
      "MNU-1: the bar greys an entry on the SDK's document scope only; the eight Sheet entries " +
        "whose COMMAND is gated on an open workbook (`when: workbookIsOpen`) render enabled, and " +
        "a click is refused silently by the command registry (nothing runs, nothing is said)",
    );
    // The document is open and no workbook is: the state a designer is in
    // before New blank workbook / Insert ▸ Spreadsheet….
    const gated = [
      "Sheet/Add sheet",
      "Sheet/Paginate into threaded frames",
      "Sheet/Insert rows",
      "Sheet/Delete rows",
      "Sheet/Insert columns",
      "Sheet/Delete columns",
      "Sheet/Copy cells",
      "Sheet/Paste into sheet",
    ];
    for (const path of gated) {
      const item = await openLeaf(live, routeOf(path));
      expect
        .soft(
          await isGreyed(item),
          `${path} is greyed while no workbook is open`,
        )
        .toBe(true);
    }
    await closeMenus(live);
  });

  test("MNU-1 (the other half) — clicking such an entry with no workbook runs nothing", async () => {
    // Not an expected failure: this pins what MNU-1 costs the user. The
    // item accepts the click and the registry refuses before the handler
    // (no `started`), so there is no message either.
    const before = await documentDigest(live);
    const item = await openLeaf(live, routeOf("Sheet/Add sheet"));
    expect(await isGreyed(item)).toBe(false);
    const runs = await live.evaluate(
      () =>
        (globalThis as unknown as { __menuProbe: { runs: unknown[] } })
          .__menuProbe.runs.length,
    );
    await item.click();
    await closeMenus(live);
    await live.waitForTimeout(500);
    expect(
      await live.evaluate(
        () =>
          (globalThis as unknown as { __menuProbe: { runs: unknown[] } })
            .__menuProbe.runs.length,
      ),
      "nothing ran",
    ).toBe(runs);
    expect(await documentDigest(live)).toBe(before);
  });

  // ── New blank workbook opens one; everything below runs against it ──

  test("Sheet/New blank workbook — opens a workbook and raises the Workbook panel", async () => {
    covers("menu:Sheet/New blank workbook");
    await expectGreyedAndInert(bare, "Sheet/New blank workbook");
    const out = await clickEntry(
      live,
      "Sheet/New blank workbook",
      "media.paged.sheet.command.newWorkbook",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.sheet.panel.workbook" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Sheet/Add sheet — runs addSheet on the open workbook", async () => {
    covers("menu:Sheet/Add sheet");
    await expectGreyedAndInert(bare, "Sheet/Add sheet");
    const out = await clickEntry(
      live,
      "Sheet/Add sheet",
      "media.paged.sheet.command.addSheet",
    );
    expect(out.shell).toEqual([]);
  });

  test("Sheet/Open sheet grid — raises the Grid panel", async () => {
    covers("menu:Sheet/Open sheet grid");
    await expectGreyedAndInert(bare, "Sheet/Open sheet grid");
    const out = await clickEntry(
      live,
      "Sheet/Open sheet grid",
      "media.paged.sheet.command.openGrid",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.sheet.panel.grid" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Sheet/Show grid in frame — runs showGridInFrame", async () => {
    covers("menu:Sheet/Show grid in frame");
    await expectGreyedAndInert(bare, "Sheet/Show grid in frame");
    const out = await clickEntry(
      live,
      "Sheet/Show grid in frame",
      "media.paged.sheet.command.showGridInFrame",
    );
    expect(out.shell).toEqual([]);
  });

  test("Sheet/Hide grid in frame — runs hideGridInFrame", async () => {
    covers("menu:Sheet/Hide grid in frame");
    await expectGreyedAndInert(bare, "Sheet/Hide grid in frame");
    const out = await clickEntry(
      live,
      "Sheet/Hide grid in frame",
      "media.paged.sheet.command.hideGridInFrame",
    );
    expect(out.shell).toEqual([]);
  });

  test("Sheet/Place selection on page — places the grid selection on the page as a frame, and one Undo removes it", async () => {
    covers("menu:Sheet/Place selection on page");
    await expectGreyedAndInert(bare, "Sheet/Place selection on page");
    const out = await clickEntry(
      live,
      "Sheet/Place selection on page",
      "media.paged.sheet.command.lowerToFrame",
    );
    expect(out.shell).toEqual([]);
    expect(
      out.after,
      "Sheet/Place selection on page changes the document",
    ).not.toBe(out.before);
    await expectOneUndoRestores(
      live,
      "Sheet/Place selection on page",
      out.before,
    );
  });

  test("Sheet/Place chart on page — runs lowerChartToFrame (the workbook has no chart)", async () => {
    covers("menu:Sheet/Place chart on page");
    await expectGreyedAndInert(bare, "Sheet/Place chart on page");
    const out = await clickEntry(
      live,
      "Sheet/Place chart on page",
      "media.paged.sheet.command.lowerChartToFrame",
    );
    expect(out.shell).toEqual([]);
  });

  test("Sheet/Paginate into threaded frames — runs paginateToChain on the open workbook", async () => {
    covers("menu:Sheet/Paginate into threaded frames");
    await expectGreyedAndInert(bare, "Sheet/Paginate into threaded frames");
    const out = await clickEntry(
      live,
      "Sheet/Paginate into threaded frames",
      "media.paged.sheet.command.paginateToChain",
    );
    expect(out.shell).toEqual([]);
  });

  test("Sheet/Insert rows — runs insertRows on the open workbook", async () => {
    covers("menu:Sheet/Insert rows");
    await expectGreyedAndInert(bare, "Sheet/Insert rows");
    const out = await clickEntry(
      live,
      "Sheet/Insert rows",
      "media.paged.sheet.command.insertRows",
    );
    expect(out.shell).toEqual([]);
  });

  test("Sheet/Delete rows — runs deleteRows on the open workbook", async () => {
    covers("menu:Sheet/Delete rows");
    await expectGreyedAndInert(bare, "Sheet/Delete rows");
    const out = await clickEntry(
      live,
      "Sheet/Delete rows",
      "media.paged.sheet.command.deleteRows",
    );
    expect(out.shell).toEqual([]);
  });

  test("Sheet/Insert columns — runs insertColumns on the open workbook", async () => {
    covers("menu:Sheet/Insert columns");
    await expectGreyedAndInert(bare, "Sheet/Insert columns");
    const out = await clickEntry(
      live,
      "Sheet/Insert columns",
      "media.paged.sheet.command.insertColumns",
    );
    expect(out.shell).toEqual([]);
  });

  test("Sheet/Delete columns — runs deleteColumns on the open workbook", async () => {
    covers("menu:Sheet/Delete columns");
    await expectGreyedAndInert(bare, "Sheet/Delete columns");
    const out = await clickEntry(
      live,
      "Sheet/Delete columns",
      "media.paged.sheet.command.deleteColumns",
    );
    expect(out.shell).toEqual([]);
  });

  test("Sheet/Sort range… — raises the Workbook panel, where the sort is set up", async () => {
    covers("menu:Sheet/Sort range…");
    await expectGreyedAndInert(bare, "Sheet/Sort range…");
    const out = await clickEntry(
      live,
      "Sheet/Sort range…",
      "media.paged.sheet.command.sortRange",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.sheet.panel.workbook" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Sheet/Find & replace… — raises the Grid panel, where the search is", async () => {
    covers("menu:Sheet/Find & replace…");
    await expectGreyedAndInert(bare, "Sheet/Find & replace…");
    const out = await clickEntry(
      live,
      "Sheet/Find & replace…",
      "media.paged.sheet.command.findReplace",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.sheet.panel.grid" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Sheet/Copy cells — runs copySelection on the open workbook", async () => {
    covers("menu:Sheet/Copy cells");
    await expectGreyedAndInert(bare, "Sheet/Copy cells");
    const out = await clickEntry(
      live,
      "Sheet/Copy cells",
      "media.paged.sheet.command.copySelection",
    );
    expect(out.shell).toEqual([]);
  });

  test("Sheet/Paste into sheet — runs pasteSelection on the open workbook", async () => {
    covers("menu:Sheet/Paste into sheet");
    await expectGreyedAndInert(bare, "Sheet/Paste into sheet");
    const out = await clickEntry(
      live,
      "Sheet/Paste into sheet",
      "media.paged.sheet.command.pasteSelection",
    );
    expect(out.shell).toEqual([]);
  });

  test("Sheet/Style from cell — runs styleFromCell on the open workbook", async () => {
    covers("menu:Sheet/Style from cell");
    await expectGreyedAndInert(bare, "Sheet/Style from cell");
    const out = await clickEntry(
      live,
      "Sheet/Style from cell",
      "media.paged.sheet.command.styleFromCell",
    );
    expect(out.shell).toEqual([]);
  });

  test("Sheet/New sheet from dataset — raises the Datasets panel", async () => {
    covers("menu:Sheet/New sheet from dataset");
    await expectGreyedAndInert(bare, "Sheet/New sheet from dataset");
    const out = await clickEntry(
      live,
      "Sheet/New sheet from dataset",
      "media.paged.sheet.command.sheetFromDataset",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.sheet.panel.datasets" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });
});
