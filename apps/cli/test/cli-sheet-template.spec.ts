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

// `paged template` over paged.sheet's module fields (plan G3): a price list
// whose quantity cell and rows are fields, filled from the command line as
// a filler and checked against the template. The sheet bundle is loaded
// from the workspace by path (the CLI auto-loads only the modules it
// depends on); without its wasm the suite says so and skips.

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
const K = "media.paged.sheet";

/** One empty page: the sheet tests' own fixture. */
const blankPage = async (): Promise<Uint8Array> =>
  (
    (await import(join(SHEET, "test/perf/workload.ts"))) as {
      blankPageIdml(): Uint8Array;
    }
  ).blankPageIdml();

let tmp: ReturnType<typeof tempDir>;
let templatePath = "";

/** The template: book!A1:B4 placed as a table (its frame is the `pears`
 *  field, B3, a number), a second frame holding the `list` field (A2:B4,
 *  up to three rows), and a document policy that lets a filler write the
 *  workbook's version label. */
async function writeTemplate(dir: string): Promise<string> {
  const { sheetBundle } = (await import(SHEET_ENTRY)) as {
    sheetBundle: PagedBundle;
  };
  const h = await createHeadlessHost({
    console: silent,
    ...(await engineOptions()),
  });
  try {
    const send = (kind: string, payload: unknown) =>
      h.host.editor.client.send({ kind, payload } as never) as Promise<{
        kind: string;
        payload: { createdId?: { id: string } };
      }>;
    const [pageId] = await h.load(await blankPage());
    h.loadBundle(sheetBundle);
    await h.objects.invoke(`${K}.command.importCsv` as never, {
      text: "name,qty\nApples,12\nPears,3\nFigs,7\n",
      name: "book.csv",
    });
    const placed = (await h.objects.invoke(
      `${K}.command.lowerToFrame` as never,
      {
        range: "book!A1:B4",
      },
    )) as { frame: string };
    await send("setSessionPolicy", { policy: { role: "author" } });
    const mutate = (m: unknown) => send("mutate", m);
    const list = await mutate({
      op: "insertTextFrame",
      args: { pageId, bounds: [300, 10, 320, 200] },
    });
    const field = (id: string, name: string, kind: string, def: unknown) =>
      mutate({
        op: "setPluginMetadata",
        args: {
          elementId: { kind: "textFrame", id },
          key: "x-paged:template",
          value: JSON.stringify({
            v: 1,
            data: {
              field: {
                name,
                kind: "module",
                module: { kind, grants: ["text.edit", "text.style"], def },
              },
            },
          }),
        },
      });
    await field(placed.frame.replace("textFrame:", ""), "pears", `${K}.cell`, {
      ref: "book!B3",
      type: "number",
      min: 0,
    });
    await field(list.payload.createdId!.id, "list", `${K}.range`, {
      ref: "book!A2:B4",
      rows: { max: 3 },
    });
    await mutate({
      op: "setDocumentMetadata",
      args: {
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: { defaults: ["document.metadata"] },
        }),
      },
    });
    // The workbook part is saved after a short debounce (the session's
    // PERSIST_DEBOUNCE_MS): let it land before the document is written.
    await new Promise((r) => setTimeout(r, 1200));
    const { bytes } = await h.exportDocument("paged");
    const path = join(dir, "prices.paged");
    writeFileSync(path, bytes);
    return path;
  } finally {
    h.dispose();
  }
}

const byName = (json: {
  fields: { field: { name: string }; value: unknown }[];
}) => Object.fromEntries(json.fields.map((f) => [f.field.name, f.value]));

describe.skipIf(!BUILT)(
  `paged template — sheet fields${BUILT ? "" : " (unavailable: the sheet wasm, bash modules/sheet/scripts/build-wasm.sh)"}`,
  () => {
    beforeAll(async () => {
      tmp = tempDir();
      templatePath = await writeTemplate(tmp.dir);
    });
    afterAll(() => tmp?.done());

    it("lists the sheet's field kinds", async () => {
      const r = await cli(["template", "kinds", PLUGINS]);
      expect(r.code).toBe(0);
      expect((r.json.kinds as { kind: string }[]).map((k) => k.kind)).toEqual([
        `${K}.cell`,
        `${K}.range`,
        `${K}.chartSource`,
      ]);
    });

    it("reads the module fields' values from the template", async () => {
      const r = await cli(["template", "fields", templatePath, PLUGINS]);
      expect(r.code).toBe(0);
      expect(byName(r.json)).toEqual({
        pears: { kind: "module", value: 3 },
        list: {
          kind: "module",
          value: [
            ["Apples", "12"],
            ["Pears", "3"],
            ["Figs", "7"],
          ],
        },
      });
    });

    it("fills a cell and a range as a filler; the result reads back and checks clean", async () => {
      const out = join(tmp.dir, "filled.paged");
      const r = await cli([
        "template",
        "fill",
        templatePath,
        "--values",
        // In the template's field order (the order `check` refills in): a
        // sheet's placement labels count the writes that reached them.
        JSON.stringify([
          {
            name: "list",
            value: {
              kind: "module",
              value: [
                ["Plums", "4"],
                ["Pears", "9"],
              ],
            },
          },
          { name: "pears", value: { kind: "module", value: 9 } },
        ]),
        "-o",
        out,
        PLUGINS,
      ]);
      expect(r.code, r.out + r.err).toBe(0);
      const got = await cli(["template", "fields", out, PLUGINS]);
      expect(byName(got.json)).toEqual({
        pears: { kind: "module", value: 9 },
        list: {
          kind: "module",
          value: [
            ["Plums", "4"],
            ["Pears", "9"],
          ],
        },
      });
      const check = await cli([
        "template",
        "check",
        templatePath,
        out,
        PLUGINS,
      ]);
      expect(check.json?.differences ?? check.out + check.err).toEqual([]);
      expect(check.code).toBe(0);

      // Tamper: a cell outside the fields (the header) changes.
      const tampered = join(tmp.dir, "tampered.paged");
      const set = await cli([
        "set",
        out,
        `plugin:${K}/cell/book!A1`,
        "value",
        "Kiwis",
        "-o",
        tampered,
        PLUGINS,
      ]);
      expect(set.code, set.out + set.err).toBe(0);
      const bad = await cli([
        "template",
        "check",
        templatePath,
        tampered,
        PLUGINS,
      ]);
      expect(bad.code).toBe(1);
      expect(bad.json.differences).toContain(`plugin:${K}/cell/book!A1`);
    });

    it("refuses a value its field does not take, and writes nothing", async () => {
      const out = join(tmp.dir, "never.paged");
      const r = await cli([
        "template",
        "fill",
        templatePath,
        "--values",
        JSON.stringify([
          { name: "pears", value: { kind: "module", value: -2 } },
        ]),
        "-o",
        out,
        PLUGINS,
      ]);
      expect(r.code).toBe(1);
      expect(r.out + r.err).toContain("-2 is less than 0.");
      expect(existsSync(out)).toBe(false);
    });
  },
);
