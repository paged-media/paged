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

// Doc ADR 630 — the Story view and the Story Map in the running editor, on
// the interaction contract's fixture C (one story threaded through two
// frames): the Story view writes the engine's story itself (no second text
// model) as one undo step and gives the canvas back where it was; the
// Story Map shows the thread by page and its chip navigates, a jump Go back
// returns from (editor ADR 1211). Each test asserts the document and the
// history.

import { expect, test, type Page } from "@playwright/test";

import { historyDepth } from "./harness/history";
import { dumpStory } from "./harness/model-dump";
import { selectedIds } from "./harness/gesture-kit";
import { UXI_C, openUxiFixture } from "./harness/uxi-fixtures";

async function invoke(page: Page, id: string): Promise<unknown> {
  return page.evaluate(
    (cmd) =>
      (
        globalThis as unknown as {
          __canvas: {
            registries: { commands: { invoke(id: string): Promise<unknown> } };
          };
        }
      ).__canvas.registries.commands.invoke(cmd),
    id,
  );
}

async function camera(page: Page) {
  return page.evaluate(() => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            camera: { read(): { scale: number; tx: number; ty: number } };
          };
        };
      }
    ).__canvas.client.camera.read();
    return {
      scale: Math.round(c.scale * 1e4) / 1e4,
      tx: Math.round(c.tx),
      ty: Math.round(c.ty),
    };
  });
}

test.describe("doc: Story view and Story Map", () => {
  test.describe.configure({ timeout: 120_000 });

  test("the Story view writes the engine's story as one undo step and gives the canvas back where it was @feat:plugin-doc.outline-panel @level:edge", async ({
    page,
  }) => {
    await openUxiFixture(page, "C");
    const before = await camera(page);
    const history = await historyDepth(page);

    await invoke(page, "media.paged.doc.command.storyView");
    const view = page.locator(`[data-story-view="${UXI_C.storyId}"]`);
    await expect(view).toBeVisible();
    const fields = view.locator("textarea[data-story-paragraph]");
    await expect(fields).toHaveCount(UXI_C.paragraphs.length);
    await expect(fields.first()).toHaveValue(UXI_C.paragraphs[0]);

    // Typing in the second paragraph (non-ASCII text before the caret: the
    // engine's offsets are bytes) is written into the story.
    const second = fields.nth(1);
    await second.click();
    await second.press("End");
    await page.keyboard.type(" Neu");
    await page.keyboard.press("Tab"); // leaving the field commits
    await expect
      .poll(() => dumpStory(page, UXI_C.storyId))
      .toContain(`${UXI_C.paragraphs[1]} Neu`);
    const after = await historyDepth(page);
    expect(after.undo, "one run of typing is one undo step").toBe(
      history.undo + 1,
    );

    // Layout view gives the canvas back, the camera where it was.
    await view.locator("[data-story-view-close]").click();
    await expect(view).toHaveCount(0);
    await expect(
      page.locator('[data-canvas-surface="viewport"]'),
    ).toBeVisible();
    expect(await camera(page)).toEqual(before);

    // The step undoes on the page like any other edit.
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          __canvas: { client: { undo(): Promise<unknown> } };
        }
      ).__canvas.client.undo(),
    );
    await expect
      .poll(() => dumpStory(page, UXI_C.storyId))
      .not.toContain(" Neu");
  });

  test("the Story Map shows the thread by page; a frame chip selects the frame and Go back returns @feat:editor-tools.text.thread-lines @level:edge", async ({
    page,
  }) => {
    await openUxiFixture(page, "C");
    const history = await historyDepth(page);
    await invoke(page, "media.paged.doc.command.storyMap");
    const row = page.locator(`[data-story-map-story="${UXI_C.storyId}"]`);
    await expect(row).toBeVisible();
    const chips = row.locator("[data-story-map-frame]");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveAttribute(
      "data-story-map-frame",
      UXI_C.first.id.id,
    );
    await expect(chips.nth(1)).toHaveText("p. 1");
    await expect(row).not.toHaveAttribute("data-overset", "true");

    // Somewhere else first, so the jump to the frame's page moves.
    const fitted = await camera(page);
    await page.locator('[data-canvas-surface="viewport"]').hover();
    await page.mouse.wheel(0, 300);
    await expect.poll(() => camera(page)).not.toEqual(fitted);
    const before = await camera(page);
    await chips.nth(1).click();
    await expect.poll(() => selectedIds(page)).toEqual([UXI_C.second.id.id]);
    // The jump is recorded: Go back returns the camera to where it was.
    await expect.poll(() => camera(page)).not.toEqual(before);
    await invoke(page, "paged.view.navigateBack");
    await expect.poll(() => camera(page)).toEqual(before);
    // Reading the map and navigating change nothing in the document.
    expect(await historyDepth(page)).toEqual(history);
  });
});
