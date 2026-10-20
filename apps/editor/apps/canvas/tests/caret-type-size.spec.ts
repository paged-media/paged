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

// The type size at the caret is the size the text is set at (engine ADR
// 206). Text whose size comes from its paragraph style alone, through a
// based-on chain or directly, showed the 12 pt default in the control bar
// and the Character panel. The fixture is built in the test, so it needs
// no corpus.

import { test, expect, type Page } from "@playwright/test";

import { openCanvas, openPanel } from "./fidelity/canvas-driver";
import {
  buildStyledTypeIdml,
  STYLED_TYPE_FIXTURE as FX,
} from "./e2e/harness/build-min-idml";
import { fieldOf } from "./e2e/harness/objects";

async function setSelection(page: Page, start: number, end: number) {
  await page.evaluate(
    ({ storyId, start, end }) => {
      const c = (
        globalThis as unknown as {
          __canvas: { setContentSelection(s: unknown): void };
        }
      ).__canvas;
      c.setContentSelection({ storyId, start, end });
    },
    { storyId: FX.storyId, start, end },
  );
}

const sizeShown = (page: Page) =>
  page.locator('[data-control-field="font-size"] input');

test.describe("Type size at the caret", () => {
  test.beforeEach(async ({ page }) => {
    await openCanvas(page);
    // Through the shell's own file input, so the shell knows a document
    // is open and the control bar follows the text selection.
    await page.setInputFiles('input[type="file"]', {
      name: "styled-type.idml",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(buildStyledTypeIdml()),
    });
    await expect(page.locator("[data-document-chip]")).toContainText(
      "styled-type",
      { timeout: 30_000 },
    );
  });

  test("the control bar shows the size the paragraph style sets @feat:editor-shell.context-toolbars @level:happy", async ({
    page,
  }) => {
    const bar = page.locator("[data-control-bar]");
    // A caret in the heading: 30 pt through Head → Base.
    await setSelection(page, 3, 3);
    await expect(bar).toHaveAttribute("data-control-bar", "text");
    await expect(sizeShown(page)).toHaveValue(String(FX.heading.size));
    // A caret in the body: the Body style's 8.5 pt.
    await setSelection(page, FX.body.start + 2, FX.body.start + 2);
    await expect(sizeShown(page)).toHaveValue(String(FX.body.size));
    // The whole body paragraph as a range reads the same.
    await setSelection(page, FX.body.start, FX.body.end);
    await expect(sizeShown(page)).toHaveValue(String(FX.body.size));
    // Across both paragraphs the sizes differ: mixed, not a default.
    await setSelection(page, 2, FX.body.start + 3);
    await expect(sizeShown(page)).toHaveValue("—");
  });

  test("the Character panel shows the size the paragraph style sets @feat:editor-shell.panels.character @level:happy", async ({
    page,
  }) => {
    await setSelection(page, FX.heading.start, FX.heading.end);
    await openPanel(page, "paged.character");
    const field = fieldOf(
      page.locator('[data-character-panel="ready"]'),
      "characterFontSize",
    );
    await expect(field.locator("input").first()).toHaveValue(
      new RegExp(`^${FX.heading.size}(\\.0+)?( ?pt)?$`),
    );
  });
});
