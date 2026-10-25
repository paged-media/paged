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

// paged.slide as its own application (editor ADR 307): `?solo=paged.slide`
// is PowerPoint's Normal view. A deck opened there gets the Slides rail on
// the left, and PowerPoint's keys, scoped to the deck: Ctrl+M makes a new
// slide after the current one, PageDown and PageUp step through the deck,
// Ctrl+D with nothing selected duplicates the slide. A comment written in
// the Comments panel is written into the exported .pptx and comes back
// when that file is opened again (slide ADR 711, amendment 2026-10-25).
//
// Ctrl, not Cmd: a browser on macOS keeps Cmd+M (minimise) for itself, so
// Ctrl+M is the chord that reaches the page on every platform; the
// bindings carry both.

import { expect, test, type Page } from "@playwright/test";
import { dirname, resolve as pathResolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Designer } from "../driver/designer";

const PPTX_FIXTURE = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../e2e/harness/slide-deck.pptx",
);
const PPTX_IMPORTER = "media.paged.slide.importer.pptx";
const PPTX_EXPORTER = "media.paged.slide.exporter.pptx";

type Registries = {
  importers?: {
    resolve: (fileName: string) => {
      id?: string;
      import: (args: { name: string; bytes: Uint8Array }) => Promise<void>;
    } | null;
  };
  exporters?: {
    list: () => {
      id: string;
      export: () => Promise<{ bytes: Uint8Array; fileName: string } | null>;
    }[];
  };
};

/** Open `bytes` as a deck through the host's importer registry (the path
 *  File ▸ Open takes). Answers the importer id, or why there was none. */
async function importDeck(
  page: Page,
  bytes: readonly number[],
  name: string,
): Promise<string> {
  return page.evaluate(
    async ({ bytes, name }) => {
      const reg = (
        globalThis as unknown as { __canvas: { registries: Registries } }
      ).__canvas.registries.importers;
      const imp = reg?.resolve(name);
      if (!imp) return "no importer resolved for .pptx";
      await imp.import({ name, bytes: new Uint8Array(bytes) });
      return imp.id ?? "imported";
    },
    { bytes: [...bytes], name },
  );
}

/** Export the open deck through the host's exporter registry. */
async function exportDeck(page: Page, id: string): Promise<number[] | null> {
  return page.evaluate(async (id) => {
    const reg = (
      globalThis as unknown as { __canvas: { registries: Registries } }
    ).__canvas.registries.exporters;
    const ex = reg?.list().find((e) => e.id === id);
    const out = ex ? await ex.export() : null;
    return out ? Array.from(out.bytes) : null;
  }, id);
}

/** The open document's page count; 0 before one is loaded. */
const pageCount = (page: Page) =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __canvas: { handle?: { pageCount: number } | null };
        }
      ).__canvas.handle?.pageCount ?? 0,
  );

/** Boot the slide profile and open the fixture deck in it. */
async function openDeckInSlideProfile(page: Page): Promise<Designer> {
  const designer = new Designer(page);
  await designer.open({ search: "?solo=paged.slide" });
  // The profile's own document: one 16:9 slide at PowerPoint's size.
  await expect.poll(() => pageCount(page), { timeout: 25_000 }).toBe(1);
  expect((await designer.handle()).pageSizesPt[0]).toEqual([960, 540]);
  expect(
    await importDeck(page, [...readFileSync(PPTX_FIXTURE)], "slide-deck.pptx"),
  ).toBe(PPTX_IMPORTER);
  await expect.poll(() => pageCount(page), { timeout: 20_000 }).toBe(10);
  return designer;
}

/** The Slides rail and the position of the active slide in it. */
function slidesRail(page: Page) {
  const panel = page.locator('[data-slides-panel="ready"]');
  const active = async () => {
    const ids = await panel
      .locator("[data-slide]")
      .evaluateAll((els) =>
        els.map((e) => [
          e.getAttribute("data-slide"),
          e.hasAttribute("data-active"),
        ]),
      );
    return ids.findIndex(([, on]) => on);
  };
  return { panel, active };
}

/** Keys go to the page, not to a panel's field. */
async function blurFocus(page: Page): Promise<void> {
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
}

test.describe("journey · paged.slide Normal view", () => {
  test("the slide profile opens a deck with its Slides rail; Ctrl+M, PageDown, PageUp and Ctrl+D act on slides @feat:editor-shell.solo-mode @level:gesture", async ({
    page,
  }) => {
    const designer = await openDeckInSlideProfile(page);
    const rail = slidesRail(page);
    // The Slides rail is the profile's left column: no panel to open.
    await expect(rail.panel).toBeVisible({ timeout: 15_000 });
    await expect(rail.panel.locator("[data-slide]")).toHaveCount(10);
    // Slide 1 is the current one: chosen in the rail, so the viewport's
    // settling after the open cannot move it.
    await rail.panel.locator("[data-slide-thumb]").first().click();
    await expect.poll(rail.active, { timeout: 10_000 }).toBe(0);
    const before = (await designer.handle()).pageIds;

    // Ctrl+M: a new slide right after the current one, and the view goes there.
    await blurFocus(page);
    await page.keyboard.press("Control+m");
    // New slide makes its copy twice (a probe it undoes, then the real
    // one, one undo step), so the page list passes through 11 pages before
    // it settles; the view goes to the new slide once it has.
    await expect.poll(rail.active, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => pageCount(page), { timeout: 20_000 }).toBe(11);
    const after = (await designer.handle()).pageIds;
    const made = after.find((id) => !before.includes(id))!;
    expect(
      after.indexOf(made),
      `the new slide in ${JSON.stringify(after)}`,
    ).toBe(1);
    expect(after.filter((id) => id !== made)).toEqual(before);

    // PageDown and PageUp step through the deck.
    await blurFocus(page);
    await page.keyboard.press("PageDown");
    await expect.poll(rail.active, { timeout: 10_000 }).toBe(2);
    await page.keyboard.press("PageDown");
    await expect.poll(rail.active, { timeout: 10_000 }).toBe(3);
    await page.keyboard.press("PageUp");
    await expect.poll(rail.active, { timeout: 10_000 }).toBe(2);

    // Ctrl+D with nothing selected duplicates the current slide.
    await page.keyboard.press("Control+d");
    await expect.poll(() => pageCount(page), { timeout: 20_000 }).toBe(12);
  });

  test("a comment written in the Comments panel survives export and opening the exported deck again @feat:plugin-slide.pptx-export @level:happy", async ({
    page,
  }) => {
    const designer = await openDeckInSlideProfile(page);
    const rail = slidesRail(page);
    await expect(rail.panel).toBeVisible({ timeout: 15_000 });
    await expect.poll(rail.active, { timeout: 10_000 }).toBe(0);
    await blurFocus(page);
    await page.keyboard.press("PageDown");
    await expect.poll(rail.active, { timeout: 10_000 }).toBe(1);

    await designer.openPanel("media.paged.slide.panel.comments");
    const panel = page.locator('[data-comments-panel="ready"]');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel).toContainText("Slide 2");
    await panel.locator("[data-comment-author]").fill("Ana Lima");
    await panel.locator("[data-comment-new]").fill("Use the brand blue here");
    await panel.locator("[data-comment-add]").click();
    await expect(panel.locator("[data-comment-text]")).toHaveText(
      "Use the brand blue here",
    );

    // Export, then open the written deck as the document.
    const bytes = await exportDeck(page, PPTX_EXPORTER);
    expect(bytes, "the PowerPoint exporter answered").not.toBeNull();
    expect(
      Buffer.from(bytes!).equals(readFileSync(PPTX_FIXTURE)),
      "a comment changes the deck",
    ).toBe(false);
    expect(await importDeck(page, bytes!, "slide-deck-commented.pptx")).toBe(
      PPTX_IMPORTER,
    );
    await expect.poll(() => pageCount(page), { timeout: 20_000 }).toBe(10);

    // Slide 2 carries the comment, under its author; slide 1 carries none.
    await expect(rail.panel.locator("[data-slide]")).toHaveCount(10, {
      timeout: 15_000,
    });
    await rail.panel
      .locator("[data-slide]")
      .nth(1)
      .locator("button")
      .first()
      .click();
    await expect.poll(rail.active, { timeout: 10_000 }).toBe(1);
    await designer.openPanel("media.paged.slide.panel.comments");
    await expect(panel.locator("[data-comment-text]")).toHaveText(
      "Use the brand blue here",
      { timeout: 10_000 },
    );
    await expect(panel.locator("[data-comment]")).toContainText("Ana Lima");
    await rail.panel
      .locator("[data-slide]")
      .nth(0)
      .locator("button")
      .first()
      .click();
    await expect.poll(rail.active, { timeout: 10_000 }).toBe(0);
    await expect(panel.locator("[data-comments-none]")).toBeVisible();
  });
});
