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
// `paged template fill` with paged.doc's module fields (editor plan G3):
// a letter placed from a Word document three times, one field per copy:
// its intro paragraph (by a bookmark), its greeting's merge field and its
// list. The CLI loads the doc bundle (`--plugins`), takes the filler role
// and hands each value to the module, which writes the .docx and the poured
// text together. A value the module refuses fails the fill.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PagedBundle } from "@paged-media/plugin-api";
import { createHeadlessHost } from "@paged-media/plugin-sdk";

import { cli, engineOptions, REPO_ROOT, silent, tempDir } from "./helpers";

const DOC_BUNDLE = join(
  REPO_ROOT,
  "modules/doc/packages/doc-bundle/src/index.ts",
);
const DOC_WASM = join(
  REPO_ROOT,
  "modules/doc/packages/doc-bundle/bin/docx_js_bg.wasm",
);
const LETTER = join(
  REPO_ROOT,
  "modules/doc/packages/doc-bundle/test/fixtures/template-letter.docx",
);
const PLUGINS = `--plugins=${DOC_BUNDLE}`;

let tmp: ReturnType<typeof tempDir>;
let templatePath = "";

/** A page with the letter placed three times, each frame a field: the
 *  intro paragraph (`intro`), the greeting's merge field (`name`), the
 *  list (`fruit`). */
async function writeTemplate(dir: string): Promise<string> {
  const h = await createHeadlessHost({
    console: silent,
    ...(await engineOptions()),
  });
  try {
    const bundle = (await import(DOC_BUNDLE)) as { default: PagedBundle };
    h.loadBundle(bundle.default);
    await h.newBlank(612, 792);
    const send = (kind: string, payload: unknown) =>
      h.host.editor.client.send({ kind, payload } as never) as Promise<{
        kind: string;
      }>;
    await send("setSessionPolicy", { policy: { role: "author" } });
    const fields = [
      {
        name: "intro",
        kind: "media.paged.doc.blockText",
        def: { anchor: { bookmark: "intro" } },
      },
      {
        name: "name",
        kind: "media.paged.doc.mergeField",
        def: { name: "Name" },
      },
      {
        name: "fruit",
        kind: "media.paged.doc.listItems",
        def: { anchor: { block: 3 } },
      },
    ];
    for (const f of fields) {
      const placed = (await h.objects.invoke(
        "media.paged.doc.command.placeDoc",
        {
          bytes: new Uint8Array(readFileSync(LETTER)),
          fileName: `${f.name}.docx`,
        },
      )) as { frame: string };
      const [kind, id] = placed.frame.split(":") as [string, string];
      const set = await send("mutate", {
        op: "setPluginMetadata",
        args: {
          elementId: { kind, id },
          key: "x-paged:template",
          value: JSON.stringify({
            v: 1,
            data: {
              field: {
                name: f.name,
                kind: "module",
                module: { kind: f.kind, grants: ["text.edit"], def: f.def },
              },
            },
          }),
        },
      });
      if (set.kind !== "mutationApplied")
        throw new Error(`template: the ${f.name} field was refused`);
    }
    const { bytes } = await h.exportDocument("paged");
    const path = join(dir, "letter.paged");
    writeFileSync(path, bytes);
    return path;
  } finally {
    h.dispose();
  }
}

const byName = (fields: { field: { name: string }; value: unknown }[]) =>
  Object.fromEntries(fields.map((f) => [f.field.name, f.value]));

const hasWasm = existsSync(DOC_WASM);
if (!hasWasm && process.env.REQUIRE_REAL_DOCX === "1")
  throw new Error(
    "cli-doc-template: REQUIRE_REAL_DOCX=1 but the docx-js wasm is not built (modules/doc/scripts/build-wasm.sh)",
  );

describe.skipIf(!hasWasm)(
  "paged template with paged.doc fields (unavailable without the docx-js wasm: modules/doc/scripts/build-wasm.sh)",
  () => {
    beforeAll(async () => {
      tmp = tempDir();
      templatePath = await writeTemplate(tmp.dir);
    }, 60_000);
    afterAll(() => tmp?.done());

    it("lists the module fields with the values their module reads", async () => {
      const r = await cli(["template", "fields", templatePath, PLUGINS]);
      expect(r.code).toBe(0);
      expect(byName(r.json.fields)).toEqual({
        intro: { kind: "module", value: "Thank you for your order." },
        name: { kind: "module", value: "«Name»" },
        fruit: {
          kind: "module",
          value: [["Apples"], ["Pears"], ["Plums"]],
        },
      });
    });

    it("fills them as a filler and writes the result", async () => {
      const out = join(tmp.dir, "filled.paged");
      const r = await cli([
        "template",
        "fill",
        templatePath,
        "--values",
        JSON.stringify({
          intro: "Your parcel is on its way.",
          name: "Ada",
          fruit: { kind: "module", value: [["Figs"], ["Dates"]] },
        }),
        "-o",
        out,
        PLUGINS,
      ]);
      expect(r.code).toBe(0);
      const got = await cli(["template", "fields", out, PLUGINS]);
      expect(byName(got.json.fields)).toEqual({
        intro: { kind: "module", value: "Your parcel is on its way." },
        name: { kind: "module", value: "Ada" },
        fruit: { kind: "module", value: [["Figs"], ["Dates"]] },
      });
      // Only the fields changed.
      const check = await cli([
        "template",
        "check",
        templatePath,
        out,
        PLUGINS,
      ]);
      expect(check.json?.ok).toBe(true);
    });

    it("refuses a value its module refuses, and writes nothing", async () => {
      const never = join(tmp.dir, "never.paged");
      const r = await cli([
        "template",
        "fill",
        templatePath,
        "--values",
        JSON.stringify({ intro: "Two\nlines" }),
        "-o",
        never,
        PLUGINS,
      ]);
      expect(r.code).toBe(1);
      expect(r.out + r.err).toContain("cannot hold a line break");
    });
  },
);
