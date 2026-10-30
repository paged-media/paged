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

// Picture adjustments (engine ADR 1037) end to end: a frame placing a real
// PNG, the panel opened from Object ▸ Effects ▸ Picture adjustments…, an
// Invert added from the panel. The picture's pixels must change inside the
// frame and nowhere else, the stack must read back from the model, and one
// undo must restore the model and the pixels byte for byte. Then "Open in
// Image editor" hands the frame to the image module. Corpus-free.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { Designer } from "../journey/driver/designer";
import { opSandwich } from "./harness/op-sandwich";
import { clickMenuRow } from "./harness/shell-surface";

interface CanvasGlobal {
  __canvas: {
    client: {
      executeScript: (
        s: string,
      ) => Promise<{ output: string[]; error: string | null }>;
      mutate: (m: unknown) => Promise<{ kind: string }>;
      elementProperties: (id: unknown) => Promise<{
        entries: Array<{ path: string; value: unknown }>;
      } | null>;
    };
    debugContext?: () => { editContext?: { type?: string } | null };
  };
}

const FRAME = { x0: 90, y0: 120, x1: 360, y1: 320 };

async function firstPage(page: Page) {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const r = await c.executeScript("paged.pages()");
    const pages = JSON.parse(r.output[0] ?? "[]") as Array<{
      selfId: string;
      sizePt: [number, number];
    }>;
    return { pageId: pages[0]!.selfId, widthPt: pages[0]!.sizePt[0] };
  });
}

/** Place a 160 × 120 two-colour PNG in the frame. */
async function place(page: Page, frame: string): Promise<string> {
  return page.evaluate(async (id) => {
    const cv = new OffscreenCanvas(160, 120);
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#2050d0";
    ctx.fillRect(0, 0, 160, 120);
    ctx.fillStyle = "#f0c020";
    ctx.fillRect(80, 0, 80, 120);
    const bytes = Array.from(
      new Uint8Array(
        await (await cv.convertToBlob({ type: "image/png" })).arrayBuffer(),
      ),
    );
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    return (
      await c.mutate({
        op: "replaceImageBytes",
        args: { elementId: id, bytes },
      })
    ).kind;
  }, frame);
}

async function stack(page: Page, frame: string): Promise<unknown> {
  return page.evaluate(async (id) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const props = await c.elementProperties({ kind: "rectangle", id });
    const v = props?.entries.find((e) => e.path === "frameImageAdjustments")
      ?.value as { value?: unknown } | undefined;
    return v?.value ?? null;
  }, frame);
}

test.describe("Picture adjustments", () => {
  test("AC-PICTURE-ADJUST-1 — Invert from the panel redraws the picture in its frame, reads back, one undo restores; Open in Image editor enters the image context @feat:images-graphics.image-filter-stack @level:happy", async ({
    page,
  }) => {
    covers(
      "panel:paged.picture-adjustments",
      "menu:Object/Effects/Picture adjustments…",
    );
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    const { pageId, widthPt } = await firstPage(page);
    const frame = await designer.drawRectangle(FRAME);
    expect(await place(page, frame)).toBe("mutationApplied");
    await designer.selectElement("rectangle", frame);

    await clickMenuRow(page, "Object/Effects/Picture adjustments…");
    const panel = page.locator("[data-picture-adjustments-panel]");
    await expect(panel).toBeVisible();
    const add = panel.locator("[data-adjust-add]");
    await expect(add).toBeEnabled();
    expect(await stack(page, frame)).toEqual([]);

    await opSandwich(page, {
      pageId,
      pageWidthPt: widthPt,
      region: {
        top: FRAME.y0,
        left: FRAME.x0,
        bottom: FRAME.y1,
        right: FRAME.x1,
      },
      regionSlackPx: 6,
      apply: async () => {
        await add.selectOption("invert");
      },
      expectModel: async () => {
        expect(await stack(page, frame)).toEqual([{ op: "invert" }]);
        await expect(panel.locator('[data-adjust-row="invert"]')).toHaveCount(
          1,
        );
      },
      dumpModel: async () => JSON.stringify(await stack(page, frame)),
      expectRestored: async () => {
        expect(await stack(page, frame)).toEqual([]);
        await expect(panel.locator("[data-adjust-row]")).toHaveCount(0);
      },
    });

    const open = panel.locator("[data-adjust-open-image]");
    await expect(open).toBeEnabled({ timeout: 20_000 });
    await open.click();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as CanvasGlobal).__canvas.debugContext?.()
                ?.editContext?.type ?? null,
          ),
        { timeout: 20_000 },
      )
      .toBe("rasterImage");
  });
});
