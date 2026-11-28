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

// W2.12 — Publication health acceptance. The risk rows are now real
// counts off the W0.6 wire summaries (overset stories, missing links,
// low-res images, missing fonts) + the last export's preflight
// findings. The clean `text` fixture reads 0 across the risks (LIVE
// counts, not em-dash seams). Aftercare-D: overset is now wired too —
// the `text-overset` fixture drives a non-zero overset count.

import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

import {
  openCanvas,
  openPanel,
  loadViaFileInput,
} from "./fidelity/canvas-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = pathResolve(__dirname, "..", "..", "..");
const FIXTURE = `${REPO_ROOT}/corpus/idml/generated/text.idml`;
const OVERSET_FIXTURE = `${REPO_ROOT}/corpus/idml/generated/text-overset.idml`;

async function loadFixtureReact(page: Page, fixture: string = FIXTURE) {
  await loadViaFileInput(page, fixture);
  // Publication health is a Design-mode panelSet panel (the kit's left
  // footer; here a standalone DOCKABLE panel — Design's fixed left slot
  // is the Document Map). panelSet membership makes it openable, not
  // auto-mounted, so open it explicitly into the dock the way the panel
  // rail / Window menu would.
  await page.evaluate(() => {
    (
      globalThis as unknown as { __canvas: { setMode: (m: string) => void } }
    ).__canvas.setMode("design");
  });
  await openPanel(page, "paged.publication-health");
}

test.describe("W2.12 — Publication health", () => {
  test("AC-HEALTH-OVERSET — text-overset surfaces a live non-zero overset count @feat:editor-shell.panels.publication-health @level:edge", async ({
    page,
  }) => {
    // Aftercare-D: `text-overset` overflows its frames (Inter shaping is
    // seeded by the React loader), so DocumentStats.overset_stories > 0
    // and the row reads a live count, not a seam.
    await openCanvas(page);
    await loadFixtureReact(page, OVERSET_FIXTURE);
    const panel = page.locator("[data-publication-health]");
    await expect(panel).toBeVisible();
    const overset = panel.locator('[data-risk-row="overset"]');
    await expect(overset).not.toHaveAttribute("data-seam", /.*/);
    await expect
      .poll(
        async () =>
          Number((await overset.getAttribute("data-risk-count")) ?? "0"),
        { timeout: 8_000 },
      )
      .toBeGreaterThan(0);
  });
});
