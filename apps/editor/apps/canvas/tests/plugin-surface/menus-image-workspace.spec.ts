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

// PLUGIN MENUS — paged.image's workspace rows of WP5.12 (image ADR 475,
// extensions ADR 340), live only inside the rasterImage edit context:
// View ▸ Rulers ▸ Pixels / Inches / Centimetres / Millimetres, Show / Lock /
// Snap to / Clear Guides, New guide…, the slice, note, count and ruler
// verbs, Image ▸ Straighten to ruler and Image ▸ File ▸ Export slices….
//
// Each row is clicked through the real bar and must run exactly its
// command; what it does is asserted where the editor shows it: the HOST
// rulers count in the image's unit, the HOST guide overlay draws the
// image's guides, the image panel's Workspace section follows. None of it
// changes the document until the image is committed.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { screenPoint } from "../e2e/harness/viewport";
import { Designer } from "../journey/driver/designer";
import {
  clickEntry,
  closeMenus,
  contextRouteOf,
  documentDigest,
  installMenuProbe,
  routeOf,
  type MenuRoute,
} from "./menu-driver";

const C = "media.paged.image.command";

async function contextType(page: Page): Promise<string | null> {
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

/** A frame holding a 160×120 PNG, ingested: the rasterImage context is
 *  active (the edit-context-chrome spec's route). */
async function enterRasterContext(page: Page): Promise<void> {
  const designer = new Designer(page);
  await designer.open();
  await designer.newDocument();
  const frame = await designer.drawRectangle({
    x0: 90,
    y0: 120,
    x1: 410,
    y1: 360,
  });
  const placed = await page.evaluate(async (elementId) => {
    const cv = new OffscreenCanvas(160, 120);
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#2050d0";
    ctx.fillRect(0, 0, 160, 120);
    const bytes = Array.from(
      new Uint8Array(
        await (await cv.convertToBlob({ type: "image/png" })).arrayBuffer(),
      ),
    );
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: { mutate: (m: unknown) => Promise<{ kind: string }> };
        };
      }
    ).__canvas;
    return (
      await c.client.mutate({
        op: "replaceImageBytes",
        args: { elementId, bytes },
      })
    ).kind;
  }, frame);
  expect(placed).toBe("mutationApplied");
  await designer.activate("select");
  await designer.selectElement("rectangle", frame);
  await designer.runCommand(`${C}.adjustSelected`);
  await expect
    .poll(() => contextType(page), { timeout: 20_000 })
    .toBe("rasterImage");
  await page.locator("body").focus();
}

/** Click a context-scoped row: View rows sit in the host's View menu, the
 *  Image rows wherever the bar shows the bundle's Image menu. */
async function run(page: Page, path: string, command: string) {
  let route: MenuRoute = routeOf(path);
  try {
    return await clickEntry(page, path, command, { route });
  } catch (first) {
    await closeMenus(page);
    route = contextRouteOf(path);
    try {
      return await clickEntry(page, path, command, { route });
    } catch {
      throw first;
    }
  }
}

const panel = (page: Page) => page.locator("[data-image-workspace-section]");
const guides = (page: Page) => page.locator("[data-workspace-guide]");

test.describe.serial(
  "plugin menus — paged.image workspace (rulers, guides, slices, notes, count)",
  { tag: ["@feat:image.editor.workspace"] },
  () => {
    let page: Page;

    test.beforeAll(async ({ browser }, info) => {
      const context = await browser.newContext({
        baseURL: info.project.use.baseURL,
        viewport: { width: 1600, height: 1000 },
      });
      page = await context.newPage();
      await enterRasterContext(page);
      await installMenuProbe(page);
      // Entering writes the frame's ownership marker; let every write the
      // entry started land before the rows' "document unchanged" checks.
      let last = "";
      await expect
        .poll(
          async () => {
            const now = await documentDigest(page);
            const settled = now === last;
            last = now;
            await page.waitForTimeout(500);
            return settled;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
    });
    test.afterAll(async () => {
      await page.context().close();
    });

    test("View/New guide… — the dialog adds a guide the HOST draws, the rulers count pixels", async () => {
      covers("menu:View/New guide…");
      const out = await run(page, "View/New guide…", `${C}.newGuide`);
      expect(out.after, "a dialog leaves the document alone").toBe(out.before);
      const dialog = page.locator("[data-image-new-guide-dialog]");
      await expect(dialog).toBeVisible();
      await dialog.locator("[data-image-guide-position]").fill("40");
      await dialog.locator("[data-image-guide-add]").click();
      await expect(guides(page)).toHaveCount(1);
      await expect(guides(page).first()).toHaveAttribute(
        "data-guide-position",
        "40",
      );
      await expect(page.locator("[data-h-ruler]")).toHaveAttribute(
        "data-ruler-unit",
        "px",
      );
    });

    test("View/Rulers/Inches, Centimetres, Millimetres, Pixels — the host rulers change unit", async () => {
      covers(
        "menu:View/Rulers/Inches",
        "menu:View/Rulers/Centimetres",
        "menu:View/Rulers/Millimetres",
        "menu:View/Rulers/Pixels",
      );
      const ruler = page.locator("[data-h-ruler]");
      for (const [leaf, suffix, unit] of [
        ["Inches", "rulerUnitIn", "in"],
        ["Centimetres", "rulerUnitCm", "cm"],
        ["Millimetres", "rulerUnitMm", "mm"],
        ["Pixels", "rulerUnitPx", "px"],
      ] as const) {
        const out = await run(page, `View/Rulers/${leaf}`, `${C}.${suffix}`);
        expect(out.after).toBe(out.before);
        await expect(ruler).toHaveAttribute("data-ruler-unit", unit);
      }
    });

    test("View/Lock guides — the guide keeps drawing but cannot be grabbed", async () => {
      covers("menu:View/Lock guides");
      await run(page, "View/Lock guides", `${C}.toggleLockGuides`);
      await expect(guides(page)).toHaveCount(1);
      await expect(page.locator("[data-workspace-guide-hit]")).toHaveCount(0);
      await run(page, "View/Lock guides", `${C}.toggleLockGuides`);
      await expect(page.locator("[data-workspace-guide-hit]")).toHaveCount(1);
    });

    test("View/Show guides — hides and shows the image's guides", async () => {
      covers("menu:View/Show guides");
      await run(page, "View/Show guides", `${C}.toggleGuides`);
      await expect(guides(page)).toHaveCount(0);
      await run(page, "View/Show guides", `${C}.toggleGuides`);
      await expect(guides(page)).toHaveCount(1);
    });

    test("View/Snap to guides — the Workspace section follows", async () => {
      covers("menu:View/Snap to guides");
      const box = panel(page).locator("[data-image-snap-guides]");
      await expect(box).toBeChecked();
      await run(page, "View/Snap to guides", `${C}.toggleSnapGuides`);
      await expect(box).not.toBeChecked();
      await run(page, "View/Snap to guides", `${C}.toggleSnapGuides`);
      await expect(box).toBeChecked();
    });

    test("View/Slices from guides and View/Delete all slices", async () => {
      covers("menu:View/Slices from guides", "menu:View/Delete all slices");
      await run(page, "View/Slices from guides", `${C}.slicesFromGuides`);
      await expect(panel(page).locator("[data-image-slice]")).toHaveCount(2);
      await run(page, "View/Delete all slices", `${C}.clearSlices`);
      await expect(panel(page).locator("[data-image-slice]")).toHaveCount(0);
    });

    test("Image/File/Export slices… — with no slices it says so and saves nothing", async () => {
      covers("menu:Image/File/Export slices…");
      const out = await run(
        page,
        "Image/File/Export slices…",
        `${C}.exportSlices`,
      );
      expect(out.shell.filter((s) => s.door === "saveFile")).toEqual([]);
    });

    test("View/New count group and View/Clear count", async () => {
      covers("menu:View/New count group", "menu:View/Clear count");
      await run(page, "View/New count group", `${C}.newCountGroup`);
      await expect(
        panel(page).locator("[data-image-count-group] option"),
      ).toHaveCount(1);
      await run(page, "View/Clear count", `${C}.clearCount`);
      await expect(panel(page).locator("[data-image-count-total]")).toHaveText(
        /^0 /,
      );
    });

    test("View/Delete all notes, View/Clear ruler and Image/Straighten to ruler run inside the image", async () => {
      covers(
        "menu:View/Delete all notes",
        "menu:View/Clear ruler",
        "menu:Image/Straighten to ruler",
      );
      const notes = await run(page, "View/Delete all notes", `${C}.clearNotes`);
      expect(notes.after).toBe(notes.before);
      await run(page, "View/Clear ruler", `${C}.clearRuler`);
      await expect(
        panel(page).locator("[data-image-ruler-readout]"),
      ).toHaveCount(0);
      const s = await run(
        page,
        "Image/Straighten to ruler",
        `${C}.straightenToRuler`,
      );
      expect(s.after, "nothing to straighten: the document is unchanged").toBe(
        s.before,
      );
    });

    test("View/Clear guides — the image's guides go, the document is untouched", async () => {
      covers("menu:View/Clear guides");
      const out = await run(page, "View/Clear guides", `${C}.clearGuides`);
      await expect(guides(page)).toHaveCount(0);
      expect(out.after).toBe(out.before);
      expect(await contextType(page)).toBe("rasterImage");
    });

    test("a guide dragged out of the top ruler lands in the image, and the Info panel reads the image @level:gesture", async () => {
      const ruler = page.locator("[data-h-ruler]");
      const rb = (await ruler.boundingBox())!;
      const viewport = page.locator("[data-paged-viewport]");
      const vb = (await viewport.boundingBox())!;
      await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
      await page.mouse.down();
      await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2, {
        steps: 8,
      });
      await page.mouse.up();
      await expect(
        page.locator('[data-workspace-guide="horizontal"]'),
      ).toHaveCount(1);
      await expect(panel(page).locator("[data-image-guide-count]")).toHaveText(
        "1 guides",
      );
      // The Info panel leads with the image's rows while the pointer is
      // over its pixels (the readout lane).
      await page.evaluate(() =>
        (
          globalThis as unknown as {
            __shellDoors: { openPanel(id: string): void };
          }
        ).__shellDoors.openPanel("paged.info"),
      );
      // Inside the frame (page 90…410 × 120…360 pt), over the image.
      const inside = await screenPoint(page, 250, 240);
      await page.mouse.move(inside.x, inside.y, { steps: 4 });
      const rows = page.locator('[data-info-section="provided:image"]');
      await expect(
        rows.locator('[data-info-row="Image RGB"] [data-info-value]'),
      ).toHaveText("32 80 208");
      expect(await contextType(page)).toBe("rasterImage");
    });
  },
);
