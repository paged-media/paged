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
// `paged template fill` with paged.slide's module fields (editor plan G3):
// a deck opened from PowerPoint whose second slide's title placeholder is a
// text field and whose fourth slide's visibility is a field (on its title,
// a slide being a page with no field of its own; the template grants
// document metadata, which the engine checks a slide's hidden flag as). The
// CLI loads the slide bundle (`--plugins`), takes the filler role and hands
// each value to the module.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PagedBundle } from "@paged-media/plugin-api";
import { createHeadlessHost } from "@paged-media/plugin-sdk";

import { cli, engineOptions, REPO_ROOT, silent, tempDir } from "./helpers";

const SLIDE_BUNDLE = join(
  REPO_ROOT,
  "modules/slide/packages/slide-bundle/src/index.ts",
);
const SLIDE_WASM = join(
  REPO_ROOT,
  "modules/slide/packages/slide-bundle/bin/slide_js_bg.wasm",
);
const DECK = join(
  REPO_ROOT,
  "modules/slide/slide-conformance/fixtures/placeholders.pptx",
);
const PLUGINS = `--plugins=${SLIDE_BUNDLE}`;
const P = "plugin:media.paged.slide";

let tmp: ReturnType<typeof tempDir>;
let templatePath = "";
let oldTitle = "";

async function writeTemplate(dir: string): Promise<string> {
  const h = await createHeadlessHost({
    console: silent,
    ...(await engineOptions()),
  });
  try {
    const bundle = (await import(SLIDE_BUNDLE)) as { default: PagedBundle };
    h.loadBundle(bundle.default);
    const { slides } = (await h.objects.invoke("media.paged.slide.importPptx", {
      bytes: new Uint8Array(readFileSync(DECK)),
      name: "deck.pptx",
    })) as { slides: string[] };
    const title = async (n: number) =>
      (
        await h.objects.query(
          `${slides[n - 1]!} > ${P}/placeholder[type=title]`,
        )
      )[0]!
        .split("/")
        .pop()!;
    const t2 = await title(2);
    const t4 = await title(4);
    const c = await h.objects.get(`${P}/placeholder/${t2}`, "content");
    oldTitle = c.kind === "value" ? String(c.value) : "";
    const send = (kind: string, payload: unknown) =>
      h.host.editor.client.send({ kind, payload } as never) as Promise<{
        kind: string;
      }>;
    await send("setSessionPolicy", { policy: { role: "author" } });
    const field = (
      name: string,
      kind: string,
      grants: string[],
      def: unknown,
    ) =>
      JSON.stringify({
        v: 1,
        data: {
          field: { name, kind: "module", module: { kind, grants, def } },
        },
      });
    const set = await send("mutate", {
      op: "batch",
      args: {
        ops: [
          {
            op: "setPluginMetadata",
            args: {
              elementId: { kind: "textFrame", id: t2 },
              key: "x-paged:template",
              value: field(
                "headline",
                "media.paged.slide.placeholderText",
                ["text.edit"],
                null,
              ),
            },
          },
          {
            op: "setPluginMetadata",
            args: {
              elementId: { kind: "textFrame", id: t4 },
              key: "x-paged:template",
              value: field(
                "appendix",
                "media.paged.slide.visibility",
                ["item.visibility"],
                null,
              ),
            },
          },
          {
            op: "setDocumentMetadata",
            args: {
              key: "x-paged:template",
              value: JSON.stringify({
                v: 1,
                data: { defaults: ["document.metadata"] },
              }),
            },
          },
        ],
      },
    });
    if (set.kind !== "mutationApplied")
      throw new Error("template: the fields were refused");
    const { bytes } = await h.exportDocument("paged");
    const path = join(dir, "deck.paged");
    writeFileSync(path, bytes);
    return path;
  } finally {
    h.dispose();
  }
}

const byName = (fields: { field: { name: string }; value: unknown }[]) =>
  Object.fromEntries(fields.map((f) => [f.field.name, f.value]));

const hasWasm = existsSync(SLIDE_WASM);

describe.skipIf(!hasWasm)(
  "paged template with paged.slide fields (unavailable without the slide wasm: modules/slide/scripts/build-wasm.sh)",
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
        headline: { kind: "module", value: oldTitle },
        appendix: { kind: "module", value: true },
      });
    });

    it("fills them as a filler and writes the result", async () => {
      const out = join(tmp.dir, "filled.paged");
      const r = await cli([
        "template",
        "fill",
        templatePath,
        "--values",
        JSON.stringify({ headline: "Our results", appendix: false }),
        "-o",
        out,
        PLUGINS,
      ]);
      expect(r.code).toBe(0);
      const got = await cli(["template", "fields", out, PLUGINS]);
      expect(byName(got.json.fields)).toEqual({
        headline: { kind: "module", value: "Our results" },
        appendix: { kind: "module", value: false },
      });
    });

    it("refuses a value its module refuses, and writes nothing", async () => {
      const r = await cli([
        "template",
        "fill",
        templatePath,
        "--values",
        JSON.stringify({ headline: "Two\nlines" }),
        "-o",
        join(tmp.dir, "never.paged"),
        PLUGINS,
      ]);
      expect(r.code).toBe(1);
      expect(r.out + r.err).toContain("A title is one line");
    });
  },
);
