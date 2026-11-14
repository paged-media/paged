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

// Design constraints are validated intent (editor ADR 1233; the UX
// strategy's Concept C; task PX3): a constraint made from the selection is
// one undo step and lives in the document (it survives a .paged save and an
// IDML export); it is evaluated as the document changes and never moves
// anything by itself; a constraint that does not hold is an issue of
// Publication health whose fix says what it will do, previews where it will
// put things, and applies as one undo step.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import {
  expectHistoryUnchanged,
  expectUndoSteps,
  undoDepth,
} from "./harness/history";
import { modelSnapshot } from "./harness/model-dump";
import { clickMenuRow, select } from "./harness/shell-surface";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

type Win = {
  __canvas: {
    client: {
      mutate(m: unknown): Promise<unknown>;
      documentMeta(): Promise<{
        pluginMetadata?: Array<{ key: string; value: string }>;
      }>;
      elementGeometry(
        ids: unknown[],
      ): Promise<Array<{ bounds: number[]; itemTransform?: number[] | null }>>;
      exportIdml(): Promise<{ bytes: Uint8Array }>;
      exportPaged(): Promise<Uint8Array>;
      loadDocument(bytes: Uint8Array): Promise<unknown>;
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

/** The page-local left edge of an item. */
const leftOf = (page: Page, id: { kind: string; id: string }) =>
  page.evaluate(async (el) => {
    const [g] = await (
      globalThis as unknown as Win
    ).__canvas.client.elementGeometry([el]);
    return (g!.bounds[1] ?? 0) + (g!.itemTransform?.[4] ?? 0);
  }, id);

const constraintLabel = (page: Page) =>
  page.evaluate(async () => {
    const meta = await (
      globalThis as unknown as Win
    ).__canvas.client.documentMeta();
    return (
      meta.pluginMetadata?.find((e) => e.key === "x-paged:constraints")
        ?.value ?? null
    );
  });

/** Fixture A with "left edges aligned" on its back (key) and front
 *  rectangles, made through Object ▸ Add constraint…'s dialog. */
async function alignBackAndFront(page: Page): Promise<void> {
  await openUxiFixture(page, "A");
  await select(page, [UXI_A.back.id, UXI_A.front.id]);
  await expectUndoSteps(
    page,
    1,
    async () => {
      // Object ▸ Add constraint… (the canvas context menu has the same row).
      await clickMenuRow(page, "Object/Add constraint…");
      const dialog = page.locator("[data-add-constraint-dialog]");
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("[data-add-constraint-note]")).toContainText(
        "never moves anything by itself",
      );
      await dialog.locator("[data-add-constraint-kind]").selectOption("align");
      await dialog.locator("[data-add-constraint-edge]").selectOption("left");
      await dialog.locator("[data-add-constraint-confirm]").click();
      await expect(dialog).toHaveCount(0);
    },
    "adding a constraint",
  );
}

test.describe("PX3 — design constraints are validated intent", () => {
  test("PX3 — a constraint from the selection is one undo step, is checked continuously and never moves anything @feat:editor-shell.panels.publication-health @feat:plugin-platform.document-metadata @level:happy", async ({
    page,
  }) => {
    covers(
      "menu:Object/Add constraint…",
      "command:paged.object.addConstraint",
      "panel:paged.publication-health",
      "panel:paged.constraints",
    );
    await alignBackAndFront(page);
    expect(await constraintLabel(page)).toContain('"kind":"align"');
    // Evaluated: the front rectangle is 108 pt off the key object's left.
    await invoke(page, "paged.panel.show.paged.constraints");
    const row = page.locator("[data-constraint-row]");
    await expect(row).toHaveAttribute("data-constraint-status", "broken");
    await expect(row.locator("[data-constraint-state]")).toContainText("108");
    await expect(
      page.locator('[data-constraint-glyph][data-constraint-status="broken"]'),
    ).toHaveCount(1);
    // Never auto-move: edits elsewhere re-evaluate, nothing it names moves.
    const front = await leftOf(page, UXI_A.front.id);
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(
      page,
      async () => {
        await page.waitForTimeout(600);
        expect(await leftOf(page, UXI_A.front.id)).toBe(front);
      },
      "evaluating a constraint",
    );
    expect(await modelSnapshot(page)).toBe(model);
    // The glyphs are an editing aid: off and on from View ▸ Editing aids.
    covers(
      "menu:View/Editing aids/Design constraints",
      "command:paged.view.toggleConstraints",
    );
    await clickMenuRow(page, "View/Editing aids/Design constraints");
    await expect(page.locator("[data-constraint-glyph]")).toHaveCount(0);
    await clickMenuRow(page, "View/Editing aids/Design constraints");
    await expect(page.locator("[data-constraint-glyph]")).toHaveCount(1);
  });

  test("PX3 — the fix says what it will do, previews where, and applies as one undo step @feat:editor-shell.panels.publication-health @feat:editor-shell.panels.align @level:happy", async ({
    page,
  }) => {
    await alignBackAndFront(page);
    await invoke(page, "paged.panel.show.paged.publication-health");
    const issue = page.locator('[data-issue-kind="constraint"]');
    await expect(issue).toHaveCount(1);
    await expect(issue).toHaveAttribute("data-issue-severity", "warning");
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(
      page,
      async () => {
        await issue.locator("[data-issue-go]").click();
        const fix = issue.locator('[data-issue-fix="constraint-move"]');
        await expect(fix).toHaveText("Align to the key object");
        await expect(issue.locator("[data-issue-fix-preview]")).toContainText(
          "Moves 1 item by 108",
        );
        // The preview draws where the front rectangle would go; it is not
        // a change.
        await fix.hover();
        await expect(
          page.locator("[data-fix-preview] [data-fix-ghost]"),
        ).toHaveCount(1);
        await page.mouse.move(2, 2);
        await expect(page.locator("[data-fix-preview]")).toHaveCount(0);
      },
      "going to a constraint and previewing its fix",
    );
    expect(await modelSnapshot(page)).toBe(model);

    const depth = await undoDepth(page);
    await expectUndoSteps(
      page,
      1,
      async () => {
        await issue.locator('[data-issue-fix="constraint-move"]').click();
        await expect(
          page.locator('[data-feedback-toast][data-outcome="success"]'),
        ).toContainText("Align to the key object");
      },
      "applying the fix",
    );
    await expect
      .poll(() => leftOf(page, UXI_A.front.id))
      .toBeCloseTo(UXI_A.back.box[1], 1);
    await expect(page.locator('[data-issue-kind="constraint"]')).toHaveCount(0);
    // Undo takes the move back; the constraint is broken again.
    await invoke(page, "paged.editor.undo");
    await expect.poll(() => undoDepth(page)).toBe(depth);
    await expect.poll(() => modelSnapshot(page)).toBe(model);
    await expect(page.locator('[data-issue-kind="constraint"]')).toHaveCount(1);
  });

  test("PX3 — the constraints travel with the document: a .paged save and an IDML export keep them @feat:plugin-platform.document-metadata @feat:plugin-publish.idml-exporter @level:edge", async ({
    page,
  }) => {
    await alignBackAndFront(page);
    const label = await constraintLabel(page);
    expect(label).not.toBeNull();
    for (const via of ["paged", "idml"] as const) {
      await page.evaluate(async (format) => {
        const c = (globalThis as unknown as Win).__canvas.client;
        const bytes =
          format === "paged"
            ? await c.exportPaged()
            : (await c.exportIdml()).bytes;
        await c.loadDocument(bytes);
      }, via);
      expect(await constraintLabel(page), `kept through ${via}`).toBe(label);
      // Its members are the same items after the round trip.
      expect(await leftOf(page, UXI_A.back.id)).toBeCloseTo(
        UXI_A.back.box[1],
        1,
      );
    }
  });
});
