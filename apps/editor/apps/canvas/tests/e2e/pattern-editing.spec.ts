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

// Pattern editing mode (WP6.9, draw ADR 366, engine ADR 1041), driven
// through the real Pattern Options panel and Swatches panel on a File ▸
// New document (corpus-free): a tile rectangle becomes a pattern field
// (the copies preview it), Save swatch writes ONE pattern swatch (one
// undo step), the Swatches panel lists it with a tile chip and applies it
// to another rectangle's fill, a second save updates the same swatch, and
// Done removes the preview copies and keeps the swatch.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { Designer } from "../journey/driver/designer";
import { mutate, selectElements } from "./harness/ui";

type Ref = { kind: string; id: string };

interface CanvasGlobal {
  __canvas: {
    client: {
      collection: (n: string) => Promise<Array<Record<string, unknown>>>;
      executeScript: (
        s: string,
      ) => Promise<{ output: string[]; error: string | null }>;
      elementProperties: (id: unknown) => Promise<{
        entries: Array<{ path: string; value: unknown }>;
      } | null>;
      undo: () => Promise<unknown>;
      redo: () => Promise<unknown>;
    };
  };
}

async function pageId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const r = await c.executeScript("paged.pages()");
    return (JSON.parse(r.output[0] ?? "[]") as Array<{ selfId: string }>)[0]!
      .selfId;
  });
}

async function frames(page: Page): Promise<Ref[]> {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const r = await c.executeScript("paged.tree()");
    type N = { id?: Ref | null; children?: N[] };
    const out: Ref[] = [];
    const walk = (nodes: N[] | undefined) => {
      for (const n of nodes ?? []) {
        if (n.id && n.id.kind !== "group" && !(n.children?.length ?? 0))
          out.push(n.id);
        walk(n.children);
      }
    };
    walk(JSON.parse(r.output[0] ?? "[]") as N[]);
    return out;
  });
}

async function patternSwatches(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (
      await (globalThis as unknown as CanvasGlobal).__canvas.client.collection(
        "swatches",
      )
    )
      .filter((s) => s.kind === "pattern")
      .map((s) => s.selfId as string),
  );
}

async function fillOf(page: Page, ref: Ref): Promise<unknown> {
  return page.evaluate(async (id) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const props = await c.elementProperties(id);
    const v = props?.entries.find((e) => e.path === "frameFillColor")?.value as
      { value?: unknown } | undefined;
    return v?.value ?? null;
  }, ref);
}

async function history(page: Page, step: "undo" | "redo"): Promise<void> {
  await page.evaluate(async (s) => {
    await (globalThis as unknown as CanvasGlobal).__canvas.client[s]();
  }, step);
}

/** File ▸ New: a red 40 pt tile rectangle and a 200 pt target, the tile
 *  selected. */
async function setUp(page: Page) {
  const designer = new Designer(page);
  await designer.open();
  await designer.newDocument();
  const pid = await pageId(page);
  await mutate(page, {
    op: "createSwatch",
    args: {
      spec: {
        selfId: "Color/TileRed",
        name: "Tile Red",
        space: "RGB",
        value: [220, 30, 40],
        model: "Process",
        alternateSpace: null,
        alternateValue: [],
        tint: null,
        alpha: null,
      },
    },
  });
  const before = await frames(page);
  for (const bounds of [
    [100, 100, 140, 140],
    [300, 100, 500, 300],
  ]) {
    await mutate(page, {
      op: "batch",
      args: {
        ops: [
          { op: "insertFrame", args: { pageId: pid, bounds } },
          {
            op: "setElementProperty",
            args: {
              elementId: { kind: "rectangle", id: "$created" },
              path: "frameFillColor",
              value: { type: "colorRef", value: "Color/TileRed" },
            },
          },
        ],
      },
    });
  }
  const added = (await frames(page)).filter(
    (f) => !before.some((b) => b.id === f.id),
  );
  expect(added).toHaveLength(2);
  const [tile, target] = added as [Ref, Ref];
  await selectElements(page, [tile]);
  return { designer, tile, target };
}

test.describe("pattern editing mode", () => {
  test("AC-PATTERN-1 — a field saves as a pattern swatch in one undo step, the Swatches panel applies it, Done removes the copies @feat:plugin-draw.pattern-bake @feat:color-swatches.pattern-paint @level:happy", async ({
    page,
  }) => {
    covers("command:media.paged.draw.command.savePatternSwatch");
    const { designer, tile, target } = await setUp(page);
    await designer.openPanel("media.paged.draw.panel.pattern");
    const panel = page.locator("[data-draw-pattern-panel]");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Pattern editing mode: the copies preview the tile.
    const framesBefore = (await frames(page)).length;
    await panel.locator("[data-draw-pattern-make]").click();
    await expect
      .poll(async () => (await frames(page)).length, { timeout: 15_000 })
      .toBeGreaterThan(framesBefore);
    const withCopies = (await frames(page)).length;
    await expect(panel).toHaveAttribute("data-draw-pattern-panel", "1");

    // Pattern Options: brick, then Save swatch — one swatch, one step.
    await panel.locator("[data-draw-pattern-layout]").selectOption("brick");
    const row = panel.locator("[data-draw-pattern-row]").first();
    await row.locator("[data-draw-pattern-save-swatch]").click();
    await expect
      .poll(() => patternSwatches(page), { timeout: 15_000 })
      .toEqual(["Pattern/pattern-1"]);
    await expect(row.locator("[data-draw-pattern-swatch]")).toHaveAttribute(
      "data-draw-pattern-swatch",
      "Pattern/pattern-1",
    );
    await history(page, "undo");
    await expect.poll(() => patternSwatches(page)).toEqual([]);
    await history(page, "redo");
    await expect
      .poll(() => patternSwatches(page))
      .toEqual(["Pattern/pattern-1"]);

    // The Swatches panel lists it with a tile chip and applies it.
    await designer.openPanel("paged.swatches");
    const swatchRow = page.locator('[data-swatch-id="Pattern/pattern-1"]');
    await expect(swatchRow).toBeVisible({ timeout: 10_000 });
    await expect(
      swatchRow.locator('[data-swatch-preview="pattern"]'),
    ).toBeVisible();
    await selectElements(page, [target]);
    // The panel's Fill picker applies any swatch, a pattern among them.
    await page
      .getByRole("combobox", { name: "Fill", exact: true })
      .selectOption({ label: "Pattern 1" });
    await expect
      .poll(() => fillOf(page, target), { timeout: 10_000 })
      .toBe("Pattern/pattern-1");
    await history(page, "undo");
    await expect.poll(() => fillOf(page, target)).toBe("Color/TileRed");
    await history(page, "redo");
    await expect.poll(() => fillOf(page, target)).toBe("Pattern/pattern-1");

    // A second save updates the same swatch; Done removes the copies.
    await selectElements(page, [tile]);
    await designer.openPanel("media.paged.draw.panel.pattern");
    await expect(panel).toBeVisible();
    await panel
      .locator("[data-draw-pattern-row]")
      .first()
      .locator("[data-draw-pattern-done]")
      .click();
    await expect
      .poll(async () => (await frames(page)).length, { timeout: 15_000 })
      .toBeLessThan(withCopies);
    expect(await patternSwatches(page)).toEqual(["Pattern/pattern-1"]);
    expect(await fillOf(page, target)).toBe("Pattern/pattern-1");
    expect((await frames(page)).some((f) => f.id === tile.id)).toBe(true);
  });
});
