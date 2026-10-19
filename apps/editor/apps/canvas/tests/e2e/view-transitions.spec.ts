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

// ADR 233 — the editor's view transitions: a dock tab switch from the strip
// animates the incoming and the outgoing panel in the direction of the move,
// and under prefers-reduced-motion nothing moves. The page itself (the live
// canvas) does not take part.

import { expect, test, type Page } from "@playwright/test";

import { openShell } from "./harness/shell-surface";

/** Click a dock tab and read the view-transition animations the switch
 *  started (a few frames: the transition starts once the commit is ready). */
async function switchAndCount(page: Page, id: string): Promise<string[]> {
  return page.evaluate(async (tab) => {
    const el = document.querySelector<HTMLElement>(`[data-dock-tab="${tab}"]`)!;
    el.click();
    for (let f = 0; f < 20; f++) {
      // Running animations only: React itself starts zero-length ones on
      // the root's group to keep the page out of the transition.
      const names = document
        .getAnimations()
        .filter((a) => Number(a.effect?.getComputedTiming().duration ?? 0) > 0)
        .map((a) => (a.effect as KeyframeEffect | null)?.pseudoElement ?? "")
        .filter((p) => p.startsWith("::view-transition"));
      if (names.length > 0) return names;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return [];
  }, id);
}

test.describe("view transitions (ADR 233)", () => {
  test("a dock tab switch animates the panels, not the page", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openShell(page, { doc: true });
    await expect(page.locator('[data-dock-tab="paged.layers"]')).toBeVisible();
    const names = await switchAndCount(page, "paged.layers");
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((n) => n.includes("(root)"))).toBe(false);
    await expect(
      page.locator('[data-dock-panel="paged.layers"]'),
    ).toBeVisible();
  });

  test("under reduced motion the switch does not animate", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openShell(page, { doc: true });
    await expect(page.locator('[data-dock-tab="paged.layers"]')).toBeVisible();
    expect(await switchAndCount(page, "paged.layers")).toEqual([]);
    await expect(
      page.locator('[data-dock-panel="paged.layers"]'),
    ).toBeVisible();
  });
});
