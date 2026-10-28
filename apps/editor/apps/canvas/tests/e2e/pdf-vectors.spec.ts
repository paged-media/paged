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

// E2E — WP4.12 (PDF half), publish ADR 658, in the real editor: File ▸
// Import ▸ PDF or AI as Vectors… opens the host's dialog; a picked PDF
// lists its pages; Place lands the page as native items (a clip group, a
// gradient-filled path, an opacity mask, a text frame) in ONE undo step,
// through paged.pdf's typed commands. Object ▸ Convert Placed PDF to
// Vectors is the bundle's menu row, reachable in the bar.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { vectorPdf } from "./harness/vector-pdf";
import { clickMenuRow, openShell } from "./harness/shell-surface";

type Node = { kind: string; children?: Node[] };
type Canvas = {
  __canvas: {
    client: { sceneTree(): Promise<Node[]> };
    registries: {
      commands: { invoke(id: string, payload?: unknown): Promise<unknown> };
      menus?: { list(): Array<{ path: string }> };
    };
  };
};

/** Every node of the scene tree, and how many are clip groups. */
const tree = (page: Page) =>
  page.evaluate(async () => {
    const roots = await (
      globalThis as unknown as Canvas
    ).__canvas.client.sceneTree();
    let n = 0;
    const walk = (x: Node) => {
      n += 1;
      for (const c of x.children ?? []) walk(c);
    };
    for (const r of roots) walk(r);
    return n;
  });

test.describe("WP4.12 — PDF or AI as vectors", () => {
  test("File ▸ Import ▸ PDF or AI as Vectors… places a page in one undo step @feat:editor-shell.import-svg-pdf-vectors @level:happy", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    covers(
      "menu:File/Import/PDF or AI as Vectors…",
      "command:paged.file.importPdfVectors",
    );
    await openShell(page, { doc: true });
    const before = await tree(page);
    await clickMenuRow(page, "File/Import/PDF or AI as Vectors…");
    const dialog = page.locator("[data-pdf-vectors-dialog]");
    await expect(dialog).toBeVisible();
    const chooser = page.waitForEvent("filechooser");
    await dialog.locator("[data-pdf-vectors-choose]").click();
    await (
      await chooser
    ).setFiles({
      name: "art.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(vectorPdf()),
    });
    await expect(dialog.locator("[data-pdf-vectors-page] option")).toHaveCount(
      1,
      {
        timeout: 60_000,
      },
    );
    await expect(dialog.locator("[data-pdf-vectors-page] option")).toHaveText(
      "1 — 300 × 300 pt",
    );
    await dialog.locator("[data-pdf-vectors-place]").click();
    // Nothing to report beyond the shared facts closes the dialog; a
    // report keeps it open with a Close button.
    await expect
      .poll(
        async () =>
          (await dialog.count()) === 0 ||
          (await dialog.locator("[data-pdf-vectors-report]").count()) > 0,
        {
          timeout: 60_000,
        },
      )
      .toBe(true);
    if ((await dialog.count()) > 0) {
      await expect(
        dialog.locator('[data-pdf-vectors-loss="colours"]'),
      ).toBeVisible();
      await dialog.locator("[data-pdf-vectors-cancel]").click();
    }
    await expect
      .poll(() => tree(page), { timeout: 30_000 })
      .toBeGreaterThan(before + 4);
    // One undo takes the whole page away.
    await page.evaluate(() =>
      (globalThis as unknown as Canvas).__canvas.registries.commands.invoke(
        "paged.editor.undo",
      ),
    );
    await expect.poll(() => tree(page)).toBe(before);
  });

  test("Object ▸ Convert Placed PDF to Vectors is in the bar @feat:editor-shell.import-svg-pdf-vectors @level:smoke", async ({
    page,
  }) => {
    covers(
      "menu:Object/Convert Placed PDF to Vectors",
      "command:media.paged.pdf.command.convertPlaced",
    );
    await openShell(page, { doc: true });
    // With nothing selected it refuses, says why, and changes nothing.
    const before = await tree(page);
    await clickMenuRow(page, "Object/Convert Placed PDF to Vectors");
    await expect.poll(() => tree(page)).toBe(before);
  });
});
