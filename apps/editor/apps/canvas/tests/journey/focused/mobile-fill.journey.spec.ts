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

// The fill presets on a phone (editor ADR 294), on emulated devices with
// touch: the business card demo in `template-fill` (the card fills the
// screen; a tapped field opens in a sheet; the portrait comes from the
// camera input) and in `form` (the form first, the preview folded away).
// One finger pans the card, the zoom buttons zoom it, two fingers pinch.

import { test, expect, devices, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";
import { PNG } from "pngjs";

// The device's viewport, scale, user agent and touch, on this project's
// Chromium (a describe group cannot switch the browser type).
function onChromium(name: "Pixel 7" | "iPhone 13") {
  const { defaultBrowserType: _browser, ...device } = devices[name];
  return device;
}

/** A small picture, as a phone's camera hands it to the page. */
function photo(): Buffer {
  const png = new PNG({ width: 48, height: 64 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 180;
    png.data[i + 1] = 120;
    png.data[i + 2] = 90;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

const ready = (page: Page) =>
  expect(page.getByRole("status")).toContainText("ready", { timeout: 90_000 });

/** The on-screen box of a field's outline on the canvas. */
async function outline(page: Page, field: string) {
  const box = await page
    .locator(`[data-template-field-outline="${field}"] polygon`)
    .boundingBox();
  if (!box) throw new Error(`no outline for ${field}`);
  return box;
}

/** A touch gesture through the browser's own touch input: the page sees
 *  the pointer events a finger makes. */
async function touch(
  page: Page,
  steps: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
) {
  const cdp = await page.context().newCDPSession(page);
  const points = (at: ReadonlyArray<readonly [number, number]>) =>
    at.map(([x, y], id) => ({ x, y, id }));
  // Each step a frame apart, and the fingers rest before they lift: a
  // finger lifted while still moving flings, and the browser spends the
  // next tap stopping the fling instead of clicking.
  const t0 = Date.now() / 1000;
  const at = (ms: number) => t0 + ms / 1000;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: points(steps[0]!),
    timestamp: at(0),
  });
  let ms = 0;
  for (const step of steps.slice(1)) {
    ms += 16;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: points(step),
      timestamp: at(ms),
    });
  }
  ms += 300;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: points(steps[steps.length - 1]!),
    timestamp: at(ms),
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
    timestamp: at(ms + 16),
  });
  await cdp.detach();
}

test.describe("journey · fill presets on a phone (Pixel 7)", () => {
  test.use(onChromium("Pixel 7"));

  test("template-fill: tap a field, type, take a photo, pan and zoom @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.template.form");
    await page.goto("/demos/business-card.html");
    await ready(page);

    // The phone layout: no tool rail, the card, a sheet and zoom buttons.
    await expect(
      page.locator('[data-compact-layout="field-sheet"]'),
    ).toBeVisible();
    await expect(page.locator("[data-tool-rail]")).toHaveCount(0);
    await expect(page.locator("[data-field-sheet]")).toBeVisible();
    await expect(page.locator("[data-touch-zoom]")).toBeVisible();
    for (const button of await page
      .locator("[data-touch-zoom-command], [data-region-command]")
      .all()) {
      const box = (await button.boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    }

    // Tap the name on the card: the sheet shows that field.
    await expect(
      page.locator('[data-template-field-outline="name"]'),
    ).toHaveCount(1, { timeout: 15_000 });
    const name = await outline(page, "name");
    await page.touchscreen.tap(
      name.x + name.width / 2,
      name.y + name.height / 2,
    );
    const input = page.locator('[data-field-input="name"]');
    await expect(input).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-field-input="title"]')).toHaveCount(0);
    await input.tap();
    await input.fill("Grace Example");
    await input.press("Enter");
    await page.locator("[data-sheet-done]").tap();
    await expect(input).toHaveCount(0);

    // The portrait: from the camera input.
    const portrait = await outline(page, "photo");
    await page.touchscreen.tap(
      portrait.x + portrait.width / 2,
      portrait.y + portrait.height / 2,
    );
    const camera = page.locator(
      '[data-field-picture-input="camera"] input[data-field-file="photo"]',
    );
    await expect(camera).toHaveAttribute("capture", "environment");
    await expect(camera).toHaveAttribute("accept", "image/*");
    await camera.setInputFiles({
      name: "portrait.png",
      mimeType: "image/png",
      buffer: photo(),
    });
    // The frame shows the photo: its colour is on the canvas.
    await expect
      .poll(
        async () => {
          const box = await outline(page, "photo");
          const shot = PNG.sync.read(
            await page.screenshot({
              clip: {
                x: box.x + box.width / 4,
                y: box.y + (box.height * 3) / 4,
                width: 2,
                height: 2,
              },
              scale: "css",
            }),
          );
          const [r, g, b] = [shot.data[0]!, shot.data[1]!, shot.data[2]!];
          return Math.abs(r - 180) + Math.abs(g - 120) + Math.abs(b - 90) < 30;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect(page.locator("[data-field-problem]")).toHaveCount(0);

    // One finger pans the card.
    const start = await outline(page, "name");
    const x = start.x + start.width / 2;
    const y = start.y + start.height + 20;
    await touch(page, [
      [[x, y]],
      [[x - 20, y + 10]],
      [[x - 40, y + 30]],
      [[x - 60, y + 40]],
    ]);
    await expect
      .poll(async () => {
        const now = await outline(page, "name");
        return [Math.round(now.x - start.x), Math.round(now.y - start.y)];
      })
      .toEqual([-60, 40]);
    // Panning moved nothing on the card: no field is open.
    await expect(page.locator('[data-field-input="name"]')).toHaveCount(0);

    // The zoom buttons zoom, once the pan's camera has settled (as the pinch
    // below waits for the zoom): the pan's last camera update must not land
    // after the zoom and take it back.
    let settled = "";
    await expect
      .poll(async () => {
        const o = await outline(page, "name");
        const now = `${Math.round(o.x)},${Math.round(o.y)},${Math.round(o.width)}`;
        const same = now === settled;
        settled = now;
        return same;
      })
      .toBe(true);
    const small = await outline(page, "name");
    await page.locator('[data-touch-zoom-command="paged.view.zoomIn"]').tap();
    await expect
      .poll(async () => (await outline(page, "name")).width)
      .toBeGreaterThan(small.width * 1.1);

    // Two fingers spread apart zoom in further, once the zoom has settled
    // (the buttons animate the camera).
    let last = -1;
    await expect
      .poll(async () => {
        const now = Math.round((await outline(page, "name")).width);
        const settled = now === last;
        last = now;
        return settled;
      })
      .toBe(true);
    const mid = await outline(page, "name");
    const cx = mid.x + mid.width / 2;
    const cy = mid.y + mid.height + 30;
    await touch(page, [
      [
        [cx - 30, cy],
        [cx + 30, cy],
      ],
      [
        [cx - 50, cy],
        [cx + 50, cy],
      ],
      [
        [cx - 80, cy],
        [cx + 80, cy],
      ],
    ]);
    await expect
      .poll(async () => (await outline(page, "name")).width)
      .toBeGreaterThan(mid.width * 2);

    // Submit hands the typed name to the host.
    await page.locator('[data-region-command="paged.host.submit"]').tap();
    await expect(page.locator("[data-demo-submitted]")).toContainText(
      '"name": "Grace Example"',
      { timeout: 15_000 },
    );
  });
});

test.describe("journey · fill presets on a phone (iPhone 13)", () => {
  test.use(onChromium("iPhone 13"));

  test("form: the fields first, the preview folds out on request @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.template.form");
    await page.goto("/demos/business-card.html?layout=form");
    await ready(page);

    const toggle = page.locator("[data-preview-toggle]");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("[data-paged-canvas]")).toBeHidden();
    const input = page.locator('[data-field-input="title"]');
    await expect(input).toBeVisible({ timeout: 15_000 });
    const box = (await input.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    await input.tap();
    await input.fill("Head of Type");
    await input.press("Enter");

    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("[data-paged-canvas]")).toBeVisible();
    await expect(page.locator("[data-touch-zoom]")).toBeVisible();
    // The preview edits nothing: a tap on a field opens nothing.
    await expect(
      page.locator('[data-template-field-outline="name"]'),
    ).toHaveCount(1, { timeout: 15_000 });

    await page.locator('[data-region-command="paged.host.submit"]').tap();
    await expect(page.locator("[data-demo-submitted]")).toContainText(
      '"title": "Head of Type"',
      { timeout: 15_000 },
    );
  });
});
