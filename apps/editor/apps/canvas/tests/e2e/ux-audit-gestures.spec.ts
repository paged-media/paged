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

// The UX audit's canvas-gesture findings (docs/design/ux-audit-2026-10.md)
// as regression tests that FAIL today: each is an expected failure
// (`test.fail`), titled with its finding id. When a fix lands the test
// passes, Playwright reports it as an unexpected pass, and the marker
// comes off in the same change. The behaviour is NOT fixed here.
//
// Driven through the gesture DSL (browser backend) and judged by the
// model and the editor's own state, never by a screenshot. GM-2 is a
// finding of the gesture matrix, recorded the same way.

import { expect, test, type Page } from "@playwright/test";

import {
  browserGestures,
  gestureFixture,
  GESTURE_TARGETS as T,
  type BrowserPage,
  type GestureDsl,
} from "@paged-media/test-kit";

import { fitFirstPage, openCanvas } from "../fidelity/canvas-driver";
import { loadViaReactPath } from "./harness/viewport";
import {
  activeTool,
  boxOf,
  cornersOf,
  gestureEditor,
  selectElements,
  selectedIds,
} from "./harness/gesture-kit";

type Cam = { scale: number; tx: number; ty: number };
const camera = (page: Page): Promise<Cam> =>
  page.evaluate(() =>
    (
      globalThis as unknown as {
        __canvas: { client: { camera: { read(): Cam } } };
      }
    ).__canvas.client.camera.read(),
  );
const editContext = (page: Page) =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __canvas: {
            debugContext(): { editContext: { type: string } | null };
          };
        }
      ).__canvas.debugContext().editContext?.type ?? null,
  );
const angleOf = (cs: Array<[number, number]>) =>
  (Math.atan2(cs[1][1] - cs[0][1], cs[1][0] - cs[0][0]) * 180) / Math.PI;
/** `PAGED_UX_AUDIT_SHOW=1` runs the expected failures as plain tests, to
 *  read WHY each fails today (they must fail for the finding's reason). */
const EXPECTED = process.env.PAGED_UX_AUDIT_SHOW !== "1";
const side = (cs: Array<[number, number]>) =>
  Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]);

test.describe("UX audit 2026-10 — canvas gestures (expected failures until fixed)", () => {
  test("[F-26] a press-drag on an UNSELECTED frame selects it and moves it in one gesture @level:gesture", async ({
    page,
  }) => {
    test.fail(
      EXPECTED,
      "F-26: the press starts a marquee; the frame stays put",
    );
    const { g } = await gestureEditor(page);
    await g.tool("paged.tool.select").settle();
    await selectElements(page, []);
    const before = (await cornersOf(page, T.frame.id))!;
    await g
      .drag({ from: T.frame.at, to: [T.frame.at[0] + 120, T.frame.at[1] + 80] })
      .settle();
    const after = (await cornersOf(page, T.frame.id))!;
    expect(await selectedIds(page)).toEqual(["uframe"]);
    expect(after[0][0] - before[0][0]).toBeGreaterThan(100);
    expect(after[0][1] - before[0][1]).toBeGreaterThan(60);
  });

  test("[F-29] a double-click on a shape inside a group selects that shape, not the vector-graphic context @level:gesture", async ({
    page,
  }) => {
    test.fail(
      EXPECTED,
      "F-29: the double-click enters paged.draw's vector-graphic context",
    );
    const { g } = await gestureEditor(page);
    await g.tool("paged.tool.select").settle().dblclick(T.group.at).settle();
    expect(await editContext(page)).not.toBe("vectorGraphic");
    expect(await selectedIds(page)).toEqual(["ugA"]);
  });

  test("[F-29] Direct Selection on a grouped shape selects the shape, not the group @level:gesture", async ({
    page,
  }) => {
    test.fail(EXPECTED, "F-29: Direct Selection selects the whole group");
    const { g } = await gestureEditor(page);
    await g.tool("paged.tool.directSelect").settle().click(T.group.at).settle();
    expect(await selectedIds(page)).toEqual(["ugA"]);
  });

  test("[F-29] a double-click on a placed image does not open the vector-graphic context @level:gesture", async ({
    page,
  }) => {
    test.fail(
      EXPECTED,
      "F-29: the double-click opens paged.draw's vector-graphic context for an image",
    );
    await openCanvas(page);
    await loadViaReactPath(page, "images");
    const g: GestureDsl = browserGestures(page as unknown as BrowserPage);
    const framed = (await page.evaluate(async () => {
      const c = (
        globalThis as unknown as {
          __canvas: {
            client: {
              send(m: unknown): Promise<{ payload: { roots: unknown[] } }>;
              elementGeometry(i: unknown[]): Promise<
                Array<{
                  id: unknown;
                  hasImage?: boolean;
                  pageId?: string | null;
                  bounds: number[];
                  itemTransform?: number[] | null;
                }>
              >;
            };
          };
        }
      ).__canvas.client;
      const ids: unknown[] = [];
      const walk = (n: { id?: unknown; children?: unknown[] }) => {
        if (n.id) ids.push(n.id);
        for (const k of (n.children ?? []) as (typeof n)[]) walk(k);
      };
      (await c.send({ kind: "requestSceneTree" })).payload.roots.forEach((r) =>
        walk(r as never),
      );
      return (
        (await c.elementGeometry(ids)).find((x) => x.hasImage && x.pageId) ??
        null
      );
    }))!;
    expect(
      framed,
      "the images fixture has a placed image on a page",
    ).not.toBeNull();
    const [t, l, b, r] = framed.bounds;
    const [a, bb, c, d, tx, ty] = framed.itemTransform ?? [1, 0, 0, 1, 0, 0];
    const cx = (l + r) / 2;
    const cy = (t + b) / 2;
    await g
      .tool("paged.tool.select")
      .settle()
      .dblclick([a * cx + c * cy + tx, bb * cx + d * cy + ty])
      .settle();
    expect(await editContext(page)).not.toBe("vectorGraphic");
  });

  test("[F-30] just outside a selected frame's corner, a drag ROTATES it (it resizes today) @level:gesture", async ({
    page,
  }) => {
    test.fail(
      EXPECTED,
      "F-30: there is no rotate zone outside the corners; the drag resizes",
    );
    const { g } = await gestureEditor(page);
    await g.tool("paged.tool.select").settle();
    await selectElements(page, [T.frame.id]);
    const s = (await camera(page)).scale;
    const before = (await cornersOf(page, T.frame.id))!;
    // 6 screen px up and right of the top-right corner (216, 100).
    const from: [number, number] = [216 + 6 / s, 100 - 6 / s];
    await g.drag({ from, to: [from[0] - 40 / s, from[1] + 70 / s] }).settle();
    const after = (await cornersOf(page, T.frame.id))!;
    expect(Math.abs(angleOf(after) - angleOf(before))).toBeGreaterThan(5);
    expect(side(after)).toBeCloseTo(side(before), 0);
  });

  test("[F-31] keyboard zoom and ctrl+wheel zoom share one range @level:gesture", async ({
    page,
  }) => {
    test.fail(
      EXPECTED,
      "F-31: ctrl+wheel stops at 1,600 %, the keyboard goes past 60,000 %",
    );
    const { g } = await gestureEditor(page);
    for (let i = 0; i < 60; i++) await g.key("Equal", { mods: ["cmd"] });
    await g.settle();
    const keyboardMax = (await camera(page)).scale;
    await fitFirstPage(page);
    for (let i = 0; i < 40; i++)
      await g.wheel({ at: T.frame.at, ctrl: true, deltaY: -100 });
    await g.settle();
    const wheelMax = (await camera(page)).scale;
    expect(keyboardMax).toBeCloseTo(wheelMax, 1);
    expect(keyboardMax).toBeLessThanOrEqual(40);
  });

  test("[F-32] a multi-page document opens with page 1 fitted, not the whole document @level:gesture", async ({
    page,
  }) => {
    test.fail(EXPECTED, "F-32: documents open at fit-whole-document");
    await openCanvas(page);
    // The React path, and NO Home press: the camera the open leaves.
    await page.setInputFiles('input[type="file"]', {
      name: "two-pages.idml",
      mimeType: "application/vnd.adobe.indesign-idml-package",
      buffer: Buffer.from(gestureFixture("targets")),
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(
            (globalThis as unknown as { __canvas?: { ready?: boolean } })
              .__canvas?.ready,
          ),
        ),
      )
      .toBe(true);
    await page.waitForFunction(
      () =>
        (
          globalThis as unknown as {
            __canvas: { client: { camera: { read(): Cam } } };
          }
        ).__canvas.client.camera.read().scale > 0,
    );
    const host = (await page
      .locator('[data-testid="viewport-canvas-host"]')
      .boundingBox())!;
    const s = (await camera(page)).scale;
    // Page 1 (612 × 792 pt) fills the viewport's height or width.
    const fill = Math.max((792 * s) / host.height, (612 * s) / host.width);
    expect(fill).toBeGreaterThan(0.8);
  });

  test("[F-33] Shift + wheel pans horizontally @level:gesture", async ({
    page,
  }) => {
    test.fail(EXPECTED, "F-33: Shift + wheel scrolls vertically");
    const { g } = await gestureEditor(page);
    const c0 = await camera(page);
    await g.wheel({ at: T.empty.at, shift: true, deltaY: 200 }).settle();
    const c1 = await camera(page);
    expect(c1.ty).toBe(c0.ty);
    expect(c1.tx).toBe(c0.tx - 200);
  });

  // F-35 does NOT reproduce: the Pen stays the base and effective tool
  // after Enter (and after Escape). The audit read `__canvas.activeTool`,
  // the legacy key that reports "select" for every tool but Type. So this
  // one is a passing guard of the behaviour the finding asks for.
  test("[F-35] the Pen stays the active tool after Enter finishes a path (not reproduced: a guard) @level:gesture", async ({
    page,
  }) => {
    const { g } = await gestureEditor(page);
    const tools = () =>
      page.evaluate(() => {
        const t = (
          globalThis as unknown as {
            __canvas: {
              debugContext(): {
                tools: { base: string | null; effective: string | null };
              };
            };
          }
        ).__canvas.debugContext().tools;
        return [t.base, t.effective];
      });
    await g
      .tool("paged.tool.pen")
      .settle()
      .click([360, 540])
      .settle()
      .click([460, 560])
      .settle()
      .drag({ from: [420, 620], to: [460, 620] })
      .settle()
      .click([500, 540])
      .settle()
      .key("Enter")
      .settle();
    expect(await tools()).toEqual(["paged.tool.pen", "paged.tool.pen"]);
    expect(await activeTool(page)).toBe("paged.tool.pen");
    await g.key("Escape").settle();
    expect(await tools()).toEqual(["paged.tool.pen", "paged.tool.pen"]);
  });

  test("[F-27] a right-click on a frame opens a context menu @level:gesture", async ({
    page,
  }) => {
    test.fail(EXPECTED, "F-27: the canvas has no context menu");
    const { g } = await gestureEditor(page);
    await g.tool("paged.tool.select").settle();
    await selectElements(page, [T.frame.id]);
    await g.click(T.frame.at, { button: 2 }).settle();
    await expect(page.locator('[role="menu"]')).toHaveCount(1, {
      timeout: 2_000,
    });
  });

  test("[GM-2] a transform tool acts on the selection made AFTER it was picked (the Layers panel, Select All) @level:gesture", async ({
    page,
  }) => {
    test.fail(
      EXPECTED,
      "GM-2: the Rotate / Scale / Shear handlers read the selection the tool was activated with",
    );
    const { g } = await gestureEditor(page);
    await g.tool("paged.tool.select").settle();
    await selectElements(page, [T.frame.id]);
    await g.tool("paged.tool.rotate").settle();
    // The selection moves to the rotated frame while the Rotate tool is held.
    await selectElements(page, [T.rotated.id]);
    const frame0 = boxOf((await cornersOf(page, T.frame.id))!);
    const rot0 = (await cornersOf(page, T.rotated.id))!;
    const at: [number, number] = [T.rotated.at[0] - 43, T.rotated.at[1] + 65];
    await g.drag({ from: at, to: [at[0] + 120, at[1] + 80] }).settle();
    expect(boxOf((await cornersOf(page, T.frame.id))!)).toEqual(frame0);
    expect(
      Math.abs(angleOf((await cornersOf(page, T.rotated.id))!) - angleOf(rot0)),
    ).toBeGreaterThan(5);
  });
});
