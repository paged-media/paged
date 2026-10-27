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

// A deck's chart is live (slide ADR 715): double-click a chart in the
// slide profile and its data sheet opens over it (the chart context's
// frame surface); a value typed into a cell and Done redraws the chart on
// the slide, and the exported .pptx carries the new value in the chart
// part and its workbook.

import { expect, test, type Page } from "@playwright/test";
import { dirname, resolve as pathResolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readZipText } from "../../e2e/harness/read-zip";
import { Designer } from "../driver/designer";

const CHARTS_FIXTURE = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../../modules/slide/slide-conformance/fixtures/charts.pptx",
);
const PPTX_EXPORTER = "media.paged.slide.exporter.pptx";

type Node = {
  kind: string;
  id?: { kind: string; id: string } | null;
  children?: Node[];
};
type Canvas = {
  __canvas: {
    handle?: { pageCount: number } | null;
    client: {
      sceneTree(): Promise<Node[]>;
      camera: { read: () => { scale: number; tx: number; ty: number } };
      elementGeometry: (ids: unknown[]) => Promise<
        Array<{
          bounds: [number, number, number, number];
          itemTransform?: number[] | null;
        }>
      >;
    };
    registries: {
      importers?: {
        resolve: (n: string) => {
          import: (a: { name: string; bytes: Uint8Array }) => Promise<void>;
        } | null;
      };
      exporters?: {
        list: () => {
          id: string;
          export: () => Promise<{ bytes: Uint8Array } | null>;
        }[];
      };
    };
  };
};

const pageCount = (page: Page) =>
  page.evaluate(
    () => (globalThis as unknown as Canvas).__canvas.handle?.pageCount ?? 0,
  );

/** The screen centre of the tallest bar of the first page's chart, and
 *  the chart group's members' bounds (what a redraw changes). */
async function chartOnScreen(page: Page) {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as Canvas).__canvas;
    const roots = await c.client.sceneTree();
    const find = (n: Node): Node | null => {
      if (n.kind.toLowerCase() === "group" && (n.children?.length ?? 0) > 10)
        return n;
      for (const ch of n.children ?? []) {
        const f = find(ch);
        if (f) return f;
      }
      return null;
    };
    const group = find(roots[0]!);
    if (!group) return null;
    const members = (group.children ?? []).filter((m) => m.id);
    const geom = await c.client.elementGeometry(members.map((m) => m.id));
    let best = 0;
    for (let i = 1; i < geom.length; i++) {
      const h = (g: (typeof geom)[number]) =>
        members[geom.indexOf(g)]!.kind.toLowerCase() === "polygon"
          ? g.bounds[2] - g.bounds[0]
          : 0;
      if (
        h(geom[i]!) > h(geom[best]!) &&
        geom[i]!.bounds[3] - geom[i]!.bounds[1] < 60
      )
        best = i;
    }
    const [top, left, bottom, right] = geom[best]!.bounds;
    const [a, b, cc, d, tx, ty] = geom[best]!.itemTransform ?? [
      1, 0, 0, 1, 0, 0,
    ];
    const mx = (left + right) / 2;
    const my = (top + bottom) / 2;
    let canvas: HTMLCanvasElement | null = null;
    let area = 0;
    for (const cv of Array.from(document.querySelectorAll("canvas"))) {
      const r = cv.getBoundingClientRect();
      if (r.width * r.height > area) {
        area = r.width * r.height;
        canvas = cv;
      }
    }
    const wrap = (canvas?.parentElement ?? canvas)!.getBoundingClientRect();
    const cam = c.client.camera.read();
    return {
      x: wrap.left + (a! * mx + cc! * my + tx!) * cam.scale + cam.tx,
      y: wrap.top + (b! * mx + d! * my + ty!) * cam.scale + cam.ty,
      bounds: JSON.stringify(geom.map((g) => g.bounds.map(Math.round))),
    };
  });
}

test.describe("paged.slide: live chart data", () => {
  test("double-click a chart, edit a cell, Done: the chart redraws and the export carries it", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const designer = new Designer(page);
    await designer.open({ search: "?solo=paged.slide" });
    await expect.poll(() => pageCount(page), { timeout: 25_000 }).toBe(1);
    const bytes = [...readFileSync(CHARTS_FIXTURE)];
    await page.evaluate(async (bytes) => {
      const reg = (globalThis as unknown as Canvas).__canvas.registries
        .importers;
      await reg!
        .resolve("charts.pptx")!
        .import({ name: "charts.pptx", bytes: new Uint8Array(bytes) });
    }, bytes);
    await expect.poll(() => pageCount(page), { timeout: 20_000 }).toBe(5);
    await page.waitForTimeout(800);

    const before = await chartOnScreen(page);
    expect(before, "the first slide's chart is on screen").not.toBeNull();
    // The first double-click enters the chart's group, the second its data.
    await page.mouse.dblclick(before!.x, before!.y);
    await page.waitForTimeout(400);
    await page.mouse.dblclick(before!.x, before!.y);
    const surface = page.locator("[data-slide-chart-surface]");
    await expect(surface).toBeVisible({ timeout: 10_000 });
    await expect(surface.locator('[data-cell="B1"]')).toHaveText("North");

    await surface.locator('[data-cell="B3"]').click();
    await page.keyboard.type("9.25");
    await page.keyboard.press("Enter");
    await expect(surface.locator('[data-cell="B3"]')).toHaveText("9.25");
    if (process.env.PAGED_SHOT)
      await page.screenshot({ path: process.env.PAGED_SHOT });
    await surface.locator("[data-slide-chart-done]").click();
    await expect(surface).toHaveCount(0, { timeout: 10_000 });

    // The chart on the slide is drawn anew from the data.
    await expect
      .poll(async () => (await chartOnScreen(page))?.bounds, {
        timeout: 15_000,
      })
      .not.toBe(before!.bounds);

    const out = await page.evaluate(async (id) => {
      const ex = (globalThis as unknown as Canvas).__canvas.registries
        .exporters!.list()
        .find((e) => e.id === id);
      const r = ex ? await ex.export() : null;
      return r ? Array.from(r.bytes) : null;
    }, PPTX_EXPORTER);
    expect(out).not.toBeNull();
    const chart = readZipText(Buffer.from(out!), "ppt/charts/chart1.xml");
    expect(chart).toContain("<c:v>9.25</c:v>");
  });
});
