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

// Engine ADR 1008 — the Effects panel's stack, end to end: add a
// Gaussian blur and an outline stroke to a frame from the Add menu, read
// the stack back from the ENGINE (`RequestGet`, past the object model),
// see the render change, reorder them, switch one off, and undo each
// gesture in one step.

import { expect, test, type Locator, type Page } from "@playwright/test";

import { openCanvas, openPanel } from "./fidelity/canvas-driver";
import { loadFixture, type ElementRef } from "./e2e/harness/fixtures";
import { mutate, selectElements } from "./e2e/harness/ui";
import { undoOnce } from "./e2e/harness/objects";
import {
  engineGet,
  expectRenderChange,
  pageRender,
} from "./e2e/harness/engine";

const addr = (r: ElementRef) => `${r.kind}:${r.id}`;

type Entry = { kind: string; enabled: boolean };

async function stackOf(page: Page, ref: ElementRef): Promise<Entry[]> {
  const v = (await engineGet(page, addr(ref), "frameEffectStack")) as {
    entries?: Entry[];
  } | null;
  return (v?.entries ?? []).map((e) => ({ kind: e.kind, enabled: e.enabled }));
}

const kinds = (s: Entry[]) => s.map((e) => e.kind);

async function effectsPanel(page: Page): Promise<Locator> {
  await openPanel(page, "paged.effects");
  const panel = page.locator('[data-effects-panel="ready"]');
  await expect(panel).toBeVisible();
  return panel;
}

test.describe("Effects ▸ effect stack (engine ADR 1008)", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    await openCanvas(page);
  });

  test("EFX-STACK-add-reorder-undo — add a blur and an outline stroke, reorder, switch off, one undo each @feat:effects-transparency.effect-stack @feat:editor-shell.panels.effects @feat:round-tripping.undo-redo @level:happy", async ({
    page,
  }) => {
    const fx = await loadFixture(page, "geometry");
    const ref = fx.firstRectangle as ElementRef;
    expect(ref, "geometry has a rectangle").not.toBeNull();
    await mutate(page, {
      op: "setElementProperty",
      args: {
        elementId: ref,
        path: "frameFillColor",
        value: { type: "colorRef", value: "Color/Black" },
      },
    });
    await selectElements(page, [ref]);
    const panel = await effectsPanel(page);
    const stack = panel.locator('[data-effect-stack="object"]');
    await expect(stack).toBeVisible();
    const before = await stackOf(page, ref);
    const render0 = await pageRender(page, fx.pages[0]!);

    // Add a Gaussian blur, then an outline stroke.
    await stack.locator("select[data-effect-stack-add]").selectOption("gaussianBlur");
    await expect
      .poll(async () => kinds(await stackOf(page, ref)))
      .toEqual([...kinds(before), "gaussianBlur"]);
    await expectRenderChange(page, fx.pages[0]!, render0);
    await stack.locator("select[data-effect-stack-add]").selectOption("outlineStroke");
    await expect
      .poll(async () => kinds(await stackOf(page, ref)))
      .toEqual([...kinds(before), "gaussianBlur", "outlineStroke"]);
    await expect(stack.locator("[data-effect-stack-row]")).toHaveCount(
      before.length + 2,
    );

    // The stroke's size, in its own fields.
    const strokeRow = stack.locator('[data-effect-stack-row="outlineStroke"]');
    await strokeRow.locator("[data-effect-stack-open]").click();
    const size = strokeRow.locator('[data-effect-param="sizePt"] input');
    await size.click();
    await size.fill("6");
    await size.press("Enter");
    await expect
      .poll(async () => {
        const v = (await engineGet(page, addr(ref), "frameEffectStack")) as {
          entries: Array<{ kind: string; sizePt?: number }>;
        };
        return v.entries.find((e) => e.kind === "outlineStroke")?.sizePt;
      })
      .toBe(6);

    // Reorder: the stroke moves above the blur.
    await strokeRow.locator('[data-effect-stack-action="up"]').click();
    await expect
      .poll(async () => kinds(await stackOf(page, ref)))
      .toEqual([...kinds(before), "outlineStroke", "gaussianBlur"]);

    // Switch the blur off: it stays on the stack.
    await stack
      .locator('[data-toggle-switch="stack:gaussianBlur"]')
      .click();
    await expect
      .poll(async () =>
        (await stackOf(page, ref)).find((e) => e.kind === "gaussianBlur")
          ?.enabled,
      )
      .toBe(false);

    // One undo per gesture: off, reorder, size, stroke, blur.
    await undoOnce(page);
    await expect
      .poll(async () =>
        (await stackOf(page, ref)).find((e) => e.kind === "gaussianBlur")
          ?.enabled,
      )
      .toBe(true);
    await undoOnce(page);
    await expect
      .poll(async () => kinds(await stackOf(page, ref)))
      .toEqual([...kinds(before), "gaussianBlur", "outlineStroke"]);
    await undoOnce(page);
    await undoOnce(page);
    await expect
      .poll(async () => kinds(await stackOf(page, ref)))
      .toEqual([...kinds(before), "gaussianBlur"]);
    await undoOnce(page);
    await expect.poll(async () => stackOf(page, ref)).toEqual(before);
  });

  test("EFX-STACK-targets — a fill target offers InDesign's effects only @feat:effects-transparency.effect-stack @level:smoke", async ({
    page,
  }) => {
    const fx = await loadFixture(page, "geometry");
    await selectElements(page, [fx.firstRectangle as ElementRef]);
    const panel = await effectsPanel(page);
    await panel.locator('[data-effects-target="fill"]').click();
    const add = panel.locator(
      '[data-effect-stack="fill"] select[data-effect-stack-add]',
    );
    await expect(add).toBeVisible();
    const offered = await add.locator("option").evaluateAll((os) =>
      os.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
    );
    expect(offered).toContain("innerGlow");
    expect(offered).not.toContain("gaussianBlur");
  });
});
