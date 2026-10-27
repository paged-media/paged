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

// E2E — the History panel (editor ADR 285, engine ADR 1030) in the running
// editor: three edits on a blank document, Edit ▸ History opens the panel,
// the steps are listed by name; a click on the first step leaves the
// document as it was after step 1 (one `undoTo`), and a click on the last
// (undone) step redoes up to it (one `redoTo`).

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { openCanvas } from "../fidelity/canvas-driver";
import { clickMenuRow } from "./harness/shell-surface";

type Canvas = {
  ready?: boolean;
  handle: { pageIds: string[] };
  client: {
    mutate(m: unknown): Promise<{ kind: string }>;
    send(m: unknown): Promise<{ kind: string; payload: any }>;
    undoLog(): Promise<{ undoLen: number; redoLen: number }>;
  };
  registries: { commands: { invoke(id: string): Promise<unknown> } };
};

async function newBlankDocument(page: Page): Promise<void> {
  await openCanvas(page);
  await page.evaluate(async () => {
    const c = (globalThis as unknown as { __canvas: Canvas }).__canvas;
    await c.registries.commands.invoke("paged.file.new");
  });
  await page.waitForFunction(
    () =>
      (globalThis as unknown as { __canvas?: { ready?: boolean } }).__canvas
        ?.ready === true,
    null,
    { timeout: 15_000 },
  );
}

/** Three text frames, one per mutation: three undo steps. */
async function threeEdits(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const c = (globalThis as unknown as { __canvas: Canvas }).__canvas;
    const pageId = c.handle.pageIds[0];
    for (const x of [40, 200, 360]) {
      const r = await c.client.mutate({
        op: "insertTextFrame",
        args: { pageId, bounds: [x, 40, x + 120, 140] },
      });
      if (r.kind !== "mutationApplied") throw new Error(r.kind);
    }
  });
}

/** Text frames in the document, from the engine's scene tree. */
async function textFrames(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as { __canvas: Canvas }).__canvas;
    const reply = await c.client.send({ kind: "requestSceneTree" });
    type Node = { kind?: string; children?: Node[] };
    const count = (nodes: Node[]): number =>
      nodes.reduce(
        (n, node) =>
          n +
          (String(node.kind).toLowerCase().includes("textframe") ? 1 : 0) +
          count(node.children ?? []),
        0,
      );
    return count(reply.payload.roots as Node[]);
  });
}

const undoLen = (page: Page) =>
  page.evaluate(
    async () =>
      (
        await (
          globalThis as unknown as { __canvas: Canvas }
        ).__canvas.client.undoLog()
      ).undoLen,
  );

test.describe("E2E History panel @feat:editor-shell.panels.history", () => {
  test("Edit ▸ History lists three steps; a click goes back to step 1 and forward again @level:smoke", async ({
    page,
  }) => {
    covers("menu:Edit/History");
    await newBlankDocument(page);
    await threeEdits(page);
    expect(await textFrames(page)).toBe(3);

    await clickMenuRow(page, "Edit/History");
    const panel = page.locator("[data-history-panel]");
    await expect(panel).toBeVisible();
    const steps = panel.locator("[data-history-step]");
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toHaveText("Insert text frame");
    await expect(steps.nth(2)).toHaveAttribute("data-history-state", "current");

    // The first step: the document as it was after step 1.
    await steps.nth(0).click();
    await expect(steps.nth(0)).toHaveAttribute("data-history-state", "current");
    await expect(steps.nth(2)).toHaveAttribute("data-history-state", "undone");
    expect(await undoLen(page)).toBe(1);
    expect(await textFrames(page)).toBe(1);

    // The last (undone) step: redo up to it.
    await steps.nth(2).click();
    await expect(steps.nth(2)).toHaveAttribute("data-history-state", "current");
    expect(await undoLen(page)).toBe(3);
    expect(await textFrames(page)).toBe(3);
  });
});
