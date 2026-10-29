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
// Journey: Word's Track Changes (doc ADR 613, engine ADR 1037, editor ADR
// 300). A .docx opened with File ▸ Open: Cmd+Shift+E turns tracking on (the
// status bar says so); typed text is recorded as an insertion, a deleted
// word stays in the story struck through and gets a balloon in the margin
// band; the Review panel's Accept All resolves both in one step, which
// Cmd+Z takes back; No Markup empties the band.

import { expect, test } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import {
  collection,
  get,
  invoke,
  offsetOf,
  openStructure,
  select,
  texts,
} from "./doc-structure-kit";

interface Change {
  kind?: string;
  text?: string;
  userName?: string;
}

test.describe("journey · Word track changes", () => {
  test.setTimeout(180_000);

  test("a Word user tracks an insertion and a deletion, accepts them and undoes the accept @feat:plugin-doc.standalone-open @feat:plugin-doc.edit-context @level:happy", async ({
    page,
  }) => {
    await openStructure(page);
    const changes = () => collection<Change>(page, "trackedChanges");
    const line = "A closing";
    const at = await offsetOf(page, line);
    await select(page, at);
    await expect(
      page.locator('[data-control-bar="contributed"] [data-word-home]'),
    ).toBeVisible({ timeout: 10_000 });

    // The margin band stands beside the page: zoomed out, page and band
    // both fit the canvas, as a reviewer sets the view.
    for (let i = 0; i < 3; i++) await invoke(page, "paged.view.zoomOut");
    covers(
      "keybinding:cmd+shift+e→media.paged.doc.command.review.toggleTrackChanges",
    );
    await page.keyboard.press("Meta+Shift+e");
    await expect(
      page.locator('[data-word-status="trackChanges"]'),
    ).toHaveAttribute("data-tracking", "on", { timeout: 10_000 });
    await expect
      .poll(() => get(page, "doc", "documentTrackChanges"))
      .toBe(true);

    // Typing is recorded as an insertion by the reviewer.
    await page.keyboard.type("New ");
    await expect
      .poll(async () => (await changes()).map((c) => [c.kind, c.text]))
      .toContainEqual(["insert", "New "]);

    // A forward Delete over "A " keeps the text, struck through, and the
    // caret steps past it: the next Delete takes the next character.
    await select(page, at + "New ".length, at + "New A ".length);
    await page.keyboard.press("Delete");
    await expect
      .poll(async () => (await changes()).map((c) => c.kind))
      .toContain("delete");
    expect((await texts(page)).some((p) => p.startsWith(`New ${line}`))).toBe(
      true,
    );

    // The deletion's balloon stands in the margin band.
    await expect(
      page.locator('[data-margin-balloon][data-margin-kind="delete"]'),
    ).toHaveCount(1, { timeout: 10_000 });

    // The Review panel's Accept All: the insertion stays, the deletion goes.
    covers("command:media.paged.doc.command.review.showReview");
    await invoke(page, "media.paged.doc.command.review.showReview");
    const panel = page.locator("[data-review-panel]");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await panel.locator("[data-review-accept-all]").click();
    await expect.poll(async () => (await changes()).length).toBe(0);
    await expect
      .poll(async () =>
        (await texts(page)).some((p) => p.startsWith("New closing")),
      )
      .toBe(true);

    // One undo step brings both changes back.
    await invoke(page, "paged.editor.undo");
    await expect.poll(async () => (await changes()).length).toBe(2);

    // No Markup shows the final text and empties the band.
    covers("command:media.paged.doc.command.review.markupNone");
    await panel.locator("[data-review-view]").selectOption("none");
    await expect
      .poll(() => get(page, "doc", "documentMarkupView"))
      .toBe("none");
    await expect(page.locator("[data-margin-balloon]")).toHaveCount(0);
  });
});
