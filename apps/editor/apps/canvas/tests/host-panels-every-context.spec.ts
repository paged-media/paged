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

// Editor ADR 311, plan WP10.7 — the shared host panels and tools in every
// module's edit context, end to end on the real engine.
//
// For each context (doc, slide, sheet, draw, image, web, data) and for a
// publish (IDML) document with no context, on a frame placing a picture:
//
//   Gradient            Window ▸ Styles ▸ Gradients opens; the
//                       panel's select fills the frame with a document
//                       gradient — one engine undo step (inside an
//                       image's pixels the row is the foreground colour
//                       well and says it takes no gradient);
//   Picture adjustments Object ▸ Effects ▸ Picture adjustments… opens;
//                       Add ▸ Invert writes the frame's filter stack — one
//                       undo step;
//   Free Transform      the rail shows the tool inside the context and
//                       picking it does not leave; a drag inside the box
//                       moves the frame, also through a module's frame
//                       surface (the sheet grid) — one undo step;
//   History             Edit ▸ History opens on the document's steps; a
//                       click on the step before the last goes back one
//                       step (one `undoTo`).
//
// After every action the context is still the one entered: a shared host
// surface works on the frame being edited, it is not a way out.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { Designer } from "./journey/driver/designer";
import { clickMenuRow } from "./e2e/harness/shell-surface";
import { screenPoint } from "./e2e/harness/viewport";

type Ref = { kind: string; id: string };

interface CanvasGlobal {
  __canvas: {
    client: {
      mutate: (m: unknown) => Promise<{ kind: string }>;
      undoLog: () => Promise<{ undoLen: number; redoLen: number }>;
      elementProperties: (id: unknown) => Promise<{
        entries: Array<{ path: string; value: unknown }>;
      } | null>;
      elementGeometry: (
        ids: unknown[],
      ) => Promise<Array<{ bounds: [number, number, number, number] }>>;
    };
    debugContext?: () => { editContext?: { type?: string } | null };
  };
}

const FRAME = { x0: 120, y0: 140, x1: 340, y1: 300 };
const GRADIENT = "Gradient/uWp107";

/** The modules' edit contexts, as their bundles register them; `null` is
 *  a publish (IDML) document, where no context is entered. */
const CONTEXTS = [
  { module: "doc", type: "wordDocument" },
  { module: "slide", type: "slideDeck" },
  { module: "sheet", type: "sheet" },
  { module: "draw", type: "vectorGraphic" },
  { module: "image", type: "rasterImage" },
  { module: "web", type: "webFrame" },
  { module: "data", type: "dataBinding" },
  { module: "publish", type: null },
] as const;

const undoLen = (page: Page) =>
  page.evaluate(
    async () =>
      (await (globalThis as unknown as CanvasGlobal).__canvas.client.undoLog())
        .undoLen,
  );

const contextType = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as CanvasGlobal).__canvas.debugContext?.()
        ?.editContext?.type ?? null,
  );

async function property(page: Page, ref: Ref, path: string): Promise<unknown> {
  return page.evaluate(
    async ({ ref, path }) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
      const props = await c.elementProperties(ref);
      const v = props?.entries.find((e) => e.path === path)?.value as
        { value?: unknown } | undefined;
      return v?.value ?? null;
    },
    { ref, path },
  );
}

const bounds = (page: Page, ref: Ref) =>
  page.evaluate(async (r) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    return (await c.elementGeometry([r]))[0]!.bounds;
  }, ref);

/** A blank document, a document gradient and a frame placing a two-colour
 *  PNG (so Picture adjustments has a picture to work on). */
async function setUp(page: Page): Promise<Ref> {
  const designer = new Designer(page);
  await designer.open();
  await designer.newDocument();
  const id = await designer.drawRectangle(FRAME);
  const ref = { kind: "rectangle", id };
  const placed = await page.evaluate(
    async ({ id, gradient }) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
      const made = await c.mutate({
        op: "createGradient",
        args: {
          spec: {
            selfId: gradient,
            name: "WP10.7",
            kind: "Linear",
            stops: [
              { stopColor: "Color/Paper", locationPct: 0 },
              { stopColor: "Color/Black", locationPct: 100 },
            ],
          },
        },
      });
      if (made.kind !== "mutationApplied") return made.kind;
      const cv = new OffscreenCanvas(160, 120);
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#2050d0";
      ctx.fillRect(0, 0, 160, 120);
      ctx.fillStyle = "#f0c020";
      ctx.fillRect(80, 0, 80, 120);
      const bytes = Array.from(
        new Uint8Array(
          await (await cv.convertToBlob({ type: "image/png" })).arrayBuffer(),
        ),
      );
      return (
        await c.mutate({
          op: "replaceImageBytes",
          args: { elementId: id, bytes },
        })
      ).kind;
    },
    { id, gradient: GRADIENT },
  );
  expect(placed).toBe("mutationApplied");
  await designer.selectElement("rectangle", id);
  return ref;
}

async function enter(page: Page, type: string, ref: Ref): Promise<void> {
  const entered = await page.evaluate(
    async ({ type, ref }) => {
      const raw = (globalThis as unknown as { __shellDoors?: unknown })
        .__shellDoors;
      const doors = (typeof raw === "function" ? raw() : raw) as
        | { enterEditContext?: (t: string, e: unknown) => Promise<boolean> }
        | undefined;
      return (await doors?.enterEditContext?.(type, ref)) ?? false;
    },
    { type, ref },
  );
  expect(entered, `entered ${type}`).toBe(true);
  await expect.poll(() => contextType(page)).toBe(type);
}

/** Run `action` and expect exactly one new engine undo step. */
async function oneStep(page: Page, what: string, action: () => Promise<void>) {
  const before = await undoLen(page);
  await action();
  await expect
    .poll(() => undoLen(page), { message: `${what}: one undo step` })
    .toBe(before + 1);
  // Settled: nothing else lands behind it.
  await page.waitForTimeout(250);
  expect(await undoLen(page), `${what}: only one`).toBe(before + 1);
}

test.describe("Shared host panels and tools in every edit context (editor ADR 311)", () => {
  test.beforeEach(() => {
    test.setTimeout(240_000);
  });

  for (const ctx of CONTEXTS) {
    test(`HPX-${ctx.module} — Gradient, Picture adjustments, Free Transform and History ${
      ctx.type ? `inside ${ctx.type}` : "in a publish (IDML) document"
    } @feat:editor-shell.shared-panels-every-context @level:happy`, async ({
      page,
    }) => {
      covers(
        "panel:paged.gradients",
        "panel:paged.picture-adjustments",
        "panel:paged.history",
        "tool:paged.tool.freeTransform",
        "menu:Edit/History",
        "menu:Object/Effects/Picture adjustments…",
        "menu:Window/Styles/Gradients",
      );
      const ref = await setUp(page);
      if (ctx.type) await enter(page, ctx.type, ref);
      const stillHere = async () =>
        expect(await contextType(page), "still in the context").toBe(ctx.type);

      // GRADIENT — through the Window menu, which offers it here.
      await clickMenuRow(page, "Window/Styles/Gradients");
      const gradients = page.locator('[data-gradients-panel="ready"]');
      await expect(gradients).toBeVisible();
      const select = gradients.locator('select[data-collection="gradients"]');
      if (ctx.type === "rasterImage") {
        // Inside the pixels the selection's fill is the image's foreground
        // colour well (paged.image's colour provider, ADR 023), which takes
        // a colour, not a gradient: the row says so instead of writing the
        // frame behind the user's back. On the page the gradient applies
        // to the placement (the publish row).
        await expect(select).toBeDisabled();
      } else {
        await expect(select).toBeEnabled();
        await oneStep(page, "gradient", async () => {
          await select.selectOption(GRADIENT);
        });
        await expect
          .poll(() => property(page, ref, "frameFillColor"))
          .toBe(GRADIENT);
      }
      await stillHere();

      // PICTURE ADJUSTMENTS — Object ▸ Effects ▸ Picture adjustments….
      await clickMenuRow(page, "Object/Effects/Picture adjustments…");
      const adjust = page.locator('[data-picture-adjustments-panel="ready"]');
      await expect(adjust).toBeVisible();
      const add = adjust.locator("[data-adjust-add]");
      await expect(add).toBeEnabled();
      await oneStep(page, "picture adjustments", async () => {
        await add.selectOption("invert");
      });
      await expect
        .poll(() => property(page, ref, "frameImageAdjustments"))
        .toEqual([{ op: "invert" }]);
      await stillHere();

      // FREE TRANSFORM — on the rail here, and picking it stays.
      const slot = page.locator(
        '[data-tool-slot="transform"][data-tool="paged.tool.freeTransform"]',
      );
      await expect(slot).toBeVisible();
      await slot.click();
      await expect(slot).toHaveAttribute("data-active", "true");
      await stillHere();
      const start = await bounds(page, ref);
      // Off the centre, where a graphic frame's content grabber sits.
      const cx = FRAME.x0 + 40;
      const cy = FRAME.y0 + 40;
      const a = await screenPoint(page, cx, cy);
      const b = await screenPoint(page, cx + 40, cy + 30);
      await oneStep(page, "free transform", async () => {
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
        await page.mouse.move(b.x, b.y, { steps: 6 });
        await page.waitForTimeout(60);
        await page.mouse.up();
      });
      const moved = await bounds(page, ref);
      expect(Math.abs(moved[1] - start[1] - 40)).toBeLessThan(2);
      expect(Math.abs(moved[0] - start[0] - 30)).toBeLessThan(2);
      await stillHere();

      // HISTORY — Edit ▸ History lists the document's steps; a click on
      // the one before the last goes back one step.
      await clickMenuRow(page, "Edit/History");
      const history = page.locator("[data-history-panel]");
      await expect(history).toBeVisible();
      await expect(history).toHaveAttribute("data-history-source", "document");
      const steps = history.locator("[data-history-step]");
      const n = await steps.count();
      expect(n).toBeGreaterThanOrEqual(3);
      await expect(steps.nth(n - 1)).toHaveAttribute(
        "data-history-state",
        "current",
      );
      const before = await undoLen(page);
      await steps.nth(n - 2).click();
      await expect.poll(() => undoLen(page)).toBe(before - 1);
      await expect(steps.nth(n - 1)).toHaveAttribute(
        "data-history-state",
        "undone",
      );
      // The step undone was the Free Transform move.
      await expect.poll(() => bounds(page, ref)).toEqual(start);
      await stillHere();
    });
  }
});
