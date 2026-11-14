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

// paged.slide ADR 725 (UX audit F-47): a deck opens in the slide sorter —
// its navigation — on the real engine. The sorter marks the slide being
// edited, its keys move through the deck and open a slide in Normal view,
// and its Delete is one undo step. Opening in the sorter changes nothing in
// the document. The suite opts in (`slideSorterOnOpen`); every other deck
// journey boots with decks opening on the canvas.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { openCanvas } from "../fidelity/canvas-driver";
import { Designer } from "../journey/driver/designer";
import { historyDepth, undoDepth } from "./harness/history";
import { modelSnapshot } from "./harness/model-dump";

const DECK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "harness/slide-deck.pptx",
);
const SORTER_CMD = "media.paged.slide.command.slideSorter";

async function pageCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __canvas: { handle?: { pageIds: string[] } };
        }
      ).__canvas.handle?.pageIds.length ?? 0,
  );
}

async function openDeckInSorter(page: Page): Promise<void> {
  await openCanvas(page, { slideSorterOnOpen: true });
  await new Designer(page).newDocument();
  const bytes = [...readFileSync(DECK)];
  await page.evaluate(
    async ({ bytes }) => {
      const reg = (
        globalThis as unknown as {
          __canvas: {
            registries: {
              importers: {
                resolve(n: string): {
                  import(a: {
                    name: string;
                    bytes: Uint8Array;
                    mimeType: string;
                  }): Promise<void>;
                } | null;
              };
            };
          };
        }
      ).__canvas.registries.importers;
      await reg.resolve("slide-deck.pptx")!.import({
        name: "slide-deck.pptx",
        bytes: new Uint8Array(bytes),
        mimeType: "",
      });
    },
    { bytes },
  );
  await expect.poll(() => pageCount(page), { timeout: 30_000 }).toBe(10);
}

test.describe("paged.slide ADR 725 — a deck opens in the slide sorter", () => {
  test.describe.configure({ timeout: 180_000 });

  test("F-47 — a ten-slide deck opens in the sorter; the current slide is marked; Enter opens a slide in Normal view; nothing in the document changes @feat:plugin-slide.slide-sorter @level:edge", async ({
    page,
  }) => {
    await openDeckInSorter(page);
    const sorter = page.locator('[data-slide-sorter="ready"]');
    await expect(sorter).toBeVisible();
    await expect(sorter.locator("[data-sorter-slide]")).toHaveCount(10);
    await expect(sorter.locator('[data-current="true"]')).toHaveCount(1);
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);

    // The keys: the third slide, then Normal view on it.
    const list = sorter.locator('[role="listbox"]');
    await list.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(
      sorter.locator('[data-sorter-slide][aria-selected="true"]'),
    ).toHaveAttribute("data-number", "3");
    const third = await sorter
      .locator('[data-sorter-slide][aria-selected="true"]')
      .getAttribute("data-sorter-slide");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-slide-sorter]")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (
              await (
                globalThis as unknown as {
                  __canvas: {
                    client: {
                      documentMeta(): Promise<{ activePage?: string | null }>;
                    };
                  };
                }
              ).__canvas.client.documentMeta()
            ).activePage ?? null,
        ),
      )
      .toBe(third);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);
  });

  test("F-47 — Delete in the sorter removes the selected slides as one undo step @feat:plugin-slide.slide-sorter @level:edge", async ({
    page,
  }) => {
    await openDeckInSorter(page);
    const sorter = page.locator('[data-slide-sorter="ready"]');
    await expect(sorter).toBeVisible();
    const depth = await undoDepth(page);
    await sorter.locator('[data-sorter-slide][data-number="2"]').click();
    await sorter
      .locator('[data-sorter-slide][data-number="3"]')
      .click({ modifiers: ["Shift"] });
    await page.keyboard.press("Delete");
    await expect.poll(() => pageCount(page)).toBe(8);
    expect(await undoDepth(page)).toBe(depth + 1);
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          __canvas: { client: { undo(): Promise<unknown> } };
        }
      ).__canvas.client.undo(),
    );
    await expect.poll(() => pageCount(page)).toBe(10);
  });

  test("the sorter's switch: with 'Open decks in the sorter' off, View ▸ Slide Sorter still opens it @feat:plugin-slide.slide-sorter @level:edge", async ({
    page,
  }) => {
    await openDeckInSorter(page);
    const sorter = page.locator('[data-slide-sorter="ready"]');
    const toggle = sorter.locator("[data-sorter-open-on-load]");
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await sorter.locator('[data-sorter="normal"]').click();
    await expect(page.locator("[data-slide-sorter]")).toHaveCount(0);
    await new Designer(page).runCommand(SORTER_CMD);
    await expect(sorter).toBeVisible();
    await expect(
      sorter.locator("[data-sorter-open-on-load]"),
    ).not.toBeChecked();
  });
});
