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

// Publication time travel (editor ADR 1234; the UX strategy's Concept H;
// task PX7): an import is the first checkpoint of the timeline; Save
// checkpoint… keeps the open state, saved or not, without moving the saved
// version; a checkpoint previews read-only and compares with the open
// document (what differs boxed and listed) — neither changes the model or
// the history; Restore makes it the newest version as a NEW state, the open
// document kept first.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { expectHistoryUnchanged, undoDepth } from "./harness/history";
import { modelSnapshot } from "./harness/model-dump";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

type Win = {
  __canvas: {
    client: {
      mutate(m: unknown): Promise<{ kind: string }>;
      elementGeometry(
        ids: unknown[],
      ): Promise<Array<{ itemTransform?: number[] | null }>>;
    };
    registries: { commands: { invoke(id: string): Promise<unknown> } };
  };
};

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (cmd) =>
      (globalThis as unknown as Win).__canvas.registries.commands.invoke(cmd),
    id,
  );

const frontX = (page: Page) =>
  page.evaluate(async (id) => {
    const [g] = await (
      globalThis as unknown as Win
    ).__canvas.client.elementGeometry([id]);
    return g?.itemTransform?.[4] ?? 0;
  }, UXI_A.front.id);

async function clearLibrary(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root
      .removeEntry("paged-library", { recursive: true })
      .catch(() => undefined);
  });
}

test.describe("PX7 — publication time travel", () => {
  test("PX7 — checkpoints keep states without moving the saved version; preview and compare change nothing; restore is a new state @feat:editor-shell.panels.library @feat:editor-shell.panels.history @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.library");
    await openUxiFixture(page, "A");
    await clearLibrary(page);
    await page.reload();
    await openUxiFixture(page, "A");
    await invoke(page, "paged.panel.show.paged.library");
    const panel = page.locator("[data-library-panel]");
    const versions = panel.locator("[data-library-version]");
    await expect(versions).toHaveCount(1);
    // The import is the timeline's first checkpoint.
    const chips = panel.locator("[data-checkpoint]");
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toHaveAttribute(
      "data-checkpoint-kind",
      "import",
    );

    // An unsaved edit: the front rectangle moved 40 pt.
    const x0 = await frontX(page);
    await page.evaluate(
      async ([id, x]) => {
        const c = (globalThis as unknown as Win).__canvas.client;
        await c.mutate({
          op: "moveFrame",
          args: { frameId: id, transform: [1, 0, 0, 1, x, 0] },
        });
      },
      [UXI_A.front.id.id, x0 + 40] as const,
    );
    await expect.poll(() => frontX(page)).toBeCloseTo(x0 + 40, 1);

    // Save checkpoint…: kept on the timeline; the saved versions unchanged.
    await panel.locator("[data-checkpoint-save]").click();
    await panel.locator("[data-checkpoint-name]").fill("Typography pass");
    await panel.locator("[data-checkpoint-keep]").click();
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toHaveText("Typography pass");
    await expect(versions).toHaveCount(1);

    // Preview and compare the import with the open document: read-only.
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(
      page,
      async () => {
        await chips.first().click();
        await panel.locator("[data-checkpoint-preview]").click();
        const dialog = page.locator("[data-compare-dialog]");
        await expect(dialog).toHaveAttribute("data-compare-status", "ready", {
          timeout: 60_000,
        });
        await expect(dialog.locator('[data-compare-side="a"] img')).toHaveCount(
          1,
        );
        await dialog.locator("[data-compare-close]").click();
        await expect(dialog).toHaveCount(0);

        await panel.locator("[data-checkpoint-compare]").click();
        await expect(dialog).toHaveAttribute("data-compare-dialog", "compare");
        await expect(dialog).toHaveAttribute("data-compare-status", "ready", {
          timeout: 60_000,
        });
        // The moved rectangle: a boxed region, and listed as moved.
        expect(
          Number(
            await dialog
              .locator("[data-compare-regions]")
              .getAttribute("data-compare-regions"),
          ),
        ).toBeGreaterThan(0);
        await expect(
          dialog.locator(
            '[data-compare-group="frames"] [data-compare-change="moved"]',
          ),
        ).toContainText(UXI_A.front.id.id);
        await dialog.locator("[data-compare-close]").click();
      },
      "previewing and comparing a checkpoint",
    );
    expect(await modelSnapshot(page)).toBe(model);

    // Restore as a new version: the open state is kept first, the import's
    // state becomes main's newest version, and opens.
    await panel.locator("[data-checkpoint-restore]").click();
    await panel.locator("[data-checkpoint-restore-go]").click();
    await expect(versions).toHaveCount(2);
    await expect(versions.first()).toContainText("Restore");
    await expect.poll(() => frontX(page)).toBeCloseTo(x0, 1);
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(2)).toHaveAttribute(
      "data-checkpoint-kind",
      "before",
    );
    // A new state: the reopened document has nothing to undo.
    expect(await undoDepth(page)).toBe(0);
  });
});
