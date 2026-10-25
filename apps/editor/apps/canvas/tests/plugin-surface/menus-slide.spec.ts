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

// PLUGIN MENUS — paged.slide (modules/slide/packages/slide-bundle/src/menu.ts).
//
// Eleven entries: File ▸ Open PowerPoint deck… and File ▸ Export PowerPoint
// deck…, Insert ▸ Shapes…, and eight slide verbs under the Slide menu (New,
// Duplicate, Delete, Move up / down, Previous / Next slide, New comment),
// which the bar folds into Plugins ▸ Slide beside the panels.
//
// ORDER MATTERS here (serial): the document starts as a blank one, where
// only Open applies; the deck is then opened (through the importer, as
// File ▸ Open does: the Open entry's own click is answered "cancelled") and
// every later entry runs against it, on its first slide.
//
// WHAT EVERY ENTRY OWES, asserted per entry through the real menu bar
// (menu-driver.ts says where an entry shows and how a click is observed):
// greyed and inert without a document; greyed where its command does not
// apply; enabled where it does, a click running exactly its command once,
// with no payload, settling without throwing; and what it then did (the
// file asked for, the file handed to the saver, the slides changed, and
// that ONE Undo takes the change back).

import { readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import {
  clickEntry,
  documentDigest,
  expectGreyedAndInert,
  expectOneUndoRestores,
  isGreyed,
  openLeaf,
  openMenuPages,
  closeMenus,
  routeOf,
  runCommand,
} from "./menu-driver";

const HERE = dirname(fileURLToPath(import.meta.url));
const PPTX_FIXTURE = pathResolve(HERE, "../e2e/harness/slide-deck.pptx");
const C = "media.paged.slide.command";

const OPEN = "File/Open PowerPoint deck…";
const EXPORT = "File/Export PowerPoint deck…";
const NEW = "Slide/New slide";
const DUPLICATE = "Slide/Duplicate slide";
const DELETE = "Slide/Delete slide";
const UP = "Slide/Move slide up";
const DOWN = "Slide/Move slide down";
const PREVIOUS = "Slide/Previous slide";
const NEXT = "Slide/Next slide";
const COMMENT = "Slide/New comment";
const SHAPES = "Insert/Shapes…";
const SLIDE_VERBS = [NEW, DUPLICATE, DELETE, UP, DOWN, PREVIOUS, NEXT, COMMENT];

interface CanvasProbe {
  __canvas: {
    handle: { pageCount: number; pageIds: string[] } | null;
    registries: {
      importers: {
        resolve(name: string): {
          id: string;
          import(f: {
            name: string;
            bytes: Uint8Array;
            mimeType: string;
          }): Promise<void>;
        } | null;
      };
    };
  };
}

const pageIds = (page: Page) =>
  page.evaluate(
    () => (globalThis as unknown as CanvasProbe).__canvas.handle?.pageIds ?? [],
  );

/** Wait until `path` renders enabled (`true`) or greyed (`false`): the
 *  slide verbs follow the active slide, which settles after an edit. */
async function expectEnabled(
  page: Page,
  path: string,
  enabled: boolean,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const item = await openLeaf(page, routeOf(path));
        const greyed = await isGreyed(item);
        await closeMenus(page);
        return !greyed;
      },
      { message: `${path} enabled = ${enabled}`, timeout: 15_000 },
    )
    .toBe(enabled);
}

/** Go to the deck's first slide (View ▸ First page) and wait until the
 *  slide verbs see it: Move slide up greys there. */
async function toFirstSlide(page: Page): Promise<void> {
  await runCommand(page, "paged.view.firstPage");
  await expectEnabled(page, UP, false);
}

test.describe.serial("plugin menus — paged.slide", () => {
  let bare: Page;
  let live: Page;
  let close: () => Promise<void>;

  test.beforeAll(async ({ browser }, info) => {
    ({ bare, live, close } = await openMenuPages(browser, info.project.use));
  });
  test.afterAll(async () => {
    await close();
  });

  // ── a blank document ──

  test("File/Open PowerPoint deck… — asks for a .pptx / .ppsx / .potx file", async () => {
    covers("menu:File/Open PowerPoint deck…");
    covers("command:media.paged.slide.command.importPptx");
    await expectGreyedAndInert(bare, OPEN);
    const out = await clickEntry(live, OPEN, `${C}.importPptx`);
    expect(out.shell).toEqual([
      {
        door: "pickFile",
        arg: '{"accept":[".pptx",".ppsx",".potx","application/vnd.openxmlformats-officedocument.presentationml.presentation"],"multiple":false}',
      },
    ]);
    expect(out.after, "a cancelled pick leaves the document alone").toBe(
      out.before,
    );
  });

  test("outside a deck the slide verbs and Export are greyed and inert", async () => {
    for (const path of [EXPORT, ...SLIDE_VERBS]) {
      await expectGreyedAndInert(bare, path);
      await expectGreyedAndInert(live, path);
    }
  });

  // ── a deck, on its first slide ──

  test("in a deck the verbs apply; Move slide up is greyed on the first slide", async () => {
    const bytes = [...readFileSync(PPTX_FIXTURE)];
    await live.evaluate(
      async ({ bytes, name }) => {
        const imp = (
          globalThis as unknown as CanvasProbe
        ).__canvas.registries.importers.resolve(name);
        await imp!.import({ name, bytes: new Uint8Array(bytes), mimeType: "" });
      },
      { bytes, name: "slide-deck.pptx" },
    );
    await expect
      .poll(async () => (await pageIds(live)).length, { timeout: 30_000 })
      .toBe(10);
    await expectEnabled(live, NEW, true);
    for (const path of [EXPORT, DUPLICATE, DELETE, DOWN, NEXT, COMMENT])
      await expectEnabled(live, path, true);
    await expectGreyedAndInert(live, UP);
    await expectGreyedAndInert(live, PREVIOUS);
  });

  test("Slide/Next slide and Slide/Previous slide — the view steps through the deck, the document unchanged", async () => {
    covers("menu:Slide/Next slide");
    covers("menu:Slide/Previous slide");
    covers("command:media.paged.slide.command.nextSlide");
    covers("command:media.paged.slide.command.previousSlide");
    await expectGreyedAndInert(bare, NEXT);
    await expectGreyedAndInert(bare, PREVIOUS);
    await toFirstSlide(live);
    const next = await clickEntry(live, NEXT, `${C}.nextSlide`);
    expect(next.after, "going to a slide edits nothing").toBe(next.before);
    // On slide 2 there is a slide above: Previous applies, and goes back.
    await expectEnabled(live, PREVIOUS, true);
    await expectEnabled(live, UP, true);
    const previous = await clickEntry(live, PREVIOUS, `${C}.previousSlide`);
    expect(previous.after).toBe(previous.before);
    await expectEnabled(live, PREVIOUS, false);
  });

  test("Slide/New comment — raises the Comments panel on the active slide", async () => {
    covers("menu:Slide/New comment");
    covers("command:media.paged.slide.command.addComment");
    await expectGreyedAndInert(bare, COMMENT);
    await toFirstSlide(live);
    const out = await clickEntry(live, COMMENT, `${C}.addComment`);
    expect(out.after, "raising the panel edits nothing").toBe(out.before);
    await expect(live.locator('[data-comments-panel="ready"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(live.locator("[data-comment-new]")).toBeVisible();
  });

  test("Insert/Shapes… — opens the Shapes panel on the active slide", async () => {
    covers("menu:Insert/Shapes…");
    covers("command:media.paged.slide.command.insertShapes");
    await expectGreyedAndInert(bare, SHAPES);
    await toFirstSlide(live);
    const out = await clickEntry(live, SHAPES, `${C}.insertShapes`);
    expect(out.after, "opening the panel edits nothing").toBe(out.before);
    await expect(live.locator("[data-shapes-panel]")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("Slide/New slide — adds a slide after the active one; one Undo removes it", async () => {
    covers("menu:Slide/New slide");
    await expectGreyedAndInert(bare, NEW);
    await toFirstSlide(live);
    const before = await pageIds(live);
    const out = await clickEntry(live, NEW, `${C}.newSlide`);
    await expect.poll(async () => (await pageIds(live)).length).toBe(11);
    const after = await pageIds(live);
    expect(after[0]).toBe(before[0]);
    expect(before).not.toContain(after[1]);
    await expectOneUndoRestores(live, NEW, out.before);
  });

  test("Slide/Duplicate slide — copies the active slide right after it; one Undo removes it", async () => {
    covers("menu:Slide/Duplicate slide");
    await expectGreyedAndInert(bare, DUPLICATE);
    await toFirstSlide(live);
    await expectEnabled(live, DUPLICATE, true);
    const before = await pageIds(live);
    const out = await clickEntry(live, DUPLICATE, `${C}.duplicateSlide`);
    await expect.poll(async () => (await pageIds(live)).length).toBe(11);
    const after = await pageIds(live);
    expect(after[0]).toBe(before[0]);
    expect(after.slice(2)).toEqual(before.slice(1));
    await expectOneUndoRestores(live, DUPLICATE, out.before);
  });

  test("Slide/Move slide down and Slide/Move slide up — the slide passes its neighbour and back; one Undo each", async () => {
    covers("menu:Slide/Move slide down");
    covers("menu:Slide/Move slide up");
    await expectGreyedAndInert(bare, DOWN);
    await expectGreyedAndInert(bare, UP);
    await toFirstSlide(live);
    const before = await pageIds(live);
    const down = await clickEntry(live, DOWN, `${C}.moveSlideDown`);
    await expect
      .poll(async () => (await pageIds(live)).slice(0, 2))
      .toEqual([before[1], before[0]]);
    expect(down.after).not.toBe(down.before);
    // The viewport followed the slide: it is now second, so it can go up.
    await expectEnabled(live, UP, true);
    const up = await clickEntry(live, UP, `${C}.moveSlideUp`);
    await expect.poll(() => pageIds(live)).toEqual(before);
    expect(up.after).toBe(down.before);
    await expectOneUndoRestores(live, UP, up.before);
    await expectOneUndoRestores(live, DOWN, down.before);
  });

  test("Slide/Delete slide — removes the active slide; one Undo brings it back", async () => {
    covers("menu:Slide/Delete slide");
    await expectGreyedAndInert(bare, DELETE);
    await toFirstSlide(live);
    await expectEnabled(live, DELETE, true);
    const before = await pageIds(live);
    const digest = await documentDigest(live);
    await clickEntry(live, DELETE, `${C}.deleteSlide`);
    await expect.poll(async () => (await pageIds(live)).length).toBe(9);
    expect(before.length).toBe(10);
    await expectOneUndoRestores(live, DELETE, digest);
  });

  test("File/Export PowerPoint deck… — hands the written deck to the host's saver", async () => {
    covers("menu:File/Export PowerPoint deck…");
    covers("command:media.paged.slide.command.exportPptx");
    await expectGreyedAndInert(bare, EXPORT);
    const out = await clickEntry(live, EXPORT, `${C}.exportPptx`);
    // The deck's file name: see slide.spec.ts's KNOWN DEFECT on the name.
    expect(out.shell).toEqual([
      { door: "saveFile", arg: '{"suggestedName":"slide-deck.pptx"}' },
    ]);
    expect(out.after, "an export leaves the document alone").toBe(out.before);
  });
});
