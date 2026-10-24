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

// E2E — WP4.4 in the real editor: Object ▸ Transform ▸ Transform each…
// opens the dialog over the selection, its preview applies and Cancel
// takes it back, OK leaves ONE undo step; and the Align panel aligns to
// the page and to a key object (the key drawn with a thicker outline).

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { openPanel } from "../fidelity/canvas-driver";
import {
  clickMenuRow,
  openShell,
  select,
  SHELL,
} from "./harness/shell-surface";

interface Geometry {
  bounds: [number, number, number, number];
  itemTransform?: number[] | null;
}

/** An object's transformed box, page space. */
async function shown(page: Page, id: { kind: string; id: string }) {
  return page.evaluate(async (target) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: { elementGeometry(ids: unknown[]): Promise<unknown[]> };
        };
      }
    ).__canvas;
    const [g] = (await c.client.elementGeometry([target])) as Geometry[];
    const [t, l, b, r] = g!.bounds;
    const m = g!.itemTransform ?? [1, 0, 0, 1, 0, 0];
    const pts = [
      [l, t],
      [r, t],
      [r, b],
      [l, b],
    ].map(([x, y]) => [
      m[0]! * x! + m[2]! * y! + m[4]!,
      m[1]! * x! + m[3]! * y! + m[5]!,
    ]);
    const xs = pts.map((p) => p[0]!);
    const ys = pts.map((p) => p[1]!);
    return [
      Math.min(...ys),
      Math.min(...xs),
      Math.max(...ys),
      Math.max(...xs),
    ].map((v) => Math.round(v * 100) / 100);
  }, id);
}

async function undo(page: Page) {
  await page.evaluate(async () => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          registries: { commands: { invoke(id: string): Promise<unknown> } };
        };
      }
    ).__canvas;
    await c.registries.commands.invoke("paged.editor.undo");
  });
}

test.describe("WP4.4 — Transform each and the Align scopes", () => {
  test.beforeEach(async ({ page }) => {
    await openShell(page, { doc: true });
  });

  test("Object ▸ Transform ▸ Transform each…: preview, cancel, OK in one undo step @feat:editor-shell.align-transform-each @level:happy", async ({
    page,
  }) => {
    covers(
      "menu:Object/Transform/Transform each…",
      "command:paged.object.transformEachDialog",
      "command:paged.object.transformEach",
    );
    const before = await shown(page, SHELL.frame);
    await select(page, [SHELL.frame]);
    await clickMenuRow(page, "Object/Transform/Transform each…");
    const dialog = page.locator("[data-transform-each-dialog]");
    await expect(dialog).toBeVisible();
    const moveH = dialog.locator('input[aria-label="Move Horizontal"]');
    await moveH.fill("10");
    await moveH.press("Enter");
    await dialog.locator('[data-transform-each-check="preview"]').check();
    await expect
      .poll(() => shown(page, SHELL.frame))
      .toEqual([before[0], before[1]! + 10, before[2], before[3]! + 10]);
    await dialog.locator("[data-transform-each-cancel]").click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => shown(page, SHELL.frame)).toEqual(before);

    await clickMenuRow(page, "Object/Transform/Transform each…");
    await dialog.locator('input[aria-label="Angle"]').fill("90");
    await dialog.locator('input[aria-label="Angle"]').press("Enter");
    await dialog.locator("[data-transform-each-ok]").click();
    await expect(dialog).toHaveCount(0);
    // A 144 × 72 frame turned about its centre shows 72 × 144.
    await expect
      .poll(async () => {
        const [t, l, b, r] = await shown(page, SHELL.frame);
        return [Math.round(r! - l!), Math.round(b! - t!)];
      })
      .toEqual([72, 144]);
    await undo(page);
    await expect.poll(() => shown(page, SHELL.frame)).toEqual(before);
  });

  test("Align panel: to the page, and to a key object @feat:editor-shell.align-transform-each @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.align", "command:paged.align.objects");
    await openPanel(page, "paged.align");
    const panel = page.locator('[data-align-panel="ready"]');
    await select(page, [SHELL.frame]);
    await panel.locator("[data-align-scope]").selectOption("page");
    await panel.locator('[data-align-kind="left"]').click();
    await expect.poll(async () => (await shown(page, SHELL.frame))[1]).toBe(0);
    await undo(page);

    const text = SHELL.text;
    await select(page, [text, SHELL.frame]);
    await panel.locator("[data-align-scope]").selectOption("keyObject");
    // The first selected is the key, drawn thicker.
    await expect(page.locator("[data-key-object]")).toHaveCount(1);
    const key = await shown(page, text);
    await panel.locator('[data-align-kind="right"]').click();
    await expect
      .poll(async () => (await shown(page, SHELL.frame))[3])
      .toBe(key[3]);
    expect(await shown(page, text)).toEqual(key);
  });
});
