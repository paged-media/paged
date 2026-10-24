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

// PLUGIN MENUS — paged.sheet's RIGHT-CLICK rows (`Context/…`,
// modules/sheet/packages/sheet-bundle/src/menu.ts CONTEXT_ENTRIES).
//
// They show in the canvas context menu while the sheet edit context is
// active and the right-click lands in the frame surface (extensions ADR
// 334, editor ADR 281); the menu bar never shows them. sheet-context-
// driver.ts says how they are reached and how a click is observed.
//
// WHAT EVERY ROW OWES, asserted per row: it is in the sheet's right-click
// menu, a click runs exactly its command once and settles without an
// error, and what the click then does where the editor shows it — the
// cells the bar reads back, the card that opens under the bar, the panel
// it raises, the filter buttons on the grid, the rows the grid shows.
//
// ORDER MATTERS (serial, one editor): the workbook is imported once and
// each row acts on what the rows before it left. The fixture
// (sheet-02-formulas.xlsx): A1=2, B1="Sum", A2=3, B2="Product",
// A3=SUM(A1:A2), B3=B1&B2.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { fitFirstPage, openCanvas } from "../fidelity/canvas-driver";
import { fixturePath } from "../e2e/harness/fixtures";
import {
  clickCell,
  clickContextRow,
  contextRow,
  enterSheet,
  importAndPlace,
  inputOf,
  nameBox,
  openContextMenu,
  type SheetContext,
  workbookPart,
} from "./sheet-context-driver";

const C = "media.paged.sheet.command";
const ROWS = [
  "Cut",
  "Copy",
  "Paste",
  "Paste special…",
  "Insert rows",
  "Insert columns",
  "Delete rows",
  "Delete columns",
  "Clear contents",
  "Sort…",
  "Format cells…",
  "Data validation…",
  "Circle invalid data",
  "Filter",
  "Hide",
  "Unhide",
  "Group",
  "Ungroup",
  "Goal Seek…",
];

test.describe.serial("plugin menus — paged.sheet right-click rows", () => {
  let page: Page;
  let sheet: SheetContext;

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({
      baseURL: info.project.use.baseURL,
      viewport: { width: 1600, height: 1000 },
    });
    // The sheet's copy and paste go through the system clipboard.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    page = await context.newPage();
    await openCanvas(page);
    await page.setInputFiles('input[type="file"]', fixturePath("geometry"));
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __canvas: { ready: boolean } })
                .__canvas.ready,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await fitFirstPage(page);
    await page.waitForTimeout(300);
    const frame = await importAndPlace(page, "A1:G14");
    sheet = await enterSheet(page, frame, 5, 4);
  });
  test.afterAll(async () => {
    await page?.context().close();
  });

  test("the sheet's right-click menu holds every Context/ row, and none of the page item's", async () => {
    const menu = await openContextMenu(page, sheet, 0, 0);
    for (const label of ROWS)
      await expect(contextRow(menu, label), label).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: /Bring to Front/i }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("Context/Copy — copies the cell; Context/Paste puts it in another", async () => {
    covers("menu:Context/Copy");
    await clickContextRow(page, sheet, [0, 0], "Copy", `${C}.copySelection`);
    expect(await inputOf(page, sheet, 0, 3)).toBe("");
  });

  test("Context/Paste — pastes the copied cell at the right-clicked one, one undo step", async () => {
    covers("menu:Context/Paste");
    await clickContextRow(page, sheet, [0, 3], "Paste", `${C}.pasteSelection`);
    await expect.poll(() => inputOf(page, sheet, 0, 3)).toBe("2");
  });

  test("Context/Cut — the cut cell moves when its paste lands", async () => {
    covers("menu:Context/Cut");
    await clickContextRow(page, sheet, [0, 1], "Cut", `${C}.cutSelection`);
    // Copied, not yet moved.
    expect(await inputOf(page, sheet, 0, 1)).toBe("Sum");
    await clickContextRow(page, sheet, [1, 3], "Paste", `${C}.pasteSelection`);
    await expect.poll(() => inputOf(page, sheet, 1, 3)).toBe("Sum");
    expect(await inputOf(page, sheet, 0, 1)).toBe("");
  });

  test("Context/Paste special… — opens the paste special card; its OK pastes and closes it", async () => {
    covers("menu:Context/Paste special…");
    await clickContextRow(
      page,
      sheet,
      [2, 3],
      "Paste special…",
      `${C}.pasteSpecial`,
    );
    const card = page.locator('[data-testid="sheet-paste-special"]');
    await expect(card).toBeVisible();
    await page.locator('[data-testid="sheet-paste-special-ok"]').click();
    await expect(card).toHaveCount(0);
    await expect.poll(() => inputOf(page, sheet, 2, 3)).toBe("Sum");
  });

  test("Context/Insert rows — a blank row above the right-clicked cell", async () => {
    covers("menu:Context/Insert rows");
    await clickContextRow(
      page,
      sheet,
      [0, 0],
      "Insert rows",
      `${C}.insertRows`,
    );
    await expect.poll(() => inputOf(page, sheet, 0, 0)).toBe("");
    expect(await inputOf(page, sheet, 1, 0)).toBe("2");
  });

  test("Context/Delete rows — the right-clicked row goes, the ones below move up", async () => {
    covers("menu:Context/Delete rows");
    await clickContextRow(
      page,
      sheet,
      [0, 0],
      "Delete rows",
      `${C}.deleteRows`,
    );
    await expect.poll(() => inputOf(page, sheet, 0, 0)).toBe("2");
    expect(await inputOf(page, sheet, 1, 0)).toBe("3");
  });

  test("Context/Insert columns — a blank column left of the right-clicked cell", async () => {
    covers("menu:Context/Insert columns");
    await clickContextRow(
      page,
      sheet,
      [0, 0],
      "Insert columns",
      `${C}.insertColumns`,
    );
    await expect.poll(() => inputOf(page, sheet, 0, 0)).toBe("");
    expect(await inputOf(page, sheet, 0, 1)).toBe("2");
  });

  test("Context/Delete columns — the right-clicked column goes, the ones right of it move left", async () => {
    covers("menu:Context/Delete columns");
    await clickContextRow(
      page,
      sheet,
      [0, 0],
      "Delete columns",
      `${C}.deleteColumns`,
    );
    await expect.poll(() => inputOf(page, sheet, 0, 0)).toBe("2");
    expect(await inputOf(page, sheet, 0, 3)).toBe("2");
  });

  test("Context/Clear contents — empties the right-clicked cell", async () => {
    covers("menu:Context/Clear contents");
    await clickContextRow(
      page,
      sheet,
      [0, 3],
      "Clear contents",
      `${C}.clearCells`,
    );
    await expect.poll(() => inputOf(page, sheet, 0, 3)).toBe("");
    expect(await inputOf(page, sheet, 0, 0)).toBe("2");
  });

  test("Context/Sort… — opens the Sort card under the sheet bar, on the data around the cell", async () => {
    covers("menu:Context/Sort…");
    const out = await clickContextRow(
      page,
      sheet,
      [0, 0],
      "Sort…",
      `${C}.sortRange`,
    );
    // Inside the frame the card is the sheet's own; no panel is raised.
    expect(out.shell).toEqual([]);
    const card = page.locator('[data-testid="sheet-sort-card"]');
    await expect(card).toBeVisible();
    await expect(page.locator('[data-testid="sheet-sort-ok"]')).toBeVisible();
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(card).toHaveCount(0);
  });

  test("Context/Format cells… — raises the Sheet properties panel", async () => {
    covers("menu:Context/Format cells…");
    const out = await clickContextRow(
      page,
      sheet,
      [0, 0],
      "Format cells…",
      `${C}.formatCells`,
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.sheet.panel.properties" },
    ]);
  });

  test("Context/Data validation… — opens the Data validation card; its OK puts a rule on the cell", async () => {
    covers("menu:Context/Data validation…");
    await clickContextRow(
      page,
      sheet,
      [0, 0],
      "Data validation…",
      `${C}.dataValidation`,
    );
    const type = page.locator('[data-testid="sheet-validation-type"]');
    await expect(type).toBeVisible();
    // A1 holds 2: a whole number of at most 1 makes it invalid.
    await type.selectOption("whole");
    await page
      .locator('[data-testid="sheet-validation-operator"]')
      .selectOption("lessThanOrEqual");
    await page.locator('[data-testid="sheet-validation-formula1"]').fill("1");
    await page.locator('[data-testid="sheet-validation-ok"]').click();
    await expect(type).toHaveCount(0);
  });

  test("Context/Circle invalid data — circles the cell that breaks its rule, and toggles off", async () => {
    covers("menu:Context/Circle invalid data");
    await clickCell(page, sheet, 0, 0);
    const before = await sheet.surface.screenshot();
    await clickContextRow(
      page,
      sheet,
      [0, 0],
      "Circle invalid data",
      `${C}.circleInvalid`,
    );
    await expect
      .poll(async () => (await sheet.surface.screenshot()).equals(before), {
        message: "a circle is drawn round A1",
      })
      .toBe(false);
    await clickContextRow(
      page,
      sheet,
      [0, 0],
      "Circle invalid data",
      `${C}.circleInvalid`,
    );
    await expect
      .poll(async () => (await sheet.surface.screenshot()).equals(before), {
        message: "the circle goes again",
      })
      .toBe(true);
  });

  test("Context/Filter — filter buttons on the data's header row, and off again", async () => {
    covers("menu:Context/Filter");
    const buttons = page.locator('[data-testid="sheet-filter-button"]');
    await expect(buttons).toHaveCount(0);
    await clickContextRow(page, sheet, [0, 0], "Filter", `${C}.toggleFilter`);
    await expect(buttons.first()).toBeVisible();
    await clickContextRow(page, sheet, [0, 0], "Filter", `${C}.toggleFilter`);
    await expect(buttons).toHaveCount(0);
  });

  /** Which cell the grid shows at row 2's place in column A. */
  const atSecondRow = async () => {
    const p = await sheet.cell(1, 0);
    await page.mouse.click(p.x, p.y);
    return (await nameBox(page).textContent())?.trim();
  };

  test("Context/Hide — the right-clicked row is hidden: the next row takes its place", async () => {
    covers("menu:Context/Hide");
    expect(await atSecondRow()).toBe("A2");
    await clickContextRow(page, sheet, [1, 0], "Hide", `${C}.hideSelection`);
    await expect.poll(atSecondRow).toBe("A3");
  });

  test("Context/Unhide — over a selection spanning the hidden row, it shows again", async () => {
    covers("menu:Context/Unhide");
    // A1 to A3 (the arrows step through the hidden A2).
    await clickCell(page, sheet, 0, 0);
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(nameBox(page)).toHaveText("A1:A3");
    await clickContextRow(
      page,
      sheet,
      [0, 0],
      "Unhide",
      `${C}.unhideSelection`,
    );
    await expect.poll(atSecondRow).toBe("A2");
  });

  /** Row 2's outline level in the workbook as exported (0: none). The
   *  frame's grid draws no outline bar, so the file is where a group shows. */
  const secondRowLevel = async () => {
    const xml = await workbookPart(page, "xl/worksheets/sheet1.xml");
    const row = /<row\b[^>]*\br="2"[^>]*>/.exec(xml)?.[0] ?? "";
    return Number(/outlineLevel="(\d+)"/.exec(row)?.[1] ?? 0);
  };

  test("Context/Group — the right-clicked row is grouped: the workbook carries its outline level", async () => {
    covers("menu:Context/Group");
    expect(await secondRowLevel()).toBe(0);
    await clickContextRow(page, sheet, [1, 0], "Group", `${C}.groupSelection`);
    await expect.poll(secondRowLevel).toBe(1);
  });

  test("Context/Ungroup — the group goes again", async () => {
    covers("menu:Context/Ungroup");
    await clickContextRow(
      page,
      sheet,
      [1, 0],
      "Ungroup",
      `${C}.ungroupSelection`,
    );
    await expect.poll(secondRowLevel).toBe(0);
  });

  test("Context/Goal Seek… — opens the Goal Seek card", async () => {
    covers("menu:Context/Goal Seek…");
    await clickContextRow(page, sheet, [0, 0], "Goal Seek…", `${C}.goalSeek`);
    await expect(
      page.locator('[data-testid="sheet-goal-seek-target"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="sheet-goal-seek-ok"]'),
    ).toBeVisible();
  });
});
