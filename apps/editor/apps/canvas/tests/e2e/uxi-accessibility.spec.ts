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

// Accessibility and keyboard-only editing (interaction contract §19; editor
// ADR "An accessible object tree"): the object tree names the document's
// objects and shares one selection with the canvas and the inspector
// (UXI-T69), a document is created and transformed with the keyboard alone
// (UXI-T70), and axe finds no WCAG 2.2 AA violation in the main chrome, dark
// or light, beyond the exceptions listed below. Each asserts the model, the
// selection and the history, never a screenshot.

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import {
  expectHistoryUnchanged,
  expectUndoSteps,
  historyDepth,
} from "./harness/history";
import { clickMenuRow } from "./harness/shell-surface";
import { modelSnapshot, selectionSnapshot } from "./harness/model-dump";
import { loadUxiFixture, openUxiFixture, UXI_A } from "./harness/uxi-fixtures";
import { openCanvas } from "../fidelity/canvas-driver";

const A = UXI_A;
const key = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;

interface CanvasGlobal {
  __canvas: {
    client: {
      setElementSelection(ids: unknown[], mode: string): Promise<Ref[]>;
      elementGeometry(
        ids: unknown[],
      ): Promise<
        Array<{ id: Ref; bounds: number[]; itemTransform?: number[] | null }>
      >;
    };
    registries: { commands: { invoke: (id: string) => unknown } };
  };
}
type Ref = { kind: string; id: string };

/** The engine's own element selection (an empty `add` answers the set). */
async function engineSelection(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas;
    const ids = await c.client.setElementSelection([], "add");
    return ids.map((i) => `${i.kind}:${i.id}`).sort();
  });
}

async function mirror(page: Page): Promise<string[]> {
  return (await selectionSnapshot(page)).elements.map(key);
}

async function geometry(page: Page, ref: Ref) {
  return page.evaluate(async (r) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas;
    const [g] = await c.client.elementGeometry([r]);
    return g ?? null;
  }, ref);
}

const viewport = (page: Page) =>
  page.locator('[data-canvas-surface="viewport"]');
const tree = (page: Page) => page.locator("[data-object-tree]");
const treeRow = (page: Page, ref: Ref) =>
  page.locator(`[data-object-key="${key(ref)}"]`);

/** Focus the canvas with the keyboard's own route: no click. */
async function focusCanvas(page: Page): Promise<void> {
  await viewport(page).focus();
  await expect(viewport(page)).toBeFocused();
}

/** Run a command through the palette, typed. */
async function palette(page: Page, text: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("[data-palette-footer]")).toBeVisible();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-palette-footer]")).toBeHidden();
}

test.describe("the object tree", () => {
  test("UXI-T69 — the object tree names each object's type, page and lock state, and its selection is the canvas's and the inspector's, both ways @feat:editor-shell.panels.tree @feat:editor-shell.keyboard-shortcuts @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.tree");
    covers("command:paged.view.objectTree");
    covers("keybinding:alt+shift+o→paged.view.objectTree");
    await openUxiFixture(page, "A");
    const before = await modelSnapshot(page);
    await expectHistoryUnchanged(
      page,
      async () => {
        // From the canvas, the documented key reaches the tree.
        await focusCanvas(page);
        await page.keyboard.press("Alt+Shift+KeyO");
        await expect(tree(page)).toBeFocused();
        await expect(tree(page)).toHaveAttribute("role", "tree");

        // Names: type, page, lock.
        await expect(treeRow(page, A.locked.id)).toHaveAccessibleName(
          /^Rectangle .*page 1, locked$/,
        );
        await expect(treeRow(page, A.front.id)).toHaveAccessibleName(
          /^Rectangle .*page 1$/,
        );
        await expect(treeRow(page, A.note.id)).toHaveAccessibleName(
          /^Text frame /,
        );

        // Walk to the locked rectangle with the arrows and select it.
        for (let i = 0; i < 12; i++) {
          const active = await tree(page).getAttribute("aria-activedescendant");
          const id = await treeRow(page, A.locked.id).getAttribute("id");
          if (active === id) break;
          await page.keyboard.press("ArrowDown");
        }
        await page.keyboard.press("Enter");
        // One accepted selection: the engine's, the canvas mirror's, the
        // inspector's, and the row's state.
        await expect
          .poll(() => engineSelection(page))
          .toEqual([key(A.locked.id)]);
        await expect.poll(() => mirror(page)).toEqual([key(A.locked.id)]);
        await expect(treeRow(page, A.locked.id)).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(
          page.locator('[data-properties-panel="ready"]'),
        ).toHaveAttribute("data-has-element", "true");

        // The other way: a selection made on the canvas side marks its row.
        await page.evaluate(async (ref) => {
          const c = (globalThis as unknown as CanvasGlobal)
            .__canvas as never as {
            client: CanvasGlobal["__canvas"]["client"];
            setElementSelection(i: unknown[]): void;
            setElementGeometry(g: unknown[]): void;
          };
          const ids = await c.client.setElementSelection([ref], "replace");
          c.setElementSelection(ids);
          c.setElementGeometry(await c.client.elementGeometry(ids));
        }, A.front.id);
        await expect(treeRow(page, A.front.id)).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(treeRow(page, A.locked.id)).toHaveAttribute(
          "aria-selected",
          "false",
        );

        // Escape gives focus back to the canvas, which keeps the selection.
        await tree(page).focus();
        await page.keyboard.press("Escape");
        await expect(viewport(page)).toBeFocused();
        expect(await mirror(page)).toEqual([key(A.front.id)]);
      },
      "navigating and selecting through the tree",
    );
    expect(await modelSnapshot(page)).toBe(before);
  });
});

test.describe("keyboard-only editing", () => {
  test("UXI-T70 — create, select, move, turn and size an object with the keyboard alone, one undo step each @feat:editor-tools.object-commands @feat:frames-paths.frame.insert @level:happy", async ({
    page,
  }) => {
    covers("command:paged.insert.rectangle");
    covers("command:paged.object.nudgeRight");
    covers("command:paged.transform.rotate90Clockwise");
    covers("command:paged.transform.scaleUp");
    covers("command:paged.object.selectNextBelow");
    covers("keybinding:cmd+alt+[→paged.object.selectNextBelow");
    covers("keybinding:ctrl+alt+[→paged.object.selectNextBelow");
    covers("keybinding:cmd+alt+]→paged.object.selectNextAbove");
    covers("keybinding:ctrl+alt+]→paged.object.selectNextAbove");
    await openUxiFixture(page, "A");
    await focusCanvas(page);

    // Create: Insert rectangle from the palette, centred in view, selected.
    let depth = (await historyDepth(page)).undo;
    await palette(page, "Insert rectangle");
    await expect
      .poll(async () => (await historyDepth(page)).undo)
      .toBe(depth + 1);
    const [created] = (await selectionSnapshot(page)).elements;
    expect(created?.kind).toBe("rectangle");
    const placed = (await geometry(page, created!))!;
    expect(placed.bounds[3]! - placed.bounds[1]!).toBeCloseTo(160, 3);

    // Move: the palette gave focus back to the canvas, so an arrow nudges.
    await expect(viewport(page)).toBeFocused();
    depth = (await historyDepth(page)).undo;
    const x0 = (await geometry(page, created!))!.itemTransform?.[4] ?? 0;
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => (await historyDepth(page)).undo)
      .toBe(depth + 1);
    expect(
      ((await geometry(page, created!))!.itemTransform?.[4] ?? 0) - x0,
    ).toBeCloseTo(1, 3);

    // Turn: a quarter turn clockwise, one step.
    depth = (await historyDepth(page)).undo;
    await palette(page, "Transform: Rotate 90° clockwise");
    await expect
      .poll(async () => (await historyDepth(page)).undo)
      .toBe(depth + 1);
    const turned = (await geometry(page, created!))!.itemTransform!;
    expect(turned[0]).toBeCloseTo(0, 6);
    expect(turned[1]).toBeCloseTo(1, 6);

    // Size: up 10 %, one step.
    depth = (await historyDepth(page)).undo;
    await palette(page, "Transform: Scale up 10%");
    await expect
      .poll(async () => (await historyDepth(page)).undo)
      .toBe(depth + 1);
    const scaled = (await geometry(page, created!))!.itemTransform!;
    expect(Math.hypot(scaled[0]!, scaled[1]!)).toBeCloseTo(1.1, 4);

    // Select under: the overlapping pair, front then back, by key; a
    // selection change is no undo step (D-15).
    await page.evaluate(async (ref) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas as never as {
        client: CanvasGlobal["__canvas"]["client"];
        setElementSelection(i: unknown[]): void;
        setElementGeometry(g: unknown[]): void;
      };
      const ids = await c.client.setElementSelection([ref], "replace");
      c.setElementSelection(ids);
      c.setElementGeometry(await c.client.elementGeometry(ids));
    }, A.front.id);
    await focusCanvas(page);
    await expectHistoryUnchanged(
      page,
      async () => {
        await page.keyboard.press("ControlOrMeta+Alt+BracketLeft");
        await expect.poll(() => mirror(page)).toEqual([key(A.back.id)]);
        await page.keyboard.press("ControlOrMeta+Alt+BracketLeft");
        await expect.poll(() => mirror(page)).toEqual([key(A.front.id)]);
        await page.keyboard.press("ControlOrMeta+Alt+BracketRight");
        await expect.poll(() => mirror(page)).toEqual([key(A.back.id)]);
      },
      "the selection cycle",
    );
    expect(await engineSelection(page)).toEqual([key(A.back.id)]);
  });
});

test.describe("the menus", () => {
  test("Object ▸ Transform's rotate and scale steps, Object's selection cycle and View ▸ Go to object tree, each from its menu row: one undo step per transform, none per selection @feat:editor-tools.object-commands @feat:editor-shell.menus @level:happy", async ({
    page,
  }) => {
    covers("menu:Object/Transform/Rotate 90° clockwise");
    covers("menu:Object/Transform/Rotate 90° counterclockwise");
    covers("menu:Object/Transform/Rotate 15° clockwise");
    covers("menu:Object/Transform/Rotate 15° counterclockwise");
    covers("menu:Object/Transform/Scale up 10%");
    covers("menu:Object/Transform/Scale down 10%");
    covers("command:paged.transform.rotate90Counterclockwise");
    covers("command:paged.transform.rotateStepClockwise");
    covers("command:paged.transform.rotateStepCounterclockwise");
    covers("command:paged.transform.scaleDown");
    covers("menu:Object/Select next object below");
    covers("menu:Object/Select next object above");
    covers("command:paged.object.selectNextAbove");
    covers("menu:View/Go to object tree");
    await openUxiFixture(page, "A");
    await page.evaluate(async (ref) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas as never as {
        client: CanvasGlobal["__canvas"]["client"];
        setElementSelection(i: unknown[]): void;
        setElementGeometry(g: unknown[]): void;
      };
      const ids = await c.client.setElementSelection([ref], "replace");
      c.setElementSelection(ids);
      c.setElementGeometry(await c.client.elementGeometry(ids));
    }, A.free.id);
    const linear = async () => {
      const t = (await geometry(page, A.free.id))!.itemTransform ?? [
        1, 0, 0, 1, 0, 0,
      ];
      return t.slice(0, 4).map((v) => Math.round(v * 1e4) / 1e4);
    };
    // A quarter turn each way comes back; 15° each way too.
    await expectUndoSteps(page, 1, () =>
      clickMenuRow(page, "Object/Transform/Rotate 90° clockwise"),
    );
    expect(await linear()).toEqual([0, 1, -1, 0]);
    await expectUndoSteps(page, 1, () =>
      clickMenuRow(page, "Object/Transform/Rotate 90° counterclockwise"),
    );
    expect(await linear()).toEqual([1, 0, 0, 1]);
    await expectUndoSteps(page, 1, () =>
      clickMenuRow(page, "Object/Transform/Rotate 15° clockwise"),
    );
    const c15 = Math.round(Math.cos(Math.PI / 12) * 1e4) / 1e4;
    const s15 = Math.round(Math.sin(Math.PI / 12) * 1e4) / 1e4;
    expect(await linear()).toEqual([c15, s15, -s15, c15]);
    await expectUndoSteps(page, 1, () =>
      clickMenuRow(page, "Object/Transform/Rotate 15° counterclockwise"),
    );
    expect(await linear()).toEqual([1, 0, 0, 1]);
    await expectUndoSteps(page, 1, () =>
      clickMenuRow(page, "Object/Transform/Scale up 10%"),
    );
    expect((await linear())[0]).toBeCloseTo(1.1, 4);
    await expectUndoSteps(page, 1, () =>
      clickMenuRow(page, "Object/Transform/Scale down 10%"),
    );
    expect((await linear())[0]).toBeCloseTo(0.99, 4);

    // The cycle from the menu: front over back, a selection change only.
    await page.evaluate(async (ref) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas as never as {
        client: CanvasGlobal["__canvas"]["client"];
        setElementSelection(i: unknown[]): void;
        setElementGeometry(g: unknown[]): void;
      };
      const ids = await c.client.setElementSelection([ref], "replace");
      c.setElementSelection(ids);
      c.setElementGeometry(await c.client.elementGeometry(ids));
    }, A.back.id);
    await expectHistoryUnchanged(page, async () => {
      await clickMenuRow(page, "Object/Select next object above");
      await expect.poll(() => mirror(page)).toEqual([key(A.front.id)]);
      await clickMenuRow(page, "Object/Select next object below");
      await expect.poll(() => mirror(page)).toEqual([key(A.back.id)]);
      // View ▸ Go to object tree: the tree, focused, its row selected.
      await clickMenuRow(page, "View/Go to object tree");
      await expect(tree(page)).toBeFocused();
      await expect(treeRow(page, A.back.id)).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  test("Edit ▸ Settings ▸ Contrast: High, Standard and As the system, each ticked and applied, the document unchanged @feat:editor-shell.theme @feat:editor-shell.menus @level:happy", async ({
    page,
  }) => {
    covers("menu:Edit/Settings/Contrast/As the system");
    covers("menu:Edit/Settings/Contrast/Standard");
    covers("menu:Edit/Settings/Contrast/High");
    covers("command:paged.view.contrast.system");
    covers("command:paged.view.contrast.standard");
    covers("command:paged.view.contrast.high");
    covers("setting:paged.contrast");
    await page.emulateMedia({ contrast: "more" });
    await openUxiFixture(page, "A");
    const root = page.locator("[data-paged-editor]").first();
    const before = await modelSnapshot(page);
    await expectHistoryUnchanged(page, async () => {
      await expect(root).toHaveAttribute("data-contrast", "more");
      await clickMenuRow(page, "Edit/Settings/Contrast/Standard");
      await expect(root).toHaveAttribute("data-contrast", "standard");
      expect(
        await page.evaluate(() => localStorage.getItem("paged.contrast")),
      ).toBe("standard");
      await clickMenuRow(page, "Edit/Settings/Contrast/High");
      await expect(root).toHaveAttribute("data-contrast", "more");
      await page.emulateMedia({ contrast: "no-preference" });
      await expect(root).toHaveAttribute("data-contrast", "more");
      await clickMenuRow(page, "Edit/Settings/Contrast/As the system");
      await expect(root).toHaveAttribute("data-contrast", "standard");
      await page.emulateMedia({ contrast: "more" });
      await expect(root).toHaveAttribute("data-contrast", "more");
    });
    expect(await modelSnapshot(page)).toBe(before);
  });
});

/** The rules axe may not hold the editor to yet, each with its reason. A
 *  rule leaves this list when it passes; a new violation fails the run.
 *  Empty: the chrome passes every WCAG 2.2 A and AA rule axe checks. */
export const AXE_EXCEPTIONS: ReadonlyArray<{ rule: string; why: string }> = [];

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axe(page: Page, scope = "[data-paged-editor]") {
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .include(scope)
    // The canvas's pixels are the document, not the chrome (its structure
    // is the object tree); the bitmap itself has nothing for axe to read.
    .exclude("canvas")
    .disableRules(AXE_EXCEPTIONS.map((e) => e.rule))
    .analyze();
  return results.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    count: v.nodes.length,
  }));
}

/** The chrome, three menus and the palette, each through axe. */
async function axeTheChrome(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as CanvasGlobal).__canvas.registries.commands.invoke(
      "paged.panel.show.paged.tree",
    ),
  );
  await expect(tree(page)).toBeVisible();
  expect(await axe(page), "the chrome").toEqual([]);
  for (const name of ["Object", "Edit", "View"]) {
    await page.getByRole("menuitem", { name, exact: true }).first().click();
    await expect(page.locator('[role="menu"]').first()).toBeVisible();
    expect(await axe(page, '[role="menu"]'), `the ${name} menu`).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
  }
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("[data-palette-footer]")).toBeVisible();
  await page.keyboard.type("rect");
  expect(await axe(page, '[role="dialog"]'), "the palette").toEqual([]);
  await page.keyboard.press("Escape");
}

/** Start in `theme` (and, with `contrast`, under `prefers-contrast`). */
async function openIn(
  page: Page,
  theme: "dark" | "light",
  contrast?: "more",
): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("paged.theme", t);
    } catch {
      /* private mode: the default theme */
    }
  }, theme);
  if (contrast) await page.emulateMedia({ contrast });
  await openUxiFixture(page, "A");
  const root = page.locator("[data-paged-editor]").first();
  if (theme === "dark") await expect(root).toHaveClass(/\bdark\b/);
  else await expect(root).not.toHaveClass(/\bdark\b/);
}

test.describe("contrast", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`UXI-T74 — ${theme} theme: axe finds no WCAG 2.2 AA violation in the chrome, its menus and the palette (F-51) @feat:editor-shell.theme @level:happy @uxi:UXI-A11Y-001 @uxi:UXI-A11Y-012`, async ({
      page,
    }) => {
      covers("panel:paged.tree");
      await openIn(page, theme);
      await expect(page.locator("[data-paged-editor]").first()).toHaveAttribute(
        "data-contrast",
        "standard",
      );
      const before = await modelSnapshot(page);
      await expectHistoryUnchanged(page, () => axeTheChrome(page));
      expect(await modelSnapshot(page)).toBe(before);
    });

    test(`UXI-T74 — ${theme} theme under prefers-contrast: more: high contrast, a two-tone selection and focus ring, axe clean, the document and selection unchanged @feat:editor-shell.theme @level:edge @uxi:UXI-A11Y-012`, async ({
      page,
    }) => {
      covers("setting:paged.contrast");
      await openIn(page, theme, "more");
      const root = page.locator("[data-paged-editor]").first();
      await expect(root).toHaveAttribute("data-contrast", "more");
      const before = await modelSnapshot(page);
      await expectHistoryUnchanged(page, async () => {
        // The selection's chrome: a halo around every selection stroke.
        await page.evaluate(async (ref) => {
          const c = (globalThis as unknown as CanvasGlobal)
            .__canvas as never as {
            client: CanvasGlobal["__canvas"]["client"];
            setElementSelection(i: unknown[]): void;
            setElementGeometry(g: unknown[]): void;
          };
          const ids = await c.client.setElementSelection([ref], "replace");
          c.setElementSelection(ids);
          c.setElementGeometry(await c.client.elementGeometry(ids));
        }, A.front.id);
        const cue = page.locator('[stroke="var(--overlay-selection)"]').first();
        await expect(cue).toBeAttached();
        expect(
          await cue.evaluate((el) => getComputedStyle(el).filter),
        ).toContain("drop-shadow");
        // A focused control: a 3 px ring with a band of the surface.
        await focusCanvas(page);
        await page.keyboard.press("Alt+Shift+KeyO");
        await expect(tree(page)).toBeFocused();
        const ring = await tree(page).evaluate((el) => {
          const cs = getComputedStyle(el);
          return {
            width: cs.outlineWidth,
            style: cs.outlineStyle,
            shadow: cs.boxShadow,
          };
        });
        expect(ring.width).toBe("3px");
        expect(ring.style).toBe("solid");
        expect(ring.shadow).not.toBe("none");
        // Words, not colour alone: the locked object says so.
        await expect(treeRow(page, A.locked.id)).toHaveAccessibleName(
          /locked$/,
        );
        await page.keyboard.press("Escape");
        await axeTheChrome(page);
        // Standard on request, whatever the system says.
        await page.evaluate(() =>
          (
            globalThis as unknown as CanvasGlobal
          ).__canvas.registries.commands.invoke("paged.view.contrast.standard"),
        );
        await expect(root).toHaveAttribute("data-contrast", "standard");
        expect(await cue.evaluate((el) => getComputedStyle(el).filter)).toBe(
          "none",
        );
      });
      expect(await mirror(page)).toEqual([key(A.front.id)]);
      expect(await modelSnapshot(page)).toBe(before);
    });
  }
});

test.describe("reduced motion and 200 % zoom", () => {
  test("UXI-T75 — at 200 % browser zoom with reduced motion, nothing scrolls sideways, no control is cut off, and the keyboard reaches the canvas, the tree and back @feat:editor-shell.theme @feat:editor-tools.nav.zoom @level:edge @uxi:UXI-A11Y-002 @uxi:UXI-A11Y-013", async ({
    browser,
  }) => {
    // 200 % zoom of a 1280 × 800 window: a 640 × 400 CSS-pixel viewport
    // at twice the device pixels, as the browser lays it out.
    const context = await browser.newContext({
      viewport: { width: 640, height: 400 },
      deviceScaleFactor: 2,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    try {
      await openCanvas(page, { adaptiveWorkspace: true });
      await loadUxiFixture(page, "A");
      const before = await modelSnapshot(page);
      await expectHistoryUnchanged(page, async () => {
        // Nothing scrolls sideways.
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          ),
        ).toBeLessThanOrEqual(0);
        // Every header control is on screen whole (or scrolled into its
        // own zone, never cut by the window's edge).
        const clipped = await page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              "header button, header [role=menuitem]",
            ),
          ]
            .filter((el) => el.offsetParent !== null)
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.right > window.innerWidth + 0.5 || r.left < -0.5;
            })
            .filter((el) => {
              // A control inside a horizontally scrolling zone is reached
              // by scrolling that zone, as the menus' zone does.
              for (let p = el.parentElement; p; p = p.parentElement) {
                if (
                  p.scrollWidth > p.clientWidth + 1 &&
                  getComputedStyle(p).overflowX !== "visible"
                )
                  return false;
              }
              return true;
            })
            .map((el) => el.getAttribute("aria-label") ?? el.textContent),
        );
        expect(clipped).toEqual([]);
        // The keyboard reaches the canvas by Tab, with a visible ring.
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.blur?.(),
        );
        let reached = false;
        for (let i = 0; i < 80 && !reached; i++) {
          await page.keyboard.press("Tab");
          reached = await viewport(page).evaluate(
            (el) => el === document.activeElement,
          );
        }
        expect(reached).toBe(true);
        expect(
          await viewport(page).evaluate(
            (el) => getComputedStyle(el).outlineStyle,
          ),
        ).not.toBe("none");
        // …then the object tree, and back.
        await page.keyboard.press("Alt+Shift+KeyO");
        await expect(tree(page)).toBeFocused();
        await expect(tree(page)).toBeInViewport();
        await page.keyboard.press("Escape");
        await expect(viewport(page)).toBeFocused();
        // Reduced motion: a fit is one step, no animation.
        const scales: number[] = [];
        await page.evaluate(() =>
          (
            globalThis as unknown as CanvasGlobal
          ).__canvas.registries.commands.invoke("paged.view.zoomIn"),
        );
        for (let i = 0; i < 6; i++) {
          scales.push(
            await page.evaluate(
              () =>
                (
                  globalThis as unknown as {
                    __canvas: {
                      client: { camera: { read: () => { scale: number } } };
                    };
                  }
                ).__canvas.client.camera.read().scale,
            ),
          );
          await page.waitForTimeout(40);
        }
        expect(new Set(scales).size).toBe(1);
      });
      expect(await modelSnapshot(page)).toBe(before);
    } finally {
      await context.close();
    }
  });
});
