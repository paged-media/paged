/*
 * This file is part of paged (https://paged.media).
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

// `paged-node invoke` over paged.sheet (plan G4): placing a range across a
// frame chain and deleting a chart placed in an earlier session, through
// their typed commands, the sheet bundle loaded from the workspace by path.
// Without the sheet wasm the suite says so and skips.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createHeadlessHost } from "@paged-media/plugin-sdk";
import type { PagedBundle } from "@paged-media/plugin-api";

import { cli, engineOptions, REPO_ROOT, silent, tempDir } from "./helpers";

const SHEET = join(REPO_ROOT, "modules/sheet/packages/sheet-bundle");
const SHEET_ENTRY = join(SHEET, "src/index.ts");
const BUILT = existsSync(join(SHEET, "bin/sheet_js_bg.wasm"));
const PLUGINS = `--plugins=${SHEET_ENTRY}`;
const C = "media.paged.sheet.command";

const blankPage = async (): Promise<Uint8Array> =>
  (
    (await import(join(SHEET, "test/perf/workload.ts"))) as {
      blankPageIdml(): Uint8Array;
    }
  ).blankPageIdml();

let tmp: ReturnType<typeof tempDir>;
let docPath = "";
let chainFrame = "";

/** A workbook (book!A1:B4) with a chart over B2:B4 placed on the page, and
 *  two threaded empty frames, saved as .paged. */
async function writeDocument(dir: string): Promise<[string, string]> {
  const { sheetBundle } = (await import(SHEET_ENTRY)) as {
    sheetBundle: PagedBundle;
  };
  const h = await createHeadlessHost({
    console: silent,
    ...(await engineOptions()),
  });
  try {
    const [pageId] = await h.load(await blankPage());
    h.loadBundle(sheetBundle);
    await h.objects.invoke(`${C}.importCsv` as never, {
      text: "name,qty\nApples,12\nPears,3\nFigs,7\n",
      name: "book.csv",
    });
    const made = await h.objects.batch([
      {
        op: "create",
        kind: "plugin:media.paged.sheet/chart",
        props: {
          kind: "column",
          title: "Stock",
          series: [
            {
              values: "book!B2:B4",
              categories: "book!A2:A4",
              name: "qty",
              color: "",
            },
          ],
        },
      } as never,
    ]);
    if (!made.applied) throw new Error(`chart refused: ${made.reason}`);
    if (
      !(await h.objects.invoke(`${C}.lowerChartToFrame` as never, {
        chart: 0,
      }))
    )
      throw new Error("chart not placed");
    const frame = async (bounds: [number, number, number, number]) => {
      const o = (await h.host.document.mutate({
        op: "insertTextFrame",
        args: { pageId: pageId!, bounds },
      } as never)) as { createdId: { id: string } };
      return o.createdId.id;
    };
    const first = await frame([400, 36, 440, 296]);
    const second = await frame([400, 316, 560, 576]);
    await h.host.document.mutate({
      op: "linkFrames",
      args: { from: first, to: second },
    } as never);
    // The workbook part is saved after a short debounce (the session's
    // PERSIST_DEBOUNCE_MS): let it land before the document is written.
    await new Promise((r) => setTimeout(r, 1200));
    const { bytes } = await h.exportDocument("paged");
    const path = join(dir, "book.paged");
    writeFileSync(path, bytes);
    return [path, first];
  } finally {
    h.dispose();
  }
}

beforeAll(async () => {
  tmp = tempDir();
  if (BUILT) [docPath, chainFrame] = await writeDocument(tmp.dir);
});
afterAll(() => tmp.done());

describe.skipIf(!BUILT)(
  `paged-node invoke — paged.sheet${BUILT ? "" : " (unavailable: the sheet wasm, bash modules/sheet/scripts/build-wasm.sh)"}`,
  () => {
    it("place paginates a range across the frame chain", async () => {
      const out = join(tmp.dir, "placed.paged");
      const r = await cli([
        "invoke",
        docPath,
        `${C}.place`,
        JSON.stringify({
          ref: "book!A1:B4",
          chain: `textFrame:${chainFrame}`,
          repeatHeaderRows: 1,
        }),
        "-o",
        out,
        PLUGINS,
      ]);
      expect(r.code, r.out + r.err).toBe(0);
      expect(r.json.result).toEqual({
        frame: `textFrame:${chainFrame}`,
        frames: [`textFrame:${chainFrame}`],
      });
      // Two frames, a table in each (the header row repeated).
      const tables = await cli(["query", out, "table", PLUGINS]);
      expect(tables.code, tables.out + tables.err).toBe(0);
      expect((tables.json as { addresses: string[] }).addresses).toHaveLength(
        2,
      );
    });

    it("place puts a frame's view on the page: a fixed box, printed headings and gridlines", async () => {
      const out = join(tmp.dir, "view.paged");
      const r = await cli([
        "invoke",
        docPath,
        `${C}.place`,
        JSON.stringify({
          ref: "book!A1:B4",
          sizing: "fixed",
          box: { width: 200, height: 60 },
          view: { topLeft: "A2", lock: true },
          print: { headings: true, gridlines: true },
        }),
        "-o",
        out,
        PLUGINS,
      ]);
      expect(r.code, r.out + r.err).toBe(0);
      const { frame, frames } = r.json.result as {
        frame: string;
        frames: string[];
      };
      expect(frames).toEqual([frame]);
      const tables = await cli(["query", out, "table", PLUGINS]);
      expect((tables.json as { addresses: string[] }).addresses).toHaveLength(
        1,
      );
    });

    it("place names what it cannot place", async () => {
      const r = await cli([
        "invoke",
        docPath,
        `${C}.place`,
        JSON.stringify({ source: "printArea", ref: "book" }),
        "--no-save",
        PLUGINS,
      ]);
      expect(r.code).toBe(1);
      expect(JSON.stringify(r.json)).toMatch(/has no print area/);
    });

    it("deleteChart removes the chart and the art placed in an earlier session", async () => {
      const r = await cli([
        "invoke",
        docPath,
        `${C}.deleteChart`,
        JSON.stringify({ chart: 0 }),
        "--no-save",
        PLUGINS,
      ]);
      expect(r.code, r.out + r.err).toBe(0);
      expect(r.json.result).toBe(1);
    });
  },
);
