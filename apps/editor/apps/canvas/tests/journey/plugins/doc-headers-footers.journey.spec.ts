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

// Journey: Word headers and footers (doc ADR 611, editor ADR 301, contract
// C6). A .docx opened with File ▸ Open shows each section's headers on its
// masters; a double-click in page 1's header band edits that page's
// header in place (the body dimmed, the header bar with Word's options),
// typing lands in the master's story, and Esc returns to the body.

import { expect, test } from "@playwright/test";

import { screenPoint } from "../../e2e/harness/viewport";
import { collection, openStructure, texts } from "./doc-structure-kit";

test.describe("journey · Word headers and footers", () => {
  test.setTimeout(120_000);

  test("a Word user edits the first page's header in place and returns with Esc @feat:plugin-doc.standalone-open @feat:plugin-doc.edit-context @level:happy", async ({
    page,
  }) => {
    await openStructure(page);
    // The section stories' rules name the masters; page 1 shows the
    // first-page master.
    const pages = await collection<{ selfId: string; appliedMaster?: string }>(
      page,
      "pages",
    );
    expect(pages[0]!.appliedMaster).toBe("docx_m1");
    expect(await texts(page, "docx_m1_h")).toEqual(["Title page header"]);

    // Double-click in the header band (above the 54 pt top margin).
    const at = await screenPoint(page, 120, 34);
    await page.mouse.dblclick(at.x, at.y);
    const bar = page.locator("[data-sub-context-bar]");
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await expect(bar).toContainText("First Page Header -Section 1-");
    await expect(page.locator("[data-sub-context-veil]")).toBeVisible();
    await expect(
      bar.locator(
        '[data-command="media.paged.doc.command.word.differentFirstPage"]',
      ),
    ).toBeVisible();

    // Typing goes into the master's header story.
    await page.keyboard.type("Draft ");
    await expect
      .poll(async () => (await texts(page, "docx_m1_h"))[0] ?? "")
      .toContain("Draft");

    // Esc returns to the body.
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
  });
});
