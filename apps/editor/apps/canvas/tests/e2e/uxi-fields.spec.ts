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

// The one numeric field in the running editor (track FI, the interaction
// spec's §15.1–15.2): a scrub previews live and is ONE undo step, Escape
// mid-scrub puts the document back, a typed expression is one step, and a
// relative entry over a mixed selection gives each object its own value in
// one step. Each asserts the document and the engine's undo log.

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { openPanel } from "../fidelity/canvas-driver";
import { selectElements } from "./harness/gesture-kit";
import {
  expectHistoryUnchanged,
  expectUndoSteps,
  historyDepth,
  undoDepth,
} from "./harness/history";
import { activateTool } from "./harness/interaction";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

const A = UXI_A;
const WEIGHT = '[data-stroke-panel="ready"] [data-control="frameStrokeWeight"]';

/** An element's stroke weight as the engine reads it (pt). */
async function strokeWeight(
  page: Page,
  id: { kind: string; id: string },
): Promise<number | null> {
  return page.evaluate(async (elementId) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            elementProperties(id: unknown): Promise<{
              entries: Array<{
                path: string;
                value: { value?: unknown } | null;
              }>;
            }>;
          };
        };
      }
    ).__canvas;
    const props = await c.client.elementProperties(elementId);
    const v = props.entries.find((e) => e.path === "frameStrokeWeight")?.value
      ?.value;
    return typeof v === "number" ? v : null;
  }, id);
}

async function setStrokeWeight(
  page: Page,
  id: { kind: string; id: string },
  value: number,
): Promise<void> {
  await page.evaluate(
    async ([elementId, v]) => {
      const c = (
        globalThis as unknown as {
          __canvas: { client: { mutate(m: unknown): Promise<unknown> } };
        }
      ).__canvas;
      await c.client.mutate({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameStrokeWeight",
          value: { type: "length", value: v },
        },
      });
    },
    [id, value] as const,
  );
}

async function handleCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page
    .locator(`${WEIGHT} [data-scrub-handle]`)
    .boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe("UXI FI1 — the one numeric field in the editor", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
    await setStrokeWeight(page, A.back.id, 1);
    await setStrokeWeight(page, A.front.id, 4);
    await selectElements(page, [A.back.id]);
    await openPanel(page, "paged.stroke");
    await expect(page.locator(`${WEIGHT} input`)).toHaveValue("1 pt");
  });

  test("@uxi:UXI-PNL-005 — a scrub of the stroke weight previews live and is one undo step @uxi:UXI-PNL-002 @feat:editor-shell.panels.stroke @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.stroke");
    const at = await handleCentre(page);
    await expectUndoSteps(
      page,
      1,
      async () => {
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.mouse.move(at.x + 3, at.y, { steps: 3 });
        // Live: the document follows the scrub before the release.
        await expect.poll(() => strokeWeight(page, A.back.id)).toBe(4);
        await page.mouse.move(at.x + 5, at.y, { steps: 2 });
        await page.mouse.up();
      },
      "a scrub",
    );
    expect(await strokeWeight(page, A.back.id)).toBe(6);
    await expect(page.locator(`${WEIGHT} input`)).toHaveValue("6 pt");
    // One undo takes the whole scrub back.
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          __canvas: { client: { undo(): Promise<unknown> } };
        }
      ).__canvas.client.undo(),
    );
    await expect.poll(() => strokeWeight(page, A.back.id)).toBe(1);
  });

  test("@uxi:UXI-PNL-005 — Escape mid-scrub puts the document back and leaves no step @feat:editor-shell.panels.stroke @level:edge", async ({
    page,
  }) => {
    covers("panel:paged.stroke");
    const before = await undoDepth(page);
    const at = await handleCentre(page);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 6, at.y, { steps: 3 });
    await expect.poll(() => strokeWeight(page, A.back.id)).toBe(7);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(() => strokeWeight(page, A.back.id)).toBe(1);
    await expect.poll(() => undoDepth(page)).toBe(before);
    await expect(page.locator(`${WEIGHT} input`)).toHaveValue("1 pt");
  });

  test("@uxi:UXI-PNL-009 — a typed expression with mixed units is one step @feat:editor-shell.panels.stroke @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.stroke");
    const field = page.locator(`${WEIGHT} input`);
    await expectUndoSteps(page, 1, async () => {
      await field.click();
      await field.fill("1 mm + 2 pt");
      await field.press("Enter");
    });
    await expect
      .poll(() => strokeWeight(page, A.back.id))
      .toBeCloseTo(72 / 25.4 + 2, 1);
    // A refused value says why and writes nothing.
    const depth = await historyDepth(page);
    await field.click();
    await field.fill("3 furlongs");
    await field.press("Enter");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator(`${WEIGHT} [role="alert"]`)).toHaveText(
      "This field does not take furlongs",
    );
    await field.press("Escape");
    expect(await historyDepth(page)).toEqual(depth);
  });

  test("@uxi:UXI-PNL-010 — two objects that differ read Mixed; +=2 gives each its own value in one step @uxi:UXI-PNL-008 @uxi:UXI-SEL-016 @uxi:UXI-SEL-017 @feat:editor-shell.panels.stroke @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.stroke");
    await selectElements(page, [A.back.id, A.front.id]);
    const field = page.locator(`${WEIGHT} input`);
    await expect(field).toHaveValue("Mixed");
    await expectUndoSteps(page, 1, async () => {
      await field.click();
      await field.fill("+=2");
      await field.press("Enter");
    });
    await expect.poll(() => strokeWeight(page, A.back.id)).toBe(3);
    await expect.poll(() => strokeWeight(page, A.front.id)).toBe(6);
    // *150% scales each.
    await expectUndoSteps(page, 1, async () => {
      await field.click();
      await field.fill("*150%");
      await field.press("Enter");
    });
    await expect.poll(() => strokeWeight(page, A.back.id)).toBe(4.5);
    await expect.poll(() => strokeWeight(page, A.front.id)).toBe(9);
  });
});

test.describe("UXI FI2/FI3 — Properties as an inspector, the control bar as an accelerator", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
    await setStrokeWeight(page, A.back.id, 1);
    await setStrokeWeight(page, A.front.id, 4);
    await openPanel(page, "paged.properties");
  });

  test("@uxi:UXI-PNL-001 — a search for a synonym opens the section that holds it, and the field takes a value in one step @feat:editor-shell.panels.properties @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.properties");
    await selectElements(page, [A.back.id]);
    const props = page.locator('[data-properties-panel="ready"]');
    const search = props.locator("[data-inspector-search-input]");
    await search.fill("border");
    await expect(
      props.locator('[data-inspector-section="stroke"]'),
    ).toBeVisible();
    await expect(
      props.locator('[data-inspector-section="object"]'),
    ).toBeHidden();
    await search.press("Enter");
    const focused = page.locator(":focus");
    await expect(focused).toHaveAttribute("inputmode", "decimal");
    await expectUndoSteps(page, 1, async () => {
      await focused.fill("2.5");
      await focused.press("Enter");
    });
    await expect.poll(() => strokeWeight(page, A.back.id)).toBe(2.5);
    await search.fill("");
    await expect(
      props.locator('[data-inspector-section="object"]'),
    ).toBeVisible();
  });

  test("@uxi:UXI-PNL-010 — a multi-selection states its scope, and +=1 in Properties gives each object its own value in one step @uxi:UXI-SEL-017 @feat:editor-shell.panels.properties @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.properties");
    await selectElements(page, [A.back.id, A.front.id]);
    const props = page.locator('[data-properties-panel="ready"]');
    await expect(props.locator("[data-inspector-scope-label]")).toHaveText(
      "2 objects · 2 rectangles",
    );
    const weight = props.locator(
      '[data-properties-section="stroke"] [data-control="frameStrokeWeight"] input',
    );
    await expect(weight).toHaveValue("Mixed");
    await expectUndoSteps(page, 1, async () => {
      await weight.click();
      await weight.fill("+=1");
      await weight.press("Enter");
    });
    await expect.poll(() => strokeWeight(page, A.back.id)).toBe(2);
    await expect.poll(() => strokeWeight(page, A.front.id)).toBe(5);
  });

  test("@uxi:UXI-PNL-001 — the control bar's More… focuses the inspector's field; Escape gives focus back @uxi:UXI-CMD-004 @feat:editor-shell.panels.control @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.properties");
    await selectElements(page, [A.back.id]);
    const more = page.locator('[data-cockpit-action="more-object"]');
    await more.click();
    const focused = page.locator(":focus");
    await expect(focused).toHaveAttribute("inputmode", "decimal");
    expect(
      await focused.evaluate(
        (el) =>
          el
            .closest("[data-properties-section]")
            ?.getAttribute("data-properties-section") ?? null,
      ),
    ).toBe("object");
    await expectHistoryUnchanged(page, () => focused.press("Escape"));
    await expect(more).toBeFocused();
  });
});
