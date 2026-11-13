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

// The interaction coordinator (editor ADR "The interaction coordinator";
// plan tasks IC1 and IC2): every pointer sequence on the canvas is one
// session, and whatever ends it from outside — a lost pointer capture, a
// hidden page, a tool switch, a failed worker, Escape — rolls the gesture
// back exactly once, leaves the document and its history as they were, and
// leaves the editor able to begin the next drag. Each test asserts the
// model (`modelSnapshot`) and the history (the engine's undo log).

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { selectElements } from "./harness/gesture-kit";
import { undoDepth } from "./harness/history";
import {
  activateTool,
  assertCanBeginNewDrag,
  clientPointOf,
  dragStartOnObject,
  engineGestureOpen,
  expectNoGesturePreview,
  movePointerBy,
  releasePointer,
} from "./harness/interaction";
import { modelSnapshot } from "./harness/model-dump";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

const A = UXI_A;

/** The coordinator's flag (until it is the default) and the slow worker. */
const FLAGS = "?debug=coordinator,chaos";

interface TraceEntry {
  event: string;
  owner?: string;
  kind?: string;
  result?: string;
  reason?: string;
}

async function trace(page: Page): Promise<TraceEntry[]> {
  return page.evaluate(() =>
    (
      globalThis as unknown as {
        __interaction: { trace(): TraceEntry[] };
      }
    ).__interaction.trace(),
  );
}

async function clearTrace(page: Page): Promise<void> {
  await page.evaluate(() =>
    (
      globalThis as unknown as { __interaction: { clearTrace(): void } }
    ).__interaction.clearTrace(),
  );
}

/** The session holding the pointer, as the coordinator shows it. */
async function activeSession(
  page: Page,
): Promise<{ owner: string; kind: string; phase: string } | null> {
  return page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __interaction: {
            snapshot(): {
              active: { owner: string; kind: string; phase: string } | null;
            };
          };
        }
      ).__interaction.snapshot().active,
  );
}

async function camera(page: Page) {
  return page.evaluate(() => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            camera: { read(): { scale: number; tx: number; ty: number } };
          };
        };
      }
    ).__canvas.client.camera.read();
    return { scale: c.scale, tx: c.tx, ty: c.ty };
  });
}

/** Activate a tool the way a keyboard shortcut does, while the pointer
 *  may be held (no wait on the rail: the test checks it). */
async function switchTool(page: Page, id: string): Promise<void> {
  await page.evaluate(
    (id) =>
      (
        globalThis as unknown as {
          __canvas: {
            registries: { commands: { invoke(id: string): unknown } };
          };
        }
      ).__canvas.registries.commands.invoke(`paged.tool.activate.${id}`),
    id,
  );
}

const ended = (t: TraceEntry[], reason: string) =>
  t.some((e) => e.event === "end" && e.reason === reason);

test.describe("UXI coordinator — sessions end once, from wherever (IC1, IC2)", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "A", FLAGS);
    await activateTool(page, "paged.tool.select");
  });

  test("UXI-T10 — a permanent tool switch mid-move cancels the move and the new tool is in hand @feat:editor-tools.gesture-lifecycle @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.select", "tool:paged.tool.rectangle");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await clearTrace(page);
    await dragStartOnObject(page, A.free.id);
    await movePointerBy(page, 70, 30);
    await expect.poll(() => engineGestureOpen(page)).toBe(true);
    await switchTool(page, "paged.tool.rectangle");
    await expect(
      page
        .locator('[data-tool="paged.tool.rectangle"][data-active="true"]')
        .first(),
    ).toBeVisible();
    await expect.poll(() => engineGestureOpen(page)).toBe(false);
    await expect.poll(() => modelSnapshot(page)).toBe(model);
    expect(ended(await trace(page), "tool-switch")).toBe(true);
    expect(await activeSession(page)).toBeNull();
    await expectNoGesturePreview(page);
    // The rest of the old drag and its release do nothing.
    await movePointerBy(page, 30, 30);
    await releasePointer(page);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
    await assertCanBeginNewDrag(page, A.free.id);
  });

  test("UXI-T10 — a tool switch mid-draw cancels the rectangle: no object, the spine lets go of the pointer @feat:editor-tools.draw.rectangle @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.rectangle", "tool:paged.tool.select");
    await activateTool(page, "paged.tool.rectangle");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await clearTrace(page);
    await dragStartOnObject(page, { at: A.emptyAt });
    await movePointerBy(page, 90, 60);
    await expect(page.locator("[data-gesture-preview]").first()).toBeVisible();
    await switchTool(page, "paged.tool.select");
    await expectNoGesturePreview(page);
    expect(ended(await trace(page), "tool-switch")).toBe(true);
    // The Selection tool now owns the next press; the old drag's moves and
    // release reach no handler.
    await movePointerBy(page, 20, 20);
    await releasePointer(page);
    await expectNoGesturePreview(page);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
    await assertCanBeginNewDrag(page, A.free.id);
  });

  test("UXI-T08 — a lost pointer capture mid-move rolls back once, and the next drag works @feat:editor-tools.gesture-lifecycle @level:gesture @uxi:UXI-INV-014", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await clearTrace(page);
    await dragStartOnObject(page, A.free.id);
    await movePointerBy(page, 70, 30);
    await expect.poll(() => engineGestureOpen(page)).toBe(true);
    // What another element taking the capture delivers to the canvas host.
    await page.evaluate(() =>
      document
        .querySelector('[data-testid="viewport-canvas-host"]')!
        .dispatchEvent(
          new PointerEvent("lostpointercapture", {
            bubbles: true,
            pointerId: 1,
          }),
        ),
    );
    await expect.poll(() => engineGestureOpen(page)).toBe(false);
    await expect.poll(() => modelSnapshot(page)).toBe(model);
    const t = await trace(page);
    expect(ended(t, "capture-lost")).toBe(true);
    // Ended once: the release that follows ends nothing more.
    await releasePointer(page);
    const ends = (await trace(page)).filter((e) => e.event === "end");
    expect(ends).toHaveLength(1);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
    await assertCanBeginNewDrag(page, A.free.id);
  });

  test("UXI-T09 — a hidden page mid-move ends the session with no partial edit @feat:editor-tools.gesture-lifecycle @level:gesture @uxi:UXI-INV-014", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await dragStartOnObject(page, A.free.id);
    await movePointerBy(page, 60, 20);
    await expect.poll(() => engineGestureOpen(page)).toBe(true);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      delete (document as unknown as { visibilityState?: unknown })
        .visibilityState;
    });
    await expect.poll(() => engineGestureOpen(page)).toBe(false);
    expect(ended(await trace(page), "hidden")).toBe(true);
    await releasePointer(page);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
    await assertCanBeginNewDrag(page, A.free.id);
  });

  test("UXI-T07 — Escape cancels a marquee and the rest of the drag neither selects nor pans @feat:editor-tools.select.click-marquee @level:gesture @uxi:UXI-ESC-001", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    const cam = await camera(page);
    await dragStartOnObject(page, { at: [380, 40] });
    await movePointerBy(page, 200, 160);
    await expect(page.locator('[data-gesture-preview="marquee"]')).toHaveCount(
      1,
    );
    await page.keyboard.press("Escape");
    await expectNoGesturePreview(page);
    await movePointerBy(page, 60, 60);
    expect(
      await camera(page),
      "Escape never turns the drag into a pan",
    ).toEqual(cam);
    await releasePointer(page);
    expect(
      await page.evaluate(
        () =>
          (
            globalThis as unknown as {
              __canvas: { elementSelection?: unknown[] | null };
            }
          ).__canvas.elementSelection?.length ?? 0,
      ),
    ).toBe(0);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T07 — Escape mid-move never pans: the rest of the drag is inert @feat:editor-tools.gesture-lifecycle @level:gesture @uxi:UXI-ESC-001", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await dragStartOnObject(page, A.free.id);
    await movePointerBy(page, 50, 30);
    await expect.poll(() => engineGestureOpen(page)).toBe(true);
    const cam = await camera(page);
    await page.keyboard.press("Escape");
    await expect.poll(() => engineGestureOpen(page)).toBe(false);
    await movePointerBy(page, 80, 50);
    expect(await camera(page)).toEqual(cam);
    await releasePointer(page);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
    await assertCanBeginNewDrag(page, A.free.id);
  });

  test("UXI-T61 — the worker failing after the press ends the gesture, claims no success, and says so @feat:editor-tools.gesture-lifecycle @level:edge", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await selectElements(page, [A.free.id]);
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    const mark = await page.evaluate(
      () =>
        (
          globalThis as unknown as {
            __canvas: { client: { editMark: number } };
          }
        ).__canvas.client.editMark,
    );
    // The begin's answer is held: the press is waiting on the worker.
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          __chaos: { delayReply(kind: string, ms: number): void };
        }
      ).__chaos.delayReply("beginGesture", 30_000),
    );
    await dragStartOnObject(page, A.free.id);
    await movePointerBy(page, 60, 40);
    expect((await activeSession(page))?.owner).toBe("canvas-transform");
    // Nothing has changed while the press waits.
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
    await page.evaluate(() =>
      (
        globalThis as unknown as { __chaos: { failWorker(): void } }
      ).__chaos.failWorker(),
    );
    // The gesture ended, aborted, and the editor says what happened.
    await expect.poll(() => activeSession(page)).toBeNull();
    expect(ended(await trace(page), "worker-failed")).toBe(true);
    await expect(page.locator("[data-engine-failure]")).toBeVisible();
    await expect(page.locator("[data-engine-failure]")).toHaveAttribute(
      "role",
      "alert",
    );
    await expectNoGesturePreview(page);
    // The rest of the drag does nothing (no pan), and no success is claimed:
    // no edit was counted, and the dead worker accepts no write. (The
    // notice takes room above the canvas, which keeps its centre: the
    // camera is read once it is shown.)
    const cam = await camera(page);
    await movePointerBy(page, 40, 40);
    expect(await camera(page)).toEqual(cam);
    await releasePointer(page);
    expect(
      await page.evaluate(
        () =>
          (
            globalThis as unknown as {
              __canvas: { client: { editMark: number } };
            }
          ).__canvas.client.editMark,
      ),
    ).toBe(mark);
    const refused = await page.evaluate(() =>
      (
        globalThis as unknown as {
          __canvas: { client: { undoLog(n: number): Promise<unknown> } };
        }
      ).__canvas.client
        .undoLog(0)
        .then(
          () => "answered",
          (e: Error) => e.message,
        ),
    );
    expect(refused).toContain("canvas worker failed");
  });

  test("a document opened mid-drag ends the drag first; the old begin's late answer opens nothing @feat:editor-tools.gesture-lifecycle @level:edge @uxi:UXI-INV-015", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await selectElements(page, [A.free.id]);
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          __chaos: { delayReply(kind: string, ms: number): void };
        }
      ).__chaos.delayReply("beginGesture", 1_500),
    );
    await dragStartOnObject(page, A.free.id);
    await movePointerBy(page, 60, 40);
    await clearTrace(page);
    // Replace the document while the begin is out.
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          __canvas: {
            registries: { commands: { invoke(id: string): unknown } };
          };
        }
      ).__canvas.registries.commands.invoke("paged.file.new"),
    );
    await expect
      .poll(async () =>
        (await trace(page)).some(
          (e) => e.event === "end" && e.reason?.startsWith("document-"),
        ),
      )
      .toBe(true);
    await releasePointer(page);
    // The held begin is answered by now; the new document has no gesture
    // open and no history.
    await expect
      .poll(() => engineGestureOpen(page), { timeout: 10_000 })
      .toBe(false);
    expect(await undoDepth(page)).toBe(0);
  });
});

test.describe("UXI coordinator — the trace (IC1)", () => {
  test("a press, a move and a release are one session in the trace, with no user text @feat:editor-tools.gesture-lifecycle @level:happy @uxi:UXI-OBS-001", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await openUxiFixture(page, "A", FLAGS);
    await activateTool(page, "paged.tool.select");
    await clearTrace(page);
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    const p = await clientPointOf(page, { at: A.emptyAt });
    await page.mouse.click(p.x, p.y);
    const t = await trace(page);
    const begins = t.filter((e) => e.event === "begin");
    expect(begins).toHaveLength(1);
    expect(begins[0]!.owner).toBe("canvas-select");
    expect(t.filter((e) => e.event === "end")).toHaveLength(1);
    for (const e of t)
      for (const value of Object.values(e))
        expect(String(value)).not.toContain(A.note.text);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });
});
