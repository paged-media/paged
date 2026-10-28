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

// Journey: Word fields and the table of contents (doc ADR 612). A .docx
// opened with File ▸ Open keeps its fields live (the TOC's page numbers,
// REF and PAGEREF to its bookmarks); F9 updates, Shift+F9 shows the
// codes, and Insert ▸ Table of contents builds one from the headings.

import { expect, test } from "@playwright/test";

import {
  content,
  get,
  invoke,
  offsetOf,
  openStructure,
  select,
  texts,
} from "./doc-structure-kit";

test.describe("journey · Word fields and the table of contents", () => {
  test.setTimeout(120_000);

  test("a Word user toggles field codes, updates fields and inserts a table of contents @feat:plugin-doc.standalone-open @feat:plugin-doc.edit-context @level:happy", async ({
    page,
  }) => {
    await openStructure(page);
    const c = await content(page);
    const codes = (c?.paragraphs ?? []).flatMap((p) =>
      p.runs.flatMap((r) => (r.fieldCode ? [r.fieldCode] : [])),
    );
    expect(codes).toContain("PAGEREF _Toc1 \\h");
    expect(codes).toContain("REF _Toc2 \\h");
    expect((c?.textAnchors ?? []).map((a) => a.name)).toEqual([
      "_Toc1",
      "_Toc2",
    ]);

    // The caret in the body: Word's keys apply.
    await select(page, await offsetOf(page, "See "));
    await expect(
      page.locator('[data-control-bar="contributed"] [data-word-home]'),
    ).toBeVisible({ timeout: 10_000 });

    // Shift+F9 shows the codes, again hides them.
    await page.keyboard.press("Shift+F9");
    await expect
      .poll(() => get(page, "doc", "documentShowFieldCodes"))
      .toBe(true);
    await page.keyboard.press("Shift+F9");
    await expect
      .poll(() => get(page, "doc", "documentShowFieldCodes"))
      .toBe(false);

    // F9: the fields already show the layout's values.
    await page.keyboard.press("F9");
    expect((await texts(page))[1]).toMatch(/^Introduction\t\d+$/);

    // Insert ▸ Table of contents from the heading styles.
    const before = (await texts(page)).length;
    await select(page, await offsetOf(page, "A closing"));
    await invoke(page, "media.paged.doc.command.word.insertToc");
    await expect
      .poll(async () => (await texts(page)).length)
      .toBeGreaterThan(before);
  });
});
