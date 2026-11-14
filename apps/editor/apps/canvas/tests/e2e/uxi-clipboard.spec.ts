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

// The clipboard (interaction spec §16.2, UXI-CLP-001…005; editor ADRs 231
// and 289; task DF9 of interaction-plan.md): copy and paste of several
// native objects keep what they are and where they stand to each other,
// Paste in place is not an offset paste, Cut is one step, and verbs typed
// quickly run in the order they were typed (SH-201's race). Every test
// asserts the model and the undo history.

import { expect, test, type Page } from "@playwright/test";

import { expectUndoSteps, historyDepth } from "./harness/history";
import { modelSnapshot, selectionSnapshot } from "./harness/model-dump";
import { select } from "./harness/shell-surface";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

type Id = { kind: string; id: string };
type Geometry = {
  pageId?: string | null;
  bounds: number[];
  itemTransform?: number[] | null;
};

type Win = {
  __canvas: {
    client: {
      elementGeometry(ids: Id[]): Promise<Geometry[]>;
      sceneTree(): Promise<Array<{ id?: Id | null; children?: unknown[] }>>;
    };
    elementSelection?: Id[] | null;
    registries: { commands: { invoke(id: string): Promise<unknown> } };
  };
};

/** Every page item id in the document. */
const itemIds = (page: Page) =>
  page.evaluate(async () => {
    const tree = await (
      globalThis as unknown as Win
    ).__canvas.client.sceneTree();
    const out: string[] = [];
    const visit = (n: { id?: Id | null; children?: unknown[] }) => {
      if (n.id && typeof n.id.id === "string")
        out.push(`${n.id.kind}:${n.id.id}`);
      for (const c of (n.children ?? []) as Array<typeof n>) visit(c);
    };
    for (const r of tree) visit(r);
    return out;
  });

/** Each id's box on its page, through its transform: `[x, y, w, h]`. */
const boxes = (page: Page, ids: Id[]) =>
  page.evaluate(async (list) => {
    const g = await (
      globalThis as unknown as Win
    ).__canvas.client.elementGeometry(list);
    return g.map(({ bounds, itemTransform, pageId }) => {
      const [top, left, bottom, right] = bounds as [
        number,
        number,
        number,
        number,
      ];
      const [, , , , tx, ty] = itemTransform ?? [1, 0, 0, 1, 0, 0];
      return {
        pageId: pageId ?? null,
        x: left + (tx as number),
        y: top + (ty as number),
        w: right - left,
        h: bottom - top,
      };
    });
  }, ids);

const selected = async (page: Page): Promise<Id[]> =>
  (await selectionSnapshot(page)).elements;

const close = (a: number, b: number) => Math.abs(a - b) < 0.01;

const TWO: Id[] = [UXI_A.back.id, UXI_A.free.id];

test.describe("UXI-T65 — the clipboard", () => {
  test("UXI-T65 — copy and paste two native objects: both pasted, as rectangles, their spacing kept, one undo step @feat:editor-shell.menus @feat:round-tripping.undo-redo @uxi:UXI-CLP-001 @uxi:UXI-CLP-003 @level:happy", async ({
    page,
  }) => {
    await openUxiFixture(page, "A");
    await select(page, TWO);
    const source = await boxes(page, TWO);
    const before = await itemIds(page);
    const model = await modelSnapshot(page);

    // Cmd+C then Cmd+V as fast as the keyboard sends them: the paste waits
    // for the copy (SH-201 saw the paste run first and paste nothing).
    await expectUndoSteps(page, 1, async () => {
      await page.keyboard.press("Meta+KeyC");
      await page.keyboard.press("Meta+KeyV");
      await expect
        .poll(async () => (await itemIds(page)).length, { timeout: 10_000 })
        .toBe(before.length + 2);
    });
    const made = (await itemIds(page)).filter((id) => !before.includes(id));
    expect(made.every((id) => id.startsWith("rectangle:"))).toBe(true);
    // The paste is what is selected.
    const sel = await selected(page);
    expect(sel.map((s) => `${s.kind}:${s.id}`).sort()).toEqual(
      [...made].sort(),
    );
    // Relative geometry: the two copies stand to each other as the sources.
    const pasted = await boxes(page, sel);
    const order = pasted
      .map((b, i) => ({ b, i }))
      .sort((p, q) => p.b.x - q.b.x)
      .map((p) => p.b);
    const src = [...source].sort((p, q) => p.x - q.x);
    expect(close(order[1]!.x - order[0]!.x, src[1]!.x - src[0]!.x)).toBe(true);
    expect(close(order[1]!.y - order[0]!.y, src[1]!.y - src[0]!.y)).toBe(true);
    expect(order.map((b) => [b.w, b.h])).toEqual(src.map((b) => [b.w, b.h]));

    // One undo takes the whole paste back: the model is as it was.
    await page.evaluate(() =>
      (globalThis as unknown as Win).__canvas.registries.commands.invoke(
        "paged.editor.undo",
      ),
    );
    await expect.poll(() => modelSnapshot(page)).toBe(model);
  });

  test("UXI-T65 — Paste in place keeps each item's position (not an offset paste), one undo step @feat:editor-shell.menus @feat:round-tripping.undo-redo @uxi:UXI-CLP-003 @level:happy", async ({
    page,
  }) => {
    await openUxiFixture(page, "A");
    await select(page, TWO);
    const source = await boxes(page, TWO);
    const before = await itemIds(page);
    await page.keyboard.press("Meta+KeyC");
    await expectUndoSteps(page, 1, async () => {
      await page.keyboard.press("Meta+Alt+Shift+KeyV");
      await expect
        .poll(async () => (await itemIds(page)).length, { timeout: 10_000 })
        .toBe(before.length + 2);
    });
    const pasted = await boxes(page, await selected(page));
    const key = (b: { x: number; y: number }) =>
      `${b.x.toFixed(2)},${b.y.toFixed(2)}`;
    expect(pasted.map(key).sort()).toEqual(source.map(key).sort());
    expect(pasted.every((b) => b.pageId === source[0]!.pageId)).toBe(true);
  });

  test("UXI-T65 — Cut is one step: the items go, the clip holds them, one undo brings them back @feat:editor-shell.menus @feat:round-tripping.undo-redo @uxi:UXI-CLP-002 @level:edge", async ({
    page,
  }) => {
    await openUxiFixture(page, "A");
    const model = await modelSnapshot(page);
    const before = await itemIds(page);
    await select(page, TWO);
    await expectUndoSteps(page, 1, async () => {
      await page.keyboard.press("Meta+KeyX");
      await expect
        .poll(async () => (await itemIds(page)).length, { timeout: 10_000 })
        .toBe(before.length - 2);
    });
    // The cut items are on the clipboard: Paste brings two back.
    await expectUndoSteps(page, 1, async () => {
      await page.keyboard.press("Meta+KeyV");
      await expect
        .poll(async () => (await itemIds(page)).length, { timeout: 10_000 })
        .toBe(before.length);
    });
    // Two undos: the paste, then the cut — the document is as it was.
    for (let i = 0; i < 2; i++)
      await page.evaluate(() =>
        (globalThis as unknown as Win).__canvas.registries.commands.invoke(
          "paged.editor.undo",
        ),
      );
    await expect.poll(() => modelSnapshot(page)).toBe(model);
    expect((await historyDepth(page)).redo).toBe(2);
  });

  test("UXI-T65 — inside a text caret the story owns the keys: no object is pasted @feat:editor-shell.menus @uxi:UXI-CLP-001 @uxi:UXI-CLP-005 @level:edge", async ({
    page,
  }) => {
    await openUxiFixture(page, "A");
    await select(page, [UXI_A.free.id]);
    await page.keyboard.press("Meta+KeyC");
    const before = await itemIds(page);
    // A caret in the note's story: object paste does not apply there.
    await page.evaluate(
      ({ storyId }) =>
        (
          globalThis as unknown as {
            __canvas: { setContentSelection(s: unknown): void };
          }
        ).__canvas.setContentSelection({ storyId, start: 0, end: 0 }),
      { storyId: UXI_A.note.storyId },
    );
    await page.evaluate(() =>
      (globalThis as unknown as Win).__canvas.registries.commands.invoke(
        "paged.edit.paste",
      ),
    );
    await page.waitForTimeout(300);
    expect(await itemIds(page)).toEqual(before);
  });
});
