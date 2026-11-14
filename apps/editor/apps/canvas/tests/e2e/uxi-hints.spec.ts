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

// Modifier hints on the canvas (the interaction specification's §7.5 and
// §11.4; plan task IC10, extensions ADR 1109): with a tool in hand the
// canvas names what the modifiers do — the host's words for the Selection
// tool, the Pen's own (its handler's `modifierHints`) — and lights the key
// held. Hints change nothing: the model and the history stay as they were.

import { expect, test } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { undoDepth } from "./harness/history";
import { activateTool } from "./harness/interaction";
import { clickMenuRow } from "./harness/shell-surface";
import { modelSnapshot } from "./harness/model-dump";
import { openUxiFixture } from "./harness/uxi-fixtures";

test.describe("UXI modifier hints (IC10)", () => {
  test("the canvas names what the modifiers do with the tool in hand and lights the one held @feat:editor-tools.gesture-lifecycle @level:happy @uxi:UXI-GST-015", async ({
    page,
  }) => {
    covers("tool:paged.tool.select", "tool:paged.tool.pen");
    await openUxiFixture(page, "A");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await activateTool(page, "paged.tool.select");
    const strip = page.locator('[data-modifier-hints="paged.tool.select"]');
    await expect(strip).toBeVisible();
    const shift = strip.locator('[data-modifier-hint="shift"]');
    await expect(shift).not.toHaveAttribute("data-held", "");
    await page.keyboard.down("Shift");
    await expect(shift).toHaveAttribute("data-held", "");
    await page.keyboard.up("Shift");
    await expect(shift).not.toHaveAttribute("data-held", "");
    // The Pen names its own (its handler's hints).
    await activateTool(page, "paged.tool.pen");
    const pen = page.locator('[data-modifier-hints="paged.tool.pen"]');
    await expect(pen).toContainText("45°");
    expect(await modelSnapshot(page), "hints change nothing").toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });

  test('past a tool\'s first uses the hints recede; Edit ▸ Settings ▸ "Keep modifier hints visible" keeps them, remembered @feat:editor-shell.menus @level:happy', async ({
    page,
  }) => {
    covers(
      "menu:Edit/Settings/Keep modifier hints visible",
      "command:paged.preferences.modifierHints",
      "setting:paged.modifierHints.always",
      "setting:paged.modifierHints.uses",
    );
    // The Selection tool has had its five first uses.
    await page.addInitScript(() =>
      localStorage.setItem(
        "paged.modifierHints.uses",
        JSON.stringify({ "paged.tool.select": 5 }),
      ),
    );
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
    const model = await modelSnapshot(page);
    const strip = page.locator('[data-modifier-hints="paged.tool.select"]');
    await expect(strip).toHaveCount(0);
    await clickMenuRow(page, "Edit/Settings/Keep modifier hints visible");
    await expect(strip).toBeVisible();
    expect(
      await page.evaluate(() =>
        localStorage.getItem("paged.modifierHints.always"),
      ),
    ).toBe("true");
    await clickMenuRow(page, "Edit/Settings/Keep modifier hints visible");
    await expect(strip).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("paged.modifierHints.always"),
      ),
    ).toBe(null);
    expect(await modelSnapshot(page)).toBe(model);
  });
});
