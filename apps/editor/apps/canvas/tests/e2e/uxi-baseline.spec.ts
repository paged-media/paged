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

// The interaction contract's acceptance scenarios (spec §23.1) that today's
// editor already meets — the baseline the interaction tracks build on. Each
// asserts the document (`modelSnapshot`) and the history (the engine's undo
// log), never a screenshot. Scenarios the owner decided to change (Shift
// toggles, a directional marquee, conventional Tab, image double-click,
// one Escape resolution per press) are not here: they are acknowledged in
// scripts/uxi-acknowledged.json with the task that changes them.

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { openPanel } from "../fidelity/canvas-driver";
import { elementPageRectPt } from "./harness/fixtures";
import { idsOfKind, selectElements } from "./harness/gesture-kit";
import {
  expectHistoryUnchanged,
  expectUndoSteps,
  undoDepth,
} from "./harness/history";
import {
  activateTool,
  assertCanBeginNewDrag,
  clickOn,
  clientPointOf,
  dragBy,
  dragStartOnObject,
  engineGestureOpen,
  expectNoGesturePreview,
  movePointerBy,
  releasePointer,
} from "./harness/interaction";
import {
  dumpStory,
  modelSnapshot,
  selectionSnapshot,
} from "./harness/model-dump";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

const A = UXI_A;

interface CanvasGlobal {
  __canvas: {
    client: {
      undo(): Promise<unknown>;
      camera: {
        read(): { scale: number; tx: number; ty: number; rotation?: number };
      };
    };
  };
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as CanvasGlobal).__canvas.client.undo(),
  );
}

async function cameraScale(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (globalThis as unknown as CanvasGlobal).__canvas.client.camera.read()
        .scale,
  );
}

/** The top-left corner of an element's page footprint, pt. */
async function corner(page: Page, ref: { kind: string; id: string }) {
  const r = (await elementPageRectPt(page, ref))!;
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
}

/** The value a numeric inspector field shows. */
async function shown(page: Page, selector: string): Promise<number | null> {
  const raw = await page.locator(selector).inputValue();
  const n = Number.parseFloat(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const TRANSFORM = '[data-object-transform-panel="ready"]';

test.describe("UXI baseline — A. pointer, selection, gesture and history", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
  });

  test("UXI-T01 — a click on an unselected rectangle selects only it; the transform inspector and the Layers tree agree @feat:editor-tools.select.click-marquee @level:happy", async ({
    page,
  }) => {
    covers(
      "tool:paged.tool.select",
      "panel:paged.object-transform",
      "panel:paged.layers",
    );
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, () => clickOn(page, { at: A.back.at }));
    await expect
      .poll(async () => (await selectionSnapshot(page)).elements)
      .toEqual([A.back.id]);

    // The inspector reads the selected rectangle: its page footprint.
    await openPanel(page, "paged.object-transform");
    const [t, l, b, r] = A.back.box;
    await expect
      .poll(async () => [
        await shown(page, `${TRANSFORM} input[aria-label="x"]`),
        await shown(page, `${TRANSFORM} input[aria-label="y"]`),
        await shown(page, `${TRANSFORM} input[aria-label="width"]`),
        await shown(page, `${TRANSFORM} input[aria-label="height"]`),
      ])
      .toEqual([l, t, r - l, b - t]);

    // The Layers tree (the accessible tree of the page's objects) marks
    // that one item selected, and no other.
    await openPanel(page, "paged.layers");
    const tree = page.locator(
      '[data-panel-host="paged.layers"] [data-layer-objects="ready"]',
    );
    await expect(tree).toBeVisible();
    const selected = tree.locator('[role="treeitem"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute(
      "data-object-row",
      `${A.back.id.kind}:${A.back.id.id}`,
    );
    expect(await modelSnapshot(page), "a click changes no document state").toBe(
      model,
    );
  });

  test("UXI-T02 — dragging an unselected rectangle moves it in the same gesture: no marquee, one undo step @feat:editor-tools.move.translate @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    expect((await selectionSnapshot(page)).elements).toEqual([]);
    const model = await modelSnapshot(page);
    const before = await corner(page, A.free.id);
    const scale = await cameraScale(page);
    await expectUndoSteps(page, 1, async () => {
      await dragStartOnObject(page, A.free.id);
      await movePointerBy(page, 60, 40);
      await expect(
        page.locator('[data-gesture-preview="marquee"]'),
      ).toHaveCount(0);
      await releasePointer(page);
    });
    const after = await corner(page, A.free.id);
    // The press-and-drag moved it with the pointer (a snap may pull the
    // drop a few screen px).
    const slack = 10 / scale;
    expect(Math.abs(after.x - before.x - 60 / scale)).toBeLessThan(slack);
    expect(Math.abs(after.y - before.y - 40 / scale)).toBeLessThan(slack);
    expect(after.w).toBeCloseTo(before.w, 3);
    expect(after.h).toBeCloseTo(before.h, 3);
    expect((await selectionSnapshot(page)).elements).toEqual([A.free.id]);
    // One undo restores the document exactly.
    await undo(page);
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("UXI-T05 — dragging one of three selected objects moves all three by the same offset, one undo step @feat:editor-tools.move.translate @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const three = [A.back.id, A.front.id, A.free.id];
    await selectElements(page, three);
    const model = await modelSnapshot(page);
    const before = await Promise.all(three.map((id) => corner(page, id)));
    await expectUndoSteps(page, 1, () =>
      dragBy(page, { at: A.back.at }, 50, 30),
    );
    const after = await Promise.all(three.map((id) => corner(page, id)));
    const dx = after[0].x - before[0].x;
    const dy = after[0].y - before[0].y;
    expect(Math.hypot(dx, dy), "the selection moved").toBeGreaterThan(1);
    after.forEach((a, i) => {
      expect(a.x - before[i].x, `${three[i].id} dx`).toBeCloseTo(dx, 2);
      expect(a.y - before[i].y, `${three[i].id} dy`).toBeCloseTo(dy, 2);
      expect(a.w, `${three[i].id} width`).toBeCloseTo(before[i].w, 3);
      expect(a.h, `${three[i].id} height`).toBeCloseTo(before[i].h, 3);
    });
    await undo(page);
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("UXI-T07 — Escape mid-move leaves the geometry and the history as they were, clears the overlays, and the next drag works @feat:editor-tools.gesture-lifecycle @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await dragStartOnObject(page, A.free.id);
    await movePointerBy(page, 80, 20);
    await expect.poll(() => engineGestureOpen(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
    await expectNoGesturePreview(page);
    // Letting go after the Escape commits nothing either.
    await releasePointer(page);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
    await assertCanBeginNewDrag(page, A.free.id);
  });

  test("UXI-T08 — a pointercancel mid-move rolls back, ends the gesture, and the next drag works @feat:editor-tools.gesture-lifecycle @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await dragStartOnObject(page, A.free.id);
    await movePointerBy(page, 70, 30);
    await expect.poll(() => engineGestureOpen(page)).toBe(true);
    // What a capture loss delivers to the canvas host.
    await page.evaluate(() =>
      document
        .querySelector('[data-testid="viewport-canvas-host"]')!
        .dispatchEvent(
          new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }),
        ),
    );
    await expect.poll(() => engineGestureOpen(page)).toBe(false);
    await expect.poll(() => modelSnapshot(page)).toBe(model);
    await releasePointer(page);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
    await assertCanBeginNewDrag(page, A.free.id);
  });

  test("UXI-T09 — a window blur mid-resize leaves no open session and no partial edit @feat:editor-tools.resize.handles @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await selectElements(page, [A.free.id]);
    const handle = page
      .locator('[data-selection-handle="southEast"] [data-handle="southEast"]')
      .last();
    await expect(handle).toHaveCount(1);
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 45, { steps: 8 });
    await expect.poll(() => engineGestureOpen(page)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect.poll(() => engineGestureOpen(page)).toBe(false);
    await expect.poll(() => modelSnapshot(page)).toBe(model);
    await page.mouse.up();
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
    await assertCanBeginNewDrag(page, A.free.id);
  });

  test("UXI-T13 — dragging a locked item changes nothing and adds no history; the inspector shows it locked @feat:editor-tools.move.translate @level:edge", async ({
    page,
  }) => {
    covers("tool:paged.tool.select", "panel:paged.attributes");
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, () => dragBy(page, A.locked.id, 60, 40));
    expect(await modelSnapshot(page)).toBe(model);
    // The press selects it (locked items are selectable), and the
    // inspector says why it stayed: its Locked switch is on.
    await expect
      .poll(async () => (await selectionSnapshot(page)).elements)
      .toEqual([A.locked.id]);
    await openPanel(page, "paged.attributes");
    await expect(
      page
        .locator('[data-panel-host="paged.attributes"]')
        .getByRole("switch", { name: "Locked" }),
    ).toHaveAttribute("aria-checked", "true");
    // Selected or not.
    await selectElements(page, [A.locked.id]);
    await expectHistoryUnchanged(page, () => dragBy(page, A.locked.id, 60, 40));
    expect(await modelSnapshot(page)).toBe(model);
    expect(await engineGestureOpen(page)).toBe(false);
  });

  test("UXI-T15 — the same corner handle answers the same CSS-px hit box at 25 %, 100 % and 800 % @feat:editor-tools.resize.handles @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    for (const zoom of [0.25, 1, 8]) {
      await setZoom(page, zoom);
      await selectElements(page, [A.free.id]);
      const [, , b, r] = A.free.box;
      // The SE corner, on screen; panned into view when it is not.
      const se = await ensureOnScreen(page, [r, b]);
      // Its hit box is 12 × 12 CSS px about the corner at every zoom.
      const hit = page
        .locator(
          '[data-selection-handle="southEast"] > rect[data-handle="southEast"]',
        )
        .first();
      const box = (await hit.boundingBox())!;
      expect(box.width, `${zoom}: hit width`).toBeCloseTo(12, 0);
      expect(box.height, `${zoom}: hit height`).toBeCloseTo(12, 0);
      expect(box.x + box.width / 2, `${zoom}: centred`).toBeCloseTo(se.x, 0);
      expect(box.y + box.height / 2, `${zoom}: centred`).toBeCloseTo(se.y, 0);
      // 5 px inside the corner — past the visible square — is the handle.
      const at = { x: se.x - 5, y: se.y - 5 };
      expect(
        await page.evaluate(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.getAttribute("data-handle") ??
            null,
          at,
        ),
        `${zoom}: the press lands on the handle`,
      ).toBe("southEast");
      // And a drag from there resizes: the opposite corner stays.
      const model = await modelSnapshot(page);
      const before = await corner(page, A.free.id);
      await expectUndoSteps(
        page,
        1,
        () => dragFrom(page, at, 24, 16),
        `a resize at ${zoom * 100} %`,
      );
      const resized = await corner(page, A.free.id);
      expect(resized.x, `${zoom}: the NW corner stays`).toBeCloseTo(
        before.x,
        1,
      );
      expect(resized.y, `${zoom}: the NW corner stays`).toBeCloseTo(
        before.y,
        1,
      );
      expect(resized.w, `${zoom}: wider`).toBeGreaterThan(before.w);
      expect(resized.h, `${zoom}: taller`).toBeGreaterThan(before.h);
      await undo(page);
      expect(await modelSnapshot(page)).toBe(model);
    }
  });

  test("UXI-T16 — Escape while drawing a rectangle leaves no object and no undo entry @feat:editor-tools.draw.rectangle @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.rectangle");
    await activateTool(page, "paged.tool.rectangle");
    const model = await modelSnapshot(page);
    const count = (await idsOfKind(page, "rectangle")).length;
    await expectHistoryUnchanged(page, async () => {
      await dragStartOnObject(page, { at: A.emptyAt });
      await movePointerBy(page, 90, 60);
      await page.keyboard.press("Escape");
      await expectNoGesturePreview(page);
      await releasePointer(page);
    });
    expect((await idsOfKind(page, "rectangle")).length).toBe(count);
    expect(await modelSnapshot(page)).toBe(model);
  });
});

test.describe("UXI baseline — B. keyboard", () => {
  test("UXI-T27 — Delete removes the selected object; the text of another story is untouched; one undo restores it @feat:editor-tools.object-commands @level:happy", async ({
    page,
  }) => {
    covers("keybinding:delete→paged.object.delete");
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
    const model = await modelSnapshot(page);
    const story = await dumpStory(page, A.note.storyId);
    expect(story).toContain(A.note.text);
    await clickOn(page, A.free.id);
    await expect
      .poll(async () => (await selectionSnapshot(page)).elements)
      .toEqual([A.free.id]);
    await expectUndoSteps(page, 1, () => page.keyboard.press("Delete"));
    expect(await idsOfKind(page, "rectangle")).not.toContain(A.free.id.id);
    expect(await idsOfKind(page, "rectangle")).toContain(A.back.id.id);
    expect(await dumpStory(page, A.note.storyId)).toBe(story);
    await undo(page);
    expect(await modelSnapshot(page)).toBe(model);
  });
});

test.describe("UXI baseline — D. camera", () => {
  for (const dpr of [1, 2]) {
    test.describe(`at DPR ${dpr}`, () => {
      test.use({ deviceScaleFactor: dpr });
      test(`UXI-T47 — a wheel zoom keeps the chosen point under the pointer (DPR ${dpr}); the document and history are untouched @feat:editor-tools.nav.zoom @level:gesture`, async ({
        page,
      }) => {
        await openUxiFixture(page, "A");
        const model = await modelSnapshot(page);
        for (const at of [A.back.at, A.free.at, A.emptyAt]) {
          const p0 = await clientPointOf(page, { at });
          const s0 = await cameraScale(page);
          await page.mouse.move(p0.x, p0.y);
          await expectHistoryUnchanged(page, async () => {
            await page.keyboard.down("Control");
            await page.mouse.wheel(0, -120);
            await page.keyboard.up("Control");
            await expect
              .poll(() => cameraScale(page))
              .toBeGreaterThan(s0 * 1.2);
          });
          const p1 = await clientPointOf(page, { at });
          expect(Math.abs(p1.x - p0.x), `x drift at ${at}`).toBeLessThan(1);
          expect(Math.abs(p1.y - p0.y), `y drift at ${at}`).toBeLessThan(1);
        }
        expect(await modelSnapshot(page)).toBe(model);
      });
    });
  }
});

// ── helpers ────────────────────────────────────────────────────────

/** Zoom to `scale` with ctrl + wheel about the viewport centre, the
 *  editor's own zoom path, and wait for the camera to land there. */
async function setZoom(page: Page, scale: number): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const s = await cameraScale(page);
    if (Math.abs(s - scale) / scale < 0.002) return;
    const host = (await page
      .locator('[data-testid="viewport-canvas-host"]')
      .boundingBox())!;
    await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -Math.log(scale / s) / 0.005);
    await page.keyboard.up("Control");
    await expect.poll(() => cameraScale(page)).not.toBe(s);
  }
  expect(Math.abs((await cameraScale(page)) - scale) / scale).toBeLessThan(
    0.01,
  );
}

/** Client px of a page-local point, panned (a plain wheel) to the middle
 *  of the viewport first when it is not comfortably inside. */
async function ensureOnScreen(
  page: Page,
  at: readonly [number, number],
): Promise<{ x: number; y: number }> {
  const host = (await page
    .locator('[data-testid="viewport-canvas-host"]')
    .boundingBox())!;
  let p = await clientPointOf(page, { at });
  const inside = (c: number, lo: number, len: number) =>
    c >= lo + len * 0.25 && c <= lo + len * 0.75;
  if (inside(p.x, host.x, host.width) && inside(p.y, host.y, host.height))
    return p;
  await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2);
  await page.mouse.wheel(
    p.x - (host.x + host.width / 2),
    p.y - (host.y + host.height / 2),
  );
  await expect
    .poll(async () => {
      const q = await clientPointOf(page, { at });
      return Math.hypot(q.x - p.x, q.y - p.y);
    })
    .toBeGreaterThan(1);
  p = await clientPointOf(page, { at });
  return p;
}

/** Press at a client point, move by `dx`, `dy` CSS px, release. */
async function dragFrom(
  page: Page,
  from: { x: number; y: number },
  dx: number,
  dy: number,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
}
