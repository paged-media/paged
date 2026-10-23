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

// paged.image's typed `filterRegion { selection: true }` in the running
// editor (image ADR 465, amendment): a designer opens a placed image,
// drags a rectangle with the marquee tool, and a caller of the object
// model filters within that selection. Only the selected pixels of the
// frame's image change, and one document undo restores them.
//
// The selection is made the way a designer makes it (the marquee tool's
// drag over the frame), and the panel's own readout says which image
// pixels it covers. The filter runs where the editor runs it: on the GPU
// where the realm has a device, otherwise on the CPU twins of the same
// kernels, so this spec holds on the CPU lane too.

import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";

import { mutate } from "../e2e/harness/ui";
import { Designer } from "../journey/driver/designer";
import {
  ADJ_PANEL,
  FRAME,
  armTool,
  dragPt,
  sourceReadout,
} from "../journey/plugins/image-helpers";

const FILTER = "media.paged.image.command.filterRegion";
const ADJUST_SELECTED = "media.paged.image.command.adjustSelected";
const MARQUEE = "media.paged.image.tool.marqueeRect";
const W = 96;
const H = 96;

interface CanvasHandle {
  client: {
    placedAssetBytesBinary(id: string): Promise<{ encoded: Uint8Array } | null>;
    undo(): Promise<unknown>;
  };
  objects: { invoke(command: string, args: unknown): Promise<unknown> } | null;
}

/** A W×H PNG of a diagonal gradient, encoded in the page. */
function gradientPng(page: Page): Promise<number[]> {
  return page.evaluate(
    async ({ w, h }) => {
      const cv = new OffscreenCanvas(w, h);
      const ctx = cv.getContext("2d")!;
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, "#1830ff");
      g.addColorStop(0.5, "#20c040");
      g.addColorStop(1, "#ff3018");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      const blob = await cv.convertToBlob({ type: "image/png" });
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    { w: W, h: H },
  );
}

/** The frame's placed image, decoded to straight RGBA8. */
async function placedPixels(
  page: Page,
  frame: string,
): Promise<{ width: number; height: number; data: Uint8Array }> {
  const bytes = await page.evaluate(async (id) => {
    const c = (globalThis as unknown as { __canvas: CanvasHandle }).__canvas;
    const r = await c.client.placedAssetBytesBinary(id);
    return r ? Array.from(r.encoded) : null;
  }, frame);
  expect(bytes, "the frame holds an image").not.toBeNull();
  const png = PNG.sync.read(Buffer.from(bytes!));
  return {
    width: png.width,
    height: png.height,
    data: new Uint8Array(png.data),
  };
}

/** The panel's selection bounds readout, `x,y w×h` in image pixels. */
async function selectionBounds(
  page: Page,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const el = page.locator("[data-image-selection-bounds]");
  if ((await el.count()) === 0) return null;
  const m = ((await el.first().textContent()) ?? "")
    .trim()
    .match(/^(\d+),(\d+) (\d+)×(\d+)$/);
  return m
    ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }
    : null;
}

test.describe("paged.image · filterRegion within the editor's selection", () => {
  test("a marquee selection, then filterRegion { selection: true }: only the selected pixels change, and one undo restores them @feat:image.editor.region-filter @feat:image.selection.mask-tools @level:edge", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    // ── A frame with a placed photo, opened in the image editor. ──
    const frame = await designer.drawRectangle(FRAME);
    expect(frame, "drew a target frame").not.toBe("");
    const placed = (await mutate(page, {
      op: "replaceImageBytes",
      args: { elementId: frame, bytes: await gradientPng(page) },
    })) as { kind?: string };
    expect(placed?.kind).toBe("mutationApplied");
    await designer.selectElement("rectangle", frame);
    await designer.runCommand(ADJUST_SELECTED);
    await designer.openPanel(ADJ_PANEL);
    await expect
      .poll(() => sourceReadout(page), { timeout: 20_000 })
      .toContain(`${W}×${H}`);

    // ── The marquee: a drag over the frame's left part. ──
    await armTool(designer, MARQUEE);
    const midY = (FRAME.y0 + FRAME.y1) / 2;
    await dragPt(page, [
      [FRAME.x0 + 10, FRAME.y0 + 10],
      [(FRAME.x0 + FRAME.x1) / 2, midY],
      [(FRAME.x0 + FRAME.x1) / 2, midY + 30],
    ]);
    await expect
      .poll(() => selectionBounds(page), { timeout: 15_000 })
      .not.toBeNull();
    const sel = (await selectionBounds(page))!;
    // A part of the image, not all of it and not nothing.
    expect(sel.w * sel.h, JSON.stringify(sel)).toBeGreaterThan(16);
    expect(sel.w * sel.h, JSON.stringify(sel)).toBeLessThan(W * H);

    const before = await placedPixels(page, frame);
    expect([before.width, before.height]).toEqual([W, H]);

    // ── The typed command, as a script or a panel calls it. ──
    const result = await page.evaluate(
      async ({ command, frame }) => {
        const c = (globalThis as unknown as { __canvas: CanvasHandle })
          .__canvas;
        try {
          return {
            ok: true as const,
            value: await c.objects!.invoke(command, {
              layer: `plugin:media.paged.image/layer/${frame}/1`,
              params: { "invert.enabled": true },
              selection: true,
            }),
          };
        } catch (err) {
          return { ok: false as const, error: String(err) };
        }
      },
      { command: FILTER, frame },
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      value: { applied: true, undoSteps: 1 },
    });

    // ── Only the selected pixels changed. ──
    let after = await placedPixels(page, frame);
    await expect
      .poll(
        async () => {
          after = await placedPixels(page, frame);
          return Buffer.from(after.data).equals(Buffer.from(before.data));
        },
        { timeout: 15_000 },
      )
      .toBe(false);
    const px = (img: Uint8Array, x: number, y: number) =>
      Array.from(img.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
    let changedInside = 0;
    let insideInterior = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const a = px(before.data, x, y);
        const b = px(after.data, x, y);
        const inside =
          x >= sel.x && x < sel.x + sel.w && y >= sel.y && y < sel.y + sel.h;
        if (!inside) {
          expect(b, `(${x}, ${y}) lies outside the selection`).toEqual(a);
          continue;
        }
        const interior =
          x > sel.x &&
          x < sel.x + sel.w - 1 &&
          y > sel.y &&
          y < sel.y + sel.h - 1;
        if (interior) {
          insideInterior++;
          // Fully selected: inverted exactly.
          expect(b, `(${x}, ${y}) lies inside the selection`).toEqual([
            255 - a[0]!,
            255 - a[1]!,
            255 - a[2]!,
            a[3],
          ]);
        }
        if (b.some((v, i) => v !== a[i])) changedInside++;
      }
    expect(insideInterior).toBeGreaterThan(0);
    expect(changedInside).toBeGreaterThanOrEqual(insideInterior);

    // ── One document undo restores every pixel. ──
    await page.evaluate(async () => {
      await (
        globalThis as unknown as { __canvas: CanvasHandle }
      ).__canvas.client.undo();
    });
    await expect
      .poll(
        async () =>
          Buffer.from((await placedPixels(page, frame)).data).equals(
            Buffer.from(before.data),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
  });
});
