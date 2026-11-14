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

// paged.image ADR 487 on the real engine (the UX strategy's §7.2; UX audit
// F-43):
//
//   one tool set   inside the raster context the tools are the rail's; the
//                  context toolbar names the tool in hand and what the next
//                  edit changes, and repeats no tool;
//   edit kinds     the layer rows name their kind;
//   pixel view     the image's own pixels at 100 %, following the pointer —
//                  a read: no document change, no undo step;
//   split          the filter dialog's split view turns on and off without
//                  touching the document (the preview itself needs the GPU
//                  lane; the split's pixels are the unit tests').
//
// Every test asserts the model and the history, never a screenshot.

import { expect, test, type Page } from "@playwright/test";

import { Designer } from "../journey/driver/designer";
import { ADJ_PANEL, FRAME, ingest } from "../journey/plugins/image-helpers";
import { historyDepth } from "./harness/history";
import { modelSnapshot } from "./harness/model-dump";
import { screenPoint } from "./harness/viewport";

const C = "media.paged.image.command";

async function context(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __canvas: {
            debugContext?: () => { editContext?: { type?: string } | null };
          };
        }
      ).__canvas.debugContext?.()?.editContext?.type ?? null,
  );
}

async function enterImage(page: Page): Promise<Designer> {
  const designer = new Designer(page);
  await ingest(designer, page, "ux-source.png", "gradient");
  if ((await context(page)) !== "rasterImage") {
    await designer.runCommand(`${C}.adjustSelected`);
    await expect
      .poll(() => context(page), { timeout: 20_000 })
      .toBe("rasterImage");
  }
  return designer;
}

test.describe("paged.image ADR 487 — one tool set, what an edit changes, the pixels", () => {
  test.describe.configure({ timeout: 180_000 });

  test("F-43 — the raster context's tools are the rail's; the bar names the tool in hand and what the next edit changes @feat:editor-shell.context-toolbars @level:edge", async ({
    page,
  }) => {
    await enterImage(page);
    const segment = page.locator("[data-context-segment]");
    await expect(segment.locator("[data-context-label]")).toHaveText("Image");
    // One tool set: the bar repeats none of the rail's tools.
    await expect(page.locator("[data-context-tool]")).toHaveCount(0);
    expect(
      await page.locator('[data-tool-slot^="media.paged.image."]').count(),
    ).toBeGreaterThan(1);
    // The tool in hand, by name.
    const inHand = segment.locator("[data-context-tool-in-hand]");
    await expect(inHand).toHaveCount(1);
    expect(((await inHand.textContent()) ?? "").trim().length).toBeGreaterThan(
      0,
    );
    // What the next edit changes: this layer's pixels.
    await expect(segment.locator('[data-image-edit-kind="pixels"]')).toHaveText(
      "Editing: Pixels",
    );
  });

  test("the layer rows name their kind; the pixel view reads the image's own pixels around the pointer — no document change, no undo step @feat:image.editor.layers @level:edge", async ({
    page,
  }) => {
    const designer = await enterImage(page);
    await designer.openPanel(ADJ_PANEL);
    await expect(
      page.locator('[data-image-layer-kind="pixels"]').first(),
    ).toHaveText("Pixels");
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);

    const section = page.locator("[data-image-pixel-view]");
    await section.locator("summary").first().click();
    await expect(section.locator("[data-pixel-view-size]")).toContainText(
      "96 × 96 px",
    );
    const canvas = section.locator("[data-pixel-view-canvas]");
    await expect(canvas).toHaveAttribute("data-pixel-center", "48,48");
    // The pointer over the image's top-left quarter: the view follows.
    const p = await screenPoint(
      page,
      FRAME.x0 + (FRAME.x1 - FRAME.x0) * 0.4,
      FRAME.y0 + (FRAME.y1 - FRAME.y0) * 0.25,
    );
    await page.mouse.move(p.x, p.y);
    await page.mouse.move(p.x + 1, p.y + 1);
    await expect(section.locator("[data-pixel-view-at]")).toBeVisible();
    await expect(canvas).not.toHaveAttribute("data-pixel-center", "48,48");
    await section.locator("[data-pixel-view-zoom]").selectOption("8");
    await expect(canvas).toHaveAttribute("data-pixel-zoom", "8");
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);
  });

  test("the filter dialog's split view turns on and off without touching the document @feat:image.editor.filter-dialogs @level:edge", async ({
    page,
  }) => {
    const designer = await enterImage(page);
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);
    await designer.runCommand(`${C}.filterGaussianBlur`);
    const dialog = page.locator('[data-filter-dialog="gaussianBlur"]');
    await expect(dialog).toHaveCount(1);
    await expect(dialog.locator("[data-filter-split]")).toHaveCount(0);
    await dialog.locator("[data-filter-split-toggle]").check();
    const slider = dialog.locator("[data-filter-split]");
    await expect(slider).toHaveAttribute("data-filter-split", "0.5");
    await slider.fill("0.3");
    await expect(slider).toHaveAttribute("data-filter-split", "0.3");
    await dialog.locator("[data-filter-split-toggle]").uncheck();
    await expect(dialog.locator("[data-filter-split]")).toHaveCount(0);
    await dialog.locator("[data-filter-cancel]").click();
    await expect(page.locator("[data-filter-dialog]")).toHaveCount(0);
    // Nothing reached the document.
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);
  });
});
