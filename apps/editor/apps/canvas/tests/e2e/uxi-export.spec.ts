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

// Guided export (editor ADR 1221; track DF6 of interaction-plan.md; the
// interaction specification's UXI-FIL-004 and UXI-FIL-005; UX audit F-12):
// File ▸ Export PDF… checks readiness BEFORE anything starts. A standard the
// document cannot meet (PDF/X-4 without an output intent, ADR 238) is
// refused with its reason and the panel that fixes it; nothing is sent,
// nothing is downloaded, no success is claimed, and the document and its
// history are as they were. A standard it can meet exports with its stages
// shown and a result that names the file and where it went.
//
// Fixture A is an IDML package with no CMYK working space, so PDF/X-4 has
// no output intent; fixture H (`?debug=chaos`) holds each page's reply so
// the page stage is seen.

import { expect, test, type Page } from "@playwright/test";

import { clearChaos, delayReply } from "./harness/chaos";
import { historyDepth } from "./harness/history";
import { modelSnapshot } from "./harness/model-dump";
import { clickMenuRow } from "./harness/shell-surface";
import { openUxiFixture } from "./harness/uxi-fixtures";

const dialog = (page: Page) => page.locator("[data-export-dialog]");
const result = (page: Page) =>
  page.locator('[data-feedback-key="paged.export.pdf"]');

async function openExport(page: Page): Promise<void> {
  await clickMenuRow(page, "File/Export PDF…");
  await expect(dialog(page)).toBeVisible();
  // The check has read the document (its fonts are listed).
  await expect(
    dialog(page).locator('[data-export-fact="fonts"]'),
  ).not.toContainText("Listed once");
}

test.describe("UXI-T68 — Request unsupported PDF export standard", () => {
  test("UXI-T68 — PDF/X-4 without an output intent is refused before anything starts; nothing is written and nothing changes @feat:the-renderer.pdf-export @feat:editor-shell.panels.preflight @level:edge", async ({
    page,
  }) => {
    await openUxiFixture(page, "A");
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);
    const downloads: string[] = [];
    page.on("download", (d) => downloads.push(d.suggestedFilename()));

    await openExport(page);
    await dialog(page)
      .locator("select[data-export-standard]")
      .selectOption("pdfx4");
    const blocker = dialog(page).locator('[data-export-check="standard"]');
    await expect(blocker).toHaveAttribute("data-export-check-level", "blocker");
    await expect(blocker).toContainText(
      "PDF/X-4 needs an output intent profile and this document has none",
    );
    await expect(blocker.locator("[data-export-check-fix]")).toHaveAttribute(
      "data-export-check-fix",
      "paged.color-settings",
    );
    await expect(dialog(page).locator("[data-export-summary]")).toHaveText(
      "1 problem blocks the export",
    );
    const exportButton = dialog(page).locator("[data-export-confirm]");
    await expect(exportButton).toBeDisabled();
    await exportButton.click({ force: true });
    // Nothing started: no stage, no file, no claimed success.
    await page.waitForTimeout(500);
    await expect(dialog(page).locator("[data-export-progress]")).toHaveCount(0);
    expect(downloads).toEqual([]);
    await expect(result(page)).toHaveCount(0);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);
  });

  test("UXI-T68 — the standard the document can meet exports with its stages, and the result names the file and where it went @feat:the-renderer.pdf-export @feat:editor-shell.panels.preflight @level:happy", async ({
    page,
  }) => {
    await openUxiFixture(page, "A", "?debug=chaos");
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);

    await openExport(page);
    await dialog(page)
      .locator("select[data-export-standard]")
      .selectOption("pdf17");
    await expect(
      dialog(page).locator('[data-export-check="standard"]'),
    ).toHaveAttribute("data-export-check-level", "ok");
    // Each page's reply held: the page stage, with its measure, is seen.
    await delayReply(page, "exportPdfPage", 700);
    const download = page.waitForEvent("download");
    await dialog(page).locator("[data-export-confirm]").click();
    const progress = dialog(page).locator("[data-export-progress]");
    await expect(progress).toHaveAttribute("data-export-stage", "pages");
    await expect(progress.locator('[role="progressbar"]')).toHaveAttribute(
      "aria-valuemax",
      /\d+/,
    );
    const file = await download;
    await clearChaos(page);
    expect(file.suggestedFilename()).toMatch(/\.pdf$/);
    await expect(dialog(page)).toHaveCount(0);
    await expect(result(page)).toContainText(file.suggestedFilename());
    await expect(result(page)).toContainText("in your downloads");
    await expect(result(page)).toHaveAttribute("data-outcome", "success");
    // An export changes neither the document nor its history.
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);
  });
});
