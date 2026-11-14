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

// paged.web ADR 416 on the real engine (the UX strategy's §7.6): the Web
// source panel inspects source and render together. A tag clicked in the
// outline shows its element's line, open tag, path, rendered size and the
// rules that reach it; a press on the rendered element in the frame's
// context brings the same element into focus; the publication notes say
// what a printed page cannot show; the two renderings are named; the
// sample data beside the source adds a missing value. Inspecting changes
// nothing in the document; only Save does.

import { expect, test, type Page } from "@playwright/test";

import { Designer } from "../journey/driver/designer";
import {
  insertWebFrameWith,
  screenPointInFrame,
  select,
  type ElementRef,
} from "../journey/plugins/web-kit";
import { historyDepth } from "./harness/history";
import { modelSnapshot } from "./harness/model-dump";

const HTML =
  '<div class="card">\n  <p class="lead">{{title}}</p>\n  <p>Second</p>\n</div>';
const CSS = [
  ".card p { margin: 0; font: 28px/36px Inter, sans-serif; }",
  "p.lead { color: #102030; transition: color 1s; }",
  "p:hover { color: red; }",
].join("\n");

async function openWithFrame(page: Page): Promise<ElementRef> {
  const designer = new Designer(page);
  await designer.open();
  await designer.newDocument();
  return insertWebFrameWith(page, HTML, CSS);
}

test.describe("paged.web ADR 416 — source and render inspected together", () => {
  test.describe.configure({ timeout: 180_000 });

  test("a tag in the outline: its line, open tag, path, size and rules; publication notes; the renderings named; no document change @feat:plugin-web.source-panel @level:edge", async ({
    page,
  }) => {
    await openWithFrame(page);
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);

    const inspect = page.locator("[data-web-inspect]");
    await expect(inspect).toHaveAttribute("data-web-inspect", "empty");
    const outline = page.locator("[data-web-outline]");
    const summary = outline.locator("summary").first();
    if (await summary.isVisible()) await summary.click();
    await outline.locator('[data-web-outline-tag="p"]').first().click();
    await expect(inspect).toHaveAttribute("data-web-inspect", "element");
    await expect(inspect.locator("[data-web-inspect-tag]")).toHaveText(
      '<p class="lead">',
    );
    await expect(inspect.locator("[data-web-inspect-selector]")).toHaveText(
      "div.card > p.lead",
    );
    // The size comes from the inspected render (the engine wasm).
    await expect(inspect.locator("[data-web-inspect-size]")).toHaveText(
      /× .* pt|Paints no box/,
    );
    await expect(
      inspect.locator('[data-web-inspect-rule="matched"]'),
    ).toHaveCount(2);
    await expect(
      inspect.locator('[data-web-inspect-rule="unevaluated"]'),
    ).toHaveCount(1);

    // What a printed page cannot show.
    const notes = page.locator("[data-web-publication-notes]");
    await expect(
      notes.locator('[data-web-print-note="transition"]'),
    ).toHaveCount(1);
    await expect(
      notes.locator('[data-web-print-note="interaction"]'),
    ).toHaveCount(1);
    // The two renderings, named.
    await expect(page.locator('[data-web-preview-kind="browser"]')).toHaveText(
      "Browser preview (sandboxed)",
    );

    // Inspecting is a read.
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);
  });

  test("a press on the rendered element in the frame's context brings it into focus @feat:plugin-web.in-frame-edit @level:edge", async ({
    page,
  }) => {
    const frame = await openWithFrame(page);
    await select(page, [frame]);
    const centre = await screenPointInFrame(page, frame, 120, 60);
    await page.mouse.dblclick(centre.x, centre.y);
    await expect(page.locator("[data-edit-context-breadcrumb]")).toBeVisible({
      timeout: 10_000,
    });
    // The second paragraph (the first line is the placeholder, unrendered
    // as text until it has a value): aim at its line.
    let at = await screenPointInFrame(page, frame, 30, 52);
    await expect
      .poll(async () => {
        const next = await screenPointInFrame(page, frame, 30, 52);
        const still =
          Math.abs(next.x - at.x) < 0.5 && Math.abs(next.y - at.y) < 0.5;
        at = next;
        return still;
      })
      .toBe(true);
    await page.mouse.click(at.x, at.y);
    const inspect = page.locator("[data-web-inspect]");
    await expect(inspect).toHaveAttribute("data-web-inspect", "element", {
      timeout: 10_000,
    });
    await expect(inspect.locator("[data-web-inspect-tag]")).toHaveText(/^<p/);
    await page.keyboard.press("Escape");
  });

  test("the sample data beside the source: a placeholder without a value, added with one click, changes only the draft @feat:plugin-web.source-panel @level:edge", async ({
    page,
  }) => {
    await openWithFrame(page);
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);
    const sample = page.locator("[data-web-sample-data]");
    await expect(
      sample.locator('[data-web-sample-missing="title"]'),
    ).toHaveText("{{title}} has no value");
    const rows = await page.locator("[data-web-var-row]").count();
    await sample.locator('[data-web-sample-add="title"]').click();
    await expect(page.locator("[data-web-var-row]")).toHaveCount(rows + 1);
    await expect(sample.locator("[data-web-sample-missing]")).toHaveCount(0);
    await expect(page.locator('[data-web-dirty="true"]')).toBeVisible();
    // The draft changed; the document did not.
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);
  });
});
