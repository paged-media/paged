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

// E2E — live shapes (engine ADR 10XX, editor ADR 310) in the running
// editor: the Polygon tool draws a LIVE polygon, and the on-canvas
// widgets of the selected shape change its sides, its star inset, an
// oval's pie and a rectangle's corners, each in ONE undo step, through
// the real viewport and pointer.

import { expect, test, type Page } from "@playwright/test";

import { openCanvas } from "../fidelity/canvas-driver";
import { dragMouse, loadViaReactPath, screenPoint } from "./harness/viewport";

type ElementRef = { kind: string; id: string };

interface Canvas {
  handle: { pageIds: string[] };
  client: {
    mutate: (m: unknown) => Promise<{
      kind: string;
      payload: { createdId?: ElementRef | null };
    }>;
    undo: () => Promise<unknown>;
    setElementSelection: (ids: unknown[], mode: string) => Promise<unknown[]>;
    elementGeometry: (ids: unknown[]) => Promise<unknown[]>;
    elementProperties: (
      id: unknown,
    ) => Promise<{ entries: Array<{ path: string; value: unknown }> } | null>;
    pathAnchors: (id: unknown) => Promise<{ anchors: unknown[] } | null>;
  };
  setElementSelection?: (ids: unknown[]) => void;
  setElementGeometry?: (items: unknown[]) => void;
}

/** Insert with `mutation` and select what it made, worker then mirror. */
async function insertAndSelect(
  page: Page,
  mutation: unknown,
): Promise<ElementRef> {
  return page.evaluate(async (m) => {
    const c = (globalThis as unknown as { __canvas: Canvas }).__canvas;
    const withPage = JSON.parse(
      JSON.stringify(m).replaceAll("$PAGE", c.handle.pageIds[0]!),
    );
    const made = await c.client.mutate(withPage);
    const ref = made.payload.createdId!;
    const applied = await c.client.setElementSelection([ref], "replace");
    c.setElementSelection?.(applied);
    c.setElementGeometry?.(await c.client.elementGeometry([ref]));
    return ref;
  }, mutation);
}

async function prop(
  page: Page,
  ref: ElementRef,
  path: string,
): Promise<unknown> {
  return page.evaluate(
    async ({ r, p }) => {
      const c = (globalThis as unknown as { __canvas: Canvas }).__canvas;
      const props = await c.client.elementProperties(r);
      const v = props?.entries.find((e) => e.path === p)?.value as
        { value: unknown } | null | undefined;
      return v?.value ?? null;
    },
    { r: ref, p: path },
  );
}

async function anchorCount(page: Page, ref: ElementRef): Promise<number> {
  return page.evaluate(async (r) => {
    const c = (globalThis as unknown as { __canvas: Canvas }).__canvas;
    return (await c.client.pathAnchors(r))?.anchors.length ?? 0;
  }, ref);
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (
      globalThis as unknown as { __canvas: Canvas }
    ).__canvas.client.undo();
  });
}

/** The screen centre of a widget. */
async function widgetAt(
  page: Page,
  id: string,
): Promise<{ x: number; y: number }> {
  const w = page.locator(`[data-live-handle="${id}"] circle`).first();
  await expect(w).toBeVisible();
  const box = (await w.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe("live shapes: the widgets of the selected shape", () => {
  test.beforeEach(async ({ page }) => {
    await openCanvas(page);
    await loadViaReactPath(page, "geometry");
  });

  test("the Polygon tool draws a live polygon; its side widget adds sides and its star widget makes a star, one undo step each @feat:plugin-draw.live-shapes @level:gesture", async ({
    page,
  }) => {
    await page.locator('[data-tool-slot="shape"]').click({ button: "right" });
    await page
      .locator('[data-tool-flyout="shape"] [data-tool="paged.tool.polygon"]')
      .click();
    const from = await screenPoint(page, 120, 120);
    const to = await screenPoint(page, 260, 260);
    await dragMouse(page, from, to);
    const handles = page.locator(
      "[data-live-shape-handles][data-live-shape-kind='polygon']",
    );
    await expect(handles).toBeVisible();
    const ref = await page.evaluate(
      () =>
        (
          globalThis as unknown as {
            __canvas: { elementSelection: ElementRef[] };
          }
        ).__canvas.elementSelection[0]!,
    );
    expect(await prop(page, ref, "frameShapeSides")).toBe(6);

    // Two sides up: 24 screen px.
    const s = await widgetAt(page, "sides");
    await dragMouse(page, s, { x: s.x, y: s.y - 26 });
    await expect.poll(() => prop(page, ref, "frameShapeSides")).toBe(8);
    expect(await anchorCount(page, ref)).toBe(8);

    // The star widget, halfway to the centre.
    const centre = await screenPoint(page, 190, 190);
    const i = await widgetAt(page, "inset");
    await dragMouse(page, i, {
      x: (i.x + centre.x) / 2,
      y: (i.y + centre.y) / 2,
    });
    await expect.poll(() => anchorCount(page, ref)).toBe(16);
    const inset = (await prop(page, ref, "frameShapeStarInset")) as number;
    expect(inset).toBeGreaterThan(30);
    expect(inset).toBeLessThan(70);

    await undo(page);
    await expect.poll(() => anchorCount(page, ref)).toBe(8);
    await undo(page);
    await expect.poll(() => prop(page, ref, "frameShapeSides")).toBe(6);
  });

  test("an oval's pie widget cuts a pie, one undo step @feat:plugin-draw.live-shapes @level:gesture", async ({
    page,
  }) => {
    const ref = await insertAndSelect(page, {
      op: "insertOval",
      args: { pageId: "$PAGE", bounds: [120, 120, 220, 320] },
    });
    await expect(
      page.locator("[data-live-shape-handles][data-live-shape-kind='oval']"),
    ).toBeVisible();
    // The end widget sits at three o'clock; drag it to twelve.
    const end = await widgetAt(page, "pie-end");
    const top = await screenPoint(page, 220, 120);
    await dragMouse(page, end, top);
    // To the pixel the pointer lands on: within a tenth of a degree.
    await expect
      .poll(async () =>
        Math.round(
          ((await prop(page, ref, "frameShapePieEnd")) as number) * 10,
        ),
      )
      .toBe(900);
    await undo(page);
    await expect.poll(() => prop(page, ref, "frameShapePieEnd")).toBe(360);
  });

  test("a rectangle's corner widget rounds the four corners, one undo step @feat:plugin-draw.live-shapes @level:gesture", async ({
    page,
  }) => {
    const ref = await insertAndSelect(page, {
      op: "insertFrame",
      args: { pageId: "$PAGE", bounds: [120, 120, 320, 420] },
    });
    await expect(
      page.locator(
        "[data-live-shape-handles][data-live-shape-kind='rectangle'][data-count='4']",
      ),
    ).toBeVisible();
    const w = await widgetAt(page, "corner-0");
    const inside = await screenPoint(page, 150, 150);
    await dragMouse(page, w, inside);
    await expect
      .poll(() => prop(page, ref, "frameCornerOptionBottomRight"))
      .toBe("RoundedCorner");
    const r = (await prop(page, ref, "frameCornerRadiusTopLeft")) as number;
    expect(r).toBeGreaterThan(25);
    expect(r).toBeLessThan(35);
    await undo(page);
    await expect
      .poll(() => prop(page, ref, "frameCornerOptionBottomRight"))
      .not.toBe("RoundedCorner");
  });
});
