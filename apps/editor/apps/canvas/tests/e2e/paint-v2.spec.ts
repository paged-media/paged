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

// Paint model v2 (engine ADR 1007) through the Gradients panel's ramp
// editor: a black-to-black gradient fills a square; setting the second
// stop's opacity to 0 in the real panel makes it a fade to transparent —
// the page shows through on the right — and one undo restores the model
// and the pixels. Corpus-free: File ▸ New, the square written in code.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { Designer } from "../journey/driver/designer";
import { opSandwich } from "./harness/op-sandwich";
import { mutate, openPanel } from "./harness/ui";

interface CanvasGlobal {
  __canvas: {
    client: {
      executeScript: (
        s: string,
      ) => Promise<{ output: string[]; error: string | null }>;
      gradientDetail: (id: string) => Promise<{
        stops: Array<{ opacityPct?: number | null }>;
      } | null>;
    };
  };
}

const GRADIENT = "Gradient/e2eFade";

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

async function endOpacity(page: Page): Promise<number | null> {
  return page.evaluate(async (id) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const d = await c.gradientDetail(id);
    return d?.stops[1]?.opacityPct ?? null;
  }, GRADIENT);
}

test.describe("paint model v2 in the Gradients panel", () => {
  test("AC-PAINT2-1 — a stop's opacity makes a fade to transparent, reads back, one undo restores @feat:color-swatches.paint-v2 @feat:editor-shell.panels.gradients @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.gradients");
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    const { pageId, widthPt } = await firstPage(page);
    const corner = (x: number, y: number) => ({
      anchor: [x, y] as [number, number],
      left: [x, y] as [number, number],
      right: [x, y] as [number, number],
    });
    await mutate(page, {
      op: "batch",
      args: {
        ops: [
          {
            op: "createGradient",
            args: {
              spec: {
                selfId: GRADIENT,
                name: "Fade",
                kind: "Linear",
                stops: [
                  { stopColor: "Color/Black", locationPct: 0 },
                  { stopColor: "Color/Black", locationPct: 100 },
                ],
              },
            },
          },
          {
            op: "insertPath",
            args: {
              pageId,
              anchors: [
                corner(100, 100),
                corner(300, 100),
                corner(300, 200),
                corner(100, 200),
              ],
              open: false,
            },
          },
          { op: "bindCreated", args: { handle: "sq" } },
          {
            op: "setElementProperty",
            args: {
              elementId: { kind: "polygon", id: "$h:sq" },
              path: "frameFillColor",
              value: { type: "colorRef", value: GRADIENT },
            },
          },
        ],
      },
    });

    await openPanel(page, "paged.gradients");
    const editor = page.locator('[data-gradient-editor="ready"]');
    await expect(editor).toBeVisible();
    await editor
      .locator("select[data-gradient-select], [data-gradient-select] select")
      .first()
      .selectOption(GRADIENT);
    const field = editor.locator(
      '[data-gradient-stop-row="1"] [data-stop-opacity]',
    );
    await expect(field).toHaveValue("100");
    expect(await endOpacity(page)).toBeNull();

    await opSandwich(page, {
      pageId,
      pageWidthPt: widthPt,
      // The square: black under an opaque ramp; once the end stop is
      // transparent it fades to paper toward the right, and nothing
      // outside it changes.
      region: { top: 100, left: 100, bottom: 200, right: 300 },
      regionSlackPx: 4,
      apply: async () => {
        await field.fill("0");
        await field.press("Enter");
      },
      expectModel: async () => {
        await expect.poll(() => endOpacity(page)).toBe(0);
      },
      dumpModel: async () => JSON.stringify(await endOpacity(page)),
      expectRestored: async () => {
        await expect.poll(() => endOpacity(page)).toBeNull();
      },
    });
  });
});
