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

// Editing aids and Proof view (editor ADR "Editing aids and Proof view";
// the redesign strategy's §4.1 and §4.5; the interaction contract's
// UXI-GDE-003 / -004 and UXI-OVR-002): each aid is its own remembered
// toggle, in the bottom bar's control and View ▸ Editing aids; an aid the
// engine cannot do yet is listed, disabled; Proof view hides every aid and
// the selection's handles, masks the pasteboard at the trim (or the bleed)
// and never touches the selection. Each asserts the overlays, the
// selection and the history, not a screenshot.

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { selectElements } from "./harness/gesture-kit";
import { expectHistoryUnchanged } from "./harness/history";
import { modelSnapshot, selectionSnapshot } from "./harness/model-dump";
import { clickMenuRow } from "./harness/shell-surface";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

const A = UXI_A;

const aid = (page: Page, id: string) =>
  page.locator(`[data-editing-aid="${id}"]`);

async function openControl(page: Page) {
  const control = page.locator("[data-editing-aids-control]");
  await control.click();
  await expect(aid(page, "frameEdges")).toBeVisible();
}

async function storedAids(page: Page) {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("paged.view.editingAids") ?? "null"),
  );
}

test.describe("editing aids and Proof view", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "A");
  });

  test("each aid is its own remembered switch; an unsupported one is listed, disabled @feat:editor-shell.view-menu @level:happy", async ({
    page,
  }) => {
    covers(
      "command:paged.view.toggleFrameEdges",
      "command:paged.view.toggleMarginsColumns",
      "command:paged.view.toggleBaselineGrid",
      "command:paged.view.toggleOversetMarkers",
      "command:paged.view.toggleHiddenCharacters",
      "command:paged.view.toggleNonprinting",
      "setting:paged.view.editingAids",
    );
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, async () => {
      await openControl(page);
      // The defaults: a clean page with its margins, guides and overset
      // markers; frame edges and the baseline grid off.
      await expect(aid(page, "frameEdges")).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await expect(aid(page, "marginsColumns")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(aid(page, "guides")).toHaveAttribute("aria-checked", "true");
      for (const id of ["hiddenCharacters", "nonprinting"]) {
        await expect(aid(page, id)).toHaveAttribute("data-disabled", "");
        await expect(aid(page, id)).toContainText("not supported yet");
      }
      await expect(page.locator("[data-frame-edge]")).toHaveCount(0);

      // Frame edges on: every item's edge, the unselected ones too.
      await aid(page, "frameEdges").click();
      await expect(
        page.locator(`[data-frame-edge="${A.back.id.id}"]`),
      ).toBeAttached();
      await expect(
        page.locator(`[data-frame-edge="${A.note.id.id}"]`),
      ).toBeAttached();
      // Margins and columns off, independently: the frame edges stay.
      await aid(page, "marginsColumns").click();
      await expect(aid(page, "marginsColumns")).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await expect(page.locator("[data-margin-guides]")).toHaveCount(0);
      await expect(
        page.locator(`[data-frame-edge="${A.back.id.id}"]`),
      ).toBeAttached();
      // The baseline grid, at a zoom where its lines are apart.
      await aid(page, "baselineGrid").click();
      await expect(
        page.locator("[data-baseline-grid] line").first(),
      ).toBeAttached();
      await page.keyboard.press("Escape");
    });
    expect(await storedAids(page)).toMatchObject({
      frameEdges: true,
      marginsColumns: false,
      baselineGrid: true,
      guides: true,
    });

    // The View menu shows the same switches, and a new editor on this
    // page remembers them.
    await clickMenuRow(page, "View/Editing aids/Margins and columns");
    await clickMenuRow(page, "View/Editing aids/Frame edges");
    await expect(page.locator("[data-frame-edge]")).toHaveCount(0);
    await clickMenuRow(page, "View/Editing aids/Baseline grid");
    expect(await storedAids(page)).toMatchObject({
      frameEdges: false,
      marginsColumns: true,
      baselineGrid: false,
    });
    await clickMenuRow(page, "View/Editing aids/Ruler guides");
    await clickMenuRow(page, "View/Editing aids/Overset markers");
    expect(await storedAids(page)).toMatchObject({
      guides: false,
      oversetMarkers: false,
    });
    await clickMenuRow(page, "View/Editing aids/Ruler guides");
    await clickMenuRow(page, "View/Editing aids/Overset markers");
    await clickMenuRow(page, "View/Editing aids/Frame edges");
    await openUxiFixture(page, "A");
    await expect(
      page.locator(`[data-frame-edge="${A.back.id.id}"]`),
    ).toBeAttached();
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("Proof view hides the aids and the handles, masks the pasteboard at the trim, and keeps the selection @feat:editor-shell.view-menu @level:happy", async ({
    page,
  }) => {
    covers(
      "menu:View/Proof view",
      "menu:View/Editing aids/Frame edges",
      "menu:View/Editing aids/Margins and columns",
      "menu:View/Editing aids/Ruler guides",
      "menu:View/Editing aids/Baseline grid",
      "menu:View/Editing aids/Text threads",
      "menu:View/Editing aids/Overset markers",
      "menu:View/Editing aids/Hidden characters",
      "menu:View/Editing aids/Nonprinting items",
      "command:paged.view.toggleGuides",
    );
    const model = await modelSnapshot(page);
    await selectElements(page, [A.front.id]);
    await clickMenuRow(page, "View/Editing aids/Frame edges");
    const selected = await selectionSnapshot(page);
    expect(selected.elements).toEqual([A.front.id]);
    const handles = page.locator("[data-selection-handle]");
    await expect(handles.first()).toBeVisible();
    await expect(page.locator("[data-frame-edge]").first()).toBeAttached();

    await expectHistoryUnchanged(page, async () => {
      await clickMenuRow(page, "View/Proof view");
      await expect(page.locator("[data-proof-surface]")).toHaveAttribute(
        "data-proof-surface",
        "trim",
      );
      await expect(page.locator("[data-proof-badge]")).toContainText(
        "Trim 612 × 792 pt",
      );
      await expect(handles).toHaveCount(0);
      await expect(page.locator("[data-frame-edge]")).toHaveCount(0);
      // The aids keep their states: Proof view hides, it does not switch.
      expect(await storedAids(page)).toMatchObject({ frameEdges: true });
      // The selection survived the switch.
      expect(await selectionSnapshot(page)).toEqual(selected);

      // The bottom bar's control says so and turns it off again.
      await expect(page.locator("[data-editing-aids-control]")).toHaveAttribute(
        "data-proof-view",
        "on",
      );
      await page.locator("[data-proof-leave]").click();
      await expect(page.locator("[data-proof-surface]")).toHaveCount(0);
      await expect(handles.first()).toBeVisible();
      await expect(page.locator("[data-frame-edge]").first()).toBeAttached();
      expect(await selectionSnapshot(page)).toEqual(selected);

      // The Bleed screen mode is the proof with the bleed let through.
      await openControl(page);
      await aid(page, "proofView").click();
      await expect(page.locator("[data-proof-surface]")).toHaveAttribute(
        "data-proof-surface",
        "trim",
      );
      await page.keyboard.press("Escape");
      // W, InDesign's key, from the page (not a focused button).
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur?.(),
      );
      await page.keyboard.press("w");
      await expect(page.locator("[data-proof-surface]")).toHaveCount(0);
      await expect(handles.first()).toBeVisible();
    });
    expect(await selectionSnapshot(page)).toEqual(selected);
    expect(await modelSnapshot(page)).toBe(model);
  });
});
