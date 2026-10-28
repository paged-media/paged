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

// paged.slide's animations (slide ADR 714): select a shape, add an
// entrance effect in the Animations pane, start the show on that slide:
// the shape is not there until the click, and the click brings it in.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { clickEntry, installMenuProbe } from "../../plugin-surface/menu-driver";
import { Designer } from "../driver/designer";
import { focusEditor, goToSlide, openDeck } from "./slide-show-helpers";

const stage = (page: Page) =>
  page.locator('[data-paged-presentation="show"] [data-show-stage]');

type Node = {
  id?: { kind: string; id: string } | null;
  pluginMetadata?: { key: string; value: string }[];
  children?: Node[];
};

/** The page items on `pageId` that are part of shapes from the deck. */
async function deckShapes(
  page: Page,
  pageId: string,
): Promise<{ kind: string; id: string }[]> {
  return page.evaluate(async (pid) => {
    const host = (
      globalThis as unknown as {
        __slideProbe: {
          document: {
            tree(): Promise<Node[]>;
            elementGeometry(
              ids: unknown[],
            ): Promise<{ id: { id: string }; pageId?: string | null }[]>;
          };
        };
      }
    ).__slideProbe;
    const rows: { kind: string; id: string }[] = [];
    const keys = new Set<string>();
    const walk = (nodes: Node[] | undefined) => {
      for (const n of nodes ?? []) {
        if (n.id) {
          // One item per shape (a shape with text is two items, one key).
          const key = /"shape":"([^"]+)"/.exec(
            n.pluginMetadata?.map((m) => m.value).join("") ?? "",
          )?.[1];
          if (key && !keys.has(key)) {
            keys.add(key);
            rows.push(n.id);
          }
        } else walk(n.children);
      }
    };
    walk(await host.document.tree());
    const geo = await host.document.elementGeometry(rows);
    const on = new Set(geo.filter((g) => g.pageId === pid).map((g) => g.id.id));
    return rows.filter((r) => on.has(r.id));
  }, pageId);
}

test.describe("journey · paged.slide animations", () => {
  test("an entrance effect added in the Animations pane plays on the click in the show @feat:plugin-slide.animations @level:happy", async ({
    page,
  }) => {
    covers(
      "panel:media.paged.slide.panel.animations",
      "command:media.paged.slide.command.slideShowFromCurrent",
    );
    const designer = new Designer(page);
    const ids = await openDeck(page);
    await goToSlide(page, ids[0]);
    const [shape] = await deckShapes(page, ids[0]);
    await designer.selectElement(shape.kind, shape.id);
    await designer.openPanel("media.paged.slide.panel.animations");
    const pane = page.locator("[data-animations-panel]");
    await expect(pane).toBeVisible({ timeout: 15_000 });
    const appear = pane.locator('[data-animation-preset="entr:1"]');
    await expect(appear).toBeEnabled({ timeout: 15_000 });
    await appear.click();
    await expect(pane.locator("[data-animation-row]")).toHaveCount(1, {
      timeout: 15_000,
    });

    await focusEditor(page);
    await page.keyboard.press("Shift+F5");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "1", {
      timeout: 15_000,
    });
    await expect(stage(page)).toHaveAttribute("data-frame", "animated", {
      timeout: 30_000,
    });
    // Before the click the shape is not on the slide.
    await expect(stage(page)).toHaveAttribute("data-step", "0");
    await expect(stage(page)).toHaveAttribute("data-visible-layers", "0", {
      timeout: 10_000,
    });
    // The click plays it; the slide stays.
    await page.keyboard.press("Space");
    await expect(stage(page)).toHaveAttribute("data-step", "1");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "1");
    await expect
      .poll(
        async () =>
          Number(await stage(page).getAttribute("data-visible-layers")),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    // The next click goes on to slide 2.
    await page.keyboard.press("Space");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "2");
    await page.keyboard.press("Escape");
  });

  test("Animations ▸ Animation Pane, Preview Animations and Animation Painter @feat:plugin-slide.animations @level:happy", async ({
    page,
  }) => {
    covers(
      "menu:Animations/Animation Pane",
      "menu:Animations/Preview Animations",
      "menu:Animations/Animation Painter",
      "command:media.paged.slide.command.animationPane",
      "command:media.paged.slide.command.previewAnimations",
      "command:media.paged.slide.command.animationPainter",
    );
    const designer = new Designer(page);
    const ids = await openDeck(page);
    await installMenuProbe(page);
    await goToSlide(page, ids[0]);
    const shapes = await deckShapes(page, ids[0]);
    expect(shapes.length).toBeGreaterThan(1);
    await designer.selectElement(shapes[0].kind, shapes[0].id);
    await clickEntry(
      page,
      "Animations/Animation Pane",
      "media.paged.slide.command.animationPane",
    );
    const pane = page.locator("[data-animations-panel]");
    await expect(pane).toBeVisible({ timeout: 15_000 });
    await pane.locator('[data-animation-preset="entr:10"]').click();
    await expect(pane.locator("[data-animation-row]")).toHaveCount(1, {
      timeout: 15_000,
    });

    // Preview plays the slide's animations over it in the editor.
    await clickEntry(
      page,
      "Animations/Preview Animations",
      "media.paged.slide.command.previewAnimations",
    );
    await expect(
      page.locator(`[data-slide-animation-preview="${ids[0]}"]`),
    ).toHaveCount(1, { timeout: 15_000 });

    // The painter: the next shape selected gets the effect.
    await designer.selectElement(shapes[0].kind, shapes[0].id);
    await clickEntry(
      page,
      "Animations/Animation Painter",
      "media.paged.slide.command.animationPainter",
    );
    // Select the next shape as a click does (the host's selection, which
    // bundles hear), through a bundle that may select.
    await page.evaluate(async (id) => {
      const g = globalThis as unknown as {
        __loadTestBundle: (b: unknown) => unknown;
      };
      await new Promise<void>((resolve) => {
        g.__loadTestBundle({
          manifest: {
            id: "media.paged.journey.selector",
            name: "selector",
            version: "0.0.0",
            apiVersion: "^0.2",
            capabilities: { document: { read: "broad", write: "broad" } },
          },
          activate(host: { selection: { set(ids: unknown[]): Promise<unknown> } }) {
            void host.selection.set([id]).then(() => resolve());
            return { dispose() {} };
          },
        });
      });
    }, shapes[1]);
    await expect(pane.locator("[data-animation-row]")).toHaveCount(2, {
      timeout: 15_000,
    });
  });
});
