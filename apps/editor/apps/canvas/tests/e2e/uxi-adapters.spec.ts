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

// The adapters at the arbitration boundary (the interaction specification,
// §24.2; plan task IC4; editor ADR 1210): the camera's (a wheel takes the
// camera from an animation, a pinch takes it from a pending press), the
// registered tools' (a spring-loaded Hand waits for a drawing drag to
// settle, D-09; a suspended Pen resumes its path), the selection's (an
// Alt-drag commits the copy it previewed) and the Type tool's (a drag over
// text selects text). Each test asserts the model (`modelSnapshot`) and the
// history (the engine's undo log).

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { delayReply } from "./harness/chaos";
import { idsOfKind, selectElements } from "./harness/gesture-kit";
import { expectUndoSteps, undoDepth } from "./harness/history";
import {
  activateTool,
  clientPointOf,
  clientPointOfTarget,
  dragStartOnObject,
  elementCentre,
  engineGestureOpen,
  expectNoGesturePreview,
  movePointerBy,
  releasePointer,
} from "./harness/interaction";
import { modelSnapshot, selectionSnapshot } from "./harness/model-dump";
import { openUxiFixture, UXI_A, UXI_C } from "./harness/uxi-fixtures";

const A = UXI_A;
const C = UXI_C;

interface CanvasGlobal {
  __canvas: {
    client: {
      undo(): Promise<unknown>;
      camera: {
        read(): { scale: number; tx: number; ty: number };
      };
    };
    registries: { commands: { invoke(id: string): unknown } };
  };
}

async function camera(page: Page) {
  return page.evaluate(() => {
    const c = (
      globalThis as unknown as CanvasGlobal
    ).__canvas.client.camera.read();
    return { scale: c.scale, tx: c.tx, ty: c.ty };
  });
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as CanvasGlobal).__canvas.client.undo(),
  );
}

async function invoke(page: Page, id: string): Promise<void> {
  await page.evaluate(
    (id) =>
      (
        globalThis as unknown as CanvasGlobal
      ).__canvas.registries.commands.invoke(id),
    id,
  );
}

interface TraceEntry {
  event: string;
  owner?: string;
  reason?: string;
}

async function trace(page: Page): Promise<TraceEntry[]> {
  return page.evaluate(() =>
    (
      globalThis as unknown as { __interaction: { trace(): TraceEntry[] } }
    ).__interaction.trace(),
  );
}

const toolActive = (page: Page, id: string) =>
  page.locator(`[data-tool="${id}"][data-active="true"]`).first();

/** Path-bearing items: what the Pen leaves behind. */
async function paths(page: Page): Promise<number> {
  const kinds = await Promise.all(
    ["polygon", "graphicLine", "oval", "rectangle"].map((k) =>
      idsOfKind(page, k),
    ),
  );
  return kinds.reduce((n, ids) => n + ids.length, 0);
}

test.describe("UXI adapters — the camera, the tools and the selection at the arbitration boundary (IC4)", () => {
  test("UXI-T06 — an Alt-drag commits the copy it previewed, and one undo removes it @feat:editor-tools.move.translate @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
    await selectElements(page, [A.free.id]);
    const model = await modelSnapshot(page);
    const before = await idsOfKind(page, "rectangle");
    const origin = await elementCentre(page, A.free.id);
    const scale = (await camera(page)).scale;
    await expectUndoSteps(page, 1, async () => {
      await page.keyboard.down("Alt");
      await dragStartOnObject(page, A.free.id);
      await movePointerBy(page, 60, 40);
      await releasePointer(page);
      await page.keyboard.up("Alt");
    });
    const after = await idsOfKind(page, "rectangle");
    expect(after.length, "one copy").toBe(before.length + 1);
    // The original stays where it was; the copy is where the preview was.
    const still = await elementCentre(page, A.free.id);
    expect(still.at[0]).toBeCloseTo(origin.at[0], 1);
    expect(still.at[1]).toBeCloseTo(origin.at[1], 1);
    const copy = after.find((id) => !before.includes(id))!;
    const moved = await elementCentre(page, { kind: "rectangle", id: copy });
    const slack = 10 / scale;
    expect(Math.abs(moved.at[0] - origin.at[0] - 60 / scale)).toBeLessThan(
      slack,
    );
    expect(Math.abs(moved.at[1] - origin.at[1] - 40 / scale)).toBeLessThan(
      slack,
    );
    await undo(page);
    expect(await modelSnapshot(page), "one undo removes the copy").toBe(model);
  });

  test("UXI-T52 — a wheel zoom during a camera animation takes the camera: no tug-back to the animation's end @feat:editor-tools.nav.zoom @level:gesture", async ({
    page,
  }) => {
    covers("command:paged.view.fitPage");
    await openUxiFixture(page, "A");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    const p = await clientPointOf(page, { at: A.emptyAt });
    await page.mouse.move(p.x, p.y);
    // Away from the fit first, so the fit animates a long way.
    await page.keyboard.down("Control");
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    await invoke(page, "paged.view.fitPage");
    // While it travels, the user zooms.
    await page.keyboard.down("Control");
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 120);
    await page.keyboard.up("Control");
    const taken = await camera(page);
    await page.waitForTimeout(600);
    expect(
      await camera(page),
      "the animation did not pull the camera back",
    ).toEqual(taken);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T71 — a pinch while the first finger's press waits for its hit changes the camera only, with no ghost gesture @feat:editor-tools.nav.zoom @level:edge", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await openUxiFixture(page, "A", "?debug=chaos");
    await activateTool(page, "paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    const selected = (await selectionSnapshot(page)).elements;
    const cam = await camera(page);
    // The first finger's press is slow to be answered (its hit, selection
    // and begin come in one call, IC5): it is still pending when the
    // second finger lands.
    await delayReply(page, "beginGestureAt", 1_500);
    await delayReply(page, "hitTest", 1_500);
    const a = await clientPointOfTarget(page, A.back.id);
    await page.evaluate(
      ({ ax, ay }) => {
        const host = document.querySelector<HTMLElement>(
          '[data-testid="viewport-canvas-host"]',
        )!;
        // Synthetic touches have no active pointer to capture.
        host.setPointerCapture = () => {};
        host.releasePointerCapture = () => {};
        host.hasPointerCapture = () => false;
        const fire = (type: string, id: number, x: number, y: number) =>
          host.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: id,
              pointerType: "touch",
              isPrimary: id === 11,
              button: type === "pointermove" ? -1 : 0,
              buttons: type === "pointerup" ? 0 : 1,
              clientX: x,
              clientY: y,
            }),
          );
        fire("pointerdown", 11, ax, ay);
        fire("pointerdown", 12, ax + 80, ay);
        for (let i = 1; i <= 6; i++) {
          fire("pointermove", 11, ax - 10 * i, ay);
          fire("pointermove", 12, ax + 80 + 10 * i, ay);
        }
        fire("pointerup", 12, ax + 140, ay);
        fire("pointerup", 11, ax - 60, ay);
      },
      { ax: a.x, ay: a.y },
    );
    await expect
      .poll(async () => (await camera(page)).scale)
      .toBeGreaterThan(cam.scale * 1.1);
    // The press the pinch took over ended without a mutation; its late hit
    // selects nothing.
    await page.waitForTimeout(1_800);
    expect((await selectionSnapshot(page)).elements).toEqual(selected);
    expect(await engineGestureOpen(page)).toBe(false);
    await expectNoGesturePreview(page);
    const t = await trace(page);
    expect(t.some((e) => e.event === "end" && e.reason === "pinch")).toBe(true);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T10 — Space held during a rectangle drag waits for the drag to settle (D-09); the rectangle is drawn, then the Hand is in hand @feat:editor-tools.draw.rectangle @level:gesture @uxi:UXI-OWN-011", async ({
    page,
  }) => {
    covers("tool:paged.tool.rectangle", "tool:paged.tool.hand");
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.rectangle");
    const model = await modelSnapshot(page);
    const before = await idsOfKind(page, "rectangle");
    await expectUndoSteps(page, 1, async () => {
      await dragStartOnObject(page, { at: A.emptyAt });
      await movePointerBy(page, 60, 40);
      await page.keyboard.down("Space");
      // The drag keeps its tool: no Hand mid-drag, the preview stays.
      await movePointerBy(page, 30, 20);
      await expect(
        page.locator("[data-gesture-preview]").first(),
      ).toBeVisible();
      await expect(toolActive(page, "paged.tool.rectangle")).toBeVisible();
      await releasePointer(page);
    });
    expect((await idsOfKind(page, "rectangle")).length).toBe(before.length + 1);
    expect(
      (await trace(page)).some(
        (e) => e.event === "deferred" && e.reason === "spring-load",
      ),
    ).toBe(true);
    // Settled: the held Space now gives the Hand, and its release the
    // rectangle back.
    await expect(toolActive(page, "paged.tool.hand")).toBeVisible();
    await page.keyboard.up("Space");
    await expect(toolActive(page, "paged.tool.rectangle")).toBeVisible();
    await undo(page);
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("a Pen path suspended by a Space pan resumes where it was: one path, its anchors before and after @feat:plugin-draw.pen-machine @level:gesture @uxi:UXI-OWN-010", async ({
    page,
  }) => {
    covers("tool:paged.tool.pen", "tool:paged.tool.hand");
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.pen");
    const model = await modelSnapshot(page);
    const before = await paths(page);
    const click = async (at: [number, number]) => {
      const p = await clientPointOf(page, { at });
      await page.mouse.click(p.x, p.y);
    };
    await click([430, 330]);
    await click([520, 330]);
    // Pan with the spring-loaded Hand between two Pen clicks.
    await page.keyboard.down("Space");
    await expect(toolActive(page, "paged.tool.hand")).toBeVisible();
    const p = await clientPointOf(page, { at: [500, 600] });
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 40, p.y + 30, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    await expect(toolActive(page, "paged.tool.pen")).toBeVisible();
    await click([520, 420]);
    await expectUndoSteps(page, 1, () => page.keyboard.press("Enter"));
    expect(await paths(page), "the path went on: one path").toBe(before + 1);
    await undo(page);
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("a Type-tool drag that starts over text selects text; it pulls out no frame @feat:editor-tools.text.caret-typing @level:gesture @uxi:UXI-TXT-011", async ({
    page,
  }) => {
    covers("tool:paged.tool.type");
    await openUxiFixture(page, "C");
    await activateTool(page, "paged.tool.type");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    const frames = await idsOfKind(page, "textFrame");
    await dragStartOnObject(page, {
      at: [C.first.box[1] + 12, C.first.box[0] + 8],
    });
    await movePointerBy(page, 160, 40, 12);
    await releasePointer(page);
    await expect
      .poll(async () => {
        const t = (await selectionSnapshot(page)).text;
        return t ? t.storyId === C.storyId && t.end > t.start : false;
      })
      .toBe(true);
    expect(await idsOfKind(page, "textFrame")).toEqual(frames);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });
});
