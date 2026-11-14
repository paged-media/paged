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

// The publication's issues on the page (editor ADR 1223; the UX strategy's
// Concept B; task DF7; UX audit F-09): from Publication health an issue is
// one click away — the view moves there (the view left is kept to return
// to), the item is selected, its fixes say what they will do, and a fix
// is one undo step. Going there and back changes neither the model nor
// the history.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { expectHistoryUnchanged, expectUndoSteps } from "./harness/history";
import { modelSnapshot, selectionSnapshot } from "./harness/model-dump";
import { clickMenuRow } from "./harness/shell-surface";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

type Cam = { scale: number; tx: number; ty: number; rotation?: number };
type Win = {
  __canvas: {
    client: {
      mutate(m: unknown): Promise<unknown>;
      collection(name: string): Promise<Array<Record<string, unknown>>>;
      camera: { read: () => Cam };
    };
    registries: { commands: { invoke(id: string): Promise<unknown> } };
  };
};

const camera = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as Win).__canvas.client.camera.read(),
  );

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (cmd) =>
      (globalThis as unknown as Win).__canvas.registries.commands.invoke(cmd),
    id,
  );

const overset = (page: Page) =>
  page.evaluate(async (storyId) => {
    const stories = await (
      globalThis as unknown as Win
    ).__canvas.client.collection("stories");
    return Boolean(stories.find((s) => s.selfId === storyId)?.overset);
  }, UXI_A.note.storyId);

const close = (a: Cam, b: Cam) =>
  Math.abs(a.scale - b.scale) < 1e-6 &&
  Math.abs(a.tx - b.tx) < 0.5 &&
  Math.abs(a.ty - b.ty) < 0.5;

/** Fixture A with its note frame overset (more text than it holds). */
async function oversetNote(page: Page): Promise<void> {
  await openUxiFixture(page, "A");
  await page.evaluate(async (storyId) => {
    await (globalThis as unknown as Win).__canvas.client.mutate({
      op: "insertText",
      args: {
        storyId,
        offset: 0,
        text: "Overset text runs past the frame. ".repeat(80),
        cell: null,
      },
    });
  }, UXI_A.note.storyId);
  await expect.poll(() => overset(page)).toBe(true);
  await invoke(page, "paged.panel.show.paged.publication-health");
}

test.describe("UXI-T55 — issues where they are", () => {
  test("UXI-T55 — an issue goes to its item and selects it; the view comes back; model and history untouched @feat:editor-shell.panels.publication-health @feat:stories-text.overset @level:happy", async ({
    page,
  }) => {
    await oversetNote(page);
    const row = page.locator('[data-issue-kind="overset"]');
    await expect(row).toHaveCount(1);
    const start = await camera(page);
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, async () => {
      await row.locator("[data-issue-go]").click();
      // The overset frame is selected, the view moved to it.
      await expect
        .poll(async () => (await selectionSnapshot(page)).elements)
        .toEqual([{ kind: "textFrame", id: UXI_A.note.id.id }]);
      await expect(row).toHaveAttribute("data-active", "true");
      // Its fixes say what they will do.
      await expect(
        row.locator('[data-issue-fix="expand-frame"]'),
      ).toBeVisible();
      await expect(
        row.locator("[data-issue-fix-preview]").first(),
      ).toContainText("pt down");
      // The view comes back.
      await page.locator("[data-issue-return]").click();
      await expect
        .poll(async () => close(await camera(page), start))
        .toBe(true);
    });
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("UXI-T55 — the issue markers and the page overview show where; a fix is one undo step @feat:editor-shell.panels.publication-health @feat:stories-text.overset @level:happy", async ({
    page,
  }) => {
    await oversetNote(page);
    // The page overview counts page 1's issue.
    await expect(page.locator('[data-issue-page="0"]')).toHaveAttribute(
      "data-issue-count",
      /[1-9]/,
    );
    // Markers on the page, on the frame: View ▸ Show issue markers (the
    // switch in Publication health follows it).
    covers(
      "menu:View/Show issue markers",
      "command:paged.view.toggleIssueMarkers",
    );
    await clickMenuRow(page, "View/Show issue markers");
    await expect(page.locator("[data-issue-markers-toggle]")).toBeChecked();
    await expect(
      page.locator(`[data-issue-marker="item:textFrame:${UXI_A.note.id.id}"]`),
    ).toHaveAttribute("data-issue-kinds", /overset/);
    // A marker click goes to the issue, as the list does.
    await page
      .locator(`[data-issue-marker="item:textFrame:${UXI_A.note.id.id}"]`)
      .dispatchEvent("pointerdown");
    await expect(page.locator('[data-issue-kind="overset"]')).toHaveAttribute(
      "data-active",
      "true",
    );
    // Expand frame: one undo step, and the story fits (or holds more).
    const model = await modelSnapshot(page);
    await expectUndoSteps(page, 1, async () => {
      await page.locator('[data-issue-fix="expand-frame"]').click();
      await expect(
        page.locator('[data-feedback-toast][data-outcome="success"]'),
      ).toContainText("Expand frame");
    });
    await invoke(page, "paged.editor.undo");
    await expect.poll(() => modelSnapshot(page)).toBe(model);
    expect(await overset(page)).toBe(true);
  });
});
