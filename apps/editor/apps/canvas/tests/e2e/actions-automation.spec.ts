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

// Visual action automation (task PX4 of the interaction plan; editor ADR
// 1240; the strategy's Concept F). In the running editor, on the contract's
// fixture A: an alignment from the Align command and a stroke weight from
// the Properties panel's field are recorded as what they meant (the
// selection), previewed on ANOTHER selection without changing anything,
// and run there as one undo step (UXI-MUT-013, UXI-MUT-004); a step pinned
// to an object the document no longer holds is refused by name, the model
// and the history unchanged (UXI-MUT-014). Every test asserts the model and
// the engine's undo log.
//
// Amendment 1 (editor ADR 1240): a drag and a handle resize on the canvas
// record as what they did to the selection — a move by (dx, dy) pt and a
// resize to w × h keeping the opposite corner — and replay on another
// selection as the same transform, one undo step.

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { openPanel } from "../fidelity/canvas-driver";
import { elementPageRectPt } from "./harness/fixtures";
import { idsOfKind, selectElements } from "./harness/gesture-kit";
import {
  activateTool,
  dragBy,
  dragStartOnObject,
  movePointerBy,
  releasePointer,
} from "./harness/interaction";
import { historyDepth, undoDepth } from "./harness/history";
import { modelSnapshot } from "./harness/model-dump";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

const A = UXI_A;
type Ref = { kind: string; id: string };
const addressOf = (r: Ref) => `${r.kind}:${r.id}`;

interface CanvasGlobal {
  __canvas: {
    registries: {
      commands: { invoke(id: string, p?: unknown): Promise<unknown> };
    };
    objects: {
      get(a: string, p: string): Promise<{ kind: string; value?: unknown }>;
    };
    client: {
      mutate(m: unknown): Promise<{ kind: string }>;
      undo(): Promise<unknown>;
    };
  };
}

async function invoke(page: Page, id: string, payload?: unknown) {
  await page.evaluate(
    ([command, args]) =>
      (
        globalThis as unknown as CanvasGlobal
      ).__canvas.registries.commands.invoke(command as string, args),
    [id, payload] as const,
  );
}

async function strokeWeight(page: Page, ref: Ref): Promise<unknown> {
  return page.evaluate(async (a) => {
    const v = await (
      globalThis as unknown as CanvasGlobal
    ).__canvas.objects.get(a, "frameStrokeWeight");
    return v.kind === "value" ? v.value : v.kind;
  }, addressOf(ref));
}

const panel = (page: Page) => page.locator("[data-actions-panel]");
const btn = (page: Page, name: string) =>
  page.locator(`[data-cockpit-action="${name}"]`);

/** Record what `body` does as an action named `name`; its id. */
async function record(
  page: Page,
  name: string,
  body: () => Promise<void>,
): Promise<string> {
  await openPanel(page, "paged.actions");
  await btn(page, "actions-record").click();
  await expect(page.locator("[data-actions-recording]")).toBeVisible();
  await body();
  await openPanel(page, "paged.actions");
  await page.locator("[data-actions-name]").fill(name);
  await btn(page, "actions-stop").click();
  const row = panel(page).locator("[data-actions-row]").last();
  await expect(row.locator("[data-actions-open]")).toHaveText(name);
  return (await row.getAttribute("data-actions-row"))!;
}

test.describe("Actions record what you meant (PX4, ADR 1240)", () => {
  test.describe.configure({ timeout: 120_000 });

  test("an alignment and a field edit, recorded on one selection, preview and run on another as ONE undo step @feat:editor-shell.panels.actions @level:happy @uxi:UXI-MUT-013 @uxi:UXI-MUT-004", async ({
    page,
  }) => {
    covers("panel:paged.actions");
    await openUxiFixture(page, "A");
    await selectElements(page, [A.back.id, A.front.id]);
    const id = await record(page, "Align and stroke", async () => {
      // What the Align panel sends: the selection's addresses.
      await invoke(page, "paged.align.objects", {
        kind: "left",
        targets: [addressOf(A.back.id), addressOf(A.front.id)],
        to: "selection",
      });
      await openPanel(page, "paged.properties");
      const weight = page
        .locator('[data-property-field="frameStrokeWeight"] input')
        .first();
      await weight.click();
      await weight.fill("6");
      await weight.press("Enter");
      await expect.poll(() => strokeWeight(page, A.front.id)).toBe(6);
    });
    // Stop opened the new action's detail.
    await expect(
      panel(page).locator(`[data-actions-detail="${id}"]`),
    ).toBeVisible();
    // Both steps are portable: the selection was recorded as an intent.
    await expect(panel(page).locator("[data-actions-verdict]")).toHaveText([
      "portable",
      "portable",
    ]);

    // Another selection: the front and the free rectangle.
    await selectElements(page, [A.front.id, A.free.id]);
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);
    const freeBefore = (await elementPageRectPt(page, A.free.id))!;
    const frontBefore = (await elementPageRectPt(page, A.front.id))!;
    const backBefore = (await elementPageRectPt(page, A.back.id))!;

    // The preview outlines exactly the targets and changes nothing.
    await btn(page, `actions-preview-${id}`).click();
    const preview = page.locator(`[data-actions-preview="${id}"]`);
    await expect(preview).toBeVisible();
    await expect(
      preview.locator("[data-actions-undo-statement]"),
    ).toHaveAttribute("data-actions-undo-statement", "one");
    await expect(
      page.locator('[data-preview-targets="actions"]'),
    ).toHaveAttribute("data-preview-count", "2");
    await expect(page.locator("[data-preview-target]")).toHaveCount(2);
    const outlined = await page
      .locator("[data-preview-target]")
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute("data-preview-target")).sort(),
      );
    expect(outlined).toEqual(
      [addressOf(A.free.id), addressOf(A.front.id)].sort(),
    );
    expect(await modelSnapshot(page), "a preview changes nothing").toBe(model);
    expect(await historyDepth(page)).toEqual(history);

    // Run: one undo step; the new selection aligned and stroked, the
    // recorded selection's other member untouched.
    await btn(page, "actions-run").click();
    await expect.poll(() => undoDepth(page)).toBe(history.undo + 1);
    await expect(page.locator("[data-preview-targets]")).toHaveCount(0);
    const freeAfter = (await elementPageRectPt(page, A.free.id))!;
    expect(freeAfter.left).toBeCloseTo(frontBefore.left, 3);
    expect(freeAfter.top).toBeCloseTo(freeBefore.top, 3);
    expect(await strokeWeight(page, A.free.id)).toBe(6);
    expect(await elementPageRectPt(page, A.back.id)).toEqual(backBefore);
    await expect(panel(page).locator("[data-actions-undo]")).toContainText(
      "one undo step",
    );

    // One Undo takes the whole run back.
    await page.evaluate(() =>
      (globalThis as unknown as CanvasGlobal).__canvas.client.undo(),
    );
    await expect.poll(() => modelSnapshot(page)).toBe(model);
  });

  test("a drag and a resize on the canvas, recorded, replay on another selection as the same transform in ONE undo step @feat:editor-shell.panels.actions @feat:editor-tools.move.translate @feat:editor-tools.resize.handles @level:gesture @uxi:UXI-MUT-013 @uxi:UXI-MUT-004", async ({
    page,
  }) => {
    covers(
      "panel:paged.actions",
      "tool:paged.tool.select",
      "command:paged.object.transformSelection",
    );
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
    await selectElements(page, [A.free.id]);
    const freeBefore = (await elementPageRectPt(page, A.free.id))!;
    let moved = freeBefore;
    const id = await record(page, "Drag and resize", async () => {
      // A drag of the selected rectangle…
      const depth = await undoDepth(page);
      await dragBy(page, A.free.id, 60, 40);
      await expect.poll(() => undoDepth(page)).toBe(depth + 1);
      moved = (await elementPageRectPt(page, A.free.id))!;
      expect(moved.left).not.toBeCloseTo(freeBefore.left, 1);
      // …then its south-east handle.
      const handle = page
        .locator(
          '[data-selection-handle="southEast"] > rect[data-handle="southEast"]',
        )
        .last();
      await expect(handle).toHaveCount(1);
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 50, box.y + 30, { steps: 8 });
      await page.mouse.up();
      await expect.poll(() => undoDepth(page)).toBe(depth + 2);
      // The recorder has both commits as steps.
      await expect(page.locator("[data-actions-step-count]")).toHaveText("2");
    });
    await expect(
      panel(page).locator(`[data-actions-detail="${id}"]`),
    ).toBeVisible();
    const steps = panel(page).locator("[data-actions-step]");
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toContainText("Move the selection by");
    await expect(steps.nth(1)).toContainText("Resize to");
    await expect(steps.nth(1)).toContainText("keeping the top left corner");
    // Recorded as intents on the selection: no ids, nothing uncaptured.
    await expect(panel(page).locator("[data-actions-verdict]")).toHaveText([
      "portable",
      "portable",
    ]);
    const done = (await elementPageRectPt(page, A.free.id))!;
    const dx = moved.left - freeBefore.left;
    const dy = moved.top - freeBefore.top;
    const width = done.right - done.left;
    const height = done.bottom - done.top;
    expect(width).not.toBeCloseTo(freeBefore.right - freeBefore.left, 1);

    // Another selection: the back rectangle, of another size.
    await selectElements(page, [A.back.id]);
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);
    const backBefore = (await elementPageRectPt(page, A.back.id))!;

    // The preview outlines it and changes nothing.
    await btn(page, `actions-preview-${id}`).click();
    const preview = page.locator(`[data-actions-preview="${id}"]`);
    await expect(preview).toBeVisible();
    await expect(
      preview.locator("[data-actions-undo-statement]"),
    ).toHaveAttribute("data-actions-undo-statement", "one");
    await expect(page.locator("[data-preview-target]")).toHaveCount(1);
    await expect(page.locator("[data-preview-target]")).toHaveAttribute(
      "data-preview-target",
      addressOf(A.back.id),
    );
    expect(await modelSnapshot(page), "a preview changes nothing").toBe(model);
    expect(await historyDepth(page)).toEqual(history);

    // Run: one undo step; the back rectangle moved by the same (dx, dy)
    // and took the same size, its top left corner where the move put it.
    await btn(page, "actions-run").click();
    await expect.poll(() => undoDepth(page)).toBe(history.undo + 1);
    const backAfter = (await elementPageRectPt(page, A.back.id))!;
    expect(backAfter.left).toBeCloseTo(backBefore.left + dx, 2);
    expect(backAfter.top).toBeCloseTo(backBefore.top + dy, 2);
    expect(backAfter.right - backAfter.left).toBeCloseTo(width, 2);
    expect(backAfter.bottom - backAfter.top).toBeCloseTo(height, 2);
    expect(await elementPageRectPt(page, A.free.id)).toEqual(done);

    // One Undo takes the whole run back.
    await page.evaluate(() =>
      (globalThis as unknown as CanvasGlobal).__canvas.client.undo(),
    );
    await expect.poll(() => modelSnapshot(page)).toBe(model);
  });

  test("an Alt-drag copy, recorded, replays on another selection as a copy at the same offset in ONE undo step @feat:editor-shell.panels.actions @feat:editor-tools.move.duplicate-drag @level:gesture @uxi:UXI-MUT-013", async ({
    page,
  }) => {
    covers(
      "panel:paged.actions",
      "tool:paged.tool.select",
      "command:paged.object.transformSelection",
    );
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
    await selectElements(page, [A.free.id]);
    const freeBefore = (await elementPageRectPt(page, A.free.id))!;
    const before = await idsOfKind(page, "rectangle");
    const id = await record(page, "Copy aside", async () => {
      const depth = await undoDepth(page);
      await page.keyboard.down("Alt");
      await dragStartOnObject(page, A.free.id);
      await movePointerBy(page, 60, 40);
      await releasePointer(page);
      await page.keyboard.up("Alt");
      await expect.poll(() => undoDepth(page)).toBe(depth + 1);
      await expect(page.locator("[data-actions-step-count]")).toHaveText("1");
    });
    await expect(panel(page).locator("[data-actions-step]")).toContainText(
      "Copy the selection, offset",
    );
    // The copy the drag left, and its offset from the original.
    const copy = (await idsOfKind(page, "rectangle")).find(
      (r) => !before.includes(r),
    )!;
    const copied = (await elementPageRectPt(page, {
      kind: "rectangle",
      id: copy,
    }))!;
    const dx = copied.left - freeBefore.left;
    const dy = copied.top - freeBefore.top;
    expect(Math.abs(dx)).toBeGreaterThan(1);

    // Another selection: the back rectangle gets a copy at that offset.
    await selectElements(page, [A.back.id]);
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);
    const backBefore = (await elementPageRectPt(page, A.back.id))!;
    const known = await idsOfKind(page, "rectangle");
    await btn(page, `actions-play-${id}`).click();
    await expect.poll(() => undoDepth(page)).toBe(history.undo + 1);
    const made = (await idsOfKind(page, "rectangle")).filter(
      (r) => !known.includes(r),
    );
    expect(made).toHaveLength(1);
    const backCopy = (await elementPageRectPt(page, {
      kind: "rectangle",
      id: made[0]!,
    }))!;
    expect(backCopy.left).toBeCloseTo(backBefore.left + dx, 2);
    expect(backCopy.top).toBeCloseTo(backBefore.top + dy, 2);
    expect(backCopy.right - backCopy.left).toBeCloseTo(
      backBefore.right - backBefore.left,
      2,
    );
    expect(await elementPageRectPt(page, A.back.id)).toEqual(backBefore);

    await page.evaluate(() =>
      (globalThis as unknown as CanvasGlobal).__canvas.client.undo(),
    );
    await expect.poll(() => modelSnapshot(page)).toBe(model);
  });

  test("a step pinned to an object the document no longer holds is refused by name; nothing changes @feat:editor-shell.panels.actions @level:edge @uxi:UXI-MUT-014", async ({
    page,
  }) => {
    covers("panel:paged.actions");
    await openUxiFixture(page, "A");
    // The selection is the free rectangle; the step names two others, so
    // they are object references, not the selection.
    await selectElements(page, [A.free.id]);
    const id = await record(page, "Pinned", async () => {
      await invoke(page, "paged.align.objects", {
        kind: "top",
        targets: [addressOf(A.back.id), addressOf(A.front.id)],
        to: "selection",
      });
    });
    // Stop opened the new action's detail.
    await expect(
      panel(page).locator(`[data-actions-detail="${id}"]`),
    ).toBeVisible();
    await expect(panel(page).locator("[data-actions-verdict]")).toHaveText([
      "doc ids",
    ]);
    await panel(page).locator("[data-actions-include-docbound]").check();
    // The back rectangle goes.
    await page.evaluate(async (a) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas;
      const r = await c.client.mutate({
        op: "deleteFrame",
        args: { frameId: a },
      });
      if (r.kind !== "mutationApplied") throw new Error(r.kind);
    }, A.back.id.id);
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);

    await btn(page, `actions-play-${id}`).click();
    const refusal = panel(page).locator("[data-actions-report-refusal]");
    await expect(refusal).toContainText("Step 1");
    await expect(refusal).toContainText(addressOf(A.back.id));
    await expect(refusal).toContainText("not in this document");
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);
  });

  test("an action kept in the document is a label on it, written as one undo step @feat:editor-shell.panels.actions @level:edge", async ({
    page,
  }) => {
    covers("panel:paged.actions");
    await openUxiFixture(page, "A");
    await selectElements(page, [A.back.id, A.front.id]);
    const id = await record(page, "Kept here", async () => {
      await invoke(page, "paged.align.objects", {
        kind: "left",
        targets: [addressOf(A.back.id), addressOf(A.front.id)],
        to: "selection",
      });
    });
    // Stop opened the new action's detail.
    await expect(
      panel(page).locator(`[data-actions-detail="${id}"]`),
    ).toBeVisible();
    const depth = await undoDepth(page);
    await panel(page)
      .locator("[data-actions-scope-select]")
      .selectOption("document");
    await expect.poll(() => undoDepth(page)).toBe(depth + 1);
    await expect(
      panel(page).locator(`[data-actions-row="${id}"] [data-actions-scope]`),
    ).toHaveAttribute("data-actions-scope", "document");
    const label = await page.evaluate(async () => {
      const v = await (
        globalThis as unknown as CanvasGlobal
      ).__canvas.objects.get("doc", "labels");
      return v.kind === "value"
        ? ((v.value as Record<string, string>)["x-paged:actions"] ?? null)
        : null;
    });
    expect(JSON.parse(label!).data.actions[0].name).toBe("Kept here");
  });
});
