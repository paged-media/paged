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

// File ▸ New document… (editor ADR 1220, UX audit F-04): the dialog's
// Create makes the document it describes — its size, its pages, the bleed,
// every page's margins, columns and gutter — through the engine's own
// writes, as ONE undo step, and the new document opens clean. Asserted on
// the model (the object model's reads) and the history, not the chrome.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { clickMenuRow, openShell } from "./harness/shell-surface";
import { objGet } from "./harness/objects";
import { undoDepth } from "./harness/history";

const MM = 72 / 25.4;

interface Canvas {
  __canvas: {
    client: { documentMeta(): Promise<{ dirty: boolean; pageCount: number }> };
  };
}

const meta = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as Canvas).__canvas.client.documentMeta(),
  );

async function fill(page: Page, field: string, text: string) {
  const input = page.locator(`[data-new-document-field="${field}"] input`);
  await input.fill(text);
  await input.press("Enter");
}

test.describe("File ▸ New document…", () => {
  test("Create makes the page size, pages, bleed, margins and columns it shows, as one undo step @feat:editor-shell.file-intake @level:happy", async ({
    page,
  }) => {
    covers("menu:File/New document…", "command:paged.file.newDialog");
    await openShell(page, { doc: false });
    await clickMenuRow(page, "File/New document…");
    const dialog = page.locator("[data-new-document-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-new-document-category="custom"]').click();
    await dialog.locator("select[data-new-document-units]").selectOption("mm");
    await fill(page, "width", "210");
    await fill(page, "height", "297");
    await fill(page, "pages", "3");
    await fill(page, "bleed", "3");
    for (const side of ["Top", "Bottom", "Inside", "Outside"])
      await fill(page, `margin${side}`, "20");
    await fill(page, "columns", "2");
    await fill(page, "gutter", "5");
    await expect(dialog.locator("[data-new-document-summary]")).toHaveText(
      "210 × 297 mm · 3 pages · 2 columns",
    );
    await expect(dialog.locator("[data-new-document-preview]")).toHaveAttribute(
      "data-preview-columns",
      "2",
    );
    await dialog.locator("[data-new-document-create]").click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(async () => (await meta(page)).pageCount).toBe(3);
    const near = (v: unknown, want: number) =>
      typeof v === "number" && Math.abs(v - want) < 0.01;
    await expect
      .poll(async () =>
        near(await objGet(page, "page:#3", "pageColumnCount"), 2),
      )
      .toBe(true);
    for (const n of [1, 2, 3]) {
      const bounds = (await objGet(
        page,
        `page:#${n}`,
        "pageBounds",
      )) as number[];
      expect(near(bounds[3]! - bounds[1]!, 210 * MM)).toBe(true);
      expect(near(bounds[2]! - bounds[0]!, 297 * MM)).toBe(true);
      for (const path of [
        "pageMarginTop",
        "pageMarginBottom",
        "pageMarginLeft",
        "pageMarginRight",
      ])
        expect({
          n,
          path,
          ok: near(await objGet(page, `page:#${n}`, path), 20 * MM),
        }).toEqual({ n, path, ok: true });
      expect(
        near(await objGet(page, `page:#${n}`, "pageColumnGutter"), 5 * MM),
      ).toBe(true);
    }
    expect(near(await objGet(page, "doc", "documentBleedTop"), 3 * MM)).toBe(
      true,
    );
    // The setup is how the document was made: one undo step, and the
    // document opens clean.
    expect(await undoDepth(page)).toBe(1);
    expect((await meta(page)).dirty).toBe(false);
  });

  test("Cancel creates nothing @feat:editor-shell.file-intake @level:edge", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    const before = await meta(page);
    const depth = await undoDepth(page);
    await clickMenuRow(page, "File/New document…");
    const dialog = page.locator("[data-new-document-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-new-document-cancel]").click();
    await expect(dialog).toHaveCount(0);
    expect((await meta(page)).pageCount).toBe(before.pageCount);
    expect(await undoDepth(page)).toBe(depth);
  });
});
