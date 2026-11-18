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

// Journey: the web source panel keeps the page answering while the page is
// screencast, and its browser preview loads only when its source changes.
//
// The steps of the website's web film, recorded while the editor captures
// itself through CDP `Page.startScreencast`: a web frame is selected, the
// reader clicks into the CSS editor, changes a colour and saves; then a
// second frame is threaded into the flow and the threaded source frame is
// selected again, the pointer passing over the preview. A probe evaluates
// in the page all along, and every step must answer within a budget.
//
// What the journey pins: the preview iframe's srcdoc was made trusted HTML
// (Trusted Types, editor ADR 240) on every render of the panel, a new
// object each time, so React set the attribute again and the sandboxed
// preview navigated on every render (each keystroke, each document change,
// each render the panel's parent caused), however unchanged its source.
//
// Why that froze the film: Chrome loses the acknowledgement of a mouse
// event routed to an out-of-process iframe (the sandboxed preview is one)
// that navigates before handling it, and `mouse.move` then waits forever,
// though the browser takes the next event at once. Each needless
// navigation was another chance; the film's kit now gives up on a lost
// acknowledgement (tests/films/kit/film.ts, MOUSE_ACK_MS), and so does
// this journey's pointer, which crosses the preview only where it must
// not navigate.

import { expect, test, type CDPSession, type Page } from "@playwright/test";

import { Designer } from "../driver/designer";
import {
  THREAD,
  WEB_PANEL,
  boundsOf,
  insertWebFrameWith,
  invoke,
  mutate,
  select,
  tapSceneLayers,
  webSource,
  type ElementRef,
} from "./web-kit";
import { openPanel } from "../../fidelity/canvas-driver";

const HTML = [
  '<div class="sheet">',
  "  <h1>Spring line sheet</h1>",
  "  <p>Linen, cotton and a little wool, cut for the first warm days.</p>",
  "  <p>Cotton sailor shirt, linen trousers, a canvas tote.</p>",
  "</div>",
].join("\n");
// The film's mailer sets its type in a family the document registers.
const CSS = [
  '.sheet { font: 14px/1.5 "IBM Plex Sans", sans-serif; background: #fff7ea; padding: 16px; }',
  'h1 { font: 600 22px/1.2 "IBM Plex Sans", sans-serif; margin: 0 0 8px; }',
  "p { margin: 0 0 6px; }",
].join("\n");

/** The longest the page may take to answer a probe, ms. A frozen page
 *  never answers; a busy CI runner answers well inside this. */
const ANSWER_BUDGET_MS = 5_000;
/** The longest one step may take, ms. */
const STEP_BUDGET_MS = 30_000;

/** A screencast like the films' capture (tests/films/kit/capture.ts):
 *  every frame acknowledged at once, so the page keeps producing them. */
async function startScreencast(
  page: Page,
): Promise<{ frames(): number; stop(): Promise<void> }> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  let frames = 0;
  cdp.on("Page.screencastFrame", (ev: { sessionId: number }) => {
    frames += 1;
    void cdp
      .send("Page.screencastFrameAck", { sessionId: ev.sessionId })
      .catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    everyNthFrame: 1,
  });
  return {
    frames: () => frames,
    async stop() {
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
    },
  };
}

/** How many documents the panel's preview iframe has loaded so far. */
async function previewLoads(page: Page): Promise<number> {
  return page.evaluate(() => {
    const g = globalThis as unknown as { __webPreviewLoads?: number };
    if (g.__webPreviewLoads === undefined) {
      g.__webPreviewLoads = 0;
      document.addEventListener(
        "load",
        (e) => {
          const el = e.target as Element | null;
          if (el?.matches?.("iframe[data-web-preview]"))
            g.__webPreviewLoads! += 1;
        },
        true,
      );
    }
    return g.__webPreviewLoads;
  });
}

/** The preview's load count once it has not changed for a second (a
 *  remounted panel loads its first preview, then the one with the
 *  document's faces). */
async function settledLoads(page: Page): Promise<number> {
  let last = await previewLoads(page);
  let since = Date.now();
  const end = Date.now() + 10_000;
  while (Date.now() - since < 1_000 && Date.now() < end) {
    await page.waitForTimeout(200);
    const now = await previewLoads(page);
    if (now !== last) {
      last = now;
      since = Date.now();
    }
  }
  return last;
}

/** `step` while a probe evaluates in the page every 100 ms. Fails when the
 *  step, or any probe, takes longer than the budget. */
async function answering<T>(
  page: Page,
  label: string,
  step: () => Promise<T>,
): Promise<T> {
  let worst = 0;
  let running = true;
  const probe = (async () => {
    while (running) {
      const t0 = Date.now();
      const ok = await Promise.race([
        page.evaluate(() => 0).then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), ANSWER_BUDGET_MS)),
      ]);
      worst = Math.max(worst, Date.now() - t0);
      if (!ok) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  const t0 = Date.now();
  const out = await Promise.race([
    step(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `${label}: the step did not end within ${STEP_BUDGET_MS} ms`,
            ),
          ),
        STEP_BUDGET_MS,
      ),
    ),
  ]);
  running = false;
  await probe;
  expect(
    worst,
    `${label}: the page answered every probe within ${ANSWER_BUDGET_MS} ms (took ${Date.now() - t0} ms)`,
  ).toBeLessThan(ANSWER_BUDGET_MS);
  return out;
}

/** A mouse move, given up on (and counted) when the browser does not
 *  acknowledge it within three seconds; see the header. */
let lostAcks = 0;
async function move(page: Page, x: number, y: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lost = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      lostAcks += 1;
      resolve();
    }, 3_000);
  });
  await Promise.race([page.mouse.move(x, y), lost]).finally(() =>
    clearTimeout(timer),
  );
}

/** Glide the mouse across the canvas: input the page must take. */
async function moveAcross(page: Page): Promise<void> {
  for (let i = 0; i <= 20; i++) await move(page, 400 + i * 10, 400);
}

/** Glide the mouse down across the preview, as the film's hand crosses it
 *  on its way from the CSS editor to Save. */
async function moveOverPreview(page: Page): Promise<void> {
  const preview = page.locator("iframe[data-web-preview]");
  await preview.scrollIntoViewIfNeeded();
  const b = await preview.boundingBox();
  if (!b) return;
  for (let i = 0; i <= 20; i++)
    await move(page, b.x + b.width / 2, b.y + (b.height * i) / 20);
}

test.describe("journey · paged.web preview under a screencast", () => {
  test("editing a web frame's CSS and selecting it threaded, under a screencast, the page keeps answering and the preview reloads only for a changed source @feat:plugin-web.source-panel @feat:plugin-web.flow-threading @level:edge", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    await tapSceneLayers(page);
    const first = await insertWebFrameWith(page, HTML, CSS);
    const css = page.locator("[data-web-css] [data-code-input]");
    await expect(css).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("iframe[data-web-preview]")).toBeVisible();

    const cast = await startScreencast(page);
    try {
      // ── Idle: the panel open on a saved source loads nothing. ──
      const idle0 = await settledLoads(page);
      await answering(page, "idle", async () => {
        await moveAcross(page);
        await moveOverPreview(page);
      });
      await page.waitForTimeout(1_500);
      expect(
        (await previewLoads(page)) - idle0,
        "an unchanged source does not reload the preview",
      ).toBe(0);

      // ── The CSS editor: one colour changed, typed key by key. ──
      const typed0 = await previewLoads(page);
      await answering(page, "edit the CSS", async () => {
        await css.click();
        await css.evaluate((el: HTMLTextAreaElement) => {
          const i = el.value.indexOf("fff7ea");
          el.setSelectionRange(i, i + 6);
        });
        await page.keyboard.type("e9f5ee", { delay: 60 });
      });
      // The preview follows the draft once typing settles (the panel's
      // ~300 ms debounce): one load for the six keys, not one a key (a
      // runner slow enough to pause between keys may settle twice).
      await expect
        .poll(() => previewLoads(page), { timeout: 5_000 })
        .toBeGreaterThan(typed0);
      expect(
        (await settledLoads(page)) - typed0,
        "six keystrokes reload the preview when the draft settles, not on every key",
      ).toBeLessThanOrEqual(3);

      // ── Saved: the document changes, the preview's source does not. ──
      const saved0 = await previewLoads(page);
      await answering(page, "save", async () => {
        await page.locator("[data-web-commit]").click();
        await expect
          .poll(async () => (await webSource(page, first))?.css ?? "", {
            timeout: 10_000,
          })
          .toContain("#e9f5ee");
      });
      await answering(page, "after the save", () => moveOverPreview(page));
      await page.waitForTimeout(1_500);
      expect(
        (await previewLoads(page)) - saved0,
        "saving the shown source does not reload the preview",
      ).toBe(0);

      // ── Threaded: a second frame joins the flow, and the source frame
      //    is selected again while the screencast runs. ──
      const { pageIds } = await designer.handle();
      const b = await boundsOf(page, first);
      const reply = await mutate(page, {
        op: "insertFrame",
        args: {
          pageId: pageIds[0]!,
          bounds: [b[0], b[3] + 20, b[2], b[3] + 20 + (b[3] - b[1])],
        },
      });
      expect(reply.kind).toBe("mutationApplied");
      const second: ElementRef = reply.payload!.createdId!;
      await answering(page, "thread", async () => {
        await select(page, [first, second]);
        await invoke(page, THREAD);
        await expect
          .poll(
            async () =>
              (await webSource(page, first))?.flow?.recipients?.[0]?.id,
            { timeout: 10_000 },
          )
          .toBe(second.id);
      });
      await answering(page, "select the threaded frame", async () => {
        await select(page, [first]);
        await openPanel(page, WEB_PANEL);
        await expect(css).toBeVisible({ timeout: 10_000 });
        await moveAcross(page);
      });
      const threaded0 = await settledLoads(page);
      await answering(page, "idle on the threaded frame", async () => {
        await moveAcross(page);
        await moveOverPreview(page);
      });
      await page.waitForTimeout(1_500);
      expect(
        (await previewLoads(page)) - threaded0,
        "the threaded frame's unchanged source does not reload the preview",
      ).toBe(0);
      expect(cast.frames(), "the screencast delivered frames").toBeGreaterThan(
        0,
      );
      // A lost acknowledgement is the browser's (see the header), not a
      // failure of the editor; it is recorded, not asserted.
      if (lostAcks > 0)
        test.info().annotations.push({
          type: "lost mouse acknowledgements",
          description: String(lostAcks),
        });
    } finally {
      await cast.stop();
    }
  });
});
