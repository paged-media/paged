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

// The print-output facts in the running editor (ADR 265): register a CMYK
// profile, make it the working space the way Color settings does, and
// every surface that names the working profile or the print PDF's
// standard switches together: the Prepress bar's chip, the PDF/X-4
// checklist's working-space row, Publication health, the Document Map's
// health footer and the Export Center.

import { test, expect, type Page } from "@playwright/test";

import { openPanel } from "./fidelity/canvas-driver";
import { Designer } from "./journey/driver/designer";

const PROFILE = "Journey Press CMYK";

/** Register `name` (the smallest bytes that read as an ICC profile) and
 *  make it the working space, as Color settings does. */
async function activateProfile(page: Page, name: string): Promise<void> {
  const kind = await page.evaluate(async (profile) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            registerColorProfile: (n: string, b: Uint8Array) => Promise<void>;
            mutate: (m: unknown) => Promise<{ kind: string }>;
          };
        };
      }
    ).__canvas;
    const bytes = new Uint8Array(132);
    bytes[3] = 132;
    bytes.set([0x61, 0x63, 0x73, 0x70], 36);
    await c.client.registerColorProfile(profile, bytes);
    return (
      await c.client.mutate({
        op: "setColorSettings",
        args: {
          cmykProfileName: profile,
          rgbPolicy: null,
          intent: null,
          bpc: null,
        },
      })
    ).kind;
  }, name);
  expect(kind).toBe("mutationApplied");
}

const setMode = (page: Page, mode: string) =>
  page.evaluate(
    (m) =>
      (
        globalThis as unknown as { __canvas: { setMode: (m: string) => void } }
      ).__canvas.setMode(m),
    mode,
  );

test.describe("Print-output facts (ADR 265)", () => {
  test("AC-PRINT-1 — a registered working profile: the bar, the checklist, Health, the Map and Export agree @feat:editor-shell.panels.output-readiness @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    // `:visible`: a panel in another mode's dock stays mounted, hidden,
    // and refreshes when it is shown again.
    const chip = page.locator('[data-cockpit-action="output-profile"]:visible');
    const cmykRow = page.locator('[data-readiness-row="cmyk"]:visible');
    const health = page.locator('[data-status-pill="print-readiness"]:visible');
    const map = page.locator('[data-status-pill="map-print-readiness"]:visible');
    const exportPill = page.locator('[data-status-pill="readiness-pdf-x4"]:visible');

    // Before: no working space. Every surface says so in the same words.
    await setMode(page, "prepress");
    await expect(chip).toHaveText("No CMYK profile");
    await openPanel(page, "paged.output-readiness");
    await expect(cmykRow).toHaveAttribute("data-readiness-pass", "false");
    await openPanel(page, "paged.publication-health");
    await expect(health).toHaveText("Ready · PDF 1.7");
    await expect(health).toHaveAttribute("data-tone", "ready");

    await activateProfile(page, PROFILE);

    // After: the profile is active, so the checklist passes the row the
    // bar names, and the print PDF is PDF/X-4 everywhere.
    await expect(chip).toHaveText(PROFILE);
    await openPanel(page, "paged.output-readiness");
    await expect(cmykRow).toHaveAttribute("data-readiness-pass", "true");
    await expect(cmykRow).toContainText(PROFILE);
    await openPanel(page, "paged.publication-health");
    await expect(health).toHaveText("Ready · X-4");
    await openPanel(page, "paged.document-map");
    await expect(map).toHaveText("Ready · X-4");
    // Export mode shows the Export Center on the canvas and may hold it
    // in a dock as well: every Print PDF pill on screen reads the same.
    await setMode(page, "export");
    await expect(exportPill.first()).toHaveText("Ready · X-4");
    await expect
      .poll(async () => {
        const texts = await exportPill.allTextContents();
        const tones = await exportPill.evaluateAll((els) =>
          els.map((e) => e.getAttribute("data-tone")),
        );
        return (
          texts.length > 0 &&
          texts.every((t) => t === "Ready · X-4") &&
          tones.every((t) => t === "ready")
        );
      })
      .toBe(true);
  });
});
