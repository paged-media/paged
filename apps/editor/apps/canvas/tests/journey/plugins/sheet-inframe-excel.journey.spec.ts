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

// Sheet ADR 510 — Excel inside the frame, end to end in the editor: a
// placed range is a window onto the sheet. Enter it with the keyboard,
// page down through the sheet, leave: the page's table shows the window
// you left, as whole sheet rows in order, and ONE Undo puts the page back.

import { expect, test } from "@playwright/test";

import { Designer } from "../driver/designer";
import { elementScreenCenter, importAndLower, placedValues } from "./sheet-kit";

/** 60 rows × 3 columns: `r<row>c<col>`, 1-based like the sheet. */
const LONG_CSV = Array.from({ length: 60 }, (_, r) =>
  [1, 2, 3].map((c) => `r${r + 1}c${c}`).join(","),
).join("\n");

test.describe("journey · paged.sheet — Excel inside the frame", () => {
  test("enter with Enter, page through the sheet, leave: the page shows the window left, and one Undo restores it @feat:sheet.grid.inframe @feat:sheet.lower.page @feat:sheet.edit.undo @level:gesture", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    const frame = await importAndLower(page, "A1:C5", {
      name: "long.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(LONG_CSV),
    });
    await expect
      .poll(() => placedValues(page), { timeout: 15_000 })
      .toEqual([
        ["r1c1", "r1c2", "r1c3"],
        ["r2c1", "r2c2", "r2c3"],
        ["r3c1", "r3c2", "r3c3"],
        ["r4c1", "r4c2", "r4c3"],
        ["r5c1", "r5c2", "r5c3"],
      ]);

    // ── Enter on the selected frame enters its grid (editor ADR 282). ──
    const at = await elementScreenCenter(page, frame);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    const surface = page.locator('[data-testid="sheet-frame-surface"]');
    await expect(surface).toBeVisible({ timeout: 10_000 });

    // ── Page through the sheet, well past what the page shows. ──
    for (let i = 0; i < 6; i++) await page.keyboard.press("PageDown");
    await page.waitForTimeout(300);

    // ── Leave: the page shows a later window, whole rows in order. ──
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-edit-context-breadcrumb]")).toHaveCount(0);
    let left: string[][] = [];
    await expect
      .poll(
        async () => {
          left = await placedValues(page);
          return left[0]?.[0] ?? "";
        },
        { timeout: 15_000 },
      )
      .not.toBe("r1c1");
    const first = Number(/^r(\d+)c1$/.exec(left[0]![0]!)?.[1]);
    expect(first, "the window moved down the sheet").toBeGreaterThan(5);
    left.forEach((row, i) =>
      expect(row).toEqual([1, 2, 3].map((c) => `r${first + i}c${c}`)),
    );

    // ── One Undo puts the page back where it was. ──
    await page.keyboard.press(
      `${process.platform === "darwin" ? "Meta" : "Control"}+z`,
    );
    await expect
      .poll(async () => (await placedValues(page))[0]?.[0] ?? "", {
        timeout: 15_000,
      })
      .toBe("r1c1");
  });
});
