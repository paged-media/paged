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

// Module conformance (task CM4 of the interaction plan; the interaction
// specification's §10 and §21; gate G2). Every module's edit context, on
// the interaction contract's fixtures, held to one contract:
//
//   entry          the context is entered on its frame; the breadcrumb names
//                  it as its module does (UXI-CTX-005); the page does not
//                  move and the canvas does not resize (UXI-CTX-008, F-48);
//   focus          Escape on the canvas is the context's: one press leaves
//                  one level, the frame stays selected (UXI-CTX-003);
//   commit/cancel  leaving a clean context changes no document state and
//                  adds no undo step (ADR 1214);
//   inspector      the context's own panel is offered while it is active.
//
// Then the scenarios of the specification's group C: a text frame's
// double-click (T35), a picture frame's levels (T36, T51, D-05), a group's
// member with Direct Selection (T37), a sheet frame's grid (T38), a web
// frame's source (T39), and the role and profile walls (T45, T46). Every
// test asserts the model and the history, not a screenshot.

import { expect, test, type Page } from "@playwright/test";

import { historyDepth, undoDepth } from "./harness/history";
import { dumpElement, modelSnapshot } from "./harness/model-dump";
import { clientPointOf } from "./harness/interaction";
import { selectedIds } from "./harness/gesture-kit";
import {
  UXI_B,
  UXI_C,
  UXI_E,
  UXI_F,
  openUxiFixture,
  openUxiFixtureF,
  placeModuleFrames,
} from "./harness/uxi-fixtures";
import { activeEditContext, openPanels } from "./harness/shell-surface";

type Ref = { kind: string; id: string };

interface CanvasGlobal {
  __canvas: {
    client: {
      mutate(m: unknown): Promise<{
        kind: string;
        payload?: { createdId?: Ref; error?: { kind: string } };
      }>;
      elementGeometry(ids: unknown[]): Promise<
        Array<{
          bounds: [number, number, number, number];
          itemTransform?: number[] | null;
          hasImage?: boolean;
        }>
      >;
      camera: { read(): { scale: number; tx: number; ty: number } };
      handle?: { pageIds: string[] };
      executeScript?(source: string): Promise<unknown>;
    };
    handle?: { pageIds: string[] };
    contentSelection?: { storyId: string; start: number } | null;
    registries: {
      commands: { invoke(id: string, args?: unknown): Promise<unknown> };
    };
    debugContext?: () => {
      editContext?: { type?: string } | null;
      tools?: { base?: string | null };
    };
  };
}

const viewport = (page: Page) =>
  page.locator('[data-canvas-surface="viewport"]');

/** The camera and the canvas host's box: what entering a context must not
 *  change (UXI-CTX-008, UXI-CTX-009). */
async function stage(page: Page) {
  return page.evaluate(() => {
    const cam = (
      globalThis as unknown as CanvasGlobal
    ).__canvas.client.camera.read();
    const host = document
      .querySelector('[data-testid="viewport-canvas-host"]')!
      .getBoundingClientRect();
    return {
      camera: {
        scale: Math.round(cam.scale * 1e4) / 1e4,
        tx: Math.round(cam.tx),
        ty: Math.round(cam.ty),
      },
      host: {
        top: Math.round(host.top),
        left: Math.round(host.left),
        width: Math.round(host.width),
        height: Math.round(host.height),
      },
    };
  });
}

async function geometry(page: Page, ref: Ref) {
  return page.evaluate(async (r) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    return (await c.elementGeometry([r]))[0] ?? null;
  }, ref);
}

/** Enter `type` on `ref` through the host's own door (what a double-click
 *  resolves to), as `host.shell.enterEditContext` does. */
async function enterByDoor(page: Page, type: string, ref: Ref) {
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
  await expect.poll(() => activeEditContext(page)).toBe(type);
}

async function insertRect(page: Page, x: number, y: number): Promise<Ref> {
  const id = await page.evaluate(
    async ({ x, y }) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas;
      const pageId = c.handle!.pageIds[0];
      const r = await c.client.mutate({
        op: "insertFrame",
        args: { pageId, bounds: [y, x, y + 200, x + 280] },
      });
      return r.payload?.createdId?.id ?? "";
    },
    { x, y },
  );
  expect(id).toBeTruthy();
  return { kind: "rectangle", id };
}

async function dblclickAt(page: Page, at: readonly [number, number]) {
  const p = await clientPointOf(page, { at });
  await page.mouse.dblclick(p.x, p.y);
}

async function pressEscapeOnCanvas(page: Page) {
  await viewport(page).focus();
  await page.keyboard.press("Escape");
}

/** The seven module contexts, as their bundles register them, with the
 *  name each module gives its context (extensions ADR 1106). */
const MODULE_CONTEXTS = [
  { module: "draw", type: "vectorGraphic", label: "Vector graphic" },
  { module: "web", type: "webFrame", label: "Web frame" },
  { module: "sheet", type: "sheet", label: "Spreadsheet" },
  { module: "image", type: "rasterImage", label: "Image" },
  { module: "doc", type: "wordDocument", label: "Word document" },
  { module: "slide", type: "slideChart", label: "Chart" },
  { module: "data", type: "dataBinding", label: "Data binding" },
] as const;

test.describe("UXI module conformance (G2)", () => {
  test.describe.configure({ timeout: 120_000 });

  for (const ctx of MODULE_CONTEXTS) {
    test(`a ${ctx.module} context: entered without moving the page, named by its module, left by one Escape with no document change @feat:plugin-platform.edit-context @level:edge`, async ({
      page,
    }) => {
      await openUxiFixture(page, "E");
      // Large enough that no module presents it full screen (the chart's
      // data sheet does for a frame under 240 × 140 pt).
      const frame = await insertRect(page, 300, 400);
      await page.evaluate(async (r) => {
        const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
        const ids = await (
          c as unknown as {
            setElementSelection(i: unknown[], m: string): Promise<unknown[]>;
          }
        ).setElementSelection([r], "replace");
        return ids;
      }, frame);
      const before = await stage(page);
      const model = await modelSnapshot(page);
      const history = await historyDepth(page);

      await enterByDoor(page, ctx.type, frame);
      // Entry: the trail names it as the module does, in the context
      // toolbar's fixed bar.
      const crumb = page.locator(
        `[data-edit-context-breadcrumb] [data-edit-context-crumb="${ctx.type}"]`,
      );
      await expect(crumb).toHaveText(ctx.label);
      await expect(crumb).not.toHaveText(ctx.type);
      expect(await stage(page), "entering moves nothing").toEqual(before);
      // Inspector: the context's own panels are offered.
      const declared = await page.evaluate(
        (type) =>
          (
            globalThis as unknown as {
              __canvas: {
                registries: {
                  editContexts: {
                    get(t: string): { panelIds?: string[] } | undefined;
                  };
                };
              };
            }
          ).__canvas.registries.editContexts.get(type)?.panelIds ?? [],
        ctx.type,
      );
      const open = await openPanels(page);
      for (const id of declared) expect(open, `${id} offered`).toContain(id);

      // Focus: Escape on the canvas leaves exactly this level.
      await pressEscapeOnCanvas(page);
      await expect.poll(() => activeEditContext(page)).toBe(null);
      await expect(page.locator("[data-edit-context-breadcrumb]")).toHaveCount(
        0,
      );
      expect(await selectedIds(page)).toContain(frame.id);
      expect(await stage(page), "leaving moves nothing").toEqual(before);
      // Leaving a clean context is no document change and no undo step.
      if (ctx.type !== "rasterImage") {
        expect(await modelSnapshot(page)).toBe(model);
        expect(await historyDepth(page)).toEqual(history);
      } else {
        // paged.image takes the picture in on entry (a marker of its own
        // on the frame, ADR 1215); the frame's geometry stays.
        const g = await geometry(page, frame);
        expect(g?.bounds).toEqual([400, 300, 600, 580]);
      }
    });
  }

  test("UXI-T35 — a double-click in a text frame puts the caret in that story; the bar says text, the frame stays @feat:stories-text.caret-selection @level:edge", async ({
    page,
  }) => {
    await openUxiFixture(page, "C");
    const frameBefore = await dumpElement(page, UXI_C.first.id);
    const depth = await undoDepth(page);
    await dblclickAt(page, UXI_C.first.at);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as unknown as CanvasGlobal).__canvas.contentSelection
              ?.storyId ?? null,
        ),
      )
      .toBe(UXI_C.storyId);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as unknown as CanvasGlobal).__canvas.debugContext?.()
              ?.tools?.base ?? null,
        ),
      )
      .toBe("paged.tool.type");
    expect(await dumpElement(page, UXI_C.first.id)).toBe(frameBefore);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T36 — a double-click on a picture frame enters its content: a drag moves the picture, not the frame, one undo step @feat:editor-tools.content-transform @level:edge", async ({
    page,
  }) => {
    await openUxiFixture(page, "E");
    const img = UXI_E.image.id;
    const [t, l, b, r] = UXI_E.image.box;
    const centre: [number, number] = [(l + r) / 2, (t + b) / 2];
    const before = await geometry(page, img);
    expect(before?.hasImage).toBe(true);
    const imageBefore = await imageTransform(page, img);
    const modelBefore = await modelSnapshot(page);
    const depth = await undoDepth(page);

    await dblclickAt(page, centre);
    await expect.poll(() => activeEditContext(page)).toBe("paged.imageContent");
    await expect(page.locator("[data-frame-levels]")).toHaveAttribute(
      "data-frame-level-current",
      "content",
    );
    expect((await geometry(page, img))?.bounds).toEqual(before?.bounds);

    // A drag inside the frame moves the picture by the drag, the frame stays.
    const from = await clientPointOf(page, { at: centre });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + 10, { steps: 4 });
    await page.mouse.move(from.x + 40, from.y + 20, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => undoDepth(page)).toBe(depth + 1);
    const after = await geometry(page, img);
    expect(after?.bounds, "the frame does not move").toEqual(before?.bounds);
    expect(after?.itemTransform).toEqual(before?.itemTransform);
    // The picture moved inside the frame: the document changed, and where
    // the engine reports the picture's own transform, that is what moved.
    expect(await modelSnapshot(page)).not.toBe(modelBefore);
    const imageAfter = await imageTransform(page, img);
    if (imageBefore !== null)
      expect(imageAfter, "the picture's transform").not.toEqual(imageBefore);
    // Still in the content level; one Escape back to the frame.
    expect(await activeEditContext(page)).toBe("paged.imageContent");
    await pressEscapeOnCanvas(page);
    await expect.poll(() => activeEditContext(page)).toBe(null);
    expect(await selectedIds(page)).toEqual([img.id]);
  });

  test("UXI-T51 — entering a picture's levels needs no navigation: the camera and the canvas stay; the level control changes @feat:editor-tools.content-transform @level:edge", async ({
    page,
  }) => {
    await openUxiFixture(page, "E");
    const img = UXI_E.image.id;
    const [t, l, b, r] = UXI_E.image.box;
    const centre: [number, number] = [(l + r) / 2, (t + b) / 2];
    const before = await stage(page);
    await dblclickAt(page, centre);
    await expect.poll(() => activeEditContext(page)).toBe("paged.imageContent");
    expect(await stage(page)).toEqual(before);
    // Edit image, explicitly: the level control.
    const edit = page.locator('[data-frame-levels] [data-frame-level="edit"]');
    await expect(edit).toHaveText("Edit image");
    await edit.click();
    await expect
      .poll(() => activeEditContext(page), { timeout: 20_000 })
      .toBe("rasterImage");
    expect(await stage(page), "Edit image moves nothing").toEqual(before);
    await expect(page.locator("[data-frame-levels]")).toHaveAttribute(
      "data-frame-level-current",
      "edit",
    );
    // Back to the frame through the control: both levels leave.
    await page
      .locator('[data-frame-levels] [data-frame-level="frame"]')
      .click();
    await expect.poll(() => activeEditContext(page)).toBe(null);
    expect(await selectedIds(page)).toEqual([img.id]);
    expect(await stage(page)).toEqual(before);
  });

  test("UXI-T37 — Direct Selection double-click on a grouped path selects it inside its group; the breadcrumb shows the group, the next level enters the path @feat:editor-tools.select.group-descent @level:edge", async ({
    page,
  }) => {
    await openUxiFixture(page, "B");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await page.keyboard.press("a"); // Direct Selection
    await dblclickAt(page, UXI_B.path.at);
    await expect.poll(() => selectedIds(page)).toEqual([UXI_B.path.id.id]);
    await expect(page.locator("[data-group-crumb]")).toHaveCount(1);
    await dblclickAt(page, UXI_B.path.at);
    await expect.poll(() => activeEditContext(page)).toBe("vectorGraphic");
    const trail = page.locator("[data-edit-context-breadcrumb]");
    await expect(trail.locator("[data-group-crumb]")).toHaveCount(1);
    await expect(
      trail.locator('[data-edit-context-crumb="vectorGraphic"]'),
    ).toHaveText("Vector graphic");
    // The group crumb goes back to the group level: the context leaves.
    await trail.locator("[data-group-crumb]").click();
    await expect.poll(() => activeEditContext(page)).toBe(null);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T38 — inside a sheet frame the grid owns the keys: typing edits a cell, the arrows never nudge the frame @feat:plugin-platform.modal-edit-session @level:edge", async ({
    page,
  }) => {
    await openUxiFixture(page, "E");
    const { sheet } = await placeModuleFrames(page);
    // The web frame was placed last: a click selects the sheet frame.
    const { elementScreenCenter } = await import(
      "../journey/plugins/sheet-kit"
    );
    const at = await elementScreenCenter(page, sheet);
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => selectedIds(page)).toEqual([sheet.id]);
    const frameBefore = await geometry(page, sheet);
    const before = await stage(page);
    const history = await historyDepth(page);

    // Sheet frame selected → Edit cells (sheet ADR 532, extensions ADR
    // 1107): the level control names the transition; entering it moves
    // neither the camera nor the canvas.
    const edit = page.locator('[data-frame-levels] [data-frame-level="edit"]');
    await expect(edit).toHaveText("Edit cells");
    await expect(
      page.locator('[data-frame-levels] [data-frame-level="frame"]'),
    ).toHaveAttribute("aria-checked", "true");
    await edit.click();
    await expect.poll(() => activeEditContext(page)).toBe("sheet");
    await expect(page.locator('[data-edit-context-crumb="sheet"]')).toHaveText(
      "Spreadsheet",
    );
    await expect(page.getByTestId("sheet-bar-mode")).toHaveText(
      "Editing cells",
    );
    expect(await stage(page), "entering moves nothing").toEqual(before);
    const editor = page.getByTestId("sheet-cell-editor");
    await expect(editor).toBeFocused();

    // The arrows are the grid's: the active cell moves, the frame does not.
    const name = page.getByTestId("sheet-bar-name");
    await expect(name).toHaveText("A1");
    for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"])
      await page.keyboard.press(key);
    await expect(name).toHaveText("A1");
    await page.keyboard.press("ArrowDown");
    await expect(name).toHaveText("A2");
    await page.keyboard.press("ArrowUp");
    expect(
      (await geometry(page, sheet))?.bounds,
      "the arrows are the grid's",
    ).toEqual(frameBefore?.bounds);

    // Typing edits the active cell; Enter commits and moves down. The cell
    // edit is the workbook's (the session's journal): the document's
    // history does not move while the cells are edited, and Cmd/Ctrl+Z
    // inside undoes the cell, not a document step.
    const formula = page.getByTestId("sheet-bar-formula");
    await page.keyboard.type("42");
    await page.keyboard.press("Enter");
    await expect(name).toHaveText("A2");
    await page.keyboard.press("ArrowUp");
    await expect(formula).toHaveValue("42");
    expect(await historyDepth(page)).toEqual(history);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(formula).not.toHaveValue("42");
    expect(await historyDepth(page)).toEqual(history);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(formula).toHaveValue("42");

    // The publication preview: the selection inside the placed range
    // prints; extended past the frame's last row it warns, with counts.
    const status = page.getByTestId("sheet-print-status");
    await expect(status).toHaveAttribute("data-fits", "true");
    for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowDown");
    await expect(status).toHaveAttribute("data-fits", "false");
    await expect(status).toContainText("do not print");
    await page.getByTestId("sheet-print-preview-toggle").click();
    const card = page.getByTestId("sheet-print-preview");
    await expect(card).toContainText("below the frame's edge");
    expect(
      await card.locator('[data-preview-cell="overflow"]').count(),
    ).toBeGreaterThan(0);
    // The preview is a view: the document did not change.
    expect(await historyDepth(page)).toEqual(history);

    // Done leaves the cells: the frame stays selected, nothing moved, and
    // the page shows the edit as one document step.
    await page.getByTestId("sheet-bar-exit").click();
    await expect.poll(() => activeEditContext(page)).toBe(null);
    expect(await selectedIds(page)).toContain(sheet.id);
    expect(await stage(page), "leaving moves nothing").toEqual(before);
    expect((await geometry(page, sheet))?.bounds).toEqual(frameBefore?.bounds);
    const { placedValues } = await import("../journey/plugins/sheet-kit");
    await expect
      .poll(async () => (await placedValues(page))[0]?.[0])
      .toBe("42");
    expect((await historyDepth(page)).undo).toBeGreaterThan(history.undo);
  });

  test("UXI-T39 — a web frame's source: entering and leaving are defined, nothing else in the document changes @feat:plugin-web.in-frame-edit @level:edge", async ({
    page,
  }) => {
    await openUxiFixture(page, "E");
    const { web } = await placeModuleFrames(page);
    const others = [UXI_E.image.id, UXI_E.vector.id];
    const othersBefore = await Promise.all(
      others.map((r) => dumpElement(page, r)),
    );
    const depth = await undoDepth(page);
    await enterByDoor(page, "webFrame", web);
    await expect(
      page.locator('[data-edit-context-crumb="webFrame"]'),
    ).toHaveText("Web frame");
    // A press outside the frame leaves it (a clean context: at once).
    const outside = await clientPointOf(page, { at: [560, 700] });
    await page.mouse.click(outside.x, outside.y);
    await expect.poll(() => activeEditContext(page)).toBe(null);
    await expect(
      page.locator('[data-testid="context-exit-dialog"]'),
    ).toHaveCount(0);
    expect(
      await Promise.all(others.map((r) => dumpElement(page, r))),
      "no unrelated document edits",
    ).toEqual(othersBefore);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T45 — a filler calling a hidden mutating command is refused by the engine; nothing changes @feat:editor-shell.solo-mode @level:edge", async ({
    page,
  }) => {
    await openUxiFixtureF(page);
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);
    const refused = await page.evaluate(async (design) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
      const del = await c.mutate({
        op: "deleteFrame",
        args: { frameId: design.id },
      });
      const move = await c.mutate({
        op: "moveFrame",
        args: { frameId: design.id, transform: [1, 0, 0, 1, 40, 40] },
      });
      return [del, move].map((r) =>
        r.kind === "mutationFailed"
          ? (r.payload?.error?.kind ?? r.kind)
          : r.kind,
      );
    }, UXI_F.design.id);
    for (const r of refused) expect(r).not.toBe("mutationApplied");
    expect(refused).toContain("notPermitted");
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);
  });

  test("UXI-T46 — the viewer role: pointer, shortcut and script edits are all refused by the engine, whatever the chrome offers; navigation works @feat:editor-shell.solo-mode @level:edge", async ({
    page,
  }) => {
    // The viewer profile's wall is its session role (presets.ts: role
    // "viewer"); hiding the controls is not the authorization (UXI-PLG-007),
    // so the role is tried under the full chrome, every channel open.
    await openUxiFixture(page, "A");
    await page.evaluate(async () => {
      const c = (
        globalThis as unknown as {
          __canvas: {
            client: { setSessionPolicy(p: unknown): Promise<unknown> };
          };
        }
      ).__canvas;
      await c.client.setSessionPolicy({ role: "viewer", overrides: [] });
    });
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);

    // Pointer: a drag on a frame.
    const from = await clientPointOf(page, { at: [110, 130] });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + 40, { steps: 6 });
    await page.mouse.up();
    // Shortcut: Delete with the canvas focused.
    await viewport(page).focus();
    await page.keyboard.press("Delete");
    await page.keyboard.press("Backspace");
    // Script: a mutation straight to the engine.
    const script = await page.evaluate(async () => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas;
      const r = await c.client.mutate({
        op: "insertFrame",
        args: { pageId: c.handle!.pageIds[0], bounds: [10, 10, 50, 50] },
      });
      return r.kind === "mutationFailed"
        ? (r.payload?.error?.kind ?? r.kind)
        : r.kind;
    });
    expect(script).not.toBe("mutationApplied");
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);

    // Navigation still works: the camera moves.
    const cam = await stage(page);
    await viewport(page).hover();
    await page.mouse.wheel(0, 200);
    await expect
      .poll(async () => (await stage(page)).camera)
      .not.toEqual(cam.camera);
    expect(await historyDepth(page)).toEqual(history);
  });
});

/** The placed picture's own transform inside its frame (the engine's
 *  `imageContentTransform` property). */
async function imageTransform(page: Page, ref: Ref): Promise<unknown> {
  return page.evaluate(async (r) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            elementProperties(id: unknown): Promise<{
              entries: Array<{ path: string; value: unknown }>;
            } | null>;
          };
        };
      }
    ).__canvas.client;
    const props = await c.elementProperties(r);
    const e = props?.entries.find((x) =>
      /imageContentTransform|contentTransform/i.test(x.path),
    );
    return e?.value ?? null;
  }, ref);
}
