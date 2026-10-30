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
// paged.slide effects parity (slide ADR 723), in the browser, on decks
// PowerPoint wrote: a pattern deck opens with every pattern drawn as its
// tiles and exports its `a:pattFill` as it was, after an edit too; a
// bevel deck opens with the engine's bevels and keeps its `a:sp3d`; the
// Format Painter gives a shape another's shadow and nothing else.

import { expect, test, type Page } from "@playwright/test";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { covers } from "@paged-media/test-kit";

import { Designer } from "../driver/designer";
import {
  exportedPart,
  goToSlide,
  openDeckFile,
  shapesOn,
} from "./slide-show-helpers";

const FIXTURES = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../../modules/slide/slide-conformance/fixtures",
);

/** Whether the elements hold a picture (a pattern's tiles). */
async function hasImage(
  page: Page,
  ids: { kind: string; id: string }[],
): Promise<boolean[]> {
  return page.evaluate(async (ids) => {
    const host = (
      globalThis as unknown as {
        __slideProbe: {
          document: {
            elementGeometry(ids: unknown[]): Promise<{ hasImage?: boolean }[]>;
          };
        };
      }
    ).__slideProbe;
    return (await host.document.elementGeometry(ids)).map((g) => !!g.hasImage);
  }, ids);
}

/** Select an element as a click does: the engine's selection, which a
 *  bundle hears, then the shell's mirror. */
async function click(
  page: Page,
  designer: Designer,
  el: { kind: string; id: string },
): Promise<void> {
  await page.evaluate(
    async (el) => {
      const c = (
        globalThis as unknown as {
          __canvas: {
            client: {
              setElementSelection: (
                ids: { kind: string; id: string }[],
                mode: string,
              ) => Promise<unknown>;
            };
          };
        }
      ).__canvas;
      await c.client.setElementSelection([el], "replace");
    },
    { kind: el.kind, id: el.id },
  );
  await designer.selectElement(el.kind, el.id);
}

/** The `a:spPr` of shape `id` in a slide's XML. */
const spPr = (xml: string, id: number) => {
  const at = xml.indexOf(`<p:cNvPr id="${id}"`);
  const from = xml.indexOf("<p:spPr", at);
  return xml.slice(from, xml.indexOf("</p:spPr>", from));
};

test.describe("journey · paged.slide effects", () => {
  test("patterns are drawn as their tiles and exported as they were @feat:plugin-slide.native-effects @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    const ids = await openDeckFile(
      page,
      `${FIXTURES}/patterns.pptx`,
      "patterns.pptx",
      3,
    );
    await goToSlide(page, ids[0]!);
    const shapes = await shapesOn(page, ids[0]!);
    expect(shapes.length).toBe(27);
    expect((await hasImage(page, shapes)).every(Boolean)).toBe(true);
    const xml = await exportedPart(page, "ppt/slides/slide1.xml");
    expect(xml.match(/<a:pattFill /g)?.length).toBe(27);

    // Given a shadow, the shape keeps its pattern in the exported deck.
    await designer.applyDropShadow(shapes[0]!.kind, shapes[0]!.id, 4);
    await expect
      .poll(
        async () =>
          spPr(await exportedPart(page, "ppt/slides/slide1.xml"), 100),
        { timeout: 15_000 },
      )
      .toContain("<a:outerShdw");
    expect(
      spPr(await exportedPart(page, "ppt/slides/slide1.xml"), 100),
    ).toContain('<a:pattFill prst="pct5">');
  });

  test("bevels keep their 3-D look; the Format Painter gives a shape another's shadow @feat:plugin-slide.native-effects @level:happy", async ({
    page,
  }) => {
    covers("command:media.paged.slide.command.formatPainter");
    const designer = new Designer(page);
    const ids = await openDeckFile(
      page,
      `${FIXTURES}/bevels.pptx`,
      "bevels.pptx",
      2,
    );
    await goToSlide(page, ids[1]!);
    const shapes = await shapesOn(page, ids[1]!);
    const byId = (n: number) => shapes.find((s) => s.key.endsWith(`#${n}`))!;
    // "plain offset" (104) casts an outer shadow; "glow small" (105) none.
    const from = byId(104);
    const to = byId(105);
    const slide2 = () => exportedPart(page, "ppt/slides/slide2.xml");
    expect(spPr(await slide2(), 105)).not.toContain("<a:outerShdw");

    await click(page, designer, from);
    await designer.runCommand("media.paged.slide.command.formatPainter");
    await click(page, designer, to);
    await expect
      .poll(async () => spPr(await slide2(), 105), { timeout: 15_000 })
      .toContain("<a:outerShdw");
    // The painter is off again: the next shape keeps its look.
    const other = byId(106);
    await click(page, designer, other);
    expect(spPr(await slide2(), 106)).not.toContain("<a:outerShdw");
    // Its own effects stay: the source's switched-off ones are not turned on.
    expect(spPr(await slide2(), 105)).not.toContain("<a:sp3d");

    // (Undo is not asserted here: the engine's inverse of an effect
    // setting whose previous value was absent does not restore it; see
    // slide ADR 723, Consequences.)

    // Slide 1's bevels export as PowerPoint wrote them.
    const s1 = await exportedPart(page, "ppt/slides/slide1.xml");
    expect(s1.match(/<a:bevelT/g)?.length).toBeGreaterThanOrEqual(12);
  });
});
