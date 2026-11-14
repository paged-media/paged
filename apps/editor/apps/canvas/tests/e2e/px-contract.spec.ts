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

// The living publication contract (editor ADR 1236; the UX strategy's
// Concept I; task PX8): a contract made from the document is one undo step
// and travels with it; its readiness shows in the header beside the save
// status and reacts as the document changes — a page that no longer has
// the contract's size blocks it, as an issue on that page, and Undo makes it
// ready again; approving is an explicit action, one undo step, and keeps
// the approved state as a checkpoint; an edit after the approval says so.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { expectUndoSteps } from "./harness/history";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

type Win = {
  __canvas: {
    client: { mutate(m: unknown): Promise<{ kind: string }> };
    registries: { commands: { invoke(id: string): Promise<unknown> } };
  };
};

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (cmd) =>
      (globalThis as unknown as Win).__canvas.registries.commands.invoke(cmd),
    id,
  );

test.describe("PX8 — the living publication contract", () => {
  test("PX8 — readiness reacts to a document change; approval is an explicit step with a checkpoint @feat:editor-shell.panels.publication-health @feat:editor-shell.panels.preflight @feat:plugin-platform.document-metadata @level:happy", async ({
    page,
  }) => {
    covers(
      "panel:paged.publication-contract",
      "panel:paged.publication-health",
    );
    await openUxiFixture(page, "A");
    await invoke(page, "paged.panel.show.paged.publication-contract");
    const panel = page.locator("[data-contract-panel]");
    const badge = page.locator("[data-publication-readiness]");
    await expect(badge).toHaveCount(0);
    await expectUndoSteps(
      page,
      1,
      async () => {
        await panel.locator("[data-contract-create]").click();
        await expect(panel).toHaveAttribute("data-contract-readiness", /.+/);
      },
      "making a contract",
    );
    // The fixture's fonts are not all installed here: the contract asks
    // only what this test is about.
    const fonts = panel.locator(
      '[data-contract-check="export-fonts"][data-level="blocker"]',
    );
    if ((await fonts.count()) > 0)
      await panel.locator("[data-contract-fonts]").uncheck();
    await expect(
      panel.locator('[data-contract-check="page-size"]'),
    ).toHaveAttribute("data-level", "ok");
    await expect(badge).toHaveAttribute("data-publication-readiness", "ready");

    // A document change: page 1 is no longer the contract's size.
    await page.evaluate(async (pageId) => {
      await (globalThis as unknown as Win).__canvas.client.mutate({
        op: "resizePage",
        args: { pageId, bounds: [0, 0, 792, 600] },
      });
    }, UXI_A.pageId);
    await expect(
      panel.locator('[data-contract-check="page-size"]'),
    ).toHaveAttribute("data-level", "blocker");
    await expect(badge).toHaveAttribute(
      "data-publication-readiness",
      "blocked",
    );
    await invoke(page, "paged.panel.show.paged.publication-health");
    await expect(
      page.locator('[data-issue="contract:page-size:page:0"]'),
    ).toHaveAttribute("data-issue-severity", "error");
    await invoke(page, "paged.editor.undo");
    await expect(badge).toHaveAttribute("data-publication-readiness", "ready");

    // Approve: one undo step, the approved state kept as a checkpoint.
    await invoke(page, "paged.panel.show.paged.publication-contract");
    await panel.locator("[data-contract-by]").fill("Art desk");
    await expectUndoSteps(
      page,
      1,
      async () => {
        await panel.locator("[data-contract-approve]").click();
        await expect(panel.locator("[data-contract-approval]")).toHaveAttribute(
          "data-contract-approval",
          "approved",
        );
      },
      "approving",
    );
    await expect(badge).toHaveAttribute(
      "data-publication-readiness",
      "approved",
    );
    await invoke(page, "paged.panel.show.paged.library");
    await expect(page.locator('[data-checkpoint-kind="approved"]')).toHaveCount(
      1,
    );
    // An edit after the approval: the approval is for an earlier state.
    await page.evaluate(async (storyId) => {
      await (globalThis as unknown as Win).__canvas.client.mutate({
        op: "insertText",
        args: { storyId, offset: 0, text: "Late change. ", cell: null },
      });
    }, UXI_A.note.storyId);
    await expect(badge).toHaveAttribute(
      "data-publication-readiness",
      "attention",
    );
  });
});
