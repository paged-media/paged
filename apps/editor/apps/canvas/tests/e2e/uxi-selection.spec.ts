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

// The selection model of editor ADR 1201 (D-01, D-08, D-15; ADR 235 as
// amended; plan task IC6): Shift-click toggles, the marquee is directional
// (left to right contains, right to left intersects) and looks it, a click
// and a marquee pick group members by one rule, hovering shows what a click
// would take, the objects under the pointer can be picked and cycled, the
// context menu promotes to the group as a click does, and a locked item
// says so. A selection change is never an undo step (D-15): every test
// asserts the model (`modelSnapshot`) and the history (the undo log).

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { selectElements } from "./harness/gesture-kit";
import { expectHistoryUnchanged, undoDepth } from "./harness/history";
import {
  activateTool,
  clickOn,
  clientPointOf,
  clientPointOfTarget,
  dragStartOnObject,
  movePointerBy,
  releasePointer,
} from "./harness/interaction";
import { modelSnapshot, selectionSnapshot } from "./harness/model-dump";
import { openUxiFixture, UXI_A, UXI_B } from "./harness/uxi-fixtures";

const A = UXI_A;
const B = UXI_B;

const sorted = (ids: Array<{ kind: string; id: string }>) =>
  ids.map((i) => `${i.kind}:${i.id}`).sort();

async function selected(page: Page): Promise<string[]> {
  return sorted((await selectionSnapshot(page)).elements);
}

/** A marquee from one page point to another, in steps, checking the
 *  overlay's mode mid-drag. */
async function marquee(
  page: Page,
  from: readonly [number, number],
  to: readonly [number, number],
  mode: "contain" | "intersect",
): Promise<void> {
  const a = await clientPointOf(page, { at: from });
  const b = await clientPointOf(page, { at: to });
  await dragStartOnObject(page, { at: from });
  await movePointerBy(page, b.x - a.x, b.y - a.y, 10);
  await expect(
    page.locator(
      `[data-gesture-preview="marquee"][data-marquee-mode="${mode}"]`,
    ),
  ).toHaveCount(1);
  await releasePointer(page);
}

test.describe("UXI selection — the selection model of ADR 1201 (IC6)", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
  });

  test("UXI-T03 — a marquee drawn left to right takes what it wholly contains; right to left, what it touches; nothing moves @feat:editor-tools.select.click-marquee @level:happy", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, () =>
      marquee(page, [60, 90], [262, 230], "contain"),
    );
    await expect.poll(() => selected(page)).toEqual(sorted([A.back.id]));
    // Right to left (from empty canvas) the marquee touches both.
    await clickOn(page, { at: A.emptyAt });
    await expect.poll(() => selected(page)).toEqual([]);
    await expectHistoryUnchanged(page, () =>
      marquee(page, [400, 240], [200, 90], "intersect"),
    );
    await expect
      .poll(() => selected(page))
      .toEqual(sorted([A.back.id, A.front.id]));
    expect(await modelSnapshot(page), "a marquee moves nothing").toBe(model);
  });

  test("UXI-T03 — a marquee may start on the pasteboard @feat:editor-tools.select.click-marquee @level:edge @uxi:UXI-HIT-004", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    // From above-left of the page, over the pasteboard, around the free
    // rectangle: left to right, so it takes what it contains.
    await expectHistoryUnchanged(page, () =>
      marquee(page, [400, -40], [560, 200], "contain"),
    );
    await expect.poll(() => selected(page)).toEqual(sorted([A.free.id]));
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("UXI-T04 — Shift-click toggles membership: three items in, one out, no duplicate ids @feat:editor-tools.select.click-marquee @level:happy", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await clickOn(page, A.back.id);
    await clickOn(page, A.free.id, { modifiers: ["Shift"] });
    await clickOn(page, A.locked.id, { modifiers: ["Shift"] });
    await expect
      .poll(() => selected(page))
      .toEqual(sorted([A.back.id, A.free.id, A.locked.id]));
    // Shift-click on a selected item takes it out.
    await clickOn(page, A.free.id, { modifiers: ["Shift"] });
    await expect
      .poll(() => selected(page))
      .toEqual(sorted([A.back.id, A.locked.id]));
    // And back in, once.
    await clickOn(page, A.free.id, { modifiers: ["Shift"] });
    await expect.poll(async () => (await selected(page)).length).toBe(3);
    const ids = await selected(page);
    expect(new Set(ids).size, "no duplicate ids").toBe(ids.length);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page), "selection is not an undo step").toBe(depth);
  });

  test("UXI-T13 — a locked item is selectable, says it is locked by shape, and does not move @feat:editor-tools.move.translate @level:edge @uxi:UXI-OVR-008", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, async () => {
      await dragStartOnObject(page, A.locked.id);
      await movePointerBy(page, 40, 30);
      await releasePointer(page);
    });
    await expect.poll(() => selected(page)).toEqual(sorted([A.locked.id]));
    await expect(
      page.locator(
        `[data-selection-locked="${A.locked.id.kind}:${A.locked.id.id}"]`,
      ),
    ).toHaveCount(1);
    await expect(page.locator("[data-lock-glyph]")).toHaveCount(1);
    await expect(page.locator("[data-handles-locked]")).toHaveCount(1);
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("hovering shows what a click would select, lighter than the selection, and selects nothing @feat:editor-tools.select.click-marquee @level:happy @uxi:UXI-OVR-006", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    const p = await clientPointOfTarget(page, A.free.id);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await expect(
      page.locator(
        `[data-hover-preselect="${A.free.id.kind}:${A.free.id.id}"]`,
      ),
    ).toHaveCount(1);
    expect(await selected(page)).toEqual([]);
    // Over the locked one, its label says so.
    const q = await clientPointOfTarget(page, A.locked.id);
    await page.mouse.move(q.x, q.y, { steps: 4 });
    await expect(page.locator("[data-hover-locked]")).toHaveCount(1);
    // A selected item is not outlined again.
    await selectElements(page, [A.locked.id]);
    await page.mouse.move(q.x + 2, q.y + 2);
    await expect(page.locator("[data-hover-preselect]")).toHaveCount(0);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("the objects under the pointer can be picked from the context menu and cycled @feat:editor-tools.select.click-marquee @level:edge @uxi:UXI-HIT-006", async ({
    page,
  }) => {
    covers("tool:paged.tool.select", "command:paged.edit.selectBelow");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    // The overlap: the front rectangle over the back one. A click takes the
    // topmost.
    await clickOn(page, { at: A.overlapAt });
    await expect.poll(() => selected(page)).toEqual(sorted([A.front.id]));
    // The cycle command takes the next one down at the pointer, and wraps.
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          __canvas: {
            registries: { commands: { invoke(id: string): unknown } };
          };
        }
      ).__canvas.registries.commands.invoke("paged.edit.selectBelow"),
    );
    await expect.poll(() => selected(page)).toEqual(sorted([A.back.id]));
    // The picker: right-click, Select ▸ the front rectangle.
    const p = await clientPointOf(page, { at: A.overlapAt });
    await page.mouse.click(p.x, p.y, { button: "right" });
    const menu = page.getByTestId("canvas-context-menu");
    await expect(menu).toBeVisible();
    await menu.locator("[data-object-picker]").click();
    const pick = page.locator(
      `[data-object-pick="${A.front.id.kind}:${A.front.id.id}"]`,
    );
    await expect(pick).toBeVisible();
    await pick.click();
    await expect.poll(() => selected(page)).toEqual(sorted([A.front.id]));
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T29 — Shift+F10 opens the context menu at the selection and it works without the pointer @feat:editor-tools.object-commands @level:happy", async ({
    page,
  }) => {
    covers("keybinding:shift+f10→paged.edit.contextMenu");
    await clickOn(page, A.free.id);
    await expect.poll(() => selected(page)).toEqual(sorted([A.free.id]));
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await page.keyboard.press("Shift+F10");
    const menu = page.getByTestId("canvas-context-menu");
    await expect(menu).toBeVisible();
    // Near the selection: the menu's corner is within the item's box.
    const box = (await menu.boundingBox())!;
    const c = await clientPointOfTarget(page, A.free.id);
    expect(Math.hypot(box.x - c.x, box.y - c.y)).toBeLessThan(120);
    // Keyboard only: Duplicate, from the menu.
    await page.keyboard.press("ArrowDown");
    await menu.locator('[data-command="paged.edit.duplicate"]').focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => undoDepth(page)).toBe(depth + 1);
    expect(await modelSnapshot(page)).not.toBe(model);
  });
});

test.describe("UXI selection — groups: a click and a marquee pick by one rule (IC6)", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "B");
    await activateTool(page, "paged.tool.select");
  });

  test("UXI-T03 — at the top level a marquee takes the group, as a click does; inside it, its members @feat:editor-tools.select.group-descent @level:happy @uxi:UXI-SEL-011", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    await clickOn(page, B.path.id);
    await expect.poll(() => selected(page)).toEqual(sorted([B.group]));
    await clickOn(page, { at: B.emptyAt });
    // A right-to-left marquee over the path alone takes the group too.
    // (It starts clear of the selection's corner: a press near it resizes
    // or rotates.)
    await marquee(page, [280, 300], [90, 90], "intersect");
    await expect.poll(() => selected(page)).toEqual(sorted([B.group]));
    // Inside the group (a double-click enters it), the same marquee takes
    // the member.
    const p = await clientPointOfTarget(page, B.path.id);
    await page.mouse.dblclick(p.x, p.y);
    await expect
      .poll(async () => (await selectionSnapshot(page)).activeGroup)
      .toBe(B.group.id);
    await marquee(page, [280, 300], [90, 90], "intersect");
    await expect.poll(() => selected(page)).toEqual(sorted([B.path.id]));
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("UXI-T29 — the context menu on a grouped item selects the group, as a click does @feat:editor-tools.select.group-descent @level:edge @uxi:UXI-SEL-011", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const p = await clientPointOfTarget(page, B.path.id);
    await page.mouse.click(p.x, p.y, { button: "right" });
    await expect(page.getByTestId("canvas-context-menu")).toBeVisible();
    await expect.poll(() => selected(page)).toEqual(sorted([B.group]));
    await page.keyboard.press("Escape");
    expect(await modelSnapshot(page)).toBe(model);
  });
});
