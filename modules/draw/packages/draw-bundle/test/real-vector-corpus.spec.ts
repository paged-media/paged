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
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

/**
 * Real vector artwork — the first corpus lane plugin-draw has ever had.
 *
 * Every SVG this plugin had parsed before now was a string literal in a
 * spec file, written by us, to exercise a path we already knew about.
 * The 2026-08 corpus extraction brought **476 real SVGs** out of the
 * vendor packs — icon sets, logos, UI illustrations and hero artwork
 * emitted by Illustrator, Figma, Sketch and a dozen web export
 * pipelines. None of them were written with our parser in mind.
 *
 * Two properties, and the second is the one that would actually hurt if
 * it broke:
 *
 * 1. **A real SVG never throws.** `shapesFromSvgBytes` is the importer's
 *    whole front door. A file that crashes it takes the editor with it.
 *    The shape YIELD is reported rather than gated, because "how many
 *    shapes should this logo lower to" has no right answer and pinning
 *    one would just be pinning today's parser.
 *
 * 2. **AI and EPS are refused, not half-read.** The packs ship 285 `.ai`
 *    and 282 `.eps` files alongside the SVGs, and plugin-draw has no
 *    reader for either — the catalogue lists both as intended and
 *    unbuilt. That makes them the most valuable fixtures here, because
 *    the danger is not that we fail to read them, it is that we
 *    PARTIALLY do. Both formats can carry XML-ish payloads: an `.ai` is
 *    a PDF container (`%PDF-1.5`) which can embed XMP, and an `.eps` is
 *    PostScript, often with a binary DOS-EPS header. Hand either to an
 *    XML parser and it may well find *something* and hand back shapes
 *    that are not the artwork.
 *
 *    Same property the rest of the corpus already gates for foreign
 *    formats — `legacy_xls_is_refused_rather_than_half_read` in
 *    plugin-sheets, `every_legacy_doc_is_refused_by_name` in plugin-doc.
 *    `shapesFromSvgBytes` signals refusal by returning no shapes rather
 *    than by throwing, so "refused" here means an empty result.
 *
 * OPT-IN — the assets live in the private corpus checkout:
 *
 *     PAGED_SVG_CORPUS=1 pnpm --filter @paged-media/draw test
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { shapesFromSvgBytes } from "../src/io/svg";

const GROUPS = ["idml", "docx", "psd", "html", "vector", "pptx"] as const;

function corpusRoot(): string | null {
  const sw = process.env.PAGED_SVG_CORPUS;
  if (!sw) return null;
  if (sw === "1") return join(__dirname, "../../../../../corpus");
  return sw;
}

/**
 * Every `assets/vector/*.<ext>` across every pack group, PLUS the pack's
 * own `primary.<ext>`.
 *
 * The primaries matter for the refusal side: a vector pack's headline
 * artwork is `primary.ai` at the pack root, 26 of them, and reading only
 * `assets/vector` left every one of them unopened — the file most likely
 * to be handed to an importer by a user was the file this lane did not
 * try.
 */
function vectorFiles(exts: string[]): string[] {
  const root = corpusRoot();
  if (!root) return [];
  const out: string[] = [];
  for (const group of GROUPS) {
    let packs: string[];
    try {
      packs = readdirSync(join(root, group, "packs"));
    } catch {
      continue;
    }
    for (const pack of packs) {
      for (const ext of exts) {
        const primary = join(root, group, "packs", pack, `primary${ext}`);
        try {
          if (statSync(primary).isFile()) out.push(primary);
        } catch {
          /* the pack's primary is another format */
        }
      }
      const dir = join(root, group, "packs", pack, "assets", "vector");
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        const lower = n.toLowerCase();
        if (!exts.some((e) => lower.endsWith(e))) continue;
        const p = join(dir, n);
        try {
          if (statSync(p).isFile()) out.push(p);
        } catch {
          /* raced with a corpus refresh */
        }
      }
    }
  }
  out.sort();
  return out;
}

const svgs = vectorFiles([".svg"]);
const foreign = vectorFiles([".ai", ".eps"]);
const gated = svgs.length > 0;

describe.skipIf(!gated)("real SVG corpus", () => {
  it("parses every real SVG without throwing", () => {
    const failures: string[] = [];
    let withShapes = 0;
    let totalShapes = 0;

    for (const path of svgs) {
      const bytes = new Uint8Array(readFileSync(path));
      let shapes;
      try {
        shapes = shapesFromSvgBytes(bytes);
      } catch (e) {
        failures.push(`${path.split("/").pop()}: ${(e as Error).message}`);
        continue;
      }
      totalShapes += shapes.length;
      if (shapes.length > 0) withShapes += 1;
    }

    console.log(
      `real SVG corpus: ${svgs.length} file(s), ${withShapes} yielded shapes, ` +
        `${totalShapes} shapes total`,
    );

    expect(failures, `SVG files that THREW out of the importer:\n  ${failures.join("\n  ")}`).toEqual(
      [],
    );

    // The one hard floor on yield. Zero would mean the importer only ever
    // handled the shapes our own spec strings describe — which is the
    // whole reason this lane exists.
    expect(
      withShapes,
      `not one of ${svgs.length} real SVGs produced a shape — the importer has only ` +
        `ever been fed hand-written spec strings, so this means it cannot read ` +
        `what real design tools emit`,
    ).toBeGreaterThan(0);
  });
});

describe.skipIf(foreign.length === 0)("foreign vector formats are refused, not half-read", () => {
  it("yields no shapes for .ai and .eps", () => {
    const halfRead: string[] = [];
    const threw: string[] = [];
    const byExt: Record<string, number> = {};

    for (const path of foreign) {
      const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
      byExt[ext] = (byExt[ext] ?? 0) + 1;
      const bytes = new Uint8Array(readFileSync(path));
      try {
        const shapes = shapesFromSvgBytes(bytes);
        if (shapes.length > 0) {
          halfRead.push(`${path.split("/").pop()} -> ${shapes.length} shape(s)`);
        }
      } catch (e) {
        // Throwing is not acceptable either: the importer is a front
        // door and a foreign file is an ordinary thing to be handed.
        threw.push(`${path.split("/").pop()}: ${(e as Error).message}`);
      }
    }

    console.log(
      `foreign vector formats: ${foreign.length} file(s) ` +
        `(${Object.entries(byExt)
          .map(([e, n]) => `${n} ${e}`)
          .join(", ")})`,
    );

    expect(threw, `foreign files that THREW instead of being refused:\n  ${threw.join("\n  ")}`).toEqual(
      [],
    );
    expect(
      halfRead,
      `${halfRead.length} foreign file(s) were PARTIALLY parsed as SVG:\n  ` +
        `${halfRead.join("\n  ")}\n` +
        `A half-read import is worse than a refused one — the caller gets shapes ` +
        `that are not the artwork they opened.`,
    ).toEqual([]);
  });
});
