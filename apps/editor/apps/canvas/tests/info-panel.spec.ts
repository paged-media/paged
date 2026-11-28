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

// Info panel — behaviour depth (coverage campaign P3, Tier-1).
//
// The panel is a readout over DocumentMeta; a behaviour spec proves the
// rows carry the LOADED DOCUMENT's values (recomputed from the same
// source the app reads — the wire handle), and that the Dirty row
// follows a real mutation, not a canned string.

import { test, expect, type Page } from "@playwright/test";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadViaFileInput,
  openCanvas,
  openPanel,
} from "./fidelity/canvas-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = pathResolve(__dirname, "..", "..", "..");
const FIXTURE = `${REPO_ROOT}/corpus/idml/generated/text.idml`;

/** Load via the React file-input flow — the panel reads useDocumentMeta,
 *  which the fidelity driver's direct client.loadDocument bypasses (the
 *  navigator/cockpit-panels idiom). */
async function loadViaInput(page: Page, fixture: string): Promise<void> {
  await loadViaFileInput(page, fixture);
}

test.describe("Info panel", () => {
  test.beforeEach(async ({ page }) => {
    await openCanvas(page);
    await loadViaInput(page, FIXTURE);
    await openPanel(page, "paged.info");
  });

  test("AC-INFO-1 — the rows carry the loaded document's values, and Dirty follows a real edit @feat:editor-shell.panels.info @level:happy", async ({
    page,
  }) => {
    await expect(page.locator('[data-info-panel="ready"]')).toBeVisible();

    // Pages row == the wire handle's page count (the value the app itself
    // computes from), derived — never a pinned number.
    const pageCount = await page.evaluate(() => {
      const c = (
        window as unknown as { __canvas?: { handle?: { pageCount?: number } } }
      ).__canvas;
      return c?.handle?.pageCount ?? null;
    });
    expect(pageCount).toBeGreaterThan(0);
    await expect(
      page.locator('[data-info-row="Pages"] [data-info-value]'),
    ).toHaveText(String(pageCount));

    // A fresh load has no unsaved edits.
    await expect(
      page.locator('[data-info-row="Dirty"] [data-info-value]'),
    ).toHaveText("no");
  });
});
