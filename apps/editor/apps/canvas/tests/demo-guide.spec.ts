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

// The demo guide (editor ADR 269) in the real editor: a card floating over
// the editor, friendly first (title, a plain line, steps, play / restart),
// the script behind "Show the script", collapsible to a pill that the
// next visit remembers, docked clear of the canvas.

import { expect, test } from "@playwright/test";

import { Designer } from "./journey/driver/designer";

const SCRIPT = `// Two steps, narrated.
await demo.showInfo("First step", "Something happens.", { autoMs: 200 });
await demo.wait(50);
await demo.showInfo("Second step", "Something else happens.", { autoMs: 200 });
`;

test.describe("the demo guide", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/scripts/guide-probe.js", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: SCRIPT,
      }),
    );
  });

  test("AC-DEMO-GUIDE-1 — friendly first, the script on request, collapse remembered @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open({ search: "?script=guide-probe" });
    const card = page.locator("[data-playground-source]");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-playground-chapter]")).toHaveCount(2);
    await expect(page.locator("[data-playground-code]")).toHaveCount(0);

    // It floats clear of the canvas's centre.
    const box = (await card.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x + box.width).toBeLessThan(vp.width / 2);

    // Plays to its end from the friendly view.
    await page.locator("[data-playground-play]").click();
    await expect(page.locator("[data-playground]")).toHaveAttribute(
      "data-playground-status",
      "done",
      { timeout: 15_000 },
    );
    await expect(page.locator("[data-playground-now]")).toHaveText(
      "Step 2 of 2 · Second step",
    );

    // The script, on request.
    await page.locator("[data-playground-script-toggle]").click();
    await expect(page.locator("[data-playground-code]")).toContainText(
      "Two steps, narrated.",
    );

    // Escape folds it to the pill; the next visit starts folded.
    await page.locator("[data-playground-play]").focus();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    const pill = page.locator("[data-playground-toggle]");
    await expect(pill).toHaveAttribute("aria-expanded", "false");
    await expect(pill).toContainText("guide-probe");
    await page.reload();
    await expect(page.locator("[data-playground]")).toHaveAttribute(
      "data-playground-collapsed",
      "true",
      { timeout: 15_000 },
    );
    await page.locator("[data-playground-toggle]").click();
    await expect(card).toBeVisible();
    // The script disclosure was remembered too.
    await expect(page.locator("[data-playground-code]")).toBeVisible();
  });
});
