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

// The workspace and the camera (interaction contract §13.1, §15.1, §20;
// editor ADRs "Docks are resizable and the workspace adapts" and "Density
// presets"): the docks resize and the canvas keeps the document point at
// its centre (UXI-T50), a document opens through real loading stages and
// fits its first page (UXI-T49), the workspace adapts to its width (UX
// audit F-55), the Focus workspace hides and restores the chrome, and the
// density presets size the interface, never the document. Each asserts
// the camera, the selection and the history, not a screenshot.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { openCanvas } from "../fidelity/canvas-driver";
import { fixturePath } from "./harness/fixtures";
import { clickMenuRow } from "./harness/shell-surface";
import { selectElements } from "./harness/ui";
import { loadViaReactPath } from "./harness/viewport";

interface Cam {
  scale: number;
  tx: number;
  ty: number;
  rotation?: number;
}

interface CanvasHandle {
  __canvas: {
    client: {
      camera: { read: () => Cam };
      undoLog: () => Promise<{ undoLen: number; redoLen: number }>;
    };
    elementSelection?: Array<{ kind: string; id: string }>;
    handle?: {
      pageSizesPt: Array<[number, number]>;
      pageOriginsPt?: Array<[number, number]>;
    } | null;
  };
}

/** The camera, the viewport (the canvas's own box) and what the contract
 *  says must hold across a layout change. */
async function viewState(page: Page) {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasHandle).__canvas;
    let best: HTMLCanvasElement | null = null;
    let area = 0;
    for (const cv of Array.from(document.querySelectorAll("canvas"))) {
      const r = cv.getBoundingClientRect();
      if (r.width * r.height > area) {
        area = r.width * r.height;
        best = cv;
      }
    }
    const box = (best?.parentElement ?? best)!.getBoundingClientRect();
    const cam = c.client.camera.read();
    const log = await c.client.undoLog();
    return {
      cam,
      viewport: { left: box.left, top: box.top, w: box.width, h: box.height },
      selection: (c.elementSelection ?? []).map((e) => `${e.kind}:${e.id}`),
      undo: [log.undoLen, log.redoLen],
    };
  });
}

type ViewState = Awaited<ReturnType<typeof viewState>>;

/** Viewport px → document pt (the camera's inverse, rotation included). */
function toDoc(cam: Cam, x: number, y: number): [number, number] {
  const u = (x - cam.tx) / cam.scale;
  const v = (y - cam.ty) / cam.scale;
  const r = cam.rotation ?? 0;
  if (r === 0) return [u, v];
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * u + s * v, -s * u + c * v];
}

function toViewport(cam: Cam, x: number, y: number): [number, number] {
  const r = cam.rotation ?? 0;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    cam.scale * (c * x - s * y) + cam.tx,
    cam.scale * (s * x + c * y) + cam.ty,
  ];
}

/** The document point at the viewport's centre. */
function centreDoc(s: ViewState): [number, number] {
  return toDoc(s.cam, s.viewport.w / 2, s.viewport.h / 2);
}

/** The screen centre of a selection handle. */
async function handleCentre(page: Page, name: string) {
  const box = await page
    .locator(`[data-selection-handle="${name}"]`)
    .first()
    .boundingBox();
  expect(box, `selection handle ${name}`).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** The anchor held: the document point at the centre is where it was, to
 *  half a screen pixel, at the same zoom. */
function expectAnchored(before: ViewState, after: ViewState) {
  expect(after.cam.scale).toBe(before.cam.scale);
  const [x0, y0] = centreDoc(before);
  const [x1, y1] = centreDoc(after);
  expect(Math.abs(x1 - x0) * after.cam.scale).toBeLessThanOrEqual(0.5);
  expect(Math.abs(y1 - y0) * after.cam.scale).toBeLessThanOrEqual(0.5);
}

async function settledView(page: Page, width: (s: ViewState) => boolean) {
  await expect
    .poll(async () => width(await viewState(page)), { timeout: 10_000 })
    .toBe(true);
  // Two identical reads: the resize and its anchor have landed.
  await expect
    .poll(
      async () => {
        const a = await viewState(page);
        await page.waitForTimeout(80);
        const b = await viewState(page);
        return (
          a.cam.tx === b.cam.tx &&
          a.cam.ty === b.cam.ty &&
          a.viewport.w === b.viewport.w
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return viewState(page);
}

test.describe("UXI workspace and camera", () => {
  // The workspace adapts to the window (editor ADR 1208): these specs boot
  // with it adapting, at the 1600 px desktop the classes are measured
  // against (the suite's default window is 1280 px).
  test.use({ viewport: { width: 1600, height: 1000 } });

  test("UXI-T50 — resizing the right dock keeps the document point at the viewport's centre, the selection, the history and the overlay on its object @feat:editor-shell.panel-rail @level:gesture @uxi:UXI-CAM-003 @uxi:UXI-PNL-007", async ({
    page,
  }) => {
    await openCanvas(page, { adaptiveWorkspace: true });
    const fx = await loadViaReactPath(page, "geometry-groups");
    const target = fx.firstRectangle ?? fx.frames[0]!.ref;
    await selectElements(page, [target]);
    await expect(
      page.locator('[data-selection-handle="northWest"]').first(),
    ).toBeVisible();

    const splitter = page.locator('[data-dock-splitter="right"]');
    await expect(splitter).toHaveAttribute("aria-valuenow", "320");
    const before = await viewState(page);
    const handleBefore = await handleCentre(page, "northWest");
    const handleDoc = toDoc(
      before.cam,
      handleBefore.x - before.viewport.left,
      handleBefore.y - before.viewport.top,
    );

    // Drag the divider 120 px toward the canvas: the dock grows to 440.
    const box = (await splitter.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(x - 20 * i, y);
    await page.mouse.up();
    await expect(splitter).toHaveAttribute("aria-valuenow", "440");
    const after = await settledView(
      page,
      (s) => s.viewport.w <= before.viewport.w - 119,
    );

    expectAnchored(before, after);
    // The selection and the history are untouched (UXI-CAM-001).
    expect(after.selection).toEqual(before.selection);
    expect(after.selection.length).toBeGreaterThan(0);
    expect(after.undo).toEqual(before.undo);
    // The overlay is drawn where the object now is.
    const [hx, hy] = toViewport(after.cam, handleDoc[0], handleDoc[1]);
    const handleAfter = await handleCentre(page, "northWest");
    expect(
      Math.abs(handleAfter.x - (after.viewport.left + hx)),
    ).toBeLessThanOrEqual(1.5);
    expect(
      Math.abs(handleAfter.y - (after.viewport.top + hy)),
    ).toBeLessThanOrEqual(1.5);

    // The keyboard moves it too; a double-click restores the default, and
    // the camera comes back to where it started — no drift.
    await splitter.focus();
    await page.keyboard.press("Home");
    await expect(splitter).toHaveAttribute("aria-valuenow", "240");
    const narrow = await settledView(
      page,
      (s) => s.viewport.w >= before.viewport.w + 79,
    );
    expectAnchored(before, narrow);
    await splitter.dblclick();
    await expect(splitter).toHaveAttribute("aria-valuenow", "320");
    const back = await settledView(
      page,
      (s) => Math.abs(s.viewport.w - before.viewport.w) < 1,
    );
    expect(Math.abs(back.cam.tx - before.cam.tx)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(back.cam.ty - before.cam.ty)).toBeLessThanOrEqual(0.5);
    expect(back.selection).toEqual(before.selection);
    expect(back.undo).toEqual(before.undo);
  });

  test("UXI-T50 — hiding and showing the docks keeps the anchor and never re-fits @feat:editor-shell.panel-rail @level:edge @uxi:UXI-PNL-007", async ({
    page,
  }) => {
    await openCanvas(page, { adaptiveWorkspace: true });
    await loadViaReactPath(page, "geometry-groups");
    // Zoom in first, so a re-fit would show.
    await page.keyboard.press("ControlOrMeta+=");
    await page.keyboard.press("ControlOrMeta+=");
    const before = await settledView(page, () => true);
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          __canvas: {
            registries: { commands: { invoke(id: string): unknown } };
          };
        }
      ).__canvas.registries.commands.invoke("paged.chrome.togglePanels"),
    );
    const hidden = await settledView(
      page,
      (s) => s.viewport.w > before.viewport.w + 200,
    );
    expectAnchored(before, hidden);
    expect(hidden.undo).toEqual(before.undo);
  });

  test("UXI-T49 — a 20-page document opens through its loading stages, without a percentage, and fits its first page @feat:editor-shell.file-intake @level:happy @uxi:UXI-PRF-003", async ({
    page,
  }) => {
    await openCanvas(page, { adaptiveWorkspace: true });
    // Record every stage the canvas shows, as it shows it.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __stages: string[];
        __stageWords: string[];
        __placeholders: number;
      };
      w.__stages = [];
      w.__stageWords = [];
      w.__placeholders = 0;
      const viewport = document.querySelector("[data-paged-viewport]")!;
      const record = () => {
        const stage = viewport.getAttribute("data-loading-stage");
        if (stage && w.__stages[w.__stages.length - 1] !== stage)
          w.__stages.push(stage);
        const status = viewport.querySelector("[data-loading-status]");
        if (status?.textContent) w.__stageWords.push(status.textContent);
        w.__placeholders = Math.max(
          w.__placeholders,
          viewport.querySelectorAll("[data-loading-placeholders] rect").length,
        );
      };
      new MutationObserver(record).observe(viewport, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    await page.setInputFiles('input[type="file"]', fixturePath("geometry"));
    await expect(page.locator("[data-paged-viewport]")).toHaveAttribute(
      "data-loading-stage",
      "ready",
      { timeout: 60_000 },
    );
    const seen = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __stages: string[];
        __stageWords: string[];
        __placeholders: number;
      };
      return {
        stages: w.__stages,
        words: w.__stageWords,
        placeholders: w.__placeholders,
      };
    });
    // The stages in their order (a quick stage may pass between two
    // commits, never out of order).
    const order = ["recognized", "geometry", "firstPaint", "refining", "ready"];
    const ranks = seen.stages.map((s) => order.indexOf(s));
    expect(ranks.every((r) => r >= 0)).toBe(true);
    for (let i = 1; i < ranks.length; i++)
      expect(ranks[i]!).toBeGreaterThanOrEqual(ranks[i - 1]!);
    expect(seen.stages).toContain("geometry");
    expect(seen.stages[seen.stages.length - 1]).toBe("ready");
    // Real counts in words, never an invented percentage.
    for (const w of seen.words) expect(w).not.toMatch(/\d\s*%/);
    // While the first page was composed, the 20 pages were outlined.
    if (seen.placeholders > 0) expect(seen.placeholders).toBe(20);
    await expect(page.locator("[data-loading-status]")).toHaveCount(0);

    // The first page fits, not slivers of the whole document.
    const view = await viewState(page);
    const sizes = await page.evaluate(
      () =>
        (globalThis as unknown as CanvasHandle).__canvas.handle?.pageSizesPt ??
        [],
    );
    expect(sizes.length).toBe(20);
    const [w0, h0] = sizes[0]!;
    const fit = Math.min(
      (view.viewport.w - 80) / w0,
      (view.viewport.h - 80) / h0,
    );
    expect(Math.abs(view.cam.scale - fit) / fit).toBeLessThan(0.02);
    const [left, top] = toViewport(view.cam, 0, 0);
    const [right, bottom] = toViewport(view.cam, w0, h0);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(view.viewport.w);
    expect(bottom).toBeLessThanOrEqual(view.viewport.h);
    // Opening is not an edit.
    expect(view.undo[0]).toBe(0);
  });

  test("F-55 — the workspace adapts to its width: laptop collapses the left dock to a rail, narrow makes both docks overlays, nothing scrolls sideways @feat:editor-shell.panel-rail @level:edge", async ({
    page,
  }) => {
    await openCanvas(page, { adaptiveWorkspace: true });
    await loadViaReactPath(page, "geometry-groups");
    const layout = page.locator("[data-cockpit-layout]");
    await expect(layout).toHaveAttribute("data-workspace-class", "wide");
    await expect(page.locator("[data-left-panel]")).toBeVisible();

    const overflow = () =>
      page.evaluate(() => ({
        page: document.documentElement.scrollWidth - window.innerWidth,
        header: (() => {
          const h = document.querySelector("header")!;
          return h.scrollWidth - h.clientWidth;
        })(),
        modeBar: (() => {
          const m = document.querySelector<HTMLElement>("[data-mode-switcher]");
          return m ? m.scrollWidth - m.clientWidth : 0;
        })(),
      }));
    const canvasWidth = async () => (await viewState(page)).viewport.w;

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(layout).toHaveAttribute("data-workspace-class", "laptop");
    await expect(page.locator('[data-dock-rail="left"]')).toBeVisible();
    await expect(page.locator("[data-left-panel]")).toBeHidden();
    await expect(page.locator("[data-right-column]")).toBeVisible();
    expect(await canvasWidth()).toBeGreaterThanOrEqual(640);
    // The rail's button opens the left panel over the canvas.
    const before = await viewState(page);
    await page.locator('[data-dock-rail-toggle="left"]').click();
    await expect(page.locator("[data-left-panel]")).toBeVisible();
    await expect(page.locator("[data-left-panel]")).toHaveAttribute(
      "data-dock-presentation",
      "flyout",
    );
    // A flyout covers the canvas; it does not resize it or move the view.
    const flyout = await viewState(page);
    expect(flyout.viewport.w).toBe(before.viewport.w);
    expect(flyout.cam).toEqual(before.cam);
    // A press on the canvas beside the flyout closes it.
    const canvasBox = (await page
      .locator("[data-paged-canvas]")
      .boundingBox())!;
    await page
      .locator("[data-paged-canvas]")
      .click({ position: { x: canvasBox.width - 24, y: 24 } });
    await expect(page.locator("[data-left-panel]")).toBeHidden();

    await page.setViewportSize({ width: 800, height: 600 });
    await expect(layout).toHaveAttribute("data-workspace-class", "narrow");
    await expect(page.locator("[data-right-column]")).toBeHidden();
    expect(await overflow()).toEqual({ page: 0, header: 0, modeBar: 0 });
    expect(await canvasWidth()).toBeGreaterThanOrEqual(500);
    // A panel rail button opens the dock as a drawer over the canvas.
    await page.locator("[data-panel-rail-item]").first().click();
    await expect(page.locator("[data-right-column]")).toBeVisible();
    await expect(page.locator("[data-right-column]")).toHaveAttribute(
      "data-dock-presentation",
      "drawer",
    );
    await page
      .locator("[data-paged-canvas]")
      .click({ position: { x: 20, y: 20 } });
    await expect(page.locator("[data-right-column]")).toBeHidden();

    await page.setViewportSize({ width: 1600, height: 1000 });
    await expect(layout).toHaveAttribute("data-workspace-class", "wide");
    await expect(page.locator("[data-left-panel]")).toBeVisible();
  });

  test("Edit ▸ Settings ▸ Adapt the workspace to the window off keeps the docks docked at a laptop width @feat:editor-shell.panel-rail @level:happy", async ({
    page,
  }) => {
    covers(
      "command:paged.view.adaptiveWorkspace",
      "menu:Edit/Settings/Adapt the workspace to the window",
    );
    await openCanvas(page, { adaptiveWorkspace: true });
    await loadViaReactPath(page, "geometry-groups");
    const layout = page.locator("[data-cockpit-layout]");
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(layout).toHaveAttribute("data-workspace-class", "laptop");
    await expect(page.locator("[data-left-panel]")).toBeHidden();

    await clickMenuRow(page, "Edit/Settings/Adapt the workspace to the window");
    await expect(layout).toHaveAttribute("data-workspace-class", "wide");
    await expect(page.locator("[data-left-panel]")).toBeVisible();
    await expect(page.locator('[data-dock-rail="left"]')).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("paged.adaptiveWorkspace"),
      ),
    ).toBe("off");

    await clickMenuRow(page, "Edit/Settings/Adapt the workspace to the window");
    await expect(layout).toHaveAttribute("data-workspace-class", "laptop");
  });

  test("the Focus workspace hides everything but the canvas and the tool rail and keeps the selection and the zoom @feat:editor-shell.panel-rail @level:happy", async ({
    page,
  }) => {
    covers(
      "command:paged.view.focusWorkspace",
      "menu:View/Focus workspace",
      "keybinding:cmd+.→paged.view.focusWorkspace",
      "keybinding:ctrl+.→paged.view.focusWorkspace",
    );
    await openCanvas(page, { adaptiveWorkspace: true });
    const fx = await loadViaReactPath(page, "geometry-groups");
    await selectElements(page, [fx.firstRectangle ?? fx.frames[0]!.ref]);
    const before = await viewState(page);

    await page
      .locator("[data-paged-canvas]")
      .click({ position: { x: 4, y: 4 } });
    await selectElements(page, [fx.firstRectangle ?? fx.frames[0]!.ref]);
    await page.keyboard.press("ControlOrMeta+.");
    await expect(page.locator("[data-focus-exit]")).toBeVisible();
    await expect(page.locator("header")).toBeHidden();
    await expect(page.locator("[data-mode-switcher]")).toBeHidden();
    await expect(page.locator("[data-left-panel]")).toBeHidden();
    await expect(page.locator("[data-tool-rail]")).toBeVisible();
    const focused = await settledView(
      page,
      (s) => s.viewport.w > before.viewport.w,
    );
    expect(focused.cam.scale).toBe(before.cam.scale);
    expect(focused.selection).toEqual(before.selection);
    expect(focused.undo).toEqual(before.undo);

    // The exit button brings the layout back as it was.
    await page.locator("[data-focus-exit]").click();
    await expect(page.locator("header")).toBeVisible();
    await expect(page.locator("[data-left-panel]")).toBeVisible();
    const back = await settledView(
      page,
      (s) => Math.abs(s.viewport.w - before.viewport.w) < 1,
    );
    expect(back.cam.scale).toBe(before.cam.scale);
    expect(back.selection).toEqual(before.selection);

    // View ▸ Focus workspace does the same.
    await clickMenuRow(page, "View/Focus workspace");
    await expect(page.locator("[data-focus-exit]")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+.");
    await expect(page.locator("[data-focus-exit]")).toHaveCount(0);
  });

  test("density presets size the interface, never the document or the zoom @feat:editor-shell.theme @level:happy", async ({
    page,
  }) => {
    covers(
      "menu:Edit/Settings/Interface density/Comfortable",
      "menu:Edit/Settings/Interface density/Professional",
      "menu:Edit/Settings/Interface density/Compact",
      "command:paged.view.density.comfortable",
      "command:paged.view.density.professional",
      "command:paged.view.density.compact",
    );
    await openCanvas(page, { adaptiveWorkspace: true });
    await loadViaReactPath(page, "geometry-groups");
    const root = page.locator("[data-paged-editor]");
    await expect(root).toHaveAttribute("data-density", "professional");
    const headerHeight = () =>
      page.evaluate(
        () => document.querySelector("header")!.getBoundingClientRect().height,
      );
    expect(await headerHeight()).toBe(46);
    const before = await viewState(page);
    const sizes = () =>
      page.evaluate(
        () =>
          (globalThis as unknown as CanvasHandle).__canvas.handle
            ?.pageSizesPt ?? [],
      );
    const pages = await sizes();

    for (const [label, density, header] of [
      ["Compact", "compact", 40],
      ["Comfortable", "comfortable", 52],
      ["Professional", "professional", 46],
    ] as const) {
      await clickMenuRow(page, `Edit/Settings/Interface density/${label}`);
      await expect(root).toHaveAttribute("data-density", density);
      await expect.poll(headerHeight).toBe(header);
      const now = await settledView(page, () => true);
      // The zoom and the document's geometry are the document's.
      expect(now.cam.scale).toBe(before.cam.scale);
      expect(await sizes()).toEqual(pages);
      expect(now.undo).toEqual(before.undo);
    }
  });

  test("the header: the tab names the document, Share is quiet, the developer readout is off by default (F-21, F-24) @feat:editor-shell.document-title @level:happy", async ({
    page,
  }) => {
    await openCanvas(page, { adaptiveWorkspace: true });
    await loadViaReactPath(page, "geometry-groups");
    await expect(page).toHaveTitle(/ — paged$/);
    await expect(page.locator("[data-save-status]")).toHaveCount(1);
    const share = page.locator("[data-collab-share]");
    await expect(share).toBeDisabled();
    expect(
      await share.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    await expect(page.locator("[data-viewport-hud]")).toHaveCount(0);
    // F-17 — a menu draws separators between its groups only: Help does
    // not end on one.
    await page.locator('[data-menu-trigger="Help"]').click();
    const help = page.locator('[role="menu"]').first();
    await expect(help).toBeVisible();
    expect(
      await help.evaluate(
        (el) => el.lastElementChild?.getAttribute("role") ?? null,
      ),
    ).not.toBe("separator");
    await page.keyboard.press("Escape");

    await openCanvas(page, { search: "?debug=hud", adaptiveWorkspace: true });
    await loadViaReactPath(page, "geometry-groups");
    await expect(page.locator("[data-viewport-hud]")).toBeVisible();
  });
});
