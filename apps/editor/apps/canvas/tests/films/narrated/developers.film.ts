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

// For developers, the developers page's film (ADR 224): the website's
// `films/developers.yaml`. The editor is programmable, and every way in goes
// through the same engine: the playground stepping a live script, paged.*
// queries and one-step batches in the Script panel, a plugin's manifest and
// its panel, and the paged command line in a terminal (the two terminal
// scenes are real recorded sessions the stage plays).

import { expect, type Locator, type Page } from "@playwright/test";
import { film, type Kit } from "../kit/film";
import { typeHuman } from "../kit/pointer";
import { hover, menu, press, screenPoint } from "../kit/ui";
import {
  fitPage,
  jumpTo,
  openSample,
  pagePoint,
  sampleRole,
} from "../kit/samples";

// The scenes run on a page of a real publication (website ADR 863): which
// one is the storyboard's (films/samples.take.json, "developers"). The
// swatch the batch fills with is made off camera.
const VIOLET = `paged.createSwatch({ selfId: "Color/Violet", name: "Violet", space: "RGB", value: [169, 139, 245], model: "Process" });
paged.clearSelection();`;

const QUERY = (n: number) => `paged.query("page:#${n} > frame")`;

const BATCH = (
  n: number,
) => `const frames = JSON.parse(paged.query("page:#${n} > frame"));
paged.batch(frames.flatMap((f) => [
  { op: "set", address: f, path: "frameFillColor", value: "Color/Violet" },
  { op: "set", address: f, path: "frameRotationAngle", value: -6 },
]));`;

async function run(page: Page, source: string): Promise<string[]> {
  const r = await page.evaluate(
    async (s) =>
      (
        globalThis as unknown as {
          __canvas: {
            client: {
              executeScript(
                s: string,
              ): Promise<{ output: string[]; error: string | null }>;
            };
          };
        }
      ).__canvas.client.executeScript(s),
    source,
  );
  if (r.error) throw new Error(`script failed: ${r.error}`);
  return r.output;
}

/** Each frame on page 1: its fill and rotation. */
async function frames(
  page: Page,
  n: number,
): Promise<Array<{ fill: unknown; angle: unknown }>> {
  const out = await run(
    page,
    `const v = (f, p) => JSON.parse(paged.get(f, p)).value;
console.log(JSON.stringify(JSON.parse(paged.query("page:#${n} > frame")).map((f) => ({ fill: v(f, "frameFillColor"), angle: v(f, "frameRotationAngle") }))));`,
  );
  return JSON.parse(out[0].replace(/^\[log\] /, ""));
}

/** Aim a punch-in at a rectangle of the editor's UI (CSS px), through the
 *  live camera: focus() takes page points. */
async function aimView(
  k: Kit,
  box: { x: number; y: number; width: number; height: number },
): Promise<[number, number, number, number]> {
  const o = await screenPoint(k.page, 0, 0);
  const s = ((await screenPoint(k.page, 100, 0)).x - o.x) / 100;
  return [
    (box.x - o.x) / s,
    (box.y - o.y) / s,
    (box.x + box.width - o.x) / s,
    (box.y + box.height - o.y) / s,
  ];
}

/** The script panel's ask bar, source and log, as one region. */
async function scriptArea(
  rows: Locator[],
): Promise<{ x: number; y: number; width: number; height: number }> {
  const boxes = await Promise.all(
    rows.map(async (r) => (await r.boundingBox())!),
  );
  const x = Math.min(...boxes.map((b) => b.x)) - 8;
  const y = Math.min(...boxes.map((b) => b.y)) - 8;
  const r = Math.max(...boxes.map((b) => b.x + b.width)) + 8;
  const b = Math.max(...boxes.map((b) => b.y + b.height)) + 8;
  return { x, y, width: r - x, height: b - y };
}

film("developers", async (k) => {
  const { page, designer, pointer } = k;
  const real = sampleRole("developers");
  const PAGE = real.page as number;
  let before: string[] = [];
  const panel = page.locator("[data-script-editor]");
  const source = panel.locator("[data-script-source]");
  const log = panel.locator("[data-script-log]");

  await k.setup(async () => {
    await designer.open({ search: "?script=draw-live" });
    // A document first: the canvas runs on WebGPU once one is open.
    await designer.newDocument();
    await expect(page.locator("[data-playground-source]")).toBeVisible();
    await expect(page.locator("[data-playground-chapter]")).toHaveCount(5);
    // This film is about the script: the guide shows it from the start.
    await page.locator("[data-playground-script-toggle]").click();
    await expect(page.locator("[data-playground-code]")).toBeVisible();
    await k.hold(800);
  });
  await k.roll();

  // ── The playground: play; the script draws in the editor. ──
  const status = page.locator("[data-playground-status]");
  await k.scene("playground", async () => {
    await k.hold(400);
    await press(k, page.locator("[data-playground-play]"));
    await expect(status).toHaveAttribute("data-playground-status", "playing");
    // The dome, drawn by its anchors.
    await expect(
      page.getByText("A curve, by its anchors", { exact: true }).last(),
    ).toBeVisible({ timeout: 30_000 });
    await k.hold(600);
  });

  // ── Pause, step twice (the card appears, then fills), play on. ──
  await k.scene("step", async () => {
    await press(k, page.locator("[data-playground-play]"));
    await expect(status).toHaveAttribute("data-playground-status", "paused", {
      timeout: 10_000,
    });
    // The narration box running when it paused finishes on its own clock;
    // the next step is then the card's statement.
    await expect(
      page.getByText("A curve, by its anchors", { exact: true }),
    ).toHaveCount(0, { timeout: 10_000 });
    const rects = async () =>
      (
        await run(
          page,
          `console.log(JSON.parse(paged.query("page:#1 > frame")).length)`,
        )
      )[0];
    const before = await rects();
    await press(k, page.locator("[data-playground-step]"));
    await expect.poll(rects).not.toBe(before);
    await k.hold(700);
    await press(k, page.locator("[data-playground-step]"));
    await k.hold(700);
    await press(k, page.locator("[data-playground-play]"));
    await expect(
      page.getByText("Live corners", { exact: true }).last(),
    ).toBeVisible({ timeout: 30_000 });
    await k.hold(1500);
  });

  // The script plays to its end, then a page of a real publication; the
  // edit removes the wait. (Restart does not stop a statement already
  // running: it would go on drawing into the fresh page.)
  await k.cut("Opening a real magazine", async () => {
    await expect(page.locator("[data-playground-status]")).toHaveAttribute(
      "data-playground-status",
      "done",
      { timeout: 60_000 },
    );
    await page.locator("[data-playground-toggle]").click();
    await expect(page.locator("[data-playground-source]")).toHaveCount(0);
    await openSample(k, real);
    await jumpTo(k, PAGE);
    await fitPage(k);
    await run(page, VIOLET);
    before = (await frames(page, PAGE)).map((f) => `${f.fill}/${f.angle}`);
    expect(before.length, "frames on the page").toBeGreaterThan(3);
    await k.hold(600);
    await k.recamera();
  });

  // ── The Script panel: one query, every frame's address. ──
  await k.scene("console", async () => {
    await menu(k, ["Window", "Utilities", "Script"]);
    await expect(panel).toBeVisible();
    k.focus(
      await aimView(
        k,
        await scriptArea([panel.locator("[data-script-ask]"), source, log]),
      ),
      1.8,
    );
    await press(k, source);
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");
    await typeHuman(page, QUERY(PAGE), 11);
    await press(k, panel.locator("[data-action=run]"));
    await expect(log).toContainText(/(rectangle|textFrame|polygon):/);
  });

  // ── One batch: every frame restyled, as one step. ──
  await k.scene("batch", async () => {
    await press(k, source);
    await page.keyboard.press("Meta+a");
    k.chip("Paste", "key", "⌘V");
    await page.keyboard.insertText(BATCH(PAGE));
    await k.hold(900);
    await press(k, panel.locator("[data-action=run]"));
    await expect
      .poll(async () =>
        (await frames(page, PAGE)).every(
          (f) => f.fill === "Color/Violet" && f.angle === -6,
        ),
      )
      .toBe(true);
    k.unfocus();
    await k.hold(600);
  });

  // ── One undo takes all eight writes back. ──
  await k.scene("undo", async () => {
    await k.key("Meta+z", "Undo", "⌘Z");
    await expect
      .poll(async () =>
        (await frames(page, PAGE)).map((f) => `${f.fill}/${f.angle}`),
      )
      .toEqual(before);
  });

  // ── A plugin is a manifest: the terminal shows paged.draw's. ──
  await k.scene("plugin");

  // ── Its panel opens like any other. ──
  await k.scene("panel", async () => {
    // Select the page's photograph, so the panel shows its appearance.
    await k.key("v");
    await pointer.click(await pagePoint(k, PAGE, 300, 190), {
      targetWidth: 60,
    });
    await expect
      .poll(async () => (await run(page, `console.log(paged.selection())`))[0])
      .toMatch(/"id":"/);
    await press(
      k,
      page.getByRole("menubar").getByText("Plugins", { exact: true }).first(),
    );
    await k.hold(250);
    await hover(k, page.getByRole("menuitem", { name: /^Draw/ }).first());
    await k.hold(400);
    // Settle into the Draw row (the way down crossed Data, whose submenu
    // can stay open) until Draw's own submenu shows.
    await pointer.moveTo(
      { x: pointer.position.x + 10, y: pointer.position.y },
      { targetWidth: 60 },
    );
    await expect(
      page.getByRole("menuitem", { name: /^Compound path/ }),
    ).toBeVisible({ timeout: 5000 });
    // The submenu lists the plugin's commands, then its panels: "Graphic
    // styles" is a panel (draw's Appearance panel is the host's now, draw
    // ADR 367). Into the submenu's column first, then down it: a diagonal
    // would cross the main menu's other rows and close it.
    const panelItem = page
      .getByRole("menuitem", { name: /^Graphic styles$/ })
      .last();
    await panelItem.waitFor({ state: "visible", timeout: 5000 });
    const column = (await panelItem.boundingBox())!;
    await pointer.moveTo(
      { x: column.x + column.width / 2, y: pointer.position.y },
      { targetWidth: column.width },
    );
    await k.hold(200);
    await press(k, panelItem);
    await expect(
      page.locator('[data-dock-tab="media.paged.draw.panel.graphicStyles"]'),
    ).toBeVisible();
    await k.hold(1200);
  });

  // ── The paged command line: the terminal shows a real session. ──
  await k.scene("cli");
});
