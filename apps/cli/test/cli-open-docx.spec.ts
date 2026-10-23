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

// @feat: plugin-platform.object-model.node-cli
//
// A .docx on the command line opens standalone (editor plan G4): the headless
// host has the native-open door, so paged.doc's importer makes the Word
// document the whole document, as File ▸ Open does in the editor, instead of
// placing it in a frame on a blank page. Saving or exporting it as .docx goes
// through the module's exporter (save-back), so an edit made from the
// command line is in the Word file it writes.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { cli, REPO_ROOT, tempDir } from "./helpers";

const DOC = join(REPO_ROOT, "modules/doc/packages/doc-bundle");
const PLUGINS = `--plugins=${join(DOC, "src/index.ts")}`;
const DOC_WASM = join(DOC, "bin/docx_js_bg.wasm");
// A heading, a 3 x 2 price table, a closing paragraph.
const PRICES = join(DOC, "test/fixtures/price-table.docx");
// The standalone open's section frame (an embedded placement names another).
const WORD_DOCUMENT = "plugin:media.paged.doc/docxDocument/docx_f0";
const APPLES = "plugin:media.paged.doc/block/docx_f0/b1/c2/p0";

const hasWasm = existsSync(DOC_WASM);
if (!hasWasm && process.env.REQUIRE_REAL_DOCX === "1")
  throw new Error(
    "cli-open-docx: REQUIRE_REAL_DOCX=1 but the docx-js wasm is not built (modules/doc/scripts/build-wasm.sh)",
  );

let tmp: ReturnType<typeof tempDir>;
beforeAll(() => {
  tmp = tempDir();
});
afterAll(() => tmp.done());

const isZip = (path: string) =>
  [...readFileSync(path).subarray(0, 2)].join() === "80,75";

describe.skipIf(!hasWasm)("a .docx on the command line", () => {
  it("opens standalone: the Word document is the whole document", async () => {
    const docs = await cli([
      "query",
      PRICES,
      "plugin:media.paged.doc/docxDocument",
      PLUGINS,
    ]);
    expect(docs.code, JSON.stringify(docs.json)).toBe(0);
    expect(docs.json.addresses).toEqual([WORD_DOCUMENT]);
    const pages = await cli(["query", PRICES, "page", PLUGINS]);
    expect(pages.code, JSON.stringify(pages.json)).toBe(0);
    expect(pages.json.addresses.length).toBe(1);
    const cell = await cli(["get", PRICES, APPLES, "text", PLUGINS]);
    expect(cell.code, JSON.stringify(cell.json)).toBe(0);
    expect(cell.json.value).toBe("Apples");
  });

  it("exports as .docx through the module's exporter", async () => {
    const out = join(tmp.dir, "copy.docx");
    const r = await cli(["export", PRICES, "-o", out, PLUGINS]);
    expect(r.code, JSON.stringify(r.json)).toBe(0);
    expect(isZip(out)).toBe(true);
    const back = await cli(["get", out, APPLES, "text", PLUGINS]);
    expect(back.json.value).toBe("Apples");
  });

  it("a cell written from the command line is in the .docx it saves", async () => {
    const out = join(tmp.dir, "edited.docx");
    const r = await cli([
      "set",
      PRICES,
      APPLES,
      "text",
      "Pears",
      "-o",
      out,
      PLUGINS,
    ]);
    expect(r.code, JSON.stringify(r.json)).toBe(0);
    expect(isZip(out)).toBe(true);
    const back = await cli(["get", out, APPLES, "text", PLUGINS]);
    expect(back.code, JSON.stringify(back.json)).toBe(0);
    expect(back.json.value).toBe("Pears");
    // The source is untouched.
    const source = await cli(["get", PRICES, APPLES, "text", PLUGINS]);
    expect(source.json.value).toBe("Apples");
  });
});
