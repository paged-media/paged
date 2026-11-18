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

// Journey: the selection's task bar (Generative fill, Remove; image ADR 486)
// belongs to the image's edit context.
//
// The image is opened for editing, a pixel selection made, the edits
// committed and the context left with Escape. The session keeps the image
// and its selection after that, and the bar used to stay with them: on the
// page, at screen size, under where the selection was, taking the next
// frame drag into its prompt (nothing was drawn) and every key after it.
// Now the bar goes with the context, focus in its prompt goes back to the
// canvas, and Escape in the prompt is one rung of the editor's ladder
// (editor ADR 1207): the field's, then the context's.
//
// Nothing here needs the GPU: the selection, the commit and the bar are not
// renders, so the journey runs on both lanes.

import { expect, test, type Page } from "@playwright/test";

import { screenPoint } from "../../e2e/harness/viewport";
import { Designer } from "../driver/designer";
import { ingest, statusText } from "./image-helpers";

const C = "media.paged.image.command";

async function editContext(page: Page): Promise<string | null> {
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

/** A screen point (CSS px) in document pt, through the live camera. */
async function toPt(
  page: Page,
  p: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const o = await screenPoint(page, 0, 0);
  const u = await screenPoint(page, 100, 100);
  return {
    x: ((p.x - o.x) * 100) / (u.x - o.x),
    y: ((p.y - o.y) * 100) / (u.y - o.y),
  };
}

test.describe("journey · paged.image selection task bar", () => {
  test.describe.configure({ timeout: 180_000 });

  test("leaving the image's context takes the selection's task bar with it; the next frame drag draws a frame, and Escape in the prompt is one rung @feat:image.ml.features @feat:image.selection.mask-tools @feat:editor-shell.keyboard-shortcuts @level:gesture", async ({
    page,
  }) => {
    const designer = new Designer(page);
    const { frame } = await ingest(designer, page, "task-bar.png", "gradient");
    const prompt = page.locator("[data-image-task-bar-prompt]");
    const bar = page.locator("[data-image-task-bar]");

    /** Open the image for editing (the raster context) and select all of
     *  it: the bar shows under the selection. */
    const enterAndSelect = async () => {
      if ((await editContext(page)) !== "rasterImage") {
        await designer.selectElement("rectangle", frame);
        await designer.runCommand(`${C}.adjustSelected`);
      }
      await expect
        .poll(() => editContext(page), { timeout: 20_000 })
        .toBe("rasterImage");
      await designer.runCommand(`${C}.selectAll`);
      await expect(prompt).toBeVisible({ timeout: 15_000 });
    };

    // ── A pixel selection in the open image: the bar shows under it. ──
    await enterAndSelect();
    // The bar's middle: under the image's centre, on the page.
    const box = (await page
      .getByRole("toolbar", { name: "Selection actions" })
      .boundingBox())!;
    const onBar = await toPt(page, {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });

    // ── Commit, then Escape: leaving the context takes the bar with it. ──
    await designer.runCommand(`${C}.commitImage`);
    await expect
      .poll(() => statusText(page), { timeout: 20_000 })
      .toContain("Committed revision");
    await page.keyboard.press("Escape");
    await expect.poll(() => editContext(page), { timeout: 10_000 }).toBe(null);
    await expect(bar, "the bar went with the context").toHaveCount(0);

    // ── The next tool gesture works: a frame drawn from where the bar was
    //    (below the image, clear of its frame). ──
    const drawn = await designer.drawRectangle({
      x0: onBar.x,
      y0: onBar.y,
      x1: onBar.x + 120,
      y1: onBar.y + 80,
    });
    expect(drawn, "the drag drew a frame").not.toBe("");

    // ── Back in, a selection again. Escape in the prompt is the field's:
    //    focus goes back to the canvas, the context and the bar stay; the
    //    next Escape leaves the context, and the bar goes with it. ──
    await enterAndSelect();
    await prompt.click();
    await expect(prompt).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(
      page.locator('[data-canvas-surface="viewport"]'),
    ).toBeFocused();
    expect(await editContext(page)).toBe("rasterImage");
    await expect(prompt).toBeVisible();
    await page.keyboard.press("Escape");
    await expect.poll(() => editContext(page), { timeout: 10_000 }).toBe(null);
    await expect(bar).toHaveCount(0);
  });
});
