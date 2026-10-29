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
// Journey: Word comments (doc ADR 613, engine ADR 1020, editor ADR 300). A
// .docx opened with File ▸ Open: Cmd+Alt+M with the caret in a word opens a
// new comment's balloon beside the page; the comment is typed into it; a
// reply is typed under it; Resolve marks the thread done and Delete takes
// the thread away.

import { expect, test } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import {
  collection,
  invoke,
  offsetOf,
  openStructure,
  select,
} from "./doc-structure-kit";

interface Comment {
  id: string;
  parentId?: string | null;
  text: string;
  anchorText?: string;
  resolved?: boolean;
}

test.describe("journey · Word comments", () => {
  test.setTimeout(180_000);

  test("a Word user comments a word, replies, resolves and deletes the thread @feat:plugin-doc.standalone-open @feat:plugin-doc.edit-context @level:happy", async ({
    page,
  }) => {
    await openStructure(page);
    const comments = () => collection<Comment>(page, "comments");
    // The caret inside "closing" of "A closing…".
    const at = (await offsetOf(page, "A closing")) + 4;
    await select(page, at);
    await expect(
      page.locator('[data-control-bar="contributed"] [data-word-home]'),
    ).toBeVisible({ timeout: 10_000 });

    // The margin band stands beside the page: zoomed out, page and band
    // both fit the canvas, as a reviewer sets the view.
    for (let i = 0; i < 3; i++) await invoke(page, "paged.view.zoomOut");
    covers("keybinding:cmd+alt+m→media.paged.doc.command.review.newComment");
    await page.keyboard.press("Meta+Alt+m");
    const edit = page.locator("[data-review-edit]");
    await expect(edit).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await comments()).map((c) => c.anchorText))
      .toEqual(["closing"]);
    await edit.fill("Too informal?");
    await edit.press("Enter");
    await expect
      .poll(async () => (await comments()).map((c) => c.text))
      .toEqual(["Too informal?"]);
    const [root] = await comments();

    // A reply typed under it, in its balloon.
    const reply = page.locator(`[data-review-reply-input="${root!.id}"]`);
    await reply.fill("It is fine.");
    await reply.press("Enter");
    await expect
      .poll(async () =>
        (await comments())
          .filter((c) => c.parentId === root!.id)
          .map((c) => c.text),
      )
      .toEqual(["It is fine."]);

    // Next Comment brings the thread (and its balloon) into view.
    await invoke(page, "media.paged.doc.command.review.nextComment");
    covers("command:media.paged.doc.command.review.resolveComment");
    await page
      .locator(`[data-margin-balloon] [data-review-resolve="${root!.id}"]`)
      .click();
    await expect
      .poll(
        async () => (await comments()).find((c) => c.id === root!.id)?.resolved,
      )
      .toBe(true);

    covers("command:media.paged.doc.command.review.deleteComment");
    await page
      .locator(`[data-margin-balloon] [data-review-delete="${root!.id}"]`)
      .click();
    await expect.poll(async () => (await comments()).length).toBe(0);
    await expect(page.locator("[data-margin-balloon]")).toHaveCount(0);
  });
});
