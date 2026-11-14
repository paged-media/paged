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

// Session continuity (UX audit F-06; editor ADR 1224): a reload comes back
// to the document the user worked on (from the local library) when the
// recovery journal offers nothing; File ▸ Close goes back to the empty
// canvas, and a closed document is not reopened; File ▸ Open recent… lists
// the library's documents and opens one. Model and history asserted.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { openCanvas } from "../fidelity/canvas-driver";
import { historyDepth } from "./harness/history";
import { modelSnapshot } from "./harness/model-dump";
import { clickMenuRow } from "./harness/shell-surface";
import { loadUxiFixture } from "./harness/uxi-fixtures";

type Win = {
  __canvas?: {
    ready?: boolean;
    registries: { commands: { invoke(id: string): Promise<unknown> } };
  };
};

const LAST = "paged.session.lastDocument.v1";

const lastDocument = (page: Page) =>
  page.evaluate((key) => localStorage.getItem(key), LAST);

const ready = (page: Page) =>
  page.evaluate(() => Boolean((globalThis as unknown as Win).__canvas?.ready));

/** Open fixture A and wait until the library has taken it in (the key
 *  that brings it back names it). */
async function openRemembered(page: Page): Promise<void> {
  await openCanvas(page);
  await loadUxiFixture(page, "A");
  await expect
    .poll(() => lastDocument(page), { timeout: 30_000 })
    .not.toBeNull();
}

test.describe("session continuity (F-06)", () => {
  test("a reload reopens the document worked on last, as it was, with nothing to undo @feat:editor-shell.file-intake @feat:editor-shell.panels.library @level:happy", async ({
    page,
  }) => {
    await openRemembered(page);
    const model = await modelSnapshot(page);
    await openCanvas(page);
    await expect.poll(() => ready(page), { timeout: 30_000 }).toBe(true);
    await expect(page.locator("[data-document-chip]")).toContainText("uxi-a");
    expect(await modelSnapshot(page)).toBe(model);
    expect((await historyDepth(page)).undo).toBe(0);
  });

  test("File ▸ Close goes to the empty canvas; the next start reopens nothing; Open recent… brings it back @feat:editor-shell.file-intake @feat:editor-shell.menus @level:edge", async ({
    page,
  }) => {
    covers(
      "menu:File/Close",
      "command:paged.file.close",
      "menu:File/Open recent…",
      "command:paged.file.openRecent",
    );
    await openRemembered(page);
    const model = await modelSnapshot(page);
    await clickMenuRow(page, "File/Close");
    await expect(page.locator("[data-empty-canvas]")).toBeVisible();
    await expect.poll(() => lastDocument(page)).toBeNull();
    // The next start: nothing reopens.
    await openCanvas(page);
    await page.waitForTimeout(2_000);
    await expect(page.locator("[data-empty-canvas]")).toBeVisible();
    // File ▸ Open recent… lists the library's document; it opens.
    await clickMenuRow(page, "File/Open recent…");
    const row = page.locator('[data-open-recent-kind="library"]').first();
    await expect(row).toContainText("uxi-a");
    await row.click();
    await expect.poll(() => ready(page), { timeout: 30_000 }).toBe(true);
    expect(await modelSnapshot(page)).toBe(model);
  });
});
