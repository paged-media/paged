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

// Late answers (the interaction specification, §18.1 and §18.3; plan task
// IC3): a hit test, a double-click's chain and the context menu record the
// coordinator's epochs when they ask, and their answer is applied only while
// those still hold — no newer press, no other document, no other context.
// The slow worker of fixture H (`__chaos`) delays or reorders the replies.
// Each test asserts the model (`modelSnapshot`), the history (the engine's
// undo log) and the selection.

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { chaosIdle, delayNthReply, delayReply } from "./harness/chaos";
import { expectUndoSteps, undoDepth } from "./harness/history";
import {
  activateTool,
  clickOn,
  clientPointOfTarget,
  dragStartOnObject,
  elementCentre,
  engineGestureOpen,
  movePointerBy,
  releasePointer,
} from "./harness/interaction";
import { modelSnapshot, selectionSnapshot } from "./harness/model-dump";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

const A = UXI_A;
const FLAGS = "?debug=chaos";

interface TraceEntry {
  event: string;
  reason?: string;
}

async function staleDiscards(page: Page, label: string): Promise<number> {
  const t = await page.evaluate(() =>
    (
      globalThis as unknown as { __interaction: { trace(): TraceEntry[] } }
    ).__interaction.trace(),
  );
  return t.filter(
    (e) => e.event === "stale" && e.reason === `stale ${label} discarded`,
  ).length;
}

async function invoke(page: Page, id: string): Promise<void> {
  await page.evaluate(
    (id) =>
      (
        globalThis as unknown as {
          __canvas: {
            registries: { commands: { invoke(id: string): unknown } };
          };
        }
      ).__canvas.registries.commands.invoke(id),
    id,
  );
}

test.describe("UXI async — a late answer never overwrites a newer state (IC3)", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "A", FLAGS);
    await activateTool(page, "paged.tool.select");
  });

  test("UXI-T57 — click A then B, A's hit answered last: B stays selected and A's answer is discarded @feat:editor-tools.select.click-marquee @level:edge", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    // The press is answered in one call (beginGestureAt, IC5); the click
    // asks for its hit on release. The pointer comes to rest over A first
    // and its hover preselection (IC6) has asked its own hit; then A's
    // click hit — the next hitTest — is held until B is done.
    const a = await clientPointOfTarget(page, A.back.id);
    await page.mouse.move(a.x, a.y);
    await expect(
      page.locator(
        `[data-hover-preselect="${A.back.id.kind}:${A.back.id.id}"]`,
      ),
    ).toHaveCount(1);
    await delayNthReply(page, "hitTest", 0, 1_500);
    await page.mouse.down();
    await page.mouse.up();
    await clickOn(page, A.free.id);
    await expect
      .poll(async () => (await selectionSnapshot(page)).elements)
      .toEqual([A.free.id]);
    await chaosIdle(page);
    expect(
      (await selectionSnapshot(page)).elements,
      "the late answer for A changes nothing",
    ).toEqual([A.free.id]);
    await expect
      .poll(() => staleDiscards(page, "hit-test"))
      .toBeGreaterThanOrEqual(1);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T58 — a drag that outruns its press's answer moves from the press point: no jump, one undo step @feat:editor-tools.move.translate @level:edge", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const before = await elementCentre(page, A.free.id);
    const scale = await page.evaluate(
      () =>
        (
          globalThis as unknown as {
            __canvas: { client: { camera: { read(): { scale: number } } } };
          }
        ).__canvas.client.camera.read().scale,
    );
    // The press is answered in one call (engine ADR 1303), held here until
    // the drag is long under way.
    await delayReply(page, "beginGestureAt", 1_200);
    await expectUndoSteps(page, 1, async () => {
      await dragStartOnObject(page, A.free.id);
      await movePointerBy(page, 30, 20, 4);
      await movePointerBy(page, 30, 20, 4);
      await releasePointer(page);
      await chaosIdle(page);
    });
    const after = await elementCentre(page, A.free.id);
    const slack = 10 / scale;
    expect(Math.abs(after.at[0] - before.at[0] - 60 / scale)).toBeLessThan(
      slack,
    );
    expect(Math.abs(after.at[1] - before.at[1] - 40 / scale)).toBeLessThan(
      slack,
    );
    expect((await selectionSnapshot(page)).elements).toEqual([A.free.id]);
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          __canvas: { client: { undo(): Promise<unknown> } };
        }
      ).__canvas.client.undo(),
    );
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("UXI-T59 — a document replaced while a click's hit test is out: the old answer selects nothing in the new one @feat:editor-tools.select.click-marquee @level:edge", async ({
    page,
  }) => {
    covers("tool:paged.tool.select", "command:paged.file.new");
    await delayReply(page, "hitTest", 1_500);
    await clickOn(page, A.free.id);
    await invoke(page, "paged.file.new");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as {
                __canvas: { handle?: { pageIds?: string[] } | null };
              }
            ).__canvas.handle?.pageIds?.[0] ?? "",
        ),
      )
      .not.toBe(A.pageId);
    const fresh = await modelSnapshot(page);
    await chaosIdle(page);
    expect((await selectionSnapshot(page)).elements).toEqual([]);
    await expect
      .poll(() => staleDiscards(page, "hit-test"))
      .toBeGreaterThanOrEqual(1);
    expect(await modelSnapshot(page), "the new document is untouched").toBe(
      fresh,
    );
    expect(await undoDepth(page)).toBe(0);
    expect(await engineGestureOpen(page)).toBe(false);
  });

  test("UXI-T59 — a double-click whose hit test is answered after a newer press enters nothing @feat:editor-tools.select.click-marquee @level:edge @uxi:UXI-ASY-002", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    // Every hit test 800 ms late: the double-click's chain is still waiting
    // when the next press begins.
    await delayReply(page, "hitTest", 800);
    const p = await clientPointOfTarget(page, A.note.id);
    await page.mouse.dblclick(p.x, p.y);
    await clickOn(page, { at: A.emptyAt });
    await chaosIdle(page);
    // No caret was placed in the note's story by the stale chain.
    const sel = await selectionSnapshot(page);
    expect(sel.text).toBeNull();
    await expect
      .poll(() => staleDiscards(page, "double-click"))
      .toBeGreaterThanOrEqual(1);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T57 — a context menu whose hit test is answered after a newer press does not select under the old point @feat:editor-tools.object-commands @level:edge @uxi:UXI-OWN-008", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await delayReply(page, "hitTest", 1_000);
    const p = await clientPointOfTarget(page, A.back.id);
    await page.mouse.click(p.x, p.y, { button: "right" });
    await page.keyboard.press("Escape");
    await clickOn(page, A.free.id);
    await chaosIdle(page);
    expect((await selectionSnapshot(page)).elements).toEqual([A.free.id]);
    await expect
      .poll(() => staleDiscards(page, "context-menu"))
      .toBeGreaterThanOrEqual(1);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });
});
