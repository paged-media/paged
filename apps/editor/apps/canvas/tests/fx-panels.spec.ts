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

// Editor ADR 309 — the host's Effects, Transparency and Appearance panels
// and the Effect menu, end to end on the real engine:
//
//   FXP-MENU      every Object ▸ Effects ▸ ‹group› ▸ ‹effect› row core's
//                 catalog lists appends its kind to the selection's stack
//                 (the engine reads it back), one undo step each;
//   FXP-MASK      Transparency: Make a mask from two items, its thumbnail,
//                 Clip and Invert (the render changes), Edit Mask, Release;
//   FXP-APPEAR    Appearance: the object stack and the fill's own stack;
//   FXP-CONTEXT   plan WP10.7 — inside each module's edit context (doc,
//                 slide, sheet, draw) and in a publish document, the three
//                 panels open on the selection and the Effect menu applies.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { openCanvas, openPanel } from "./fidelity/canvas-driver";
import {
  REPO_ROOT,
  loadFixture,
  type ElementRef,
  type LoadedFixture,
} from "./e2e/harness/fixtures";
import { mutate, selectElements } from "./e2e/harness/ui";
import { undoOnce } from "./e2e/harness/objects";
import {
  engineGet,
  expectRenderChange,
  pageRender,
} from "./e2e/harness/engine";
import {
  clickEntry,
  installMenuProbe,
  isGreyed,
  openLeaf,
  routeOf,
} from "./plugin-surface/menu-driver";

const addr = (r: ElementRef) => `${r.kind}:${r.id}`;

/** Core's effect kinds, as the vendored catalog lists them. */
const CATALOG = JSON.parse(
  readFileSync(
    join(
      REPO_ROOT,
      "../../platform/extensions/packages/plugin-api/src/catalog.json",
    ),
    "utf8",
  ),
) as {
  effectKinds: Array<{ kind: string; title: string; category: string }>;
};

const SEGMENTS: Record<string, string> = {
  stylize: "Stylize",
  blur: "Blur",
  noise: "Noise",
  color: "Color",
  distortAndTransform: "Distort & Transform",
  path: "Path",
  pathfinder: "Pathfinder",
  warp: "Warp",
  convertToShape: "Convert to Shape",
  rasterize: "Rasterize",
};

const menuPath = (k: { title: string; category: string }) =>
  `Object/Effects/${SEGMENTS[k.category] ?? k.category}/${k.title}`;

async function stackKinds(
  page: Page,
  ref: ElementRef,
  path = "frameEffectStack",
) {
  const v = (await engineGet(page, addr(ref), path)) as {
    entries?: Array<{ kind: string }>;
  } | null;
  return (v?.entries ?? []).map((e) => e.kind);
}

async function blackRect(page: Page): Promise<LoadedFixture> {
  const fx = await loadFixture(page, "geometry");
  await mutate(page, {
    op: "setElementProperty",
    args: {
      elementId: fx.firstRectangle,
      path: "frameFillColor",
      value: { type: "colorRef", value: "Color/Black" },
    },
  });
  return fx;
}

test.describe("Effects, Transparency and Appearance (editor ADR 309)", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(240_000);
    await openCanvas(page);
  });

  test("FXP-MENU — every Effect menu row from core's catalog applies its kind, one undo each @feat:editor-shell.panels.appearance-transparency @feat:effects-transparency.effect-stack @level:happy", async ({
    page,
  }) => {
    const fx = await blackRect(page);
    const ref = fx.firstRectangle as ElementRef;
    await selectElements(page, [ref]);
    await installMenuProbe(page);
    // The families: one row and one command per core effect kind, each
    // clicked below.
    covers("menu:Object/Effects/*/*", "command:paged.effect.add.*");
    const kinds = CATALOG.effectKinds;
    expect(kinds.length).toBeGreaterThan(10);
    for (const k of kinds) {
      const path = menuPath(k);
      const command = `paged.effect.add.${k.kind}`;
      await clickEntry(page, path, command);
      await expect
        .poll(async () => (await stackKinds(page, ref)).at(-1), {
          message: `${path} appends ${k.kind}`,
        })
        .toBe(k.kind);
    }
    expect(await stackKinds(page, ref)).toEqual(kinds.map((k) => k.kind));
    // The row raised the Appearance panel, where the parameters are.
    await expect(page.locator('[data-appearance-panel="ready"]')).toBeVisible();
    // One undo step per row.
    await undoOnce(page);
    await expect
      .poll(async () => stackKinds(page, ref))
      .toEqual(kinds.slice(0, -1).map((k) => k.kind));
    // The panel rows beside the effects.
    covers(
      "menu:Object/Effects/Transparency…",
      "menu:Object/Effects/Appearance…",
    );
    await clickEntry(
      page,
      "Object/Effects/Transparency…",
      "paged.panel.show.paged.transparency",
    );
    await expect(
      page.locator('[data-transparency-panel="ready"]'),
    ).toBeVisible();
    await clickEntry(
      page,
      "Object/Effects/Appearance…",
      "paged.panel.show.paged.appearance",
    );
    await expect(page.locator('[data-appearance-panel="ready"]')).toBeVisible();
  });

  test("FXP-MASK — make a mask, its thumbnail, Clip and Invert change the render, Edit Mask, Release @feat:editor-shell.panels.appearance-transparency @feat:effects-transparency.opacity-mask @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.transparency");
    const fx = await blackRect(page);
    const target = fx.firstRectangle as ElementRef;
    // The artwork: a white rectangle over the target's corner.
    const made = (await mutate(page, {
      op: "insertFrame",
      args: { pageId: fx.pages[0]!.pageId, bounds: [0, 0, 400, 400] },
    })) as { payload?: { createdId?: ElementRef } };
    const art = made.payload?.createdId as ElementRef;
    expect(art, "the artwork was made").toBeTruthy();
    await mutate(page, {
      op: "setElementProperty",
      args: {
        elementId: art,
        path: "frameFillColor",
        value: { type: "colorRef", value: "Color/Paper" },
      },
    });
    await openPanel(page, "paged.transparency");
    const panel = page.locator('[data-transparency-panel="ready"]');
    await selectElements(page, [target, art]);
    await panel.locator('[data-mask-action="make"]').click();
    await expect
      .poll(async () => engineGet(page, addr(target), "opacityMask"))
      .toBe(art.id);
    await expect(panel).toHaveAttribute("data-mask-state", "masked");
    await expect(
      panel.locator('[data-mask-thumbnail="ready"] img'),
    ).toBeVisible();

    const before = await pageRender(page, fx.pages[0]!);
    await panel.locator('[data-toggle-switch="mask:clip"]').click();
    await expect
      .poll(async () => engineGet(page, addr(target), "opacityMaskClip"))
      .toBe(false);
    await expectRenderChange(page, fx.pages[0]!, before);
    const unclipped = await pageRender(page, fx.pages[0]!);
    await panel.locator('[data-toggle-switch="mask:invert"]').click();
    await expect
      .poll(async () => engineGet(page, addr(target), "opacityMaskInvert"))
      .toBe(true);
    await expectRenderChange(page, fx.pages[0]!, unclipped);
    await undoOnce(page);
    await expect
      .poll(async () => engineGet(page, addr(target), "opacityMaskInvert"))
      .toBe(false);
    expect(await engineGet(page, addr(target), "opacityMask")).toBe(art.id);

    // Edit Mask: the artwork is selected while it masks.
    await panel.locator('[data-mask-action="edit"]').click();
    await expect(panel).toHaveAttribute("data-mask-state", "editing");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as {
                __canvas: { elementSelection?: Array<{ id: string }> };
              }
            ).__canvas.elementSelection?.map((e) => e.id) ?? [],
        ),
      )
      .toEqual([art.id]);
    await panel.locator('[data-mask-action="stop"]').click();
    await expect(panel).toHaveAttribute("data-mask-state", "masked");

    await panel.locator('[data-mask-action="release"]').click();
    await expect
      .poll(async () => engineGet(page, addr(target), "opacityMask"))
      .toBe("");
  });

  test("FXP-APPEAR — the object stack and the fill's own stack @feat:editor-shell.panels.appearance-transparency @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.appearance");
    const fx = await blackRect(page);
    const ref = fx.firstRectangle as ElementRef;
    await selectElements(page, [ref]);
    await openPanel(page, "paged.appearance");
    const panel = page.locator('[data-appearance-panel="ready"]');
    await expect(panel).toBeVisible();
    await panel
      .locator(
        '[data-appearance-section="effects"] select[data-effect-stack-add]',
      )
      .selectOption("gaussianBlur");
    await expect
      .poll(async () => stackKinds(page, ref))
      .toEqual(["gaussianBlur"]);
    await panel.locator('[data-appearance-target-toggle="fill"]').click();
    await panel
      .locator(
        '[data-appearance-target-stack="fill"] select[data-effect-stack-add]',
      )
      .selectOption("innerGlow");
    await expect
      .poll(async () => stackKinds(page, ref, "frameFillEffectStack"))
      .toEqual(["innerGlow"]);
  });

  // Plan WP10.7: the shared host panels in every module's edit context.
  for (const ctx of [
    { module: "doc", type: "wordDocument" },
    { module: "slide", type: "slideDeck" },
    { module: "sheet", type: "sheet" },
    { module: "draw", type: "vectorGraphic" },
    { module: "publish", type: null },
  ] as const) {
    test(`FXP-CONTEXT-${ctx.module} — the panels open and the Effect menu applies ${
      ctx.type ? `inside ${ctx.type}` : "in a publish (IDML) document"
    } @feat:editor-shell.shared-panels-every-context @feat:editor-shell.panels.appearance-transparency @level:happy`, async ({
      page,
    }) => {
      const fx = await blackRect(page);
      // A rectangle is a path to draw's vector context as well.
      const ref = fx.firstRectangle as ElementRef;
      expect(ref, "the fixture has the item").not.toBeNull();
      await selectElements(page, [ref]);
      if (ctx.type) {
        const entered = await page.evaluate(
          async ({ type, ref }) => {
            const raw = (globalThis as unknown as { __shellDoors?: unknown })
              .__shellDoors;
            const doors = (typeof raw === "function" ? raw() : raw) as
              | {
                  enterEditContext?: (
                    t: string,
                    e: unknown,
                  ) => Promise<boolean>;
                }
              | undefined;
            return (await doors?.enterEditContext?.(type, ref)) ?? false;
          },
          { type: ctx.type, ref },
        );
        expect(entered, `entered ${ctx.type}`).toBe(true);
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  globalThis as unknown as {
                    __canvas: {
                      debugContext?: () => {
                        editContext?: { type?: string } | null;
                      };
                    };
                  }
                ).__canvas.debugContext?.()?.editContext?.type ?? null,
            ),
          )
          .toBe(ctx.type);
      }
      for (const [id, ready] of [
        ["paged.effects", '[data-effects-panel="ready"]'],
        ["paged.transparency", '[data-transparency-panel="ready"]'],
        ["paged.appearance", '[data-appearance-panel="ready"]'],
      ] as const) {
        await openPanel(page, id);
        await expect(
          page.locator(ready),
          `${id} in ${ctx.module}`,
        ).toBeVisible();
      }
      // The Effects panel edits the selection here.
      await expect(
        page.locator(
          '[data-effects-panel] [data-effect-stack="object"] select[data-effect-stack-add]',
        ),
      ).toBeEnabled();
      covers(
        "menu:Object/Effects/Stylize/Drop shadow",
        "command:paged.effect.add.dropShadow",
      );
      // Through the real menu bar, inside the context.
      const item = await openLeaf(
        page,
        routeOf("Object/Effects/Stylize/Drop shadow"),
      );
      expect(await isGreyed(item), "the row applies here").toBe(false);
      await item.click();
      await expect
        .poll(async () => stackKinds(page, ref))
        .toEqual(["dropShadow"]);
      if (ctx.type) {
        // Applying the effect did not leave the context.
        expect(
          await page.evaluate(
            () =>
              (
                globalThis as unknown as {
                  __canvas: {
                    debugContext?: () => {
                      editContext?: { type?: string } | null;
                    };
                  };
                }
              ).__canvas.debugContext?.()?.editContext?.type ?? null,
          ),
        ).toBe(ctx.type);
      }
    });
  }
});
