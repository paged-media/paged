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
//   Gradient            Window ▸ Color ▸ Gradients opens; the
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
//   Eyedropper          (inside an image) the host tool's click takes the
//                       picture's colour into the image's foreground;
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
  // paged.image takes the picture in on entry (editor ADR 1215), which
  // lands as a document step of its own a moment later: wait for the
  // history to settle, so the steps counted after this are the test's.
  if (type === "rasterImage") {
    let last = -1;
    await expect
      .poll(
        async () => {
          const now = await undoLen(page);
          const steady = now === last;
          last = now;
          return steady;
        },
        { intervals: [500, 500, 500, 1000, 1000, 2000] },
      )
      .toBe(true);
  }
}

/** A two-colour PNG, drawn in the page realm, as bytes. */
async function placePicture(page: Page, id: string): Promise<void> {
  const placed = await page.evaluate(async (id) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
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
  }, id);
  expect(placed).toBe("mutationApplied");
}

/** Insert a closed straight-edged path through `points` (page pt). */
async function insertPolygon(
  page: Page,
  points: Array<[number, number]>,
): Promise<Ref> {
  const id = await page.evaluate(async (points) => {
    const g = globalThis as unknown as CanvasGlobal & {
      __canvas: { handle: { pageIds: string[] } };
    };
    const made = (await g.__canvas.client.mutate({
      op: "insertPath",
      args: {
        pageId: g.__canvas.handle.pageIds[0],
        anchors: points.map((p) => ({ anchor: p, left: p, right: p })),
        open: false,
        smooth: false,
      },
    })) as { kind: string; payload?: { createdId?: { id?: string } } };
    return made.payload?.createdId?.id ?? "";
  }, points);
  expect(id).toBeTruthy();
  return { kind: "polygon", id };
}

/** Pick `tool` from its rail slot, through the slot's flyout when another
 *  tool is the slot's face. */
async function pickTool(page: Page, tool: string, group: string) {
  const slot = page.locator(`[data-tool-slot="${group}"]`).first();
  await expect(slot, tool).toBeVisible();
  if ((await slot.getAttribute("data-tool")) === tool) {
    await slot.click();
  } else {
    await slot.click({ button: "right" });
    const flyout = page.locator(`[data-tool-flyout="${group}"]`);
    await expect(flyout, `${tool} in its slot's flyout`).toBeVisible();
    await flyout.locator(`[data-tool="${tool}"]`).click();
  }
  await expect(
    page.locator(`[data-tool-slot="${group}"][data-tool="${tool}"]`),
    tool,
  ).toHaveAttribute("data-active", "true");
}

/** A real pointer drag between two page points. */
async function dragPage(
  page: Page,
  from: [number, number],
  to: [number, number],
  modifiers: Array<"Shift" | "Alt" | "ControlOrMeta"> = [],
): Promise<void> {
  const a = await screenPoint(page, from[0], from[1]);
  const b = await screenPoint(page, to[0], to[1]);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.waitForTimeout(60);
  await page.mouse.up();
  for (const m of [...modifiers].reverse()) await page.keyboard.up(m);
}

/** The head entry of an item's object effect stack, when it is the live
 *  Free Distort: its unit-square corners. */
const freeDistortOf = (page: Page, ref: Ref) =>
  page.evaluate(async (r) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const props = await c.elementProperties(r);
    const v = props?.entries.find((e) => e.path === "frameEffectStack")
      ?.value as
      | { value?: { entries?: { kind: string; corners?: number[][] }[] } }
      | undefined;
    const head = v?.value?.entries?.[0];
    return head?.kind === "freeDistort" ? (head.corners ?? null) : null;
  }, ref);

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
    test(`HPX-${ctx.module} — Gradient, Picture adjustments, Free Transform, the path and shape tools and History ${
      ctx.type ? `inside ${ctx.type}` : "in a publish (IDML) document"
    } @feat:editor-shell.shared-panels-every-context @level:happy`, async ({
      page,
    }) => {
      covers(
        "panel:paged.gradients",
        "panel:paged.picture-adjustments",
        "panel:paged.history",
        "tool:paged.tool.freeTransform",
        "tool:paged.tool.pen",
        "tool:paged.tool.directSelect",
        "tool:paged.tool.rectangle",
        "tool:paged.tool.pencil",
        "tool:paged.tool.scissors",
        "tool:paged.tool.rotate",
        "tool:paged.tool.gradientSwatch",
        "tool:paged.tool.eyedropper",
        "tool:paged.tool.measure",
        "menu:Edit/History",
        "menu:Object/Effects/Picture adjustments…",
        "menu:Window/Color/Gradients",
      );
      const ref = await setUp(page);
      if (ctx.type) await enter(page, ctx.type, ref);
      const stillHere = async () =>
        expect(await contextType(page), "still in the context").toBe(ctx.type);

      // GRADIENT — through the Window menu, which offers it here.
      await clickMenuRow(page, "Window/Color/Gradients");
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

      // PEN, DIRECT SELECTION AND THE SHAPE TOOLS — shared the same way
      // (91ef5dcf8): each one is in its slot on the rail inside the context,
      // and picking it stays. A slot shows one face: inside draw's
      // vectorGraphic the pen slot's face is draw's Add Anchor Point (the
      // context focuses it on enter, and it shares the pen slot), so there
      // the Pen is picked from the slot's flyout, as a user would.
      for (const [tool, group] of [
        ["paged.tool.pen", "pen"],
        ["paged.tool.directSelect", "directSelect"],
        ["paged.tool.rectangle", "shape"],
        ["paged.tool.pencil", "pencil"],
        ["paged.tool.scissors", "scissors"],
        ["paged.tool.rotate", "transform"],
        ["paged.tool.gradientSwatch", "gradientSwatch"],
        ["paged.tool.eyedropper", "eyedropper"],
        ["paged.tool.measure", "measure"],
      ] as const) {
        const slot = page.locator(`[data-tool-slot="${group}"]`).first();
        await expect(slot, tool).toBeVisible();
        if ((await slot.getAttribute("data-tool")) === tool) {
          await slot.click();
        } else {
          await slot.click({ button: "right" });
          const flyout = page.locator(`[data-tool-flyout="${group}"]`);
          await expect(flyout, `${tool} in its slot's flyout`).toBeVisible();
          await flyout.locator(`[data-tool="${tool}"]`).click();
        }
        await expect(
          page.locator(`[data-tool-slot="${group}"][data-tool="${tool}"]`),
          tool,
        ).toHaveAttribute("data-active", "true");
        await stillHere();
      }

      // HISTORY — Edit ▸ History lists the document's steps; a click on
      // the one before the last goes back one step. Inside an image it
      // lists the image's own journal (editor ADR 285): paged.image takes
      // the picture in when its context is entered (editor ADR 1215), so
      // the panel's source is the context's from the start there.
      await clickMenuRow(page, "Edit/History");
      const history = page.locator("[data-history-panel]");
      await expect(history).toBeVisible();
      if (ctx.type === "rasterImage") {
        await expect(history).toHaveAttribute("data-history-source", "context");
      } else {
        await expect(history).toHaveAttribute(
          "data-history-source",
          "document",
        );
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
      }
      await stillHere();

      // EYEDROPPER (last: its ingest makes the image the History's
      // source) — the same host tool everywhere; inside an image its
      // target is the image (extensions ADR 1104): a click takes the
      // picture's colour into the foreground, which is the image context's
      // fill well, and writes nothing to the document.
      if (ctx.type === "rasterImage") {
        // The image's pixels: ingest the frame (Adjust), then wait until
        // the context's lane answers a sample at the point.
        const at = [FRAME.x0 + 130, FRAME.y0 + 60] as [number, number];
        await page.evaluate(() =>
          (
            globalThis as unknown as {
              __canvas: {
                registries: {
                  commands: { invoke(id: string): Promise<unknown> };
                };
              };
            }
          ).__canvas.registries.commands.invoke(
            "media.paged.image.command.adjustSelected",
          ),
        );
        await expect
          .poll(
            () =>
              page.evaluate(async (point) => {
                const g = globalThis as unknown as {
                  __canvas: { handle: { pageIds: string[] } };
                  __bindingProviders: {
                    takeEyedropperSample: (r: unknown) => Promise<{
                      resolved: boolean;
                    }>;
                  };
                };
                const r = await g.__bindingProviders.takeEyedropperSample({
                  pageId: g.__canvas.handle.pageIds[0],
                  point,
                  sampleSize: 1,
                  secondary: false,
                });
                return r.resolved;
              }, at),
            { message: "the image takes a sample", timeout: 30_000 },
          )
          .toBe(true);
        const slot = page.locator('[data-tool-slot="eyedropper"]').first();
        if (
          (await slot.getAttribute("data-tool")) === "paged.tool.eyedropper"
        ) {
          await slot.click();
        } else {
          await slot.click({ button: "right" });
          await page
            .locator(
              '[data-tool-flyout="eyedropper"] [data-tool="paged.tool.eyedropper"]',
            )
            .click();
        }
        // The background well (Alt-click's target) is the stroke well.
        const bg = () =>
          page.evaluate(async () => {
            const r = await (
              globalThis as unknown as {
                __bindingProviders: {
                  readSelectionProperty: (path: string) => Promise<{
                    resolved: boolean;
                    provider?: string;
                    read?: { value?: { value?: { value?: number[] } } };
                  }>;
                };
              }
            ).__bindingProviders.readSelectionProperty("frameStrokeColor");
            return r.resolved
              ? { provider: r.provider, rgb: r.read?.value?.value?.value }
              : null;
          });
        const before = await undoLen(page);
        const shown = await bg();
        expect(shown?.provider).toBe("media.paged.image");
        const p = await screenPoint(page, at[0], at[1]);
        await page.keyboard.down("Alt");
        await page.mouse.click(p.x, p.y);
        await page.keyboard.up("Alt");
        // Alt: the picture's colour (not the white default) is the
        // background now.
        await expect
          .poll(async () => JSON.stringify((await bg())?.rgb))
          .not.toBe(JSON.stringify(shown?.rgb));
        expect(await undoLen(page), "sampling is not a document edit").toBe(
          before,
        );
        await stillHere();
      }
    });
  }

  // Consolidation P2 — one tool per capability in every context. On a
  // closed polygon placing a picture (the context's frame), inside each
  // context and without leaving it:
  //
  //   Corners       Direct Selection (on every context's rail) shows the
  //                 polygon's corner widgets; a drag rounds every corner
  //                 (editor ADR 310) — one undo step;
  //   Free Distort  Free Transform, Cmd on a corner: the engine's live
  //                 Free Distort at the head of the effect stack, the
  //                 anchors kept (editor ADR 295) — one undo step; and
  //   Perspective   Cmd+Alt+Shift composes onto it — one undo step;
  //   Eyedropper    Object mode: a click on another object lends its look
  //                 to the frame (helpers' sampled-style) — one undo step;
  //   References    a footnote, a destination, a cross-reference and an
  //                 index entry at a text caret, the host's commands
  //                 (editor ADR 315) — one undo step each.
  //
  // The slide-only tools that moved onto host machinery have their own
  // specs inside the slide context: the Format Painter on sampled-style
  // (journey/plugins/slide-effects) and the motion path on the Direct
  // Selection machine (journey/plugins/slide-motion-path).
  for (const ctx of CONTEXTS) {
    test(`HPX-P2-${ctx.module} — polygon corners, live Free Distort and Perspective, the Eyedropper's object mode and the reference inserts ${
      ctx.type ? `inside ${ctx.type}` : "in a publish (IDML) document"
    } @feat:editor-shell.shared-panels-every-context @level:gesture`, async ({
      page,
    }) => {
      covers(
        "tool:paged.tool.directSelect",
        "tool:paged.tool.freeTransform",
        "tool:paged.tool.eyedropper",
        "setting:paged.tool.eyedropper.mode",
        "command:paged.insert.footnote",
        "command:paged.insert.bookmark",
        "command:paged.insert.crossReference",
        "command:paged.insert.indexEntry",
      );
      const designer = new Designer(page);
      await designer.open();
      await designer.newDocument();
      const ref = await insertPolygon(page, [
        [FRAME.x0, FRAME.y0],
        [FRAME.x1, FRAME.y0],
        [FRAME.x1, FRAME.y1],
        [FRAME.x0, FRAME.y1],
      ]);
      await placePicture(page, ref.id);
      // The Eyedropper's source: a black square with a 7 pt stroke.
      const source = await insertPolygon(page, [
        [400, 140],
        [520, 140],
        [520, 260],
        [400, 260],
      ]);
      for (const [path, value] of [
        ["frameFillColor", { type: "colorRef", value: "Color/Black" }],
        ["frameStrokeColor", { type: "colorRef", value: "Color/Black" }],
        ["frameStrokeWeight", { type: "length", value: 7 }],
      ] as const) {
        await page.evaluate(
          (m) =>
            (globalThis as unknown as CanvasGlobal).__canvas.client.mutate(m),
          {
            op: "setElementProperty",
            args: { elementId: source, path, value },
          },
        );
      }
      // The references' story.
      const { storyId } = await designer.addTextFrame({
        x0: 120,
        y0: 340,
        x1: 440,
        y1: 460,
      });
      expect(storyId).toBeTruthy();
      await page.evaluate(
        (m) =>
          (globalThis as unknown as CanvasGlobal).__canvas.client.mutate(m),
        {
          op: "insertText",
          args: { storyId, offset: 0, text: "Alpha beta gamma" },
        },
      );
      await expect
        .poll(() => designer.storyChars(storyId!))
        .toBeGreaterThan(10);

      await designer.selectElement(ref.kind, ref.id);
      if (ctx.type) await enter(page, ctx.type, ref);
      const stillHere = async () =>
        expect(await contextType(page), "still in the context").toBe(ctx.type);

      // CORNERS — Direct Selection puts the frame in path-edit mode, where
      // the corner widgets stay. 30 pt in along both edges of the square
      // top-left corner: a 30 pt radius on every corner.
      await pickTool(page, "paged.tool.directSelect", "directSelect");
      await stillHere();
      const widget = page
        .locator('[data-live-handle="polygon-corner-0"] circle')
        .first();
      await expect(
        widget,
        "the corner widget under Direct Selection",
      ).toBeVisible();
      const box = (await widget.boundingBox())!;
      const inside = await screenPoint(page, FRAME.x0 + 30, FRAME.y0 + 30);
      await oneStep(page, "corner radius", async () => {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(inside.x - 8, inside.y - 8, { steps: 6 });
        await page.mouse.move(inside.x, inside.y, { steps: 6 });
        await page.waitForTimeout(60);
        await page.mouse.up();
      });
      await expect
        .poll(() => property(page, ref, "frameCornerOptionTopLeft"))
        .toBe("RoundedCorner");
      const radius = (await property(
        page,
        ref,
        "frameCornerRadiusTopLeft",
      )) as number;
      expect(radius).toBeGreaterThan(25);
      expect(radius).toBeLessThan(35);
      expect(await property(page, ref, "frameCornerRadiusBottomRight")).toBe(
        radius,
      );
      await stillHere();

      // FREE DISTORT — Cmd on the SE corner moves that corner alone; the
      // path keeps its anchors, the effect stack's head entry moves it.
      await pickTool(page, "paged.tool.freeTransform", "transform");
      await stillHere();
      await designer.selectElement(ref.kind, ref.id);
      expect(await freeDistortOf(page, ref)).toBeNull();
      await oneStep(page, "free distort", async () => {
        await dragPage(
          page,
          [FRAME.x1, FRAME.y1],
          [FRAME.x1 + 40, FRAME.y1 + 30],
          ["ControlOrMeta"],
        );
      });
      const w = FRAME.x1 - FRAME.x0;
      const h = FRAME.y1 - FRAME.y0;
      await expect
        .poll(
          async () => {
            const corners = await freeDistortOf(page, ref);
            const se = corners?.find((p) => p[0]! > 1.05 && p[1]! > 1.05);
            return (
              !!se &&
              Math.abs(se[0]! - (w + 40) / w) < 0.03 &&
              Math.abs(se[1]! - (h + 30) / h) < 0.03
            );
          },
          { message: "the SE corner is distorted" },
        )
        .toBe(true);
      const distorted = JSON.stringify(await freeDistortOf(page, ref));
      await stillHere();

      // PERSPECTIVE — Cmd+Alt+Shift on the NE corner composes onto it.
      await oneStep(page, "perspective", async () => {
        await dragPage(
          page,
          [FRAME.x1, FRAME.y0],
          [FRAME.x1 + 30, FRAME.y0 + 2],
          ["ControlOrMeta", "Alt", "Shift"],
        );
      });
      await expect
        .poll(async () => JSON.stringify(await freeDistortOf(page, ref)))
        .not.toBe(distorted);
      await stillHere();

      // EYEDROPPER, OBJECT MODE — the source's look onto the frame.
      await pickTool(page, "paged.tool.eyedropper", "eyedropper");
      const popover = page.locator(
        '[data-tool-options="paged.tool.eyedropper"]',
      );
      await page.locator('[data-tool-slot="eyedropper"]').first().dblclick();
      await popover.locator('[data-tool-option="mode"]').selectOption("object");
      await page.mouse.click(5, 5);
      await expect(popover).toBeHidden();
      await stillHere();
      await designer.selectElement(ref.kind, ref.id);
      expect(await property(page, ref, "frameStrokeWeight")).not.toBe(7);
      const sample = await screenPoint(page, 460, 200);
      await oneStep(page, "eyedropper object", async () => {
        await page.mouse.click(sample.x, sample.y);
      });
      await expect.poll(() => property(page, ref, "frameStrokeWeight")).toBe(7);
      await stillHere();

      // REFERENCES — the host's inserts at a caret in the story.
      await page.evaluate(
        (storyId) =>
          (
            globalThis as unknown as {
              __canvas: { setContentSelection: (s: unknown) => void };
            }
          ).__canvas.setContentSelection({ storyId, start: 5, end: 5 }),
        storyId,
      );
      for (const [what, id, payload] of [
        ["footnote", "paged.insert.footnote", { text: "" }],
        [
          "destination",
          "paged.insert.bookmark",
          { name: `Here-${ctx.module}` },
        ],
        [
          "cross-reference",
          "paged.insert.crossReference",
          { bookmark: `Here-${ctx.module}`, referTo: "pageNumber" },
        ],
        ["index entry", "paged.insert.indexEntry", { topic: ["Alpha"] }],
      ] as const) {
        await oneStep(page, what, async () => {
          await page.evaluate(
            ([i, p]) =>
              (
                globalThis as unknown as {
                  __canvas: {
                    registries: {
                      commands: {
                        invoke(id: string, payload?: unknown): Promise<unknown>;
                      };
                    };
                  };
                }
              ).__canvas.registries.commands.invoke(i, p),
            [id, payload] as const,
          );
        });
        await stillHere();
      }
      expect((await designer.collection("footnotes")).length).toBe(1);
      expect((await designer.collection("indexTopics")).length).toBeGreaterThan(
        0,
      );
    });
  }
});
