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

// `paged template` with paged.web's module fields (editor plan G3): a web
// frame's CSS variable and a {{doc.key}} value it uses, filled on a server
// through the module, as a filler.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PagedBundle } from "@paged-media/plugin-api";
import { createHeadlessHost } from "@paged-media/plugin-sdk";

import { minimalIdml } from "../../../platform/extensions/packages/plugin-sdk/test/fixtures/minimal-idml";
import { cli, engineOptions, REPO_ROOT, silent, tempDir } from "./helpers";

const WEB = join(REPO_ROOT, "modules/web/packages/web-bundle/src/index.ts");
const PLUGINS = `--plugins=${WEB}`;

let tmp: ReturnType<typeof tempDir>;
let templatePath = "";

/** A card with two web frames: `company` fills {{doc.company}} in the first,
 *  `accent` picks its --accent from a list; the second frame is scenery. */
async function writeTemplate(dir: string): Promise<string> {
  const h = await createHeadlessHost({
    console: silent,
    ...(await engineOptions()),
  });
  try {
    const send = (kind: string, payload: unknown) =>
      h.host.editor.client.send({ kind, payload } as never) as Promise<{
        kind: string;
      }>;
    await h.load(minimalIdml());
    const { webBundle } = (await import(WEB)) as { webBundle: PagedBundle };
    h.loadBundle(webBundle);
    await send("setSessionPolicy", { policy: { role: "author" } });
    const frame = async () => {
      const out = (await h.objects.invoke(
        "media.paged.web.command.insertWebFrame",
        {
          page: "page:#1",
          bounds: [10, 10, 60, 200],
          html: "<h1>{{doc.company}}</h1>",
          css: ":root { --accent: red; }\nh1 { color: var(--accent); }",
        },
      )) as { frame: string };
      return out.frame.slice(out.frame.lastIndexOf(":") + 1);
    };
    const card = await frame();
    await frame();
    const field = (
      name: string,
      kind: string,
      def: unknown,
    ): Record<string, unknown> => ({
      name,
      kind: "module",
      module: { kind, grants: [], def },
    });
    // One item carries one field: the value field on the card, the CSS
    // variable on a third frame.
    const third = await frame();
    for (const [id, f] of [
      [
        card,
        field("company", "media.paged.web.value", { name: "doc.company" }),
      ],
      [
        third,
        field("accent", "media.paged.web.cssVar", {
          name: "--accent",
          allowed: ["red", "navy"],
        }),
      ],
    ] as const) {
      const r = await send("mutate", {
        op: "setPluginMetadata",
        args: {
          elementId: { kind: "rectangle", id },
          key: "x-paged:template",
          value: JSON.stringify({ v: 1, data: { field: f } }),
        },
      });
      expect(r.kind).toBe("mutationApplied");
    }
    const { bytes } = await h.exportDocument("paged");
    const path = join(dir, "web-card.paged");
    writeFileSync(path, bytes);
    return path;
  } finally {
    h.dispose();
  }
}

beforeAll(async () => {
  tmp = tempDir();
  templatePath = await writeTemplate(tmp.dir);
}, 60_000);
afterAll(() => tmp.done());

const valuesOf = (json: {
  fields: { field: { name: string }; value: unknown }[];
}) => Object.fromEntries(json.fields.map((f) => [f.field.name, f.value]));

describe("paged template with paged.web fields", () => {
  it("lists the module kinds and the fields' values", async () => {
    const kinds = await cli(["template", "kinds", PLUGINS]);
    expect(kinds.code).toBe(0);
    expect(JSON.stringify(kinds.json)).toContain("media.paged.web.cssVar");
    const r = await cli(["template", "fields", templatePath, PLUGINS]);
    expect(r.code).toBe(0);
    expect(valuesOf(r.json)).toEqual({
      company: null,
      accent: { kind: "module", value: "red" },
    });
  });

  it("fills them as a filler and writes the result", async () => {
    const out = join(tmp.dir, "filled.paged");
    const r = await cli([
      "template",
      "fill",
      templatePath,
      "--values",
      JSON.stringify({ company: "Example Ltd", accent: "navy" }),
      "-o",
      out,
      PLUGINS,
    ]);
    expect(r.code, r.out + r.err).toBe(0);
    const got = await cli(["template", "fields", out, PLUGINS]);
    expect(valuesOf(got.json)).toEqual({
      company: { kind: "module", value: "Example Ltd" },
      accent: { kind: "module", value: "navy" },
    });
  });

  it("refuses a value the field does not allow, and writes nothing", async () => {
    const r = await cli([
      "template",
      "fill",
      templatePath,
      "--values",
      JSON.stringify({ accent: "lime" }),
      "-o",
      join(tmp.dir, "never.paged"),
      PLUGINS,
    ]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain(
      "is not one of the values this field allows",
    );
  });
});
