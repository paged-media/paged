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

// paged.draw ADR 370 — vector editing with feedback, on the real engine
// through the real viewport (the UX strategy's §7.1; the interaction
// specification's §8.4):
//
//   Pen states      start, draw, close and finish each change the cursor
//                   and the hint beside the pointer; a click on the last
//                   anchor finishes the open path — one undo step;
//   magnifier       Control held with the Pen shows a loupe over the
//                   canvas; it changes no document and adds no undo step;
//   Points          with anchors selected, the inspector edits the points
//                   (not the frame): Smooth and X are one undo step each;
//   suggestions     a selected shape offers its quick actions; Smooth is
//                   one undo step;
//   Pathfinder      a button says it applies on click and outlines what it
//                   takes; nothing changes before the click.
//
// Every test asserts the model and the history, never a screenshot.

import { expect, test, type Page } from "@playwright/test";

import { openCanvas, openPanel } from "../fidelity/canvas-driver";
import { historyDepth, undoDepth } from "./harness/history";
import { modelSnapshot } from "./harness/model-dump";
import { loadViaReactPath, screenPoint } from "./harness/viewport";

type Ref = { kind: string; id: string };
type Pt = [number, number];
interface Triple {
  anchor: Pt;
  left: Pt;
  right: Pt;
}
interface Table {
  anchors: Triple[];
  subpathOpen?: boolean[];
  itemTransform?: number[] | null;
}

interface CanvasGlobal {
  __canvas: {
    client: {
      pathAnchors(id: Ref): Promise<Table | null>;
      executeScript(s: string): Promise<{ output: string[] }>;
      setElementSelection(ids: Ref[], mode: string): Promise<Ref[]>;
      elementGeometry(ids: Ref[]): Promise<unknown[]>;
      mutate(m: unknown): Promise<{
        kind: string;
        payload?: { createdId?: Ref };
      }>;
      undo(): Promise<unknown>;
    };
    handle?: { pageIds: string[] };
    setElementSelection(ids: Ref[]): void;
    setElementGeometry(g: unknown[]): void;
  };
}

/** Each state's badge, as the cursor's SVG draws it (pen-states.ts). */
const BADGE = {
  start: "M18 14v8",
  close: "M18 15a3 3 0 1 0 0.01 0",
  finish: "M14.5 18l2.5 2.5 4.5-5",
} as const;

const hostCursor = (page: Page) =>
  page.evaluate(() =>
    decodeURIComponent(
      (
        document.querySelector(
          '[data-testid="viewport-canvas-host"]',
        ) as HTMLElement
      ).style.cursor,
    ),
  );

const hint = (page: Page) =>
  page.locator('[data-overlay-layer="paged.tool.pen.hint"] text');

/** Hover at a page point, then nudge so the cursor follows the answer the
 *  Pen resolved for it (the hover's hit test is asynchronous). */
async function hoverPt(page: Page, p: Pt): Promise<void> {
  const s = await screenPoint(page, p[0], p[1]);
  await page.mouse.move(s.x, s.y);
  await page.waitForTimeout(120);
  await page.mouse.move(s.x + 0.4, s.y + 0.4);
  await page.waitForTimeout(80);
}

async function clickPt(page: Page, p: Pt): Promise<void> {
  const s = await screenPoint(page, p[0], p[1]);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.waitForTimeout(30);
  await page.mouse.up();
  await page.waitForTimeout(60);
}

async function activatePen(page: Page): Promise<void> {
  await page.locator('[data-tool-slot="pen"]').click();
  await expect(
    page.locator('[data-tool-slot="pen"][data-active="true"]'),
  ).toBeVisible();
}

async function selected(page: Page): Promise<Ref | null> {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas;
    const r = await c.client.executeScript("paged.selection()");
    const ids = JSON.parse(r.output[0] ?? "[]") as Ref[];
    return ids.length === 1 ? ids[0] : null;
  });
}

const table = (page: Page, ref: Ref) =>
  page.evaluate(
    (r) =>
      (globalThis as unknown as CanvasGlobal).__canvas.client.pathAnchors(r),
    ref,
  );

/** Draw a closed four-corner path with the Pen; it ends selected. */
async function drawClosedPath(page: Page): Promise<Ref> {
  await activatePen(page);
  for (const p of [
    [120, 120],
    [260, 120],
    [260, 240],
    [120, 240],
    [120, 120],
  ] as Pt[])
    await clickPt(page, p);
  await expect.poll(() => selected(page)).not.toBeNull();
  return (await selected(page))!;
}

const isCorner = (a: Triple) =>
  Math.hypot(a.left[0] - a.anchor[0], a.left[1] - a.anchor[1]) < 1e-3 &&
  Math.hypot(a.right[0] - a.anchor[0], a.right[1] - a.anchor[1]) < 1e-3;

test.describe("paged.draw ADR 370 — vector editing with feedback", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await openCanvas(page);
    await loadViaReactPath(page, "geometry");
  });

  test("Pen states: start, draw, close and finish show their own cursor and hint; a click on the last anchor finishes the open path, one undo step @feat:editor-tools.draw.pen @uxi:UXI-DRW-003 @uxi:UXI-DRW-006 @level:gesture", async ({
    page,
  }) => {
    await activatePen(page);
    const depth = await undoDepth(page);
    await hoverPt(page, [330, 330]);
    await expect.poll(() => hostCursor(page)).toContain(BADGE.start);

    await clickPt(page, [120, 120]);
    await hoverPt(page, [330, 330]);
    await expect(hint(page)).toHaveText(
      "Click: corner · drag: smooth · Enter: finish · Esc: cancel",
    );
    const draw = await hostCursor(page);
    for (const b of Object.values(BADGE)) expect(draw).not.toContain(b);

    await clickPt(page, [240, 140]);
    await hoverPt(page, [121, 121]);
    await expect.poll(() => hostCursor(page)).toContain(BADGE.close);
    await expect(hint(page)).toHaveText("Close the path");

    await hoverPt(page, [241, 141]);
    await expect.poll(() => hostCursor(page)).toContain(BADGE.finish);
    await expect(hint(page)).toHaveText("Finish the open path");
    // Nothing is in the document before the run ends.
    expect(await undoDepth(page)).toBe(depth);

    await clickPt(page, [240, 140]);
    await expect.poll(() => undoDepth(page)).toBe(depth + 1);
    const ref = (await selected(page))!;
    const t = (await table(page, ref))!;
    expect(t.anchors, "two anchors, not a third on top").toHaveLength(2);
    expect(t.subpathOpen?.[0], "the path stays open").toBe(true);
    // The Pen stays the Pen, ready for the next path.
    await expect(
      page.locator('[data-tool-slot="pen"][data-active="true"]'),
    ).toBeVisible();
    await hoverPt(page, [330, 330]);
    await expect.poll(() => hostCursor(page)).toContain(BADGE.start);
  });

  test("the precision magnifier: Control held with the Pen shows a loupe; no document change, no undo step @feat:editor-tools.draw.pen @level:gesture", async ({
    page,
  }) => {
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);
    const loupe = page.locator("[data-precision-magnifier]");
    // The Selection tool: Control shows nothing.
    await hoverPt(page, [200, 200]);
    await page.keyboard.down("Control");
    await hoverPt(page, [202, 202]);
    await expect(loupe).toHaveCount(0);
    await page.keyboard.up("Control");

    await activatePen(page);
    await hoverPt(page, [200, 200]);
    await page.keyboard.down("Control");
    await hoverPt(page, [204, 204]);
    await expect(loupe).toHaveAttribute("data-precision-magnifier", "page");
    await expect(loupe).toHaveAttribute("data-magnifier-factor", "4");
    // Beside the pointer, never over it.
    const at = await screenPoint(page, 204, 204);
    const box = (await loupe.boundingBox())!;
    expect(
      at.x < box.x ||
        at.x > box.x + box.width ||
        at.y < box.y ||
        at.y > box.y + box.height,
    ).toBe(true);
    await page.keyboard.up("Control");
    await expect(loupe).toHaveCount(0);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);
  });

  test("Points: with an anchor selected the inspector edits the point, not the frame; Smooth and X are one undo step each @feat:editor-tools.path.direct-edit @uxi:UXI-DRW-005 @level:gesture", async ({
    page,
  }) => {
    const ref = await drawClosedPath(page);
    // Path editing on the drawn path, then one anchor picked.
    await page.locator('[data-tool-slot="select"]').click();
    await page.evaluate(async (id) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas;
      const ids = await c.client.setElementSelection([id], "replace");
      c.setElementSelection(ids);
      c.setElementGeometry(await c.client.elementGeometry(ids));
    }, ref);
    await page.keyboard.press("Enter");
    await expect(
      page.locator(`[data-path-edit="${ref.kind}:${ref.id}"]`),
    ).toHaveCount(1);
    await clickPt(page, [260, 120]);
    await openPanel(page, "paged.properties");
    const points = page.locator("[data-points-section]");
    await expect(points).toHaveAttribute("data-points-count", "1");
    await expect(points).toHaveAttribute("data-points-kind", "corner");
    await expect(
      page.locator('[data-properties-panel="ready"]'),
    ).toHaveAttribute("data-inspector-kind", "points");
    // The frame's sections give way to the points.
    await expect(
      page.locator('[data-properties-section="object"]'),
    ).toHaveCount(0);

    const before = (await table(page, ref))!;
    const index = before.anchors.findIndex(
      (a) => Math.abs(a.anchor[0] - 260) < 1 && Math.abs(a.anchor[1] - 120) < 1,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    let depth = await undoDepth(page);
    await points.locator('[data-points-action="smooth"]').click();
    await expect.poll(() => undoDepth(page)).toBe(depth + 1);
    await expect
      .poll(async () => isCorner((await table(page, ref))!.anchors[index]!))
      .toBe(false);
    // Only that anchor changed.
    const smoothed = (await table(page, ref))!;
    smoothed.anchors.forEach((a, i) => {
      if (i !== index) expect(a).toEqual(before.anchors[i]);
    });

    depth = await undoDepth(page);
    const x = points.locator("[data-points-x] input");
    await x.fill("280pt");
    await x.press("Enter");
    await expect.poll(() => undoDepth(page)).toBe(depth + 1);
    await expect
      .poll(async () => (await table(page, ref))!.anchors[index]!.anchor[0])
      .toBeCloseTo(280, 1);
    // One undo puts the point back.
    await page.evaluate(() =>
      (globalThis as unknown as CanvasGlobal).__canvas.client.undo(),
    );
    await expect
      .poll(async () => (await table(page, ref))!.anchors[index]!.anchor[0])
      .toBeCloseTo(260, 1);
  });

  test("Shape suggestions: a selected shape offers its quick actions; Smooth is one undo step @feat:editor-tools.draw.pen @level:gesture", async ({
    page,
  }) => {
    const ref = await drawClosedPath(page);
    await openPanel(page, "paged.properties");
    const section = page.locator(
      '[data-properties-section="shape-suggestions"]',
    );
    await expect(section).toBeVisible();
    await expect(
      section.locator('[data-shape-suggestion="roundCorners"]'),
    ).toBeVisible();
    await expect(
      section.locator('[data-shape-suggestion="offset"]'),
    ).toBeVisible();
    const depth = await undoDepth(page);
    await section.locator('[data-shape-suggestion="smooth"]').click();
    await expect.poll(() => undoDepth(page)).toBe(depth + 1);
    await expect
      .poll(async () =>
        (await table(page, ref))!.anchors.every((a) => !isCorner(a)),
      )
      .toBe(true);
  });

  test("Pathfinder: a button says it applies on click and outlines what it takes; nothing changes before the click @feat:frames-paths.shape-tools @level:gesture", async ({
    page,
  }) => {
    const ids = await page.evaluate(async () => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas;
      const pageId = c.handle!.pageIds[0];
      const out: Ref[] = [];
      for (const b of [
        [100, 100, 200, 220],
        [150, 160, 260, 300],
      ]) {
        const r = await c.client.mutate({
          op: "insertFrame",
          args: { pageId, bounds: b },
        });
        out.push(r.payload!.createdId!);
      }
      const sel = await c.client.setElementSelection(out, "replace");
      c.setElementSelection(sel);
      c.setElementGeometry(await c.client.elementGeometry(sel));
      return out;
    });
    expect(ids).toHaveLength(2);
    await openPanel(page, "paged.pathfinder");
    await expect(page.locator("[data-pathfinder-applies]")).toContainText(
      "Applies on click to 2 objects",
    );
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);
    const outline = page.locator(
      '[data-overlay-layer="paged.pathfinder.operands"]',
    );
    await page.locator('[data-pathfinder-kind="union"]').hover();
    await expect(outline.locator("text")).toHaveText("Keeps the result");
    await expect(outline.locator("path[stroke-dasharray]")).toHaveCount(1);
    await page.locator('[data-pathfinder-verb="pathfinderDivide"]').hover();
    await expect(outline.locator("text")).toHaveCount(0);
    await page.mouse.move(5, 5);
    await expect(outline).toHaveCount(0);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);
  });
});
