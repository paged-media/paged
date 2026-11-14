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

// Page lenses and semantic zoom (editor ADR "Page lenses and semantic
// zoom"; the redesign strategy's §4.3 and §4.4; the interaction contract's
// UXI-CAM-016 and UXI-CAM-017; UX audit F-57): the document map finds a
// place through five lenses and one search, a click navigates with a way
// back and selects without touching the document; zoomed far out the
// handles give way while the selection, page names and markers stay, and
// zoomed far in the rulers gain their minor ticks — never another tool,
// never another selection. Each asserts the selection, the camera and the
// history, not a screenshot.

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { selectElements } from "./harness/gesture-kit";
import { expectHistoryUnchanged } from "./harness/history";
import { modelSnapshot, selectionSnapshot } from "./harness/model-dump";
import { openUxiFixture, UXI_A, UXI_D } from "./harness/uxi-fixtures";

const A = UXI_A;

interface CanvasGlobal {
  __canvas: {
    client: {
      camera: { read: () => { scale: number; tx: number; ty: number } };
      mutate: (m: unknown) => Promise<unknown>;
    };
    activeTool?: string;
  };
}

const lens = (page: Page, id: string) =>
  page.locator(`[data-page-lens="${id}"]`);
const row = (page: Page, id: string) => page.locator(`[data-lens-row="${id}"]`);
const camera = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as CanvasGlobal).__canvas.client.camera.read(),
  );

async function zoomTo(page: Page, percent: string) {
  const field = page.locator("[data-zoom-field]");
  await field.fill(percent);
  await field.press("Enter");
}

test.describe("page lenses", () => {
  test("Layers, Structure and Issues find an object, navigate with a way back and select it; the search narrows every lens @feat:editor-shell.panels.pages-navigator @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.document-map");
    await openUxiFixture(page, "A");
    // An overset story: the note's story runs past its frame.
    await page.evaluate(async (storyId) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas;
      await c.client.mutate({
        op: "insertText",
        args: {
          storyId,
          offset: 0,
          text: "Overset text runs on. ".repeat(400),
        },
      });
    }, A.note.storyId);
    const model = await modelSnapshot(page);
    const back = page.locator('[data-navigation="paged.view.navigateBack"]');

    await expect(lens(page, "pages")).toHaveAttribute("aria-selected", "true");
    await expect(lens(page, "data")).toHaveCount(0);

    await expectHistoryUnchanged(page, async () => {
      // Layers: every page item under its layer; the search narrows.
      await lens(page, "layers").click();
      await expect(row(page, `object:rectangle:${A.free.id.id}`)).toBeVisible();
      await page.locator("[data-document-map-search]").fill(A.free.id.id);
      await expect(row(page, `object:rectangle:${A.back.id.id}`)).toHaveCount(
        0,
      );
      await zoomTo(page, "300");
      const before = await camera(page);
      await row(page, `object:rectangle:${A.free.id.id}`).click();
      await expect
        .poll(async () => (await selectionSnapshot(page)).elements)
        .toEqual([A.free.id]);
      await expect(back).toBeEnabled();
      await back.click();
      await expect.poll(() => camera(page)).toEqual(before);
      expect((await selectionSnapshot(page)).elements).toEqual([A.free.id]);
      await page.locator("[data-document-map-search]").fill("");

      // Structure: the story, by its frame.
      await lens(page, "structure").click();
      await row(page, `story:${A.note.storyId}`).click();
      await expect
        .poll(async () => (await selectionSnapshot(page)).elements)
        .toEqual([A.note.id]);

      // Issues: page 1 has the overset story; a click selects its frame.
      await selectElements(page, []);
      await lens(page, "issues").click();
      const issue = row(page, "page:0");
      await expect(issue).toContainText("1 overset story");
      await issue.click();
      await expect
        .poll(async () => (await selectionSnapshot(page)).elements)
        .toEqual([A.note.id]);
    });
    expect(await modelSnapshot(page)).toBe(model);
  });
});

test.describe("semantic zoom", () => {
  test("zoomed far out the handles give way and page names stay off the pages; zoomed far in the rulers gain minor ticks; the selection and the tool never change @feat:editor-tools.overlays @level:edge", async ({
    page,
  }) => {
    covers("panel:paged.document-map");
    await openUxiFixture(page, "D");
    const D = UXI_D;
    await selectElements(page, [D.rotated(1)]);
    const selected = await selectionSnapshot(page);
    const tool = await page.evaluate(
      () => (globalThis as unknown as CanvasGlobal).__canvas.activeTool,
    );
    const handles = page.locator("[data-selection-handle]");
    await expect(handles.first()).toBeVisible();
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, async () => {
      await zoomTo(page, "8");
      await expect(handles).toHaveCount(0);
      // The selection's outline stays.
      await expect(
        page.locator("[data-selection-outline]").first(),
      ).toBeAttached();
      // Page names are drawn beside the pages, never over the next one.
      const caption = page.locator('[data-page-caption="1"]');
      await expect(caption).toHaveAttribute("data-caption-place", "side");
      await zoomTo(page, "100");
      await expect(handles.first()).toBeVisible();
      await expect(page.locator('[data-page-caption="1"]')).toHaveAttribute(
        "data-caption-place",
        "below",
      );
      await expect(page.locator("[data-ruler-minor]")).toHaveCount(0);
      await zoomTo(page, "800");
      await expect(page.locator("[data-ruler-minor]").first()).toBeAttached();
    });
    expect(await selectionSnapshot(page)).toEqual(selected);
    expect(
      await page.evaluate(
        () => (globalThis as unknown as CanvasGlobal).__canvas.activeTool,
      ),
    ).toBe(tool);
    expect(await modelSnapshot(page)).toBe(model);
  });
});
