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

// The interaction contract's test vocabulary (spec §23.3): real pointer
// input on document targets, and the three questions every cancel test
// asks — is the document unchanged (model-dump.ts `modelSnapshot`), is
// the history unchanged (history.ts), and is the editor live again
// (`assertCanBeginNewDrag`: nothing open in the engine, no preview left
// on the canvas, and a fresh drag moves an object as one undo step).
//
//   const before = await modelSnapshot(page);
//   const depth = await undoDepth(page);
//   await dragStartOnObject(page, UXI_A.back.id);
//   await movePointerBy(page, 80, 20);
//   await page.keyboard.press("Escape");
//   expect(await modelSnapshot(page)).toBe(before);
//   expect(await undoDepth(page)).toBe(depth);
//   await expectNoGesturePreview(page);
//   await assertCanBeginNewDrag(page, UXI_A.free.id);
//
// The transient overlays (marquee, tool preview, snap lines, guide drag
// preview) mark themselves with `data-gesture-preview`
// (packages/shell/src/overlays/).

import { expect, type Page } from "@playwright/test";

import { undoDepth } from "./history";
import { modelSnapshot } from "./model-dump";

export interface ElementRef {
  kind: string;
  id: string;
}

/** A point on a page (page-local pt; `page` is the 0-based page index). */
export interface PagePoint {
  at: readonly [number, number];
  page?: number;
}

export type InteractionTarget = ElementRef | PagePoint;

const HOST = '[data-testid="viewport-canvas-host"]';

/** Where the pointer is and whether its button is held, per page. */
const pointers = new WeakMap<Page, { x: number; y: number; down: boolean }>();

/** Client px of a page-local point, through the live camera (rotation
 *  included) and the page's place on the canvas. */
export async function clientPointOf(
  page: Page,
  point: PagePoint,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ host, at, index }) => {
      const r = document.querySelector(host)!.getBoundingClientRect();
      const c = (
        globalThis as unknown as {
          __canvas: {
            client: {
              camera: {
                read(): {
                  scale: number;
                  tx: number;
                  ty: number;
                  rotation?: number;
                };
              };
            };
            handle?: {
              pageOriginsPt?: Array<[number, number]>;
              pageSizesPt?: Array<[number, number]>;
            };
          };
        }
      ).__canvas;
      const origins = c.handle?.pageOriginsPt ?? [];
      let origin: [number, number] = origins[index] ?? [0, 0];
      if (!origins[index]) {
        // No engine origins: the canvas stacks the pages 24 pt apart.
        const sizes = c.handle?.pageSizesPt ?? [];
        let y = 0;
        for (let i = 0; i < index; i++) y += (sizes[i]?.[1] ?? 0) + 24;
        origin = [0, y];
      }
      const x = origin[0] + at[0];
      const y = origin[1] + at[1];
      const cam = c.client.camera.read();
      const rot = cam.rotation ?? 0;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      return {
        x: r.left + cam.scale * (cos * x - sin * y) + cam.tx,
        y: r.top + cam.scale * (sin * x + cos * y) + cam.ty,
      };
    },
    { host: HOST, at: [point.at[0], point.at[1]], index: point.page ?? 0 },
  );
}

/** The page-local centre of an element (its bounds through its item
 *  transform), and the index of the page it is on. */
export async function elementCentre(
  page: Page,
  ref: ElementRef,
): Promise<PagePoint> {
  const found = await page.evaluate(async (id) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            elementGeometry(ids: unknown[]): Promise<
              Array<{
                bounds: [number, number, number, number];
                itemTransform?: number[] | null;
                pageId?: string | null;
              }>
            >;
          };
          handle?: { pageIds?: string[] };
        };
      }
    ).__canvas;
    const g = (await c.client.elementGeometry([id]))[0];
    if (!g) return null;
    const [t, l, b, r] = g.bounds;
    const [a, bb, cc, d, tx, ty] = g.itemTransform ?? [1, 0, 0, 1, 0, 0];
    const x = (l + r) / 2;
    const y = (t + b) / 2;
    const index = g.pageId
      ? Math.max(0, (c.handle?.pageIds ?? []).indexOf(g.pageId))
      : 0;
    return {
      at: [a * x + cc * y + tx, bb * x + d * y + ty] as [number, number],
      page: index,
    };
  }, ref);
  if (!found) throw new Error(`no geometry for ${ref.kind} ${ref.id}`);
  return found;
}

const isElement = (t: InteractionTarget): t is ElementRef =>
  "kind" in t && "id" in t;

/** Client px of a target: an element's centre, or a page point. */
export async function clientPointOfTarget(
  page: Page,
  target: InteractionTarget,
): Promise<{ x: number; y: number }> {
  return clientPointOf(
    page,
    isElement(target) ? await elementCentre(page, target) : target,
  );
}

/** Press the primary button on `target` and keep it held: the start of a
 *  drag (or of a click, if the pointer is let go where it is). */
export async function dragStartOnObject(
  page: Page,
  target: InteractionTarget,
): Promise<void> {
  const p = await clientPointOfTarget(page, target);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  pointers.set(page, { ...p, down: true });
}

/** Move the pointer by `dx`, `dy` CSS px from where it is, in `steps`
 *  pointer events (the button stays as it is). */
export async function movePointerBy(
  page: Page,
  dx: number,
  dy: number,
  steps = 8,
): Promise<void> {
  const at = pointers.get(page);
  if (!at) throw new Error("movePointerBy: no pointer yet (dragStartOnObject)");
  const to = { x: at.x + dx, y: at.y + dy };
  await page.mouse.move(to.x, to.y, { steps });
  pointers.set(page, { ...to, down: at.down });
}

/** Let go of the button where the pointer is. */
export async function releasePointer(page: Page): Promise<void> {
  const at = pointers.get(page);
  await page.mouse.up();
  if (at) pointers.set(page, { ...at, down: false });
}

/** A whole drag of `target` by `dx`, `dy` CSS px: press, move, release. */
export async function dragBy(
  page: Page,
  target: InteractionTarget,
  dx: number,
  dy: number,
  steps = 8,
): Promise<void> {
  await dragStartOnObject(page, target);
  await movePointerBy(page, dx, dy, steps);
  await releasePointer(page);
}

/** Click `target` (press and release on the spot), holding `modifiers`. */
export async function clickOn(
  page: Page,
  target: InteractionTarget,
  options: { modifiers?: Array<"Shift" | "Alt" | "Meta" | "Control"> } = {},
): Promise<void> {
  const p = await clientPointOfTarget(page, target);
  const mods = options.modifiers ?? [];
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
  pointers.set(page, { ...p, down: false });
}

/** No transient gesture overlay is drawn: no marquee, no tool preview,
 *  no snap line, no guide drag preview. */
export async function expectNoGesturePreview(page: Page): Promise<void> {
  await expect(page.locator("[data-gesture-preview]")).toHaveCount(0);
}

/** Is a gesture open in the ENGINE? The engine refuses a begin while one
 *  is (`alreadyActive`), and refuses an empty one otherwise
 *  (`emptySelection`), so the probe never opens anything. */
export async function engineGestureOpen(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            send(m: unknown): Promise<{
              kind: string;
              payload?: { error?: { kind?: string } };
            }>;
          };
        };
      }
    ).__canvas;
    const r = await c.client.send({
      kind: "beginGesture",
      payload: { nodes: [], gesture: { kind: "translate" }, anchor: null },
    });
    return (
      r.kind === "gestureFailed" && r.payload?.error?.kind === "alreadyActive"
    );
  });
}

/** Activate a registered tool by id, as the tool rail does, and wait
 *  until the rail shows it active. */
export async function activateTool(page: Page, id: string): Promise<void> {
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
  await expect(
    page.locator(`[data-tool="${id}"][data-active="true"]`).first(),
  ).toBeVisible();
}

/**
 * The editor is live after whatever ended the last gesture (INV-8): the
 * pointer is let go if a test still holds it, the engine has no gesture
 * open, no gesture preview is drawn, and a fresh Selection-tool drag of
 * `target` moves it as ONE undo step — which this then undoes, leaving
 * the document as it found it.
 */
export async function assertCanBeginNewDrag(
  page: Page,
  target: ElementRef,
): Promise<void> {
  if (pointers.get(page)?.down) await releasePointer(page);
  expect(
    await engineGestureOpen(page),
    "no gesture is left open in the engine",
  ).toBe(false);
  await expectNoGesturePreview(page);
  await activateTool(page, "paged.tool.select");
  const model = await modelSnapshot(page);
  const depth = await undoDepth(page);
  const from = await elementCentre(page, target);
  await dragBy(page, target, 40, 30);
  await expect
    .poll(
      async () => {
        const now = await elementCentre(page, target);
        return Math.hypot(now.at[0] - from.at[0], now.at[1] - from.at[1]);
      },
      { message: "a fresh drag moves the object", timeout: 10_000 },
    )
    .toBeGreaterThan(1);
  await expect.poll(() => undoDepth(page), { timeout: 10_000 }).toBe(depth + 1);
  await page.evaluate(() =>
    (
      globalThis as unknown as {
        __canvas: { client: { undo(): Promise<unknown> } };
      }
    ).__canvas.client.undo(),
  );
  expect(await modelSnapshot(page), "the probe drag undoes exactly").toBe(
    model,
  );
}
