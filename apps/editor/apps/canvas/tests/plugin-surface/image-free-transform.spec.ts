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

// paged.image's Edit ▸ Free transform in the running editor (WP5.6;
// extensions ADR 339): inside the raster context the command opens the
// HOST's transform box over the layer (eight handles and a reference point
// drawn on the bundle's overlay layer), makes the image's transform tool
// the one in hand, and a corner drag moves the box. Esc cancels the BOX
// and the context stays (an open box is a sub-edit); Enter applies — on
// the GPU lane the layer is resampled (`geom.warp_projective`), on the CPU
// lane the session declines honestly, as every GPU-only verb does.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { mutate } from "../e2e/harness/ui";
import { Designer } from "../journey/driver/designer";
import {
  ADJ_PANEL,
  FRAME,
  dragPt,
  sourceReadout,
  statusText,
} from "../journey/plugins/image-helpers";

const ADJUST_SELECTED = "media.paged.image.command.adjustSelected";
const FREE_TRANSFORM = "media.paged.image.command.freeTransform";
const TOOL = "media.paged.image.tool.transform";
const BOX = '[data-overlay-layer="media.paged.image/transformBox"]';

function png(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const cv = new OffscreenCanvas(64, 48);
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#2050e0";
    ctx.fillRect(0, 0, 64, 48);
    const blob = await cv.convertToBlob({ type: "image/png" });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
}

const contextType = (page: Page) =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __canvas?: {
            debugContext?: () => { editContext?: { type?: string } | null };
          };
        }
      ).__canvas?.debugContext?.()?.editContext?.type ?? null,
  );

/** The box's square handles, as the overlay draws them. */
const handles = (page: Page) =>
  page.locator(`${BOX} [data-preview-handle="square"]`);

test.describe("paged.image · Free transform", () => {
  test("Edit ▸ Free transform opens the host box over the layer; a corner drags it; Esc cancels the box, not the context; Enter applies @feat:image.editor.transform-warp @feat:editor-tools.free-transform @level:gesture", async ({
    page,
  }) => {
    covers("tool:media.paged.image.tool.transform");
    covers("command:media.paged.image.command.freeTransform");
    test.setTimeout(180_000);
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    const frame = await designer.drawRectangle(FRAME);
    const placed = (await mutate(page, {
      op: "replaceImageBytes",
      args: { elementId: frame, bytes: await png(page) },
    })) as { kind?: string };
    expect(placed?.kind).toBe("mutationApplied");
    await designer.selectElement("rectangle", frame);
    await designer.runCommand(ADJUST_SELECTED);
    await designer.openPanel(ADJ_PANEL);
    await expect
      .poll(() => sourceReadout(page), { timeout: 20_000 })
      .toContain("64×48");
    await expect.poll(() => contextType(page)).toBe("rasterImage");

    // ── Open: the host draws the box; the image's tool is in hand. ──
    await designer.runCommand(FREE_TRANSFORM);
    await expect(handles(page)).toHaveCount(8);
    await expect(
      page.locator(`${BOX} [data-preview-handle="centre"]`),
    ).toHaveCount(1);
    await expect(
      page.locator(`[data-tool="${TOOL}"][data-active="true"]`),
    ).toHaveCount(1);

    // The layer is fit into the frame: find the box's SE corner on screen.
    const se = await handles(page).nth(4).boundingBox();
    expect(se).not.toBeNull();
    // Drag the SE corner outward: the BOX takes it (routed by the SDK).
    const at = { x: se!.x + se!.width / 2, y: se!.y + se!.height / 2 };
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.mouse.move(at.x + 30, at.y + 20, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => (await handles(page).nth(4).boundingBox())?.x ?? 0)
      .toBeGreaterThan(se!.x + 20);

    // ── Esc: the box goes, the raster context stays. ──
    await page.keyboard.press("Escape");
    await expect(handles(page)).toHaveCount(0);
    expect(await contextType(page)).toBe("rasterImage");

    // ── Enter applies: resampled on the GPU, declined on the CPU lane. ──
    await designer.runCommand(FREE_TRANSFORM);
    await expect(handles(page)).toHaveCount(8);
    const cx = (FRAME.x0 + FRAME.x1) / 2;
    await dragPt(page, [
      [cx, (FRAME.y0 + FRAME.y1) / 2],
      [cx + 20, (FRAME.y0 + FRAME.y1) / 2 + 10],
    ]);
    await page.keyboard.press("Enter");
    await expect(handles(page)).toHaveCount(0);
    expect(await contextType(page)).toBe("rasterImage");
    await expect
      .poll(() => statusText(page), { timeout: 15_000 })
      .toMatch(/Free transform/i);
  });
});
