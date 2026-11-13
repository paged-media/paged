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

// Fixture H of the interaction contract (spec §23.1): a simulated slow
// worker. The page is opened with `?debug=chaos`, which makes the page
// entry publish `__chaos` (apps/canvas/src/app/chaos.ts): a reply gate on
// the engine client that settles the callers of a request kind late, or
// in reverse order. Only the AWAITING caller is held; subscribers see a
// reply when it arrives, and the worker answers in order as always.
//
//   await openChaosCanvas(page);
//   await delayReply(page, "hitTest", 400);         // every hit test, 400 ms late
//   await reorderReplies(page, ["hitTest", "hitTest"]); // the next two swap
//   …
//   await clearChaos(page);                          // settle what is held
//
// The test kit's `settle()` waits for the client's pending map, which a
// held reply has already left: wait with `chaosIdle` instead.

import { expect, type Page } from "@playwright/test";

import {
  openCanvas,
  type OpenCanvasOptions,
} from "../../fidelity/canvas-driver";

interface ChaosGlobal {
  __chaos?: {
    delayReply(kind: string, ms: number): void;
    reorder(kinds: readonly string[]): void;
    held(): number;
    clear(): void;
  };
}

/** `openCanvas` with the `chaos` debug flag added to the query. */
export async function openChaosCanvas(
  page: Page,
  options: OpenCanvasOptions = {},
): Promise<void> {
  const search = options.search ?? "";
  const withFlag = search
    ? `${search}${search.includes("?") ? "&" : "?"}debug=chaos`
    : "?debug=chaos";
  await openCanvas(page, { ...options, search: withFlag });
  expect(
    await page.evaluate(() =>
      Boolean((globalThis as unknown as ChaosGlobal).__chaos),
    ),
    "the page publishes __chaos under ?debug=chaos",
  ).toBe(true);
}

/** Settle every caller of a `kind` request (`"hitTest"`) `ms` late. */
export async function delayReply(
  page: Page,
  kind: string,
  ms: number,
): Promise<void> {
  await page.evaluate(
    ({ kind, ms }) =>
      (globalThis as unknown as ChaosGlobal).__chaos!.delayReply(kind, ms),
    { kind, ms },
  );
}

/** Delay only the `nth` (from 0) reply of a `kind` request by `ms`. */
export async function delayNthReply(
  page: Page,
  kind: string,
  nth: number,
  ms: number,
): Promise<void> {
  await page.evaluate(
    ({ kind, nth, ms }) => {
      const chaos = (
        globalThis as unknown as {
          __chaos: {
            delayReply(k: string, f: (n: number) => number): void;
          };
        }
      ).__chaos;
      chaos.delayReply(kind, (n) => (n === nth ? ms : 0));
    },
    { kind, nth, ms },
  );
}

/** Hold the next replies to these request kinds (one per entry, in that
 *  order) until all have arrived, then settle them last first. */
export async function reorderReplies(
  page: Page,
  kinds: readonly string[],
): Promise<void> {
  await page.evaluate(
    (kinds) => (globalThis as unknown as ChaosGlobal).__chaos!.reorder(kinds),
    [...kinds],
  );
}

/** Replies the gate holds right now. */
export async function heldReplies(page: Page): Promise<number> {
  return page.evaluate(() =>
    (globalThis as unknown as ChaosGlobal).__chaos!.held(),
  );
}

/** Wait until the gate holds nothing (every delayed caller settled). */
export async function chaosIdle(page: Page, timeout = 15_000): Promise<void> {
  await expect
    .poll(() => heldReplies(page), {
      timeout,
      message: "the chaos gate should release every held reply",
    })
    .toBe(0);
}

/** Settle everything held, in arrival order, and drop every rule. */
export async function clearChaos(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as ChaosGlobal).__chaos?.clear(),
  );
}
