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

// Editor ADR 288 — Asset Export in the real editor: File ▸ Export ▸ Asset
// Export… opens the panel; Object ▸ Collect for Export collects the
// selection (one asset per item, or one for all); Collect All Artboards
// and Pages and Export All write the files the engine encoded, several as
// one ZIP; the panel's own Export writes a JPEG at 2x.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import {
  SHELL,
  clickMenuRow,
  openPanels,
  openShell,
  select,
} from "./harness/shell-surface";

type Canvas = {
  __canvas: {
    registries: {
      commands: { invoke(id: string, payload?: unknown): Promise<unknown> };
    };
  };
};

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (cmd) =>
      (globalThis as unknown as Canvas).__canvas.registries.commands.invoke(
        cmd,
      ),
    id,
  );

const panel = (page: Page) => page.locator('[data-asset-export-panel="ready"]');

const assetRows = (page: Page) =>
  panel(page)
    .locator("[data-asset-row]")
    .evaluateAll((rows) =>
      rows.map((r) => [
        (r as HTMLElement).dataset.assetKind,
        (r.querySelector("[data-asset-name]") as HTMLInputElement).value,
      ]),
    );

async function bytesOf(download: import("@playwright/test").Download) {
  const chunks: Buffer[] = [];
  for await (const c of await download.createReadStream())
    chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

test.describe("Asset Export", () => {
  test("File ▸ Export ▸ Asset Export… opens the panel @feat:editor-shell.panels.asset-export @level:happy", async ({
    page,
  }) => {
    covers(
      "menu:File/Export/Asset Export…",
      "command:paged.file.assetExport",
      "panel:paged.object-export",
    );
    await openShell(page, { doc: true });
    await clickMenuRow(page, "File/Export/Asset Export…");
    await expect(panel(page)).toBeVisible();
    expect(await openPanels(page)).toContain("paged.object-export");
    await expect(panel(page).locator("[data-asset-empty]")).toBeVisible();
  });

  test("Object ▸ Collect for Export: as multiple assets, then as one @feat:editor-shell.panels.asset-export @level:happy", async ({
    page,
  }) => {
    covers(
      "menu:Object/Collect for Export/As Multiple Assets",
      "command:paged.assetExport.collectMultiple",
      "menu:Object/Collect for Export/As Single Asset",
      "command:paged.assetExport.collectSingle",
    );
    await openShell(page, { doc: true });
    await select(page, [SHELL.frame, SHELL.group]);
    await clickMenuRow(page, "Object/Collect for Export/As Multiple Assets");
    await expect(panel(page)).toBeVisible();
    await expect.poll(() => assetRows(page)).toHaveLength(2);
    expect((await assetRows(page)).every(([k]) => k === "object")).toBe(true);
    // The same items again are not collected twice; as one asset they are
    // a new asset.
    await clickMenuRow(page, "Object/Collect for Export/As Single Asset");
    await expect.poll(() => assetRows(page)).toHaveLength(3);
  });

  test("Collect all pages, Export All: one ZIP of the engine's files @feat:editor-shell.panels.asset-export @level:happy", async ({
    page,
  }) => {
    covers(
      "command:paged.assetExport.collectPages",
      "command:paged.assetExport.exportAll",
    );
    await openShell(page, { doc: true });
    await invoke(page, "paged.assetExport.collectPages");
    await expect(panel(page)).toBeVisible();
    await expect
      .poll(() => assetRows(page))
      .toEqual([
        ["page", "Page 1"],
        ["page", "Page 2"],
      ]);
    const download = page.waitForEvent("download");
    await invoke(page, "paged.assetExport.exportAll");
    const file = await download;
    expect(file.suggestedFilename()).toBe("shell-matrix-assets.zip");
    const zip = await bytesOf(file);
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = zip.toString("latin1");
    expect(text).toContain("Page 1.png");
    expect(text).toContain("Page 2.png");
    expect(text).toContain("\x89PNG");
  });

  test("the panel exports the selected object as a JPEG at 2x, encoded by the engine @feat:editor-shell.panels.asset-export @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.object-export");
    await openShell(page, { doc: true });
    await select(page, [SHELL.frame]);
    await clickMenuRow(page, "File/Export/Asset Export…");
    await panel(page)
      .getByRole("button", { name: "Add selection (one asset per object)" })
      .click();
    await expect.poll(() => assetRows(page)).toHaveLength(1);
    const setting = panel(page).locator("[data-asset-setting]").first();
    await setting.locator("[data-asset-scale] select").selectOption("2");
    await setting.locator("[data-asset-format] select").selectOption("jpeg");
    await expect(setting.locator("[data-asset-suffix]")).toHaveValue("@2x");
    const download = page.waitForEvent("download");
    await panel(page).locator("[data-asset-export-selected]").click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/@2x\.jpg$/);
    const jpeg = await bytesOf(file);
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    await expect(panel(page).locator("[data-asset-status-message]")).toHaveText(
      "Exported 1 file.",
    );
  });
});
