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

// The HISTORY half of the interaction contract's assertions (spec §23.1:
// "assert both observable UI and authoritative model/history outcomes"):
// the engine's own undo timeline (engine ADR 1030, `client.undoLog`), read
// through the page's `__canvas` handle. A count of the editor's replies
// would trust the editor; the undo log is what Cmd-Z will act on.

import { expect, type Page } from "@playwright/test";

/** The lengths of the engine's undo and redo logs. */
export interface HistoryDepth {
  undo: number;
  redo: number;
}

/** Both logs' lengths (one round trip; no entries are read). */
export async function historyDepth(page: Page): Promise<HistoryDepth> {
  return page.evaluate(async () => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            undoLog(limit?: number): Promise<{
              undoLen: number;
              redoLen: number;
            }>;
          };
        };
      }
    ).__canvas;
    const log = await c.client.undoLog(0);
    return { undo: log.undoLen, redo: log.redoLen };
  });
}

/** Steps an undo can revert right now. */
export async function undoDepth(page: Page): Promise<number> {
  return (await historyDepth(page)).undo;
}

/** Run `fn`; the undo and redo logs must be exactly as they were (a
 *  cancelled gesture, a refused edit, a selection change: D-15 keeps
 *  selection out of the history). Resolves to what `fn` returned. */
export async function expectHistoryUnchanged<T>(
  page: Page,
  fn: () => Promise<T>,
  label = "the history",
): Promise<T> {
  const before = await historyDepth(page);
  const out = await fn();
  expect(await historyDepth(page), `${label} must not change`).toEqual(before);
  return out;
}

/** Run `fn`; it must add exactly `steps` undo steps (one gesture = one
 *  step, INV-1) and leave nothing to redo. */
export async function expectUndoSteps<T>(
  page: Page,
  steps: number,
  fn: () => Promise<T>,
  label = "the operation",
): Promise<T> {
  const before = await historyDepth(page);
  const out = await fn();
  // A gesture commits asynchronously after the release: wait for the step,
  // then hold the count to exactly `steps` (two commits are a failure).
  await expect
    .poll(async () => (await historyDepth(page)).undo, {
      message: `${label} should add ${steps} undo step(s)`,
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(before.undo + steps);
  const after = await historyDepth(page);
  expect(after.undo, `${label} adds exactly ${steps} undo step(s)`).toBe(
    before.undo + steps,
  );
  expect(after.redo, `${label} leaves no redo`).toBe(0);
  return out;
}
