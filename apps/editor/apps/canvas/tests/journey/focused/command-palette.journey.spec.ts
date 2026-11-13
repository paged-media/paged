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

// Journey: the command palette (UXI-T23).
//
// Cmd/Ctrl+K is the keyboard-driven command surface a power user reaches
// for. The journey proves the binding opens the palette, Escape dismisses
// it, and focus goes back where it was (the canvas the user worked in) —
// on the bundled-Chromium lane in CI and on real Chrome with a GPU
// (`journeys-gpu`, local evidence: issue #32 failed only there). Escape is
// the palette's handler of the editor's Escape arbiter (ADR 1203), so it
// no longer depends on which dismissable layer Radix holds on top.

import { expect, test } from "@playwright/test";

import { Designer } from "../driver/designer";

test.describe("journey · command palette", () => {
  test("UXI-T23 — Cmd+K opens the command palette; Escape dismisses it and focus returns to the canvas @feat:editor-shell.command-palette @level:gesture", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    const palette = page.locator("[data-palette-footer]");
    const canvas = page.locator('[data-canvas-surface="viewport"]');
    await expect(palette).toBeHidden();

    // Work in the canvas first: focus is there when the palette opens.
    await canvas.focus();
    await expect(canvas).toBeFocused();

    // The registry binds BOTH Cmd+K and Ctrl+K (PALETTE_TOGGLE_KEYBINDING
    // + _CTRL); press the platform one.
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+k" : "Control+k",
    );
    await expect(palette).toBeVisible();
    await expect(page.locator("[cmdk-input]")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(canvas).toBeFocused();
  });
});
