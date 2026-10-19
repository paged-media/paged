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

// The gesture kit in the browser: the test kit's gesture DSL over the
// real editor (its browser backend: real pointer events through the
// live camera), the gesture fixtures loaded through the React file
// input, and the MODEL channel over the running worker, so a browser
// spec asserts what the document holds before it looks at pixels.
//
//   const { g } = await gestureEditor(page);             // targets fixture, page 1 fitted
//   await g.tool("rectangle").drag({ from: [72, 72], to: [216, 144], mods: ["shift"] }).settle();
//   await checkUndoRedo(browserModel(page), () => g.drag(…).settle());

import { expect, type Page } from "@playwright/test";

import type { MainToWorkerKind, WorkerToMain } from "@paged-media/plugin-api";
import {
  browserGestures,
  engineModelChannel,
  gestureFixture,
  type BrowserPage,
  type GestureDsl,
  type GestureFixtureName,
  type ModelChannel,
} from "@paged-media/test-kit";

import { fitFirstPage, openCanvas } from "../../fidelity/canvas-driver";

const IDML_MIME = "application/vnd.adobe.indesign-idml-package";

/** The engine channel of the running editor (one round trip a message). */
export function browserSend(
  page: Page,
): (message: MainToWorkerKind) => Promise<WorkerToMain> {
  return (message) =>
    page.evaluate(
      (m) =>
        (
          globalThis as unknown as {
            __canvas: { client: { send(x: unknown): Promise<WorkerToMain> } };
          }
        ).__canvas.client.send(m),
      message as unknown,
    ) as Promise<WorkerToMain>;
}

/** The model dump / undo / redo of the running document (the same dump
 *  the headless tests compare: scene tree, every element's properties,
 *  the document meta, pages, spreads, swatches, layers). */
export function browserModel(page: Page): ModelChannel {
  return engineModelChannel(browserSend(page));
}

/** Load a gesture fixture through the React file input (the viewport
 *  mounts), wait for the document, fit page 1. */
export async function loadGestureFixture(
  page: Page,
  name: GestureFixtureName = "targets",
): Promise<void> {
  await page.evaluate(() => {
    const c = (globalThis as unknown as { __canvas?: { ready?: boolean } })
      .__canvas;
    if (c) c.ready = false;
  });
  await page.setInputFiles('input[type="file"]', {
    name: `gesture-${name}.idml`,
    mimeType: IDML_MIME,
    buffer: Buffer.from(gestureFixture(name)),
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Boolean(
            (globalThis as unknown as { __canvas?: { ready?: boolean } })
              .__canvas?.ready,
          ),
        ),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
  await fitFirstPage(page);
  // The file input keeps the focus after a load, and the editor's key
  // routing ignores keys aimed at an input: leave the focus where a user
  // who just opened a document has it (the page), so shortcuts reach it.
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur?.(),
  );
}

/** Open the editor on a gesture fixture; resolves to the DSL over it.
 *  Wrapped in an object: the DSL is a thenable, so an async function
 *  returning it bare would await (run) it and resolve to undefined. */
export async function gestureEditor(
  page: Page,
  name: GestureFixtureName = "targets",
): Promise<{ g: GestureDsl }> {
  await openCanvas(page);
  await loadGestureFixture(page, name);
  return { g: browserGestures(page as unknown as BrowserPage) };
}

/** Select elements the way a click would leave them: the worker's
 *  selection AND the main-thread mirror the canvas routes drags by. */
export async function selectElements(
  page: Page,
  ids: ReadonlyArray<{ kind: string; id: string }>,
): Promise<void> {
  await page.evaluate(async (list) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            setElementSelection(i: unknown[], m: string): Promise<unknown[]>;
            elementGeometry(i: unknown[]): Promise<unknown[]>;
          };
          setElementSelection(i: unknown[]): void;
          setElementGeometry(g: unknown[]): void;
        };
      }
    ).__canvas;
    const applied = await c.client.setElementSelection(list, "replace");
    c.setElementSelection(applied);
    c.setElementGeometry(await c.client.elementGeometry(applied));
  }, ids as unknown[]);
}

/** The ids the main-thread selection mirror holds. */
export async function selectedIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (
      (
        globalThis as unknown as {
          __canvas: { elementSelection?: Array<{ id: string }> };
        }
      ).__canvas.elementSelection ?? []
    ).map((e) => String(e.id)),
  );
}

/** Page-space corners of one element (bounds through its transform). */
export async function cornersOf(
  page: Page,
  id: { kind: string; id: string },
): Promise<Array<[number, number]> | null> {
  const reply = (await browserSend(page)({
    kind: "requestElementGeometry",
    payload: { ids: [id as never] },
  })) as unknown as {
    payload: {
      items: Array<{
        bounds: [number, number, number, number];
        itemTransform?: number[] | null;
      }>;
    };
  };
  const g = reply.payload.items[0];
  if (!g) return null;
  const [t, l, b, r] = g.bounds;
  const [a, bb, c, d, tx, ty] = g.itemTransform ?? [1, 0, 0, 1, 0, 0];
  const p = (x: number, y: number): [number, number] => [
    a * x + c * y + tx,
    bb * x + d * y + ty,
  ];
  return [p(l, t), p(r, t), p(r, b), p(l, b)];
}

/** Axis-aligned page box of a corner set. */
export function boxOf(cs: ReadonlyArray<[number, number]>): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const xs = cs.map((c) => c[0]);
  const ys = cs.map((c) => c[1]);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

/** Element ids of one kind in document order (a scene-tree walk). */
export async function idsOfKind(page: Page, kind: string): Promise<string[]> {
  const reply = (await browserSend(page)({
    kind: "requestSceneTree",
  })) as unknown as {
    payload: {
      roots: Array<{
        id?: { kind: string; id: string } | null;
        children?: unknown[];
      }>;
    };
  };
  const out: string[] = [];
  const walk = (n: {
    id?: { kind: string; id: string } | null;
    children?: unknown[];
  }) => {
    if (n.id?.kind === kind) out.push(n.id.id);
    for (const c of (n.children ?? []) as typeof reply.payload.roots) walk(c);
  };
  reply.payload.roots.forEach(walk);
  return out;
}

/** The id of the active tool, from the rail. */
export async function activeTool(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      (
        document.querySelector(
          '[data-tool][data-active="true"]',
        ) as HTMLElement | null
      )?.dataset.tool ?? null,
  );
}
