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
 * Three properties, and the second is the one that would actually hurt
 * if it broke:
 *
 * 1. **A real SVG never throws.** The importer's front door is the
 *    engine's `document.importSvg` (draw ADR 364: the module's own reader
 *    is gone). A file that crashes it takes the editor with it. The YIELD
 *    is reported rather than gated, because "how many items should this
 *    logo lower to" has no right answer.
 *
 * 2. **AI and EPS are refused by the SVG importer, not half-read.** The
 *    packs ship `.ai` and `.eps` files alongside the SVGs. They have their
 *    own importers now (paged.pdf's placement and the engine's PostScript
 *    interpreter, draw ADR 364), but handed to the SVG door they must be
 *    refused: an `.ai` is a PDF container that can embed XMP, and an XML
 *    reader may well find *something* in it that is not the artwork.
 *
 * 3. **A real SVG is ONE undo step.** Every file the engine imports must
 *    leave again on ONE undo.
 *
 * OPT-IN — the assets live in the private corpus checkout:
 *
 *     PAGED_SVG_CORPUS=1 bun run test (in modules/draw/packages/draw-bundle)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import { leafIdsOf } from "../src";
import { importSvgFile, SVG_IMPORTER_ID } from "../src/io/svg";
import { openHost } from "./headless/host";
import { F4_OVERLAP } from "./fixtures/corpus";

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

describe.skipIf(!gated)("real SVG corpus — the import", () => {
  it("imports every real SVG without throwing, and one undo takes each back", async () => {
    const h = await openHost();
    try {
      await h.load(F4_OVERLAP.bytes());
      const leafCount = async (): Promise<number> =>
        leafIdsOf(await h.host.document.tree()).length;
      const base = await leafCount();
      const wrong: string[] = [];
      const threw: string[] = [];
      let files = 0;
      let items = 0;

      for (const path of svgs) {
        const bytes = new Uint8Array(readFileSync(path));
        const name = path.split("/").slice(-4).join("/");
        let done;
        try {
          done = await importSvgFile(h.host, SVG_IMPORTER_ID, name, bytes, {
            origin: [0, 0],
            group: false,
          });
        } catch (e) {
          threw.push(`${name}: ${(e as Error).message}`);
          continue;
        }
        if (!done.result?.applied) continue;
        files += 1;
        items += done.result.report.items;
        await h.host.document.undo();
        if ((await leafCount()) !== base) {
          wrong.push(
            `${name}: one undo left ${(await leafCount()) - base} element(s)`,
          );
          break; // the document is no longer the baseline; stop counting
        }
      }

      console.log(
        `real SVG corpus, imported: ${files} of ${svgs.length} file(s), ` +
          `${items} items — one undo step each`,
      );
      expect(threw, `SVG files that THREW:\n  ${threw.join("\n  ")}`).toEqual(
        [],
      );
      expect(
        wrong,
        `real SVGs that did NOT leave in one undo step:\n  ${wrong.join("\n  ")}`,
      ).toEqual([]);
      expect(files).toBeGreaterThan(0);
    } finally {
      h.dispose();
    }
  }, 600_000);
});

describe.skipIf(foreign.length === 0)(
  "foreign vector formats are refused by the SVG importer, not half-read",
  () => {
    it("the engine's SVG reader applies nothing for .ai and .eps", async () => {
      const h = await openHost();
      try {
        await h.load(F4_OVERLAP.bytes());
        const halfRead: string[] = [];
        for (const path of foreign) {
          const bytes = new Uint8Array(readFileSync(path));
          const done = await importSvgFile(
            h.host,
            SVG_IMPORTER_ID,
            path.split("/").pop()!,
            bytes,
          );
          if (done.result?.applied) {
            halfRead.push(`${path.split("/").pop()}`);
            await h.host.document.undo();
          }
        }
        console.log(`foreign vector formats: ${foreign.length} file(s)`);
        expect(
          halfRead,
          `${halfRead.length} foreign file(s) were read as SVG:\n  ${halfRead.join("\n  ")}`,
        ).toEqual([]);
      } finally {
        h.dispose();
      }
    }, 600_000);
  },
);
