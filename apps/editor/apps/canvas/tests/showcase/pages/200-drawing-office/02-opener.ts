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

// Ch.14 opener — p77, C-Opener recto, and THE THESIS. The annual's
// crest arrives as an SVG through the host importer registry, claimed
// by `media.paged.draw.importer.svg`, and every shape lowers through
// the SAME `insertPath` the pen tool commits. Nothing on this page is
// an embedded picture.
//
// THE CREST'S COMPOUND SHAPES tell the second half of the thesis. The
// importer lands a multi-subpath SVG path as ONE compound Polygon
// (modules/draw/docs/status.md, "SVG"): the first contour by
// `insertPath`, the whole table by the `framePath` door Compound Path
// > Make uses, and the file's `fill-rule="evenodd"` kept as the
// element's own fill rule — so the annulus arrives as a ring and the
// shield with its keyway cut, one Polygon each. (Until the importer
// learned that, a ring landed as two sibling discs and this page merged
// them by hand.) The ring you can read the paper through is the proof.
//
// `assets/annual-crest.svg` is authored in the annual's own 540×720
// page space (the importer passes SVG user units through as page
// points, unscaled), so the artwork lands exactly where the file says:
// annulus y 140–380, shield y 182–340, banner y ~402–426, motif
// y 436–472, all centred on x 270. The opener block sits above it and
// the thesis below.

import { expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { withActivePage } from "../../active-page";
import {
  assignLayer,
  marginNote,
  proseFrame,
  specLabel,
} from "../../annual-support";
import { LAYER, STYLE, contentBox, p } from "../../names-annual";
import { newRefs } from "../../plugin-support";
import type { PageContext, PageReport } from "../../types";
import { pathAnchors } from "../150-object/wire";
import { polygons } from "./00-support";
import { CREST_NAME, CREST_POLYGON_CONTOURS, CREST_SHAPES } from "./crest";

const CREST_SVG = readFileSync(
  pathResolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "assets",
    CREST_NAME,
  ),
  "utf8",
);
const SVG_IMPORTER = "media.paged.draw.importer.svg";

/** Route the crest through the host importer registry — the same door
 *  File ▸ Open and drag-drop feed (the 06-vector recipe). */
async function importCrest(ctx: PageContext): Promise<string> {
  return ctx.page.evaluate(
    async ({ svg, name }) => {
      const importers = (
        globalThis as unknown as {
          __canvas: {
            registries: {
              importers?: {
                resolve: (
                  fileName: string,
                  mime?: string,
                ) => {
                  id?: string;
                  import: (args: {
                    name: string;
                    bytes: Uint8Array;
                    mimeType?: string;
                  }) => void | Promise<void>;
                } | null;
              };
            };
          };
        }
      ).__canvas.registries.importers;
      if (!importers) return "the host serves no importer registry";
      const importer = importers.resolve(name, "image/svg+xml");
      if (!importer) return "no importer resolved for .svg";
      await importer.import({
        name,
        bytes: new TextEncoder().encode(svg),
        mimeType: "image/svg+xml",
      });
      return importer.id ?? "imported";
    },
    { svg: CREST_SVG, name: CREST_NAME },
  );
}

export async function build(ctx: PageContext): Promise<PageReport> {
  const elements: string[] = [];
  const notes: string[] = [];
  const page = p(77);
  const [left, , right] = contentBox(page);
  const pageId = ctx.pageIds[0];

  // ── the opener block, above the crest's fixed zone ───────────────
  const number = await proseFrame(
    ctx,
    page,
    [left, 56, 150, 128],
    [{ text: "14", style: STYLE.chapterNumber }],
  );
  const title = await proseFrame(
    ctx,
    page,
    [160, 60, right, 128],
    [{ text: "The Drawing Office", style: STYLE.chapterTitle }],
  );
  elements.push(number.frameId, title.frameId);

  // ── the import ───────────────────────────────────────────────────
  const before = await polygons(ctx);
  const importer = await withActivePage(ctx.page, pageId, () =>
    importCrest(ctx),
  );
  expect(importer, `the SVG importer claimed ${CREST_NAME}`).toBe(SVG_IMPORTER);
  await expect
    .poll(async () => (await polygons(ctx)).length, {
      message: "one Polygon per crest shape (annulus, shield, banner, motif)",
      timeout: 120_000,
    })
    .toBe(before.length + CREST_SHAPES);
  const imported = await newRefs(ctx.page, "polygon", before);
  for (const ref of imported) {
    await assignLayer(ctx, "polygon", ref.id, LAYER.content);
  }

  // ── the compounds — each ring and its hole are ONE Polygon ───────
  for (const [index, contours] of CREST_POLYGON_CONTOURS.entries()) {
    if (contours < 2) continue;
    const ref = imported[index]!;
    const geom = await pathAnchors(ctx, { kind: "polygon", id: ref.id });
    expect(
      geom.subpathStarts.length,
      `crest shape ${index} imported as one compound Polygon`,
    ).toBe(contours);
  }

  // ── the thesis, below the crest ──────────────────────────────────
  const thesis = await proseFrame(
    ctx,
    page,
    [left, 486, right, 640],
    [
      {
        text: "The crest above arrived as a file of curves — annual-crest.svg, fed to the host importer registry and claimed by paged.draw. The importer lowered every shape through the same insertPath the pen tool commits, so what stands on this page is four native polygons wearing real swatches, not an embedded picture of a drawing.",
        style: STYLE.bodyFirst,
      },
      {
        text: "Two of those shapes are compound. The importer wrote each one's contours into a single polygon through the same door Compound Path > Make uses, and kept the file's even-odd fill rule on the element, so the inner contour of the annulus is a hole and not a coin. The paper you can read through the ring is the whole argument of this chapter: a drawing tool that writes the document's own geometry, not a layer above it.",
        style: STYLE.body,
      },
    ],
  );
  elements.push(thesis.frameId);

  elements.push(
    await specLabel(ctx, page, [
      "Specimen No. 115",
      "media.paged.draw.importer.svg",
      "insertPath ×4 · framePath ×2 · fill rule even-odd",
      "C-Opener",
    ]),
  );
  elements.push(
    await marginNote(
      ctx,
      page,
      "the importer's documented envelope is solid colours and geometry - gradients, <text> and <image> in an SVG do not lower; the crest was authored inside that envelope → Appendix A",
    ),
  );

  // The two compounds + banner + motif.
  const drawn = await newRefs(ctx.page, "polygon", before);
  for (const ref of drawn) elements.push(ref.id);

  return {
    title: "Ch.14 opener — the crest, lowered to native paths",
    covers: [
      "plugin-draw.svg-io",
      "plugin-draw.compound-paths",
      "plugin-draw.bundle-manifest",
      "plugin-platform.importer-exporter",
      "editor-shell.plugin-bundles",
    ],
    elements,
    notes,
  };
}
