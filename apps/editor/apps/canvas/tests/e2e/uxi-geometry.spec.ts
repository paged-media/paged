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

// Handles and geometry (the interaction specification's §5, §8.1–§8.2;
// plan task IC7): the body of a turned item is its oriented box, a resize
// handle's cursor points the way it pulls, the corner's rotate zone shows
// the angle, guides and handles follow the full camera transform, and a
// live shape's corner widget takes only its own disc — a press beside it
// moves or resizes, at 100 % and at 800 %. Each test asserts the model
// (`modelSnapshot`) and the history (the engine's undo log).

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { elementPageRectPt } from "./harness/fixtures";
import { selectElements } from "./harness/gesture-kit";
import {
  expectHistoryUnchanged,
  expectUndoSteps,
  undoDepth,
} from "./harness/history";
import {
  activateTool,
  clientPointOf,
  elementCentre,
} from "./harness/interaction";
import { modelSnapshot } from "./harness/model-dump";
import { openUxiFixture, UXI_A, UXI_D } from "./harness/uxi-fixtures";

const A = UXI_A;
const D = UXI_D;

interface CanvasGlobal {
  __canvas: {
    client: {
      undo(): Promise<unknown>;
      camera: {
        read(): { scale: number; tx: number; ty: number; rotation?: number };
      };
    };
    registries: { commands: { invoke(id: string): unknown } };
  };
}

async function cameraScale(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (globalThis as unknown as CanvasGlobal).__canvas.client.camera.read()
        .scale,
  );
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as CanvasGlobal).__canvas.client.undo(),
  );
}

async function setZoom(page: Page, scale: number): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const s = await cameraScale(page);
    if (Math.abs(s - scale) / scale < 0.002) return;
    const host = (await page
      .locator('[data-testid="viewport-canvas-host"]')
      .boundingBox())!;
    await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -Math.log(scale / s) / 0.005);
    await page.keyboard.up("Control");
    await expect.poll(() => cameraScale(page)).not.toBe(s);
  }
}

/** Pan so a page point sits mid-viewport; its client px. */
async function centre(
  page: Page,
  at: readonly [number, number],
  pageIndex = 0,
): Promise<{ x: number; y: number }> {
  const host = (await page
    .locator('[data-testid="viewport-canvas-host"]')
    .boundingBox())!;
  const p = await clientPointOf(page, { at, page: pageIndex });
  const cx = host.x + host.width / 2;
  const cy = host.y + host.height / 2;
  if (Math.hypot(p.x - cx, p.y - cy) > 40) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(p.x - cx, p.y - cy);
    await expect
      .poll(async () => {
        const q = await clientPointOf(page, { at, page: pageIndex });
        return Math.hypot(q.x - cx, q.y - cy);
      })
      .toBeLessThan(40);
  }
  return clientPointOf(page, { at, page: pageIndex });
}

async function dragFrom(
  page: Page,
  from: { x: number; y: number },
  dx: number,
  dy: number,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
}

async function frame(page: Page, ref: { kind: string; id: string }) {
  const r = (await elementPageRectPt(page, ref))!;
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
}

test.describe("UXI geometry — handles, hits and the camera's transform (IC7)", () => {
  test("a live shape's corner widget takes only its disc: beside it a press moves, on its square it resizes, at 100 % and 800 % @feat:plugin-draw.live-shapes @level:gesture @uxi:UXI-HND-002 @uxi:UXI-HND-004", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
    for (const zoom of [1, 8]) {
      await setZoom(page, zoom);
      await selectElements(page, [A.free.id]);
      const [top, left] = A.free.box;
      const nw = await centre(page, [left, top]);
      const widget = page.locator('[data-live-handle="corner-0"]');
      await expect(widget).toHaveCount(1);
      const wb = (await widget.boundingBox())!;
      const w = { x: wb.x + wb.width / 2, y: wb.y + wb.height / 2 };
      // Between the corner's resize square and the widget's disc, a little
      // past the disc: the move interior.
      const ux = (w.x - nw.x) / Math.hypot(w.x - nw.x, w.y - nw.y);
      const uy = (w.y - nw.y) / Math.hypot(w.x - nw.x, w.y - nw.y);
      const beside = { x: w.x - ux * 9, y: w.y - uy * 9 };
      const model = await modelSnapshot(page);
      const before = await frame(page, A.free.id);
      await expectUndoSteps(
        page,
        1,
        () => dragFrom(page, beside, 30, 20),
        `a move beside the widget at ${zoom * 100} %`,
      );
      const moved = await frame(page, A.free.id);
      expect(moved.w, `${zoom}: moved, not reshaped`).toBeCloseTo(before.w, 2);
      expect(moved.x - before.x, `${zoom}: moved`).toBeGreaterThan(0.5 / zoom);
      await undo(page);
      expect(await modelSnapshot(page)).toBe(model);
      // On the corner's resize square: a resize, never the radius.
      await selectElements(page, [A.free.id]);
      const sq = { x: nw.x + 3 * ux, y: nw.y + 3 * uy };
      expect(
        await page.evaluate(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.getAttribute("data-handle") ??
            null,
          sq,
        ),
        `${zoom}: the corner square is the resize handle's`,
      ).toBe("northWest");
      // And on the disc itself, the corner widget (one undo step).
      expect(
        await page.evaluate(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.closest("[data-live-handle]")
              ?.getAttribute("data-live-handle") ?? null,
          w,
        ),
        `${zoom}: the disc is the widget's`,
      ).toBe("corner-0");
    }
  });

  test("UXI-T11 — Shift pressed and released mid-resize: the preview follows the live modifier, no cumulative jump @feat:editor-tools.resize.handles @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
    await selectElements(page, [A.free.id]);
    const model = await modelSnapshot(page);
    const before = await frame(page, A.free.id);
    const [, , b, r] = A.free.box;
    const se = await centre(page, [r, b]);
    const scale = await cameraScale(page);
    await expectUndoSteps(page, 1, async () => {
      await page.mouse.move(se.x - 3, se.y - 3);
      await page.mouse.down();
      await page.mouse.move(se.x + 60, se.y + 20, { steps: 6 });
      await page.keyboard.down("Shift");
      await page.mouse.move(se.x + 61, se.y + 21, { steps: 2 });
      await page.keyboard.up("Shift");
      await page.mouse.move(se.x + 60, se.y + 20, { steps: 2 });
      await page.mouse.up();
    });
    // The result is the unconstrained resize to where the pointer was let
    // go: Shift on and off left nothing behind.
    const after = await frame(page, A.free.id);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
    expect(Math.abs(after.w - before.w - 63 / scale)).toBeLessThan(4 / scale);
    expect(Math.abs(after.h - before.h - 23 / scale)).toBeLessThan(4 / scale);
    await undo(page);
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("UXI-T14 — the rotate zone outside a turned item's corner rotates it with the angle shown, alike at 50 % and 200 % @feat:editor-tools.rotate @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await openUxiFixture(page, "D");
    await activateTool(page, "paged.tool.select");
    for (const zoom of [0.5, 2]) {
      await setZoom(page, zoom);
      await selectElements(page, [D.rotated(1)]);
      const model = await modelSnapshot(page);
      const band = page.locator('[data-rotate-band="southEast"]').first();
      await expect(band).toHaveCount(1);
      const bb = (await band.boundingBox())!;
      const from = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
      const c0 = await elementCentre(page, D.rotated(1));
      const c = await clientPointOf(page, c0);
      // A quarter turn about the centre, on screen.
      const vx = from.x - c.x;
      const vy = from.y - c.y;
      await expectUndoSteps(page, 1, async () => {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(c.x - vy, c.y + vx, { steps: 12 });
        await expect(page.locator("[data-rotate-readout]")).toBeVisible();
        await expect(page.locator("[data-rotate-readout]")).toContainText("°");
        await page.mouse.up();
      });
      await expect(page.locator("[data-rotate-readout]")).toBeHidden();
      // The centre stays (a rotation about it), at either zoom.
      const c1 = await elementCentre(page, D.rotated(1));
      expect(c1.at[0]).toBeCloseTo(c0.at[0], 0);
      expect(c1.at[1]).toBeCloseTo(c0.at[1], 0);
      await undo(page);
      expect(await modelSnapshot(page)).toBe(model);
    }
  });

  test("a turned item's body is its oriented box: a press in its bounding box's empty corner selects nothing @feat:editor-tools.select.click-marquee @level:edge @uxi:UXI-TRN-005", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await openUxiFixture(page, "D");
    await activateTool(page, "paged.tool.select");
    // Page 3's rectangle is turned 45°: the corner of its axis-aligned box
    // is empty.
    const ref = D.rotated(3);
    await selectElements(page, [ref]);
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    const r = (await elementPageRectPt(page, ref))!;
    const at = await centre(page, [r.left + 2, r.top + 2], 2);
    await expectHistoryUnchanged(page, () => dragFrom(page, at, 40, 30));
    expect(await modelSnapshot(page), "nothing moved").toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("a resize handle's cursor points the way it pulls on a turned item @feat:editor-tools.resize.handles @level:edge @uxi:UXI-OVR-010", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await openUxiFixture(page, "D");
    await activateTool(page, "paged.tool.select");
    // Page 6's rectangle is turned 90°: its east handle pulls up or down.
    await selectElements(page, [D.rotated(6)]);
    const east = page
      .locator('[data-selection-handle="east"] > rect[data-handle="east"]')
      .first();
    await expect(east).toHaveCount(1);
    expect(await east.evaluate((el) => (el as HTMLElement).style.cursor)).toBe(
      "ns-resize",
    );
  });

  test("UXI-T56 — with the view turned, a guide and a handle follow the full camera transform at every zoom @feat:editor-tools.nav.zoom @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await openUxiFixture(page, "D");
    await activateTool(page, "paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await selectElements(page, [D.rotated(1)]);
    // Turn the view a quarter (Rotate View) and check at two zooms.
    await page.evaluate(() =>
      (
        globalThis as unknown as CanvasGlobal
      ).__canvas.registries.commands.invoke("paged.view.rotateClockwise"),
    );
    for (const zoom of [0.5, 1.5]) {
      await setZoom(page, zoom);
      // The vertical guide at x 306: its line passes through the client
      // point of (306, 396) on page 1.
      const p = await clientPointOf(page, { at: [306, 396] });
      const hit = await page.evaluate(({ x, y }) => {
        const els = document.elementsFromPoint(x, y);
        return els.some((e) =>
          e.closest("[data-guide-hit],[data-guide-overlay]"),
        );
      }, p);
      expect(hit, `${zoom}: the guide passes through its page point`).toBe(
        true,
      );
      // The selection's NW handle sits on the item's NW corner through the
      // same transform.
      const handle = page
        .locator('[data-selection-handle="northWest"] > rect[data-handle]')
        .first();
      const hb = (await handle.boundingBox())!;
      const g = await page.evaluate(async (id) => {
        const c = (
          globalThis as unknown as {
            __canvas: {
              client: {
                elementGeometry(ids: unknown[]): Promise<
                  Array<{
                    bounds: [number, number, number, number];
                    itemTransform?: number[] | null;
                  }>
                >;
              };
            };
          }
        ).__canvas;
        const [item] = await c.client.elementGeometry([id]);
        const [t, l] = item!.bounds;
        const m = item!.itemTransform ?? [1, 0, 0, 1, 0, 0];
        return [m[0]! * l + m[2]! * t + m[4]!, m[1]! * l + m[3]! * t + m[5]!];
      }, D.rotated(1));
      const q = await clientPointOf(page, { at: [g[0]!, g[1]!] });
      expect(
        Math.hypot(hb.x + hb.width / 2 - q.x, hb.y + hb.height / 2 - q.y),
        `${zoom}: the handle on its corner`,
      ).toBeLessThan(2);
    }
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });
});
