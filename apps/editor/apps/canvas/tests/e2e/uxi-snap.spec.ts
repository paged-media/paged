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

// Snapping says what it snaps to (the interaction specification's §10,
// `UXI-SNP-001`, `UXI-SNP-002`, `UXI-SNP-005`; plan task IC8, editor ADR
// 1226): a move that brings an item's centre
// near the page's centre snaps it there, the line names its target, the
// target holds until the pointer is past the release tolerance
// (hysteresis, engine ADR 125 amendment 2), the commit lands exactly on
// it, and the one bypass key (the platform's primary modifier) turns
// snapping off for as long as it is held. Each test asserts the model
// (`modelSnapshot`) and the history (the engine's undo log).

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { expectUndoSteps, undoDepth } from "./harness/history";
import {
  activateTool,
  clientPointOf,
  dragStartOnObject,
  elementCentre,
  releasePointer,
} from "./harness/interaction";
import { modelSnapshot } from "./harness/model-dump";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

const A = UXI_A;
/** US Letter: the page's centre line, pt. */
const PAGE_CENTRE_Y = 396;

/** Screen px per pt at the live camera. */
async function pxPerPt(page: Page): Promise<number> {
  const a = await clientPointOf(page, { at: [0, 0] });
  const b = await clientPointOf(page, { at: [0, 100] });
  return (b.y - a.y) / 100;
}

/** Move the held pointer so the dragged item's centre would sit at
 *  `centreY` unsnapped (the pointer moves with the item). */
async function moveCentreTo(
  page: Page,
  startPointerY: number,
  startCentreY: number,
  centreY: number,
  x: number,
): Promise<void> {
  const s = await pxPerPt(page);
  await page.mouse.move(x, startPointerY + (centreY - startCentreY) * s, {
    steps: 6,
  });
}

const pageCentreLine = (page: Page) =>
  page.locator('[data-snap-target="pageCenter"]');

/** A snap line to the page's centre is drawn (one or more segments). */
async function expectPageCentreLine(page: Page): Promise<void> {
  await expect.poll(() => pageCentreLine(page).count()).toBeGreaterThan(0);
}

async function centreY(page: Page): Promise<number> {
  return (await elementCentre(page, A.free.id)).at[1];
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(() =>
    (
      globalThis as unknown as {
        __canvas: { client: { undo(): Promise<unknown> } };
      }
    ).__canvas.client.undo(),
  );
}

test.describe("UXI snapping — what a snap snaps to (IC8)", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
  });

  test("UXI-T12 — a move snaps the centre to the page centre, says so, holds it within the release reach and commits exactly; the bypass key does not snap @feat:editor-tools.move.translate @level:edge @uxi:UXI-SNP-002 @uxi:UXI-SNP-005", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    const from = await centreY(page);
    const start = await clientPointOf(page, { at: A.free.at });
    const s = await pxPerPt(page);
    const at = { at: A.free.at };

    await expectUndoSteps(page, 1, async () => {
      await dragStartOnObject(page, at);
      // 2 pt short of the page centre: within the acquire reach (4 px).
      await moveCentreTo(page, start.y, from, PAGE_CENTRE_Y - 2, start.x);
      await expectPageCentreLine(page);
      await expect(pageCentreLine(page).first()).toContainText("page centre");
      // 5 px away: past the acquire reach, inside the release reach
      // (6 px): the target holds.
      await moveCentreTo(page, start.y, from, PAGE_CENTRE_Y - 5 / s, start.x);
      await expectPageCentreLine(page);
      // Back near it, and let go: the centre is exactly on it.
      await moveCentreTo(page, start.y, from, PAGE_CENTRE_Y - 2, start.x);
      await expectPageCentreLine(page);
      await releasePointer(page);
    });
    expect(await centreY(page)).toBe(PAGE_CENTRE_Y);
    await expect(pageCentreLine(page)).toHaveCount(0);
    await undo(page);
    expect(await modelSnapshot(page), "one undo puts it back").toBe(model);
    expect(await undoDepth(page)).toBe(depth);

    // Past the release reach the target lets go.
    await dragStartOnObject(page, at);
    await moveCentreTo(page, start.y, from, PAGE_CENTRE_Y - 2, start.x);
    await expectPageCentreLine(page);
    await moveCentreTo(page, start.y, from, PAGE_CENTRE_Y - 12 / s, start.x);
    await expect(pageCentreLine(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await releasePointer(page);
    expect(await modelSnapshot(page), "Escape cancelled the move").toBe(model);

    // The bypass: the platform's primary modifier, held, does not snap.
    await expectUndoSteps(page, 1, async () => {
      await dragStartOnObject(page, at);
      await moveCentreTo(page, start.y, from, PAGE_CENTRE_Y - 30, start.x);
      await page.keyboard.down("ControlOrMeta");
      await moveCentreTo(page, start.y, from, PAGE_CENTRE_Y - 2, start.x);
      await expect(pageCentreLine(page)).toHaveCount(0);
      await releasePointer(page);
      await page.keyboard.up("ControlOrMeta");
    });
    expect(Math.abs((await centreY(page)) - (PAGE_CENTRE_Y - 2))).toBeLessThan(
      1,
    );
    await undo(page);
    expect(await modelSnapshot(page)).toBe(model);
  });
});
