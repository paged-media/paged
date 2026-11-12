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

// The appearance stack + graphic styles — p81, B-Body recto.
//
// AN IDML FRAME HAS ONE FILL AND ONE STROKE; the engine's native
// appearance gives an item several (engine ADR 1043), draws them itself
// and bakes them into stacked single-paint items when it writes IDML.
// The page builds a stack with the host's Appearance commands. (draw's
// own group bake, B-24, is gone: draw ADR 354 amendment.)
//
// GRAPHIC STYLES are the LINK, not a clipboard: three tiles share one
// saved style, a redefine propagates through the link (overrides
// overwritten, as the command warns), and a broken link keeps its
// appearance while the others move on.

import { expect } from "@playwright/test";

import { marginNote, proseFrame, specLabel } from "../../annual-support";
import { LAYER, STYLE, SWATCH, contentBox, p } from "../../names-annual";
import { invokeWith } from "../../plugin-support";
import type { PageContext, PageReport } from "../../types";
import {
  corner,
  draw,
  path,
  propOf,
  readDrawPart,
  spreadOffset,
} from "./00-support";

interface GraphicStyleLibrary {
  styles: Array<{ id: string; name: string }>;
}

export async function build(ctx: PageContext): Promise<PageReport> {
  const { doc } = ctx;
  const elements: string[] = [];
  const notes: string[] = [];
  const covers: string[] = ["plugin-draw.appearance"];
  const page = p(81);
  const [left, , right] = contentBox(page);
  const pageId = ctx.pageIds[0];
  const offset = await spreadOffset(ctx, pageId);
  // eslint-disable-next-line no-console
  console.log(`[200] p81 spread offset measured: [${offset.join(", ")}]`);

  const ink = await doc.swatch(SWATCH.ink);
  const vermilion = await doc.swatch(SWATCH.vermilion);
  const marigold = await doc.swatch(SWATCH.labMarigold);
  const screenBlue = await doc.swatch(SWATCH.screenBlue);
  const slate = await doc.swatch(SWATCH.slate);
  const layerContent = await doc.layerId(LAYER.content);

  const head = await proseFrame(
    ctx,
    page,
    [left, 54, right, 82],
    [{ text: "The appearance stack", style: STYLE.head1 }],
  );
  const intro = await proseFrame(
    ctx,
    page,
    [left, 86, right, 126],
    [
      {
        text: "An IDML frame owns one fill and one stroke. The blob below carries more: the engine's own appearance draws every fill and stroke, and an IDML export lowers them to stacked single-paint items InDesign reads.",
        style: STYLE.bodyFirst,
      },
    ],
  );
  elements.push(head.frameId, intro.frameId);

  // ── the twins ────────────────────────────────────────────────────
  const blob = async (cx: number, cy: number): Promise<string> => {
    const r = 52;
    const id = await path(
      ctx,
      pageId,
      [
        {
          anchor: [cx, cy - r],
          left: [cx - 30, cy - r],
          right: [cx + 30, cy - r],
        },
        {
          anchor: [cx + r, cy],
          left: [cx + r, cy - 30],
          right: [cx + r, cy + 30],
        },
        {
          anchor: [cx, cy + r],
          left: [cx + 30, cy + r],
          right: [cx - 30, cy + r],
        },
        {
          anchor: [cx - r, cy],
          left: [cx - r, cy + 30],
          right: [cx - r, cy - 30],
        },
      ],
      false,
      { fill: vermilion, stroke: ink, weight: 6 },
    );
    await doc.setProperty("polygon", id, "itemLayer", {
      type: "text",
      value: layerContent,
    });
    elements.push(id);
    return id;
  };

  const stackOn = async (id: string): Promise<void> => {
    await doc.select("polygon", id);
    // Two extra strokes + one extra fill, seeded from the element's own
    // paint, then the top stroke walked one step down the stack.
    await invokeWith(ctx.page, "paged.appearance.addStroke");
    await invokeWith(ctx.page, "paged.appearance.addStroke");
    await invokeWith(ctx.page, "paged.appearance.addFill");
    await invokeWith(ctx.page, "paged.appearance.moveLayer", {
      kind: "stroke",
      index: 1,
      direction: "down",
    });
  };

  const stacked = await blob(235, 210);
  await stackOn(stacked);

  const twinCaption = await proseFrame(
    ctx,
    page,
    [left, 286, right, 336],
    [
      {
        text: "A blob carrying +1 fill and +2 strokes over its own paint, one stroke moved down by Appearance: Move layer. One item, several paints: the engine draws them, and the save bakes them for InDesign.",
        style: STYLE.caption,
      },
    ],
  );
  elements.push(twinCaption.frameId);

  // ── graphic styles: save / apply / redefine / break link ─────────
  const tile = async (x: number): Promise<string> => {
    const id = await path(
      ctx,
      pageId,
      [
        corner(x, 380),
        corner(x + 88, 380),
        corner(x + 88, 448),
        corner(x, 448),
      ],
      false,
      { fill: marigold, stroke: ink, weight: 2 },
    );
    await doc.setProperty("polygon", id, "itemLayer", {
      type: "text",
      value: layerContent,
    });
    elements.push(id);
    return id;
  };
  const t1 = await tile(70);
  const t2 = await tile(196);
  const t3 = await tile(322);

  await doc.select("polygon", t1);
  await draw(ctx, "saveGraphicStyle", { name: "Annual Tile" });
  const gsLib = await readDrawPart<GraphicStyleLibrary>(
    ctx,
    "graphic-styles.json",
  );
  const style = gsLib?.styles.find((s) => s.name === "Annual Tile");
  expect(style, "the graphic-style library holds Annual Tile").toBeTruthy();

  await doc.designer.selectElements([
    { kind: "polygon", id: t2 },
    { kind: "polygon", id: t3 },
  ]);
  await draw(ctx, "applyGraphicStyle", { styleId: style!.id });
  await expect
    .poll(
      async () =>
        (await propOf(ctx, { kind: "polygon", id: t2 }, "frameFillColor"))
          ?.value ?? "",
      { message: "apply linked tile 2 to the style", timeout: 120_000 },
    )
    .toBe(marigold);

  // Redefine: restyle the source directly (an OVERRIDE — the link
  // survives), then push the new look through the link.
  await doc.setProperty("polygon", t1, "frameFillColor", {
    type: "colorRef",
    value: screenBlue,
  });
  await doc.select("polygon", t1);
  await draw(ctx, "redefineGraphicStyle", { styleId: style!.id });
  await expect
    .poll(
      async () =>
        (await propOf(ctx, { kind: "polygon", id: t3 }, "frameFillColor"))
          ?.value ?? "",
      { message: "redefine propagated to tile 3", timeout: 120_000 },
    )
    .toBe(screenBlue);

  // Break tile 3's link, then redefine again — tile 2 follows, tile 3
  // keeps the blue it had when it left.
  await doc.select("polygon", t3);
  await draw(ctx, "breakGraphicStyleLink");
  await doc.setProperty("polygon", t1, "frameFillColor", {
    type: "colorRef",
    value: slate,
  });
  await doc.select("polygon", t1);
  await draw(ctx, "redefineGraphicStyle", { styleId: style!.id });
  await expect
    .poll(
      async () =>
        (await propOf(ctx, { kind: "polygon", id: t2 }, "frameFillColor"))
          ?.value ?? "",
      {
        message: "second redefine reached the still-linked tile 2",
        timeout: 120_000,
      },
    )
    .toBe(slate);
  expect(
    (await propOf(ctx, { kind: "polygon", id: t3 }, "frameFillColor"))?.value,
    "the broken link kept its appearance",
  ).toBe(screenBlue);
  covers.push("plugin-draw.graphic-styles");

  const gsCaption = await proseFrame(
    ctx,
    page,
    [left, 458, right, 516],
    [
      {
        text: "Three tiles, one saved style. Apply linked all three; a direct recolour of the first marked it overridden without breaking its link; Redefine pushed first blue, then slate, through every link it found. The third tile broke its link after the blue pass - it keeps that appearance while its neighbours moved on. A style that only copied values would be a clipboard; the link is the feature.",
        style: STYLE.caption,
      },
    ],
  );
  elements.push(gsCaption.frameId);

  elements.push(
    await specLabel(ctx, page, [
      "Specimen No. 119",
      "paged.appearance addFill/addStroke/moveLayer",
      "saveGraphicStyle/apply/redefine/breakLink",
    ]),
  );
  elements.push(
    await marginNote(
      ctx,
      page,
      "several fills and strokes are the engine's own appearance (engine ADR 1043): drawn on canvas and in PDF, baked into stacked items only where IDML has one fill and one stroke per frame → Appendix A",
    ),
  );

  return {
    title: "The appearance stack",
    covers,
    elements,
    notes,
  };
}
