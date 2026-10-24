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

// WP4.5 / WP4.6 in the browser: what the component lane cannot see,
// because it has no layout, no real pointer and no rendered page.
//
//   · Info: the cursor over the canvas reads page-relative X/Y in the
//     document's units, a selection reads its W/H, and the colour under
//     the cursor is sampled from the page the engine drew;
//   · Navigator: the view rectangle sits on the thumbnail, a drag on the
//     thumbnail pans the canvas, the buttons zoom;
//   · isolation: entering a group or an edit context veils everything
//     outside it, and leaving lifts the veil;
//   · Layers: a row click selects the item, Locate opens the tree to the
//     selection, a drag reorders the stacking as one undo step.
//
// Documents are built in code (the test kit's gesture fixture).

import { expect, test, type Page } from "@playwright/test";
import { covers, GESTURE_TARGETS as T } from "@paged-media/test-kit";

import { openCanvas, openPanel } from "../fidelity/canvas-driver";
import {
  loadGestureFixture,
  selectElements,
  selectedIds,
} from "./harness/gesture-kit";
import { screenPoint } from "./harness/viewport";

interface CanvasGlobal {
  __canvas: {
    client: {
      undo: () => Promise<unknown>;
      sceneTree: () => Promise<
        Array<{
          id?: { kind: string; id: string } | null;
          children?: Array<{
            id?: { kind: string; id: string } | null;
            children?: Array<{ id?: { kind: string; id: string } | null }>;
          }>;
        }>
      >;
      camera: { read: () => { scale: number; tx: number; ty: number } };
    };
  };
}

test.beforeEach(async ({ page }) => {
  await openCanvas(page);
  await loadGestureFixture(page, "targets");
});

const infoValue = (page: Page, row: string) =>
  page
    .locator(
      `[data-panel-host="paged.info"] [data-info-row="${row}"] [data-info-value]`,
    )
    .textContent();

const pt = (s: string | null) => Number((s ?? "").replace(/[^\d.-]/g, ""));

const camera = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as CanvasGlobal).__canvas.client.camera.read(),
  );

const topLevelOrder = (page: Page) =>
  page.evaluate(async () => {
    const roots = await (
      globalThis as unknown as CanvasGlobal
    ).__canvas.client.sceneTree();
    return roots
      .flatMap((s) => s.children ?? [])
      .flatMap((p) => p.children ?? [])
      .map((n) => (n.id ? `${n.id.kind}:${n.id.id}` : "?"));
  });

test("Info: the cursor, the selection and the colour under the cursor @feat:editor-shell.panels.info-navigator @level:happy", async ({
  page,
}) => {
  covers("panel:paged.info");
  await openPanel(page, "paged.info");
  await expect(
    page.locator('[data-panel-host="paged.info"] [data-info-panel="ready"]'),
  ).toBeVisible();
  // Over the frame: page-relative X/Y in points (one screen pixel of
  // slack at the fitted zoom).
  const at = await screenPoint(page, T.frame.at[0], T.frame.at[1]);
  await page.mouse.move(at.x, at.y);
  const slack = 1.5 / at.scale;
  await expect
    .poll(async () => pt(await infoValue(page, "Cursor X")))
    .toBeGreaterThan(T.frame.at[0] - slack);
  expect(pt(await infoValue(page, "Cursor X"))).toBeLessThan(
    T.frame.at[0] + slack,
  );
  expect(pt(await infoValue(page, "Cursor Y"))).toBeCloseTo(T.frame.at[1], 0);
  expect(await infoValue(page, "Cursor page")).toBe("Page 1");
  // The colour is sampled from the page the engine drew: a blank spot of
  // the page reads paper white, in hex, RGB and Lab.
  const blank = await screenPoint(page, 560, 760);
  await page.mouse.move(blank.x, blank.y);
  await expect
    .poll(() => infoValue(page, "Hex"), { timeout: 15_000 })
    .toBe("#ffffff");
  expect(await infoValue(page, "RGB")).toBe("255 255 255");
  expect(await infoValue(page, "Lab")).toBe("100 0 0");
  await expect(
    page.locator('[data-panel-host="paged.info"] [data-info-note="cmyk"]'),
  ).toBeVisible();
  // The selection: the frame's box [top, left, bottom, right].
  await selectElements(page, [T.frame.id]);
  const [top, left, bottom, right] = T.frame.box;
  await expect
    .poll(() => infoValue(page, "Selection W"))
    .toBe(`${right - left} pt`);
  expect(await infoValue(page, "Selection H")).toBe(`${bottom - top} pt`);
  expect(await infoValue(page, "Selection X")).toBe(`${left} pt`);
  expect(await infoValue(page, "Selection angle")).toBe("0°");
});

test("Navigator: the view rectangle, a drag on the thumbnail pans, the buttons zoom @feat:editor-shell.panels.info-navigator @level:happy", async ({
  page,
}) => {
  covers("panel:paged.navigator");
  await openPanel(page, "paged.navigator");
  const host = page.locator('[data-panel-host="paged.navigator"]');
  const thumb = host.locator("[data-navigator-thumb]");
  await expect(thumb).toBeVisible();
  await expect(host.locator("[data-navigator]")).toHaveAttribute(
    "data-navigator-page",
    T.pageId,
  );
  await expect(host.locator("[data-navigator-view]")).toBeAttached();
  const box = (await thumb.boundingBox())!;
  const before = await camera(page);
  // Drag from the thumbnail's centre to a quarter: the canvas pans so
  // the view centres on what is under the pointer; the zoom stays.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 4, {
    steps: 5,
  });
  await page.mouse.up();
  await expect.poll(async () => (await camera(page)).tx).not.toBe(before.tx);
  const after = await camera(page);
  expect(after.scale).toBeCloseTo(before.scale, 6);
  // The view's centre is now a quarter of the page in, in page space.
  const k = box.width / T.pageSize[0];
  const vp = await page.evaluate(() => {
    const host = document.querySelector(
      '[data-testid="viewport-canvas-host"]',
    )!;
    const r = host.getBoundingClientRect();
    return [r.width, r.height];
  });
  const cx = (vp[0]! / 2 - after.tx) / after.scale;
  const cy = (vp[1]! / 2 - after.ty) / after.scale;
  expect(cx).toBeCloseTo(box.width / 4 / k, -1);
  expect(cy).toBeCloseTo(box.height / 4 / k, -1);
  // The view rectangle moved with it (it is drawn where the view is).
  await host.locator('[data-navigator-zoom="in"]').click();
  await expect
    .poll(async () => (await camera(page)).scale)
    .toBeCloseTo(after.scale * 1.5, 4);
  await expect(host.locator("[data-navigator-percent]")).toHaveValue(
    `${Math.round(after.scale * 150)}%`,
  );
  await host.locator('[data-navigator-zoom="out"]').click();
  await expect
    .poll(async () => (await camera(page)).scale)
    .toBeCloseTo(after.scale, 4);
});

test("Isolation: entering a group or an edit context veils everything else; leaving lifts it @feat:editor-shell.isolation-layers @level:happy", async ({
  page,
}) => {
  const veil = page.locator("[data-isolation-dim]");
  await expect(veil).toHaveCount(0);
  // Double-click a grouped item: the group is entered (Track L).
  const a = await screenPoint(page, T.group.at[0], T.group.at[1]);
  await page.mouse.dblclick(a.x, a.y);
  await expect(veil).toHaveAttribute(
    "data-isolation-dim",
    `group:${T.group.id.id}`,
  );
  await expect(veil).toHaveAttribute("fill-rule", "evenodd");
  // Escape climbs out of the group: the veil goes.
  await page.keyboard.press("Escape");
  await expect(veil).toHaveCount(0);
  // Double-click a plain frame: the vectorGraphic edit context, veiled
  // outside its scope root.
  const f = await screenPoint(page, T.frame.at[0], T.frame.at[1]);
  await page.mouse.dblclick(f.x, f.y);
  await expect(page.locator("[data-edit-context-breadcrumb]")).toBeVisible({
    timeout: 5_000,
  });
  await expect(veil).toHaveAttribute(
    "data-isolation-dim",
    `${T.frame.id.kind}:${T.frame.id.id}`,
  );
  await page.keyboard.press("Escape");
  await expect(veil).toHaveCount(0);
});

test("Layers: a row selects its item, Locate opens the tree to the selection, a drag reorders as one undo step @feat:editor-shell.isolation-layers @feat:editor-shell.panels.layers @level:happy", async ({
  page,
}) => {
  covers("panel:paged.layers");
  await openPanel(page, "paged.layers");
  const host = page.locator('[data-panel-host="paged.layers"]');
  await expect(host.locator('[data-layer-objects="ready"]')).toBeVisible();
  const row = (id: { kind: string; id: string }) =>
    host.locator(`[data-object-row="${id.kind}:${id.id}"]`);
  // A row click selects the item on the canvas.
  await row(T.frame.id).click();
  await expect.poll(() => selectedIds(page)).toEqual([T.frame.id.id]);
  await expect(row(T.frame.id)).toHaveAttribute("data-selected", "");
  // Locate: a group member selected on the canvas side is revealed.
  await selectElements(page, [T.group.childB]);
  await expect(row(T.group.childB)).toHaveCount(0);
  await host.locator('[data-action="locate-object"]').click();
  await expect(row(T.group.childB)).toBeVisible();
  await expect(row(T.group.childB)).toHaveAttribute("data-located", "");
  // Drag the frame onto the rotated frame: it takes that slot.
  const before = await topLevelOrder(page);
  const frameKey = `${T.frame.id.kind}:${T.frame.id.id}`;
  const rotKey = `${T.rotated.id.kind}:${T.rotated.id.id}`;
  await row(T.frame.id).dragTo(row(T.rotated.id));
  await expect
    .poll(async () => (await topLevelOrder(page)).indexOf(frameKey))
    .toBe(before.indexOf(rotKey));
  await page.evaluate(() =>
    (globalThis as unknown as CanvasGlobal).__canvas.client.undo(),
  );
  await expect.poll(() => topLevelOrder(page)).toEqual(before);
});
