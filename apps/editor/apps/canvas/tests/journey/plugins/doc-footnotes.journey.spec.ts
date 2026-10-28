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

// Journey: Word footnotes (doc ADR 611). A .docx opened with File ▸ Open
// has its footnotes at their references; Cmd+Alt+F at the caret inserts a
// new one, and Cmd+Z takes it back in one step.

import { expect, test } from "@playwright/test";

import {
  collection,
  invoke,
  offsetOf,
  openStructure,
  select,
} from "./doc-structure-kit";

test.describe("journey · Word footnotes", () => {
  test.setTimeout(120_000);

  test("a Word user inserts a footnote with Cmd+Alt+F and undoes it @feat:plugin-doc.standalone-open @feat:plugin-doc.edit-context @level:happy", async ({
    page,
  }) => {
    await openStructure(page);
    const notes = () =>
      collection<{ text: string; storyId: string }>(page, "footnotes");
    await expect
      .poll(async () => (await notes()).map((n) => n.text))
      .toEqual(["First note text.", "Second note text."]);

    // The caret after "A closing" (Word's footnote key).
    const at = (await offsetOf(page, "A closing")) + "A closing".length;
    await select(page, at);
    await expect(
      page.locator('[data-control-bar="contributed"] [data-word-home]'),
    ).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Meta+Alt+f");
    await expect.poll(async () => (await notes()).length).toBe(3);

    await invoke(page, "paged.editor.undo");
    await expect.poll(async () => (await notes()).length).toBe(2);
  });
});
