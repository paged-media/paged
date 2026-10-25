/*
 * This file is part of paged (https://paged.media).
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

// Editor ADR 287 — the View menu over the engine's view modes and
// snapping (WP4.7 over WP2.5), in the real editor:
//
//   · Outline (⌘Y) changes what the canvas draws and changes no document
//     (no undo step, the document stays clean); a second ⌘Y restores it;
//   · Overprint / Pixel Preview reach the engine as its view mode;
//   · Snap to Grid makes a move land on the 9 pt grid the overlay draws;
//   · Rotate View turns the canvas and a click still hits what is under it.
//
// @feat:editor-shell.view-menu @feat:the-renderer.view-modes

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { beginGesture, commitGesture, updateGesture } from "./harness/gesture";
import { SHELL, blurAll, clickMenuRow, openShell } from "./harness/shell-surface";
import { screenPoint } from "./harness/viewport";

type G = {
  __canvas: {
    registries: {
      commands: { invoke(id: string, payload?: unknown): Promise<unknown> };
    };
    client: {
      camera: {
        read(): { scale: number; tx: number; ty: number; rotation?: number };
      };
      documentMeta(): Promise<{ dirty: boolean }>;
      elementGeometry(ids: unknown[]): Promise<
        Array<{ bounds: [number, number, number, number] }>
      >;
      send(m: unknown): Promise<{ kind: string; payload: unknown }>;
    };
  };
  __paged: {
    scope: unknown;
    selection: { elementSelection: Array<{ kind: string; id: string }> };
  };
};

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (i) => (globalThis as unknown as G).__canvas.registries.commands.invoke(i),
    id,
  );

const VIEW_TOGGLES = realpathSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../packages/shell/src/state/view-toggles.ts",
  ),
);
const viewMode = (page: Page) =>
  page.evaluate(async (path) => {
    const m = (await import(/* @vite-ignore */ `/@fs${path}`)) as {
      viewModeOf(scope: unknown): string;
    };
    return m.viewModeOf((globalThis as unknown as G).__paged.scope);
  }, VIEW_TOGGLES);

const viewToggle = (page: Page, which: string) =>
  page.evaluate(
    async ([path, w]) => {
      const m = (await import(/* @vite-ignore */ `/@fs${path}`)) as {
        getViewToggle(scope: unknown, x: string): boolean;
      };
      return m.getViewToggle((globalThis as unknown as G).__paged.scope, w);
    },
    [VIEW_TOGGLES, which] as const,
  );

const canvasShot = async (page: Page) => {
  // The largest canvas is the document's.
  const box = await page.evaluate(() => {
    let best: DOMRect | null = null;
    for (const cv of Array.from(document.querySelectorAll("canvas"))) {
      const r = cv.getBoundingClientRect();
      if (!best || r.width * r.height > best.width * best.height) best = r;
    }
    return best && { x: best.x, y: best.y, width: best.width, height: best.height };
  });
  if (!box) throw new Error("no canvas");
  return page.screenshot({ clip: box });
};

/** Let the worker draw the frame the last change asked for. */
const settle = (page: Page) => page.waitForTimeout(600);

test.describe("View menu — view modes, grids, snapping, Rotate View [editor-shell.view-menu] [the-renderer.view-modes]", () => {
  test("⌘Y draws the outline and changes no document; ⌘Y again restores it", async ({
    page,
  }) => {
    covers(
      "command:paged.view.outline",
      "keybinding:cmd+y→paged.view.outline",
      "menu:View/Outline view",
    );
    await openShell(page, { doc: true });
    await settle(page);
    const preview = await canvasShot(page);
    await blurAll(page);
    await page.keyboard.press("Meta+y");
    await expect.poll(() => viewMode(page)).toBe("outline");
    await expect
      .poll(async () => (await canvasShot(page)).equals(preview), { timeout: 15_000 })
      .toBe(false);
    expect(await viewToggle(page, "outline")).toBe(true);
    // No document change: nothing to undo, the document is clean.
    expect(
      await page.evaluate(() =>
        (globalThis as unknown as G).__canvas.client.documentMeta().then((m) => m.dirty),
      ),
    ).toBe(false);
    await page.keyboard.press("Meta+y");
    await expect.poll(() => viewMode(page)).toBe("preview");
    await expect
      .poll(async () => (await canvasShot(page)).equals(preview), { timeout: 15_000 })
      .toBe(true);
  });

  test("Overprint and Pixel Preview reach the engine and exclude each other", async ({
    page,
  }) => {
    covers(
      "command:paged.view.overprintPreview",
      "command:paged.view.pixelPreview",
      "menu:View/Overprint Preview",
      "menu:View/Pixel Preview",
    );
    await openShell(page, { doc: true });
    await clickMenuRow(page, "View/Overprint Preview");
    await expect.poll(() => viewMode(page)).toBe("overprintPreview");
    await clickMenuRow(page, "View/Pixel Preview");
    await expect.poll(() => viewMode(page)).toBe("pixelPreview");
    expect(await viewToggle(page, "overprintPreview")).toBe(false);
    // The worker took the mode: its reply came back for this mode.
    const reply = await page.evaluate(() =>
      (globalThis as unknown as G).__canvas.client.send({
        kind: "setViewSettings",
        payload: { settings: { mode: "pixelPreview" } },
      }),
    );
    expect(reply.kind).toBe("viewSettingsApplied");
    await invoke(page, "paged.view.pixelPreview");
    await expect.poll(() => viewMode(page)).toBe("preview");
  });

  test("Snap to grid lands a move on the 9 pt grid the overlay draws", async ({
    page,
  }) => {
    covers(
      "command:paged.view.showGrid",
      "command:paged.view.snapToGrid",
      "command:paged.view.smartGuides",
      "command:paged.view.snapToPixel",
      "command:paged.view.pixelGrid",
      "menu:View/Show grid",
      "menu:View/Snap to grid",
      "menu:View/Smart guides",
      "menu:View/Snap to pixel",
      "menu:View/Show pixel grid",
    );
    await openShell(page, { doc: true });
    await clickMenuRow(page, "View/Show grid");
    await expect(page.locator("[data-document-grid]").first()).toBeVisible();
    await expect(page.locator("[data-document-grid]").first()).toHaveAttribute(
      "data-grid-step",
      "9",
    );
    await clickMenuRow(page, "View/Snap to grid");
    // Smart guides off, so the grid is the only target near the move.
    await clickMenuRow(page, "View/Smart guides");
    // Let ViewSettingsSync's setSnapSettings land.
    await page.waitForTimeout(300);
    const ref = SHELL.frame;
    const before = (
      await page.evaluate(
        (r) => (globalThis as unknown as G).__canvas.client.elementGeometry([r]),
        ref,
      )
    )[0]!.bounds;
    const h = await beginGesture(page, [ref], { kind: "translate" }, null);
    await updateGesture(page, h, [7.4, 3.3], { shift: false, alt: false });
    await commitGesture(page, h);
    const after = (
      await page.evaluate(
        (r) => (globalThis as unknown as G).__canvas.client.elementGeometry([r]),
        ref,
      )
    )[0]!.bounds;
    // The left edge (72) moved by ~7.4 lands on 81 = 9 × 9; the top (100)
    // moved by ~3.3 lands on 99 = 11 × 9.
    // `bounds` is [top, left, bottom, right]; page 1 sits at the origin.
    expect(after[1]).toBeCloseTo(81, 3);
    expect(after[0]).toBeCloseTo(99, 3);
    expect(after[3] - after[1]).toBeCloseTo(before[3] - before[1], 3);
    // Snap to pixel and the pixel grid toggle; Smart guides back on.
    await clickMenuRow(page, "View/Snap to pixel");
    expect(await viewToggle(page, "snapToPixel")).toBe(true);
    await clickMenuRow(page, "View/Show pixel grid");
    expect(await viewToggle(page, "pixelGrid")).toBe(false);
    await clickMenuRow(page, "View/Smart guides");
    expect(await viewToggle(page, "smartGuides")).toBe(true);
  });

  test("Rotate View turns the canvas, a click hits what is under it, Reset turns it back", async ({
    page,
  }) => {
    covers(
      "command:paged.view.rotateClockwise",
      "command:paged.view.rotateCounterclockwise",
      "command:paged.view.resetRotation",
      "menu:View/Rotate view/15° clockwise",
      "menu:View/Rotate view/15° counterclockwise",
      "menu:View/Rotate view/Reset rotation",
      "keybinding:shift+cmd+1→paged.view.resetRotation",
    );
    await openShell(page, { doc: true });
    const rotation = () =>
      page.evaluate(
        () => (globalThis as unknown as G).__canvas.client.camera.read().rotation ?? 0,
      );
    for (let i = 0; i < 3; i++) await clickMenuRow(page, "View/Rotate view/15° clockwise");
    await expect.poll(rotation).toBeCloseTo(Math.PI / 4, 3);
    await clickMenuRow(page, "View/Rotate view/15° counterclockwise");
    await expect.poll(rotation).toBeCloseTo(Math.PI / 6, 3);
    await settle(page);
    // Click the middle of the frame (page-local 144, 136; page 1 sits at
    // the document origin) through the turned camera.
    const at = await screenPoint(page, 144, 136);
    await page.mouse.click(at.x, at.y);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (globalThis as unknown as G).__paged.selection.elementSelection.map((e) => e.id),
        ),
      )
      .toContain(SHELL.frame.id);
    await blurAll(page);
    await page.keyboard.press("Meta+Shift+1");
    await expect.poll(rotation).toBeCloseTo(0, 6);
    await clickMenuRow(page, "View/Rotate view/15° clockwise");
    await clickMenuRow(page, "View/Rotate view/Reset rotation");
    await expect.poll(rotation).toBeCloseTo(0, 6);
  });

  test("Guides & grid preferences open from the View menu", async ({ page }) => {
    covers(
      "menu:View/Guides & grid preferences…",
      "command:paged.view.guidesAndGridPreferences",
    );
    await openShell(page, { doc: true });
    await clickMenuRow(page, "View/Guides & grid preferences…");
    const dialog = page.locator("[data-view-preferences-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-view-pref="gridSubdivisions"]').fill("4");
    await page.locator("[data-view-preferences-done]").click();
    await expect(dialog).toHaveCount(0);
    // A gridline every 72 pt in 4 subdivisions: the grid steps by 18 pt.
    await clickMenuRow(page, "View/Show grid");
    await expect(page.locator("[data-document-grid]").first()).toHaveAttribute(
      "data-grid-step",
      "18",
    );
    await page.evaluate(() => localStorage.removeItem("paged.viewPreferences"));
  });
});
