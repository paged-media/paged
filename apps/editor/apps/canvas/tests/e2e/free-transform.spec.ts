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

// Free Transform (editor ADR 293) end to end: the `e` tool on the real
// rail, real pointer drags on the canvas, the committed geometry read back
// from the engine, and one Cmd+Z undoing each drag — move, scale, rotate,
// shear (both axes), free distort and perspective; the Control bar's
// reference grid, modes and numeric shear.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { cameraScale, screenPoint } from "./harness/viewport";
import { Designer } from "../journey/driver/designer";

type Ref = { kind: string; id: string };
type Affine = [number, number, number, number, number, number];

interface Geometry {
  bounds: [number, number, number, number];
  itemTransform: Affine | null;
}

const geometry = (page: Page, ref: Ref): Promise<Geometry> =>
  page.evaluate(async (r) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: { elementGeometry: (ids: unknown[]) => Promise<Geometry[]> };
        };
      }
    ).__canvas;
    const [g] = await c.client.elementGeometry([r]);
    return { bounds: g!.bounds, itemTransform: g!.itemTransform ?? null };
  }, ref);

/** The item's four corners on the page (NW, NE, SE, SW). */
const corners = (g: Geometry): Array<[number, number]> => {
  const [top, left, bottom, right] = g.bounds;
  const t = g.itemTransform ?? [1, 0, 0, 1, 0, 0];
  const at = (x: number, y: number): [number, number] => [
    t[0] * x + t[2] * y + t[4],
    t[1] * x + t[3] * y + t[5],
  ];
  return [at(left, top), at(right, top), at(right, bottom), at(left, bottom)];
};

const anchorsOf = (page: Page, ref: Ref): Promise<Array<[number, number]>> =>
  page.evaluate(async (r) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            pathAnchors: (id: unknown) => Promise<{
              anchors: { anchor: [number, number] }[];
              itemTransform?: Affine | null;
            } | null>;
          };
        };
      }
    ).__canvas;
    const p = await c.client.pathAnchors(r);
    const t = p?.itemTransform ?? [1, 0, 0, 1, 0, 0];
    return (p?.anchors ?? []).map(({ anchor: [x, y] }) => [
      t[0] * x + t[2] * y + t[4],
      t[1] * x + t[3] * y + t[5],
    ]) as Array<[number, number]>;
  }, ref);

async function drag(
  page: Page,
  from: [number, number],
  to: [number, number],
  modifiers: Array<"Shift" | "Alt" | "ControlOrMeta"> = [],
): Promise<void> {
  const a = await screenPoint(page, from[0], from[1]);
  const b = await screenPoint(page, to[0], to[1]);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.waitForTimeout(60);
  await page.mouse.up();
  for (const m of modifiers.reverse()) await page.keyboard.up(m);
}

async function undo(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+z");
}

const near = (a: number, b: number, eps = 1.5) => Math.abs(a - b) <= eps;

async function freeTransformOn(designer: Designer, page: Page, ref: Ref) {
  await designer.selectElement(ref.kind, ref.id);
  await page.keyboard.press("Escape");
  await designer.selectElement(ref.kind, ref.id);
  await page.locator("body").press("e");
  await expect(
    page.locator(
      '[data-tool-slot="transform"][data-tool="paged.tool.freeTransform"][data-active="true"]',
    ),
  ).toBeVisible();
}

test.describe("Free Transform tool", () => {
  test("AC-FT-1 — move, scale, rotate and shear are one engine gesture each, and one undo step each @feat:editor-tools.free-transform @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.freeTransform");
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    const id = await designer.drawRectangle({
      x0: 100,
      y0: 100,
      x1: 300,
      y1: 200,
    });
    const ref: Ref = { kind: "rectangle", id };
    await freeTransformOn(designer, page, ref);
    const start = corners(await geometry(page, ref));

    // MOVE — inside the box.
    await drag(page, [180, 150], [220, 170]);
    await expect
      .poll(async () => corners(await geometry(page, ref))[0]![0])
      .toBeGreaterThan(start[0]![0] + 30);
    await undo(page);
    await expect
      .poll(async () =>
        near(corners(await geometry(page, ref))[0]![0], start[0]![0]),
      )
      .toBe(true);

    // SCALE — the SE corner; the NW corner holds.
    await drag(
      page,
      [start[2]![0], start[2]![1]],
      [start[2]![0] + 100, start[2]![1] + 50],
    );
    await expect
      .poll(async () => corners(await geometry(page, ref))[2]![0])
      .toBeGreaterThan(start[2]![0] + 80);
    const scaled = corners(await geometry(page, ref));
    expect(near(scaled[0]![0], start[0]![0])).toBe(true);
    expect(near(scaled[0]![1], start[0]![1])).toBe(true);
    await undo(page);
    await expect
      .poll(async () =>
        near(corners(await geometry(page, ref))[2]![0], start[2]![0]),
      )
      .toBe(true);

    // ROTATE — just outside the NE corner (16 screen px out: past the
    // 6 px handle, inside the 28 px rotate zone), about the centre.
    const out = 16 / (await cameraScale(page));
    await drag(
      page,
      [start[1]![0] + out, start[1]![1] - out],
      [start[1]![0] + 60, start[1]![1] + 80],
    );
    await expect
      .poll(async () => {
        const t = (await geometry(page, ref)).itemTransform;
        return t ? Math.abs(t[1]) : 0;
      })
      .toBeGreaterThan(0.1);
    await undo(page);
    await expect
      .poll(async () => {
        const t = (await geometry(page, ref)).itemTransform;
        return t ? Math.abs(t[1]) : 0;
      })
      .toBeLessThan(1e-3);

    // SHEAR x — Cmd on the top side.
    await drag(page, [200, 100], [240, 100], ["ControlOrMeta"]);
    await expect
      .poll(async () => {
        const t = (await geometry(page, ref)).itemTransform;
        return t ? Math.abs(t[2]) : 0;
      })
      .toBeGreaterThan(0.1);
    await undo(page);

    // SHEAR y — Cmd on the right side (the anchor's `shearAxis: "y"`).
    await drag(page, [300, 150], [300, 190], ["ControlOrMeta"]);
    await expect
      .poll(async () => {
        const t = (await geometry(page, ref)).itemTransform;
        return t ? Math.abs(t[1]) : 0;
      })
      .toBeGreaterThan(0.1);
    const sheared = (await geometry(page, ref)).itemTransform!;
    expect(Math.abs(sheared[2])).toBeLessThan(1e-3);
    await undo(page);
    await expect
      .poll(async () => {
        const t = (await geometry(page, ref)).itemTransform;
        return t ? Math.abs(t[1]) : 0;
      })
      .toBeLessThan(1e-3);
  });

  test("AC-FT-2 — Cmd on a corner distorts a path, Cmd+Alt+Shift puts it in perspective; one undo step each @feat:editor-tools.free-transform @level:gesture", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    const id = await designer.drawPath([
      [100, 100],
      [300, 100],
      [300, 200],
      [100, 200],
    ]);
    const ref: Ref = { kind: "polygon", id };
    await freeTransformOn(designer, page, ref);
    const before = await anchorsOf(page, ref);
    const se = before.reduce((m, p) => (p[0] + p[1] > m[0] + m[1] ? p : m));

    // FREE DISTORT — the SE corner alone moves.
    await drag(
      page,
      [se[0], se[1]],
      [se[0] + 40, se[1] + 30],
      ["ControlOrMeta"],
    );
    await expect
      .poll(async () =>
        (await anchorsOf(page, ref)).some(
          (p) => near(p[0], se[0] + 40, 3) && near(p[1], se[1] + 30, 3),
        ),
      )
      .toBe(true);
    const distorted = await anchorsOf(page, ref);
    const nw = before.reduce((m, p) => (p[0] + p[1] < m[0] + m[1] ? p : m));
    expect(distorted.some((p) => near(p[0], nw[0]) && near(p[1], nw[1]))).toBe(
      true,
    );
    await undo(page);
    await expect
      .poll(async () =>
        (await anchorsOf(page, ref)).some(
          (p) => near(p[0], se[0]) && near(p[1], se[1]),
        ),
      )
      .toBe(true);

    // PERSPECTIVE — the NE corner slides right, the NW corner mirrors it.
    const ne = before.reduce((m, p) => (p[0] - p[1] > m[0] - m[1] ? p : m));
    await drag(
      page,
      [ne[0], ne[1]],
      [ne[0] + 30, ne[1] + 2],
      ["ControlOrMeta", "Alt", "Shift"],
    );
    await expect
      .poll(async () =>
        (await anchorsOf(page, ref)).some(
          (p) => near(p[0], nw[0] - 30, 3) && near(p[1], nw[1], 3),
        ),
      )
      .toBe(true);
    await undo(page);
    await expect
      .poll(async () =>
        (await anchorsOf(page, ref)).some(
          (p) => near(p[0], nw[0]) && near(p[1], nw[1]),
        ),
      )
      .toBe(true);
  });

  test("AC-FT-3 — the Control bar: reference grid, modes and a numeric shear in one undo step @feat:editor-tools.free-transform @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    const id = await designer.drawRectangle({
      x0: 100,
      y0: 100,
      x1: 300,
      y1: 200,
    });
    const ref: Ref = { kind: "rectangle", id };
    await freeTransformOn(designer, page, ref);
    const bar = page.locator("[data-free-transform-controls]");
    await expect(bar).toBeVisible();
    await bar.locator('[data-reference="nw"]').click();
    await expect(bar.locator('[data-reference="nw"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await bar.locator('[data-box-mode="perspective"]').click();
    await expect(bar.locator('[data-box-mode="perspective"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await bar.locator('[data-box-mode="freeTransform"]').click();

    const shear = bar.locator('[data-control-field="ft-shear"] input');
    await shear.fill("20");
    await shear.press("Enter");
    await expect
      .poll(async () => {
        const t = (await geometry(page, ref)).itemTransform;
        return t ? t[2] : 0;
      })
      .toBeCloseTo(Math.tan((20 * Math.PI) / 180), 2);
    // About the NW reference point: the top-left corner did not move.
    const c = corners(await geometry(page, ref));
    expect(near(c[0]![0], 100)).toBe(true);
    expect(near(c[0]![1], 100)).toBe(true);
    await undo(page);
    await expect
      .poll(async () => {
        const t = (await geometry(page, ref)).itemTransform;
        return t ? Math.abs(t[2]) : 0;
      })
      .toBeLessThan(1e-3);
  });
});
