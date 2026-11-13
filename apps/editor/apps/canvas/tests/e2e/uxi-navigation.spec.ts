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

// Camera navigation (interaction contract §13; editor ADR "Navigation
// history and one current page"; ADR 1201 D-12): the fits land on the
// right bounds inside the one zoom range (UXI-T48), a fit under reduced
// motion jumps without animating (UXI-T53), the current-page readout
// follows a pan by one documented rule (UXI-T54), and an explicit jump
// leaves a way back that restores the view and keeps the target selected
// (UXI-T55, its navigation half; the issue markers are DF7's). Each
// asserts the camera, the selection and the history, never a screenshot.

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { selectElements } from "./harness/gesture-kit";
import { clickMenuRow } from "./harness/shell-surface";
import { expectHistoryUnchanged } from "./harness/history";
import { modelSnapshot, selectionSnapshot } from "./harness/model-dump";
import { openUxiFixture, UXI_D } from "./harness/uxi-fixtures";

const D = UXI_D;

interface Cam {
  scale: number;
  tx: number;
  ty: number;
  rotation?: number;
}

interface CanvasGlobal {
  __canvas: {
    client: {
      camera: { read: () => Cam };
      documentMeta: () => Promise<{ activePage?: string | null }>;
    };
    registries: { commands: { invoke: (id: string) => unknown } };
    handle?: {
      pageIds: string[];
      pageSizesPt: Array<[number, number]>;
      pageOriginsPt?: Array<[number, number]>;
    } | null;
  };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The camera, the canvas viewport's size and the page layout. */
async function view(page: Page) {
  return page.evaluate(() => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas;
    const host = document.querySelector<HTMLElement>(
      '[data-testid="viewport-canvas-host"]',
    )!;
    const box = host.getBoundingClientRect();
    const h = c.handle!;
    const placed = h.pageOriginsPt?.length === h.pageSizesPt.length;
    let y = 0;
    const rects = h.pageSizesPt.map(([w, hh], i) => {
      const at = placed ? h.pageOriginsPt![i]! : null;
      const r = at ? { x: at[0], y: at[1], w, h: hh } : { x: 0, y, w, h: hh };
      y += hh + 24;
      return r;
    });
    return {
      cam: c.client.camera.read(),
      vw: box.width,
      vh: box.height,
      rects,
      pageIds: h.pageIds,
    };
  });
}

type View = Awaited<ReturnType<typeof view>>;

async function run(page: Page, id: string): Promise<void> {
  await page.evaluate(
    (cmd) =>
      (
        globalThis as unknown as CanvasGlobal
      ).__canvas.registries.commands.invoke(cmd),
    id,
  );
}

/** Viewport px → document pt through the camera, rotation included. */
function toDoc(cam: Cam, x: number, y: number): [number, number] {
  const u = (x - cam.tx) / cam.scale;
  const v = (y - cam.ty) / cam.scale;
  const r = cam.rotation ?? 0;
  if (r === 0) return [u, v];
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * u + s * v, -s * u + c * v];
}

/** The fit the editor promises (`fitCamera`): the rect's turned box
 *  inside the viewport less a 40 px margin, centred, inside 5–4,000 %. */
function expectFitted(v: View, rect: Rect, label: string) {
  const r = v.cam.rotation ?? 0;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  const w = rect.w * c + rect.h * s;
  const h = rect.w * s + rect.h * c;
  const want = Math.min(
    40,
    Math.max(0.05, Math.min((v.vw - 80) / w, (v.vh - 80) / h)),
  );
  expect(v.cam.scale, `${label}: scale`).toBeCloseTo(want, 4);
  const [cx, cy] = toDoc(v.cam, v.vw / 2, v.vh / 2);
  expect(Math.abs(cx - (rect.x + rect.w / 2)) * v.cam.scale).toBeLessThan(1);
  expect(Math.abs(cy - (rect.y + rect.h / 2)) * v.cam.scale).toBeLessThan(1);
}

/** The camera has stopped: two reads a frame apart agree. */
async function settled(page: Page): Promise<View> {
  let last = "";
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(60);
        const now = JSON.stringify((await view(page)).cam);
        const same = now === last;
        last = now;
        return same;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return view(page);
}

/** The documented rule (shell `currentPageIndex`): the page containing
 *  the viewport's centre, else the nearest by distance to its rectangle;
 *  ties to the first in document order. */
function expectedPage(v: View): number {
  const [x, y] = toDoc(v.cam, v.vw / 2, v.vh / 2);
  let best = -1;
  let bestD = Infinity;
  v.rects.forEach((r, i) => {
    const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
    const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Record every camera the client writes until `stop`. */
async function recordCameras(page: Page): Promise<() => Promise<Cam[]>> {
  await page.evaluate(() => {
    const g = globalThis as unknown as CanvasGlobal & {
      __camTape?: { on: boolean; frames: string[] };
    };
    const tape = { on: true, frames: [] as string[] };
    g.__camTape = tape;
    const tick = () => {
      if (!tape.on) return;
      const now = JSON.stringify(g.__canvas.client.camera.read());
      if (tape.frames[tape.frames.length - 1] !== now) tape.frames.push(now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return async () =>
    page.evaluate(() => {
      const g = globalThis as unknown as {
        __camTape: { on: boolean; frames: string[] };
      };
      g.__camTape.on = false;
      return g.__camTape.frames.map((f) => JSON.parse(f) as Cam);
    });
}

test.describe("UXI navigation — D. camera", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "D");
  });

  test("UXI-T48 — Fit page, spread, selection and document land on their bounds inside the one zoom range @feat:editor-tools.nav.zoom @level:happy", async ({
    page,
  }) => {
    covers(
      "command:paged.view.fitPage",
      "command:paged.view.fitSpread",
      "command:paged.view.fitSelection",
      "command:paged.view.zoomFit",
    );
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, async () => {
      // Page 3 is current: the page keys took the view there.
      await run(page, "paged.view.nextPage");
      await run(page, "paged.view.nextPage");
      let v = await settled(page);
      expect(expectedPage(v)).toBe(2);

      await run(page, "paged.view.fitPage");
      v = await settled(page);
      expectFitted(v, v.rects[2]!, "Fit page");

      // Each page of D is its own spread.
      await run(page, "paged.view.fitSpread");
      v = await settled(page);
      expectFitted(v, v.rects[2]!, "Fit spread");

      // The selection: page 3's turned rectangle, by its turned box.
      await selectElements(page, [D.rotated(3)]);
      await run(page, "paged.view.fitSelection");
      v = await settled(page);
      const a = (D.angleOf(3) * Math.PI) / 180;
      const corners = [
        [0, 0],
        [144, 0],
        [144, 72],
        [0, 72],
      ].map(([x, y]) => [
        Math.cos(a) * x! - Math.sin(a) * y! + 200,
        Math.sin(a) * x! + Math.cos(a) * y! + 300,
      ]);
      const xs = corners.map((p) => p[0]!);
      const ys = corners.map((p) => p[1]!);
      const page3 = v.rects[2]!;
      expectFitted(
        v,
        {
          x: page3.x + Math.min(...xs),
          y: page3.y + Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys),
        },
        "Fit selection",
      );

      // Twenty pages would need under 5 %: the fit stops at the shared
      // minimum, centred on the document.
      await run(page, "paged.view.zoomFit");
      v = await settled(page);
      // The camera's shared memory holds 32-bit floats.
      expect(v.cam.scale).toBeCloseTo(0.05, 6);
      const last = v.rects[v.rects.length - 1]!;
      expectFitted(
        v,
        { x: 0, y: 0, w: 612, h: last.y + last.h },
        "Fit document",
      );

      // The zoom field and the wheel share the range.
      const field = page.locator("[data-zoom-field]");
      await field.fill("99999");
      await field.press("Enter");
      await expect
        .poll(async () => Math.round((await view(page)).cam.scale * 1e4))
        .toBe(40e4);
      await expect(field).toHaveValue("4000%");
      const host = (await page
        .locator('[data-testid="viewport-canvas-host"]')
        .boundingBox())!;
      await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -600);
      await page.keyboard.up("Control");
      await page.waitForTimeout(100);
      expect((await view(page)).cam.scale).toBeCloseTo(40, 4);
      await field.fill("1");
      await field.press("Enter");
      await expect
        .poll(async () => Math.round((await view(page)).cam.scale * 1e4))
        .toBe(500);
      await expect(field).toHaveValue("5%");
    });
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("UXI-T53 — with reduced motion a fit jumps to the same final view without animating @feat:editor-tools.nav.zoom @level:edge", async ({
    page,
  }) => {
    covers("command:paged.view.fitPage", "command:paged.view.lastPage");
    // The animated reference: the same jump without the preference
    // passes through intermediate cameras.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    let stop = await recordCameras(page);
    await run(page, "paged.view.lastPage");
    const animated = await settled(page);
    const frames = await stop();
    expect(frames.length).toBeGreaterThan(3);
    await run(page, "paged.view.firstPage");
    await settled(page);

    await page.emulateMedia({ reducedMotion: "reduce" });
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, async () => {
      stop = await recordCameras(page);
      await run(page, "paged.view.lastPage");
      const v = await settled(page);
      const tape = await stop();
      // One write: from where it was straight to the target.
      expect(tape.length).toBeLessThanOrEqual(2);
      expect(tape[tape.length - 1]).toEqual(v.cam);
      // The same final view as the animated jump.
      expect(v.cam.scale).toBeCloseTo(animated.cam.scale, 6);
      expect(v.cam.tx).toBeCloseTo(animated.cam.tx, 3);
      expect(v.cam.ty).toBeCloseTo(animated.cam.ty, 3);
      expectFitted(v, v.rects[19]!, "Last page");

      stop = await recordCameras(page);
      await run(page, "paged.view.fitPage");
      await run(page, "paged.view.zoomFit");
      await settled(page);
      // Two jumps, two writes; nothing in between.
      expect((await stop()).length).toBeLessThanOrEqual(3);
    });
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("UXI-T54 — panning over nearby pages moves the current-page readout by the one rule, a turned view included @feat:editor-tools.nav.pan @level:gesture", async ({
    page,
  }) => {
    covers("command:paged.view.rotateClockwise");
    const readout = page.locator("[data-control-page]");
    const host = (await page
      .locator('[data-testid="viewport-canvas-host"]')
      .boundingBox())!;
    await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2);
    const model = await modelSnapshot(page);
    const selection = await selectionSnapshot(page);

    const check = async (label: string) => {
      const v = await settled(page);
      const want = expectedPage(v);
      await expect(readout, label).toHaveText(`${want + 1} / 20`);
      // The page a plugin reads as `activePage` is the same page.
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const c = (globalThis as unknown as CanvasGlobal).__canvas;
            return (await c.client.documentMeta()).activePage ?? null;
          }),
        )
        .toBe(v.pageIds[want]);
      return want;
    };

    await expectHistoryUnchanged(page, async () => {
      expect(await check("opening view")).toBe(0);
      // Down through the gap between pages 1 and 2 and on, in steps
      // smaller than a page, so the centre crosses each edge.
      const seen = new Set<number>();
      for (let i = 0; i < 14; i++) {
        await page.mouse.wheel(0, 180);
        seen.add(await check(`after ${i + 1} wheel steps`));
      }
      expect(seen.size).toBeGreaterThanOrEqual(3);
      // Back up: the same rule on the way back.
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, -180);
        await check(`back up ${i + 1}`);
      }
      // Turn the view a quarter (six 15° steps): the readout follows the
      // turned camera's centre, not an unturned reading of it.
      for (let i = 0; i < 6; i++) await run(page, "paged.view.rotateClockwise");
      await check("turned a quarter");
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(180, 0);
        await check(`turned, after ${i + 1} sideways steps`);
      }
      await run(page, "paged.view.resetRotation");
    });
    expect(await modelSnapshot(page)).toBe(model);
    expect(await selectionSnapshot(page)).toEqual(selection);
  });

  test("UXI-T55 — a jump that selects leaves a way back: Back restores the view, the target stays selected, the document and history are untouched @feat:editor-shell.view-menu @level:happy", async ({
    page,
  }) => {
    covers(
      "command:paged.view.navigateBack",
      "command:paged.view.navigateForward",
      "command:paged.edit.goTo",
    );
    const model = await modelSnapshot(page);
    const start = await settled(page);
    const back = page.locator('[data-navigation="paged.view.navigateBack"]');
    const forward = page.locator(
      '[data-navigation="paged.view.navigateForward"]',
    );
    await expect(back).toBeDisabled();

    await expectHistoryUnchanged(page, async () => {
      // A free zoom is not a navigation.
      await page.locator("[data-zoom-field]").fill("80");
      await page.locator("[data-zoom-field]").press("Enter");
      const working = await settled(page);
      await expect(back).toBeDisabled();

      // Go to page 12 (Edit ▸ Go to page…).
      await run(page, "paged.edit.goTo");
      await page.locator("[data-goto-input]").fill("12");
      await page.locator("[data-goto-input]").press("Enter");
      const onTwelve = await settled(page);
      expect(expectedPage(onTwelve)).toBe(11);
      await expect(back).toBeEnabled();

      // Select page 12's rectangle and fit it: the target of the jump.
      await selectElements(page, [D.rotated(12)]);
      await run(page, "paged.view.fitSelection");
      const target = await settled(page);
      const selected = await selectionSnapshot(page);
      expect(selected.elements).toEqual([D.rotated(12)]);

      // Back: page 12's view, then the working view, exactly; the
      // target stays selected (a view change is not a selection change).
      await back.click();
      expect((await settled(page)).cam).toEqual(onTwelve.cam);
      await page.keyboard.press("ControlOrMeta+PageUp");
      const returned = await settled(page);
      expect(returned.cam).toEqual(working.cam);
      expect(await selectionSnapshot(page)).toEqual(selected);
      await expect(back).toBeDisabled();

      // Forward twice: the target view again.
      await forward.click();
      await settled(page);
      await page.keyboard.press("ControlOrMeta+PageDown");
      expect((await settled(page)).cam).toEqual(target.cam);
      await expect(forward).toBeDisabled();
    });
    expect(await modelSnapshot(page)).toBe(model);
    expect(start.pageIds.length).toBe(20);
  });

  test("UXI-T48 — Actual size and Calibrated size are named views beside 100 %, which keeps its meaning; Go back and Go forward are in Layout @feat:editor-tools.nav.zoom @level:edge", async ({
    page,
  }) => {
    covers(
      "command:paged.view.actualSize",
      "command:paged.view.calibratedSize",
      "command:paged.view.calibrateScreen",
      "menu:View/Actual size",
      "menu:View/Calibrated size",
      "menu:View/Calibrate screen size…",
      "menu:Layout/Go back",
      "menu:Layout/Go forward",
      "setting:paged.view.calibration",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    const model = await modelSnapshot(page);
    const field = page.locator("[data-zoom-field]");
    await expectHistoryUnchanged(page, async () => {
      await run(page, "paged.view.zoom100");
      await expect.poll(async () => (await view(page)).cam.scale).toBe(1);
      await expect(field).toHaveValue("100%");

      await clickMenuRow(page, "View/Actual size");
      await expect
        .poll(async () => (await view(page)).cam.scale)
        .toBeCloseTo(96 / 72, 5);
      await expect(field).toHaveValue("133%");

      // Not calibrated: Calibrated size asks for the calibration first,
      // and applies the view once it is saved.
      await clickMenuRow(page, "View/Calibrated size");
      const dialog = page.locator("[data-screen-calibration-dialog]");
      await expect(dialog).toBeVisible();
      await page.locator('[data-calibration-length="in"]').click();
      // A 4 in bar of 480 CSS px: 120 CSS px per inch on this screen.
      await page
        .locator("[data-calibration-slider]")
        .evaluate((el: HTMLInputElement) => {
          const set = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )!.set!;
          set.call(el, "480");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        });
      const dpr = await page.evaluate(() => devicePixelRatio);
      await expect(page.locator("[data-calibration-density]")).toContainText(
        String(Math.round(120 * dpr)),
      );
      await page.locator("[data-calibration-save]").click();
      await expect(dialog).toBeHidden();
      await expect
        .poll(async () => (await view(page)).cam.scale)
        .toBeCloseTo(120 / 72, 5);
      expect(
        await page.evaluate(() =>
          JSON.parse(localStorage.getItem("paged.view.calibration") ?? "null"),
        ),
      ).toEqual({ devicePxPerInch: 120 * dpr });

      // Once calibrated, the command zooms straight to it.
      await run(page, "paged.view.zoom100");
      await clickMenuRow(page, "View/Calibrated size");
      await expect
        .poll(async () => (await view(page)).cam.scale)
        .toBeCloseTo(120 / 72, 5);
      await clickMenuRow(page, "View/Calibrate screen size…");
      await expect(dialog).toBeVisible();
      await page.locator("[data-calibration-forget]").click();
      await expect(dialog).toBeHidden();

      // Zooms are not navigations; a page key is, and Layout's rows go
      // back and forward over it.
      const before = await settled(page);
      await run(page, "paged.view.nextPage");
      const after = await settled(page);
      await clickMenuRow(page, "Layout/Go back");
      expect((await settled(page)).cam).toEqual(before.cam);
      await clickMenuRow(page, "Layout/Go forward");
      expect((await settled(page)).cam).toEqual(after.cam);
    });
    expect(await modelSnapshot(page)).toBe(model);
  });
});
